package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"encoding/csv"
	"io"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"renology/models"
	"renology/renogy"
	"renology/storage"
	"renology/web"
)

func main() {
	targetMAC := flag.String("mac", "60:98:66:F9:84:D6", "Target Renogy BT MAC address")
	pollSec := flag.Int("interval", 5, "Polling interval in seconds")
	outputDir := flag.String("out", "./data", "Directory to store telemetry logs (JSONL, CSV, latest)")
	deviceID := flag.Int("device-id", 255, "Modbus Device ID (default 255/0xFF for Renogy BT)")
	httpAddr := flag.String("http", ":8080", "HTTP kiosk dashboard listen address (e.g. :8080, or \"\" to disable)")
	kiosk := flag.Bool("kiosk", false, "Launch browser automatically in full-screen kiosk mode")
	webOnly := flag.Bool("web-only", false, "Run only the kiosk web server without polling BLE")
	simulate := flag.Bool("simulate", false, "Run in simulation mode for testing / offline verification")
	showStatus := flag.Bool("status", false, "Print summary of RF survey and latest telemetry status")
	recentMin := flag.Int("recent", 0, "Print telemetry summary and time-series table for the last N minutes (e.g. -recent 60)")
	rawOutput := flag.Bool("raw", false, "When using -recent, print individual raw samples instead of minute aggregates")
	verbose := flag.Bool("verbose", false, "Enable verbose packet-level debug output")
	flag.Parse()

	absOutDir, err := filepath.Abs(*outputDir)
	if err != nil {
		log.Fatalf("Invalid output directory: %v", err)
	}

	if *showStatus {
		printStatusReport(absOutDir)
		return
	}

	if *recentMin > 0 {
		printRecentReport(absOutDir, *recentMin, *rawOutput)
		return
	}

	store, err := storage.NewStorage(absOutDir)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}
	defer store.Close()

	fmt.Println("=====================================================")
	fmt.Println("  Renogy Solar Telemetry Poller (Go Native)")
	fmt.Println("=====================================================")
	fmt.Printf(" Target MAC:       %s\n", *targetMAC)
	fmt.Printf(" Poll Interval:    %d seconds\n", *pollSec)
	fmt.Printf(" Modbus Device ID: 0x%02X (%d)\n", *deviceID, *deviceID)
	fmt.Printf(" Simulation Mode:  %v\n", *simulate)
	fmt.Printf(" Storage Dir:      %s\n", absOutDir)
	if *httpAddr != "" {
		fmt.Printf(" Kiosk Dashboard:  http://localhost%s\n", *httpAddr)
		fmt.Printf(" Kiosk Fullscreen: %v\n", *kiosk)
	}
	fmt.Printf(" Web Only Mode:    %v\n", *webOnly)
	fmt.Println(" Output Files & Database:")
	fmt.Printf("   - %s (scalable SQLite database)\n", filepath.Join(absOutDir, "renology.db"))
	fmt.Printf("   - %s (live snapshot)\n", filepath.Join(absOutDir, "latest_status.json"))
	fmt.Printf("   - %s (append-only history)\n", filepath.Join(absOutDir, "renology_telemetry.jsonl"))
	fmt.Printf("   - %s (CSV export)\n", filepath.Join(absOutDir, "renology_history.csv"))
	fmt.Println("=====================================================")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigChan
		fmt.Println("\nReceived termination signal. Shutting down gracefully...")
		cancel()
	}()

	// 1. Start embedded Kiosk Web Server if configured
	if *httpAddr != "" {
		webServer, err := web.NewServer(web.ServerConfig{
			ListenAddr: *httpAddr,
			Storage:    store,
			Verbose:    *verbose,
		})
		if err != nil {
			log.Fatalf("Failed to initialize web server: %v", err)
		}

		go func() {
			if err := webServer.Start(ctx); err != nil {
				log.Printf("[Web] Web server stopped: %v", err)
			}
		}()

		if *kiosk {
			go launchKioskBrowser("http://localhost" + *httpAddr)
		}
	}

	// 2. Run Poller or Web-Only Mode
	if *webOnly {
		log.Println("[Renology] Running in web-only kiosk mode (BLE polling disabled). Press Ctrl+C to stop.")
		<-ctx.Done()
	} else if *simulate {
		runSimulator(ctx, time.Duration(*pollSec)*time.Second, store, *targetMAC)
	} else {
		client := renogy.NewClient(renogy.ClientConfig{
			TargetMAC:    *targetMAC,
			DeviceID:     byte(*deviceID),
			PollInterval: time.Duration(*pollSec) * time.Second,
			Storage:      store,
			Verbose:      *verbose,
		})

		if err := client.Start(ctx); err != nil {
			log.Fatalf("Client error: %v", err)
		}
	}

	fmt.Println("Renology poller stopped.")
}

func launchKioskBrowser(url string) {
	time.Sleep(800 * time.Millisecond) // Allow web server to bind socket

	candidates := [][]string{
		{"chromium", "--kiosk", "--noerrdialogs", "--disable-infobars", url},
		{"chromium-browser", "--kiosk", "--noerrdialogs", "--disable-infobars", url},
		{"google-chrome", "--kiosk", "--noerrdialogs", "--disable-infobars", url},
		{"firefox", "--kiosk", url},
		{"xdg-open", url},
	}

	for _, cmdArgs := range candidates {
		bin, err := exec.LookPath(cmdArgs[0])
		if err == nil {
			log.Printf("[Kiosk] Launching kiosk display using %s (%s)", bin, url)
			cmd := exec.Command(bin, cmdArgs[1:]...)
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			if err := cmd.Start(); err != nil {
				log.Printf("[Kiosk] Warning: failed to start %s: %v", bin, err)
				continue
			}
			return
		}
	}
	log.Printf("[Kiosk] Note: No browser found to auto-launch kiosk. Open %s manually.", url)
}

func runSimulator(ctx context.Context, interval time.Duration, store *storage.Storage, mac string) {
	log.Printf("[Simulator] Running simulated Rover 40A telemetry poller every %v...", interval)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var counter int
	whToday := 480

	for {
		counter++
		whToday += 1
		now := time.Now()
		vBatt := 13.6 + float64(counter%5)*0.02
		aBatt := 15.4 + float64(counter%3)*0.1
		pBatt := float64(int(vBatt*aBatt*10+0.5)) / 10.0

		telem := &models.Telemetry{
			Timestamp:               now,
			MACAddress:              mac,
			DeviceName:              "BT-TH-66F984D6",
			Model:                   "RNG-CTRL-RVR40",
			DeviceID:                0xFF,
			DeviceType:              "Solar Charge Controller",
			RSSI:                    -72,
			RatedVoltageVolts:       12,
			RatedCurrentAmps:        40,
			BatterySOC:              98,
			BatteryVoltage:          vBatt,
			BatteryCurrent:          aBatt,
			BatteryPower:            pBatt,
			ControllerTemperatureC:  28,
			BatteryTemperatureC:     22,
			ChargingStatus:          "MPPT",
			BatteryType:             "Lithium (LFP)",
			PVVoltage:               36.2,
			PVCurrent:               5.80,
			PVPower:                 210,
			LoadStatus:              "Off",
			PowerGenerationTodayWh:  whToday,
			PowerGenerationTotalKWh: 142.5,
		}

		if err := store.Save(telem); err != nil {
			log.Printf("[Simulator] Storage error: %v", err)
		}

		fmt.Printf("[%s] %s | Battery: %d%% %.2fV %.2fA (%.1fW) | Solar PV: %.1fV %.2fA (%dW) | State: %s | Today: %d Wh\n",
			telem.Timestamp.Format("15:04:05"),
			telem.Model,
			telem.BatterySOC,
			telem.BatteryVoltage,
			telem.BatteryCurrent,
			telem.BatteryPower,
			telem.PVVoltage,
			telem.PVCurrent,
			telem.PVPower,
			telem.ChargingStatus,
			telem.PowerGenerationTodayWh,
		)

		select {
		case <-ticker.C:
		case <-ctx.Done():
			return
		}
	}
}

func printStatusReport(dataDir string) {
	fmt.Println("=====================================================")
	fmt.Println("  Renology RF Survey & Connection Status Report")
	fmt.Println("=====================================================")

	rfFile := filepath.Join(dataDir, "rf_survey.csv")
	f, err := os.Open(rfFile)
	if err != nil {
		fmt.Printf("No RF survey data found yet at %s\n", rfFile)
		return
	}
	defer f.Close()

	r := csv.NewReader(f)
	// Read header
	_, err = r.Read()
	if err != nil {
		fmt.Println("Empty RF survey file.")
		return
	}

	var count int
	var minRSSI = 0
	var maxRSSI = -999
	var sumRSSI int
	var successCount int
	var latestTime string
	var latestMAC string
	var latestRSSI int
	var latestErr string

	for {
		record, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil || len(record) < 6 {
			continue
		}

		count++
		latestTime = record[0]
		latestMAC = record[1]
		rssi, _ := strconv.Atoi(record[3])
		conn := record[4] == "true"
		latestErr = record[5]
		latestRSSI = rssi

		if count == 1 {
			minRSSI = rssi
			maxRSSI = rssi
		} else {
			if rssi < minRSSI {
				minRSSI = rssi
			}
			if rssi > maxRSSI {
				maxRSSI = rssi
			}
		}
		sumRSSI += rssi

		if conn {
			successCount++
		}
	}

	if count == 0 {
		fmt.Println("No RF measurements recorded yet.")
		return
	}

	avgRSSI := float64(sumRSSI) / float64(count)

	fmt.Printf(" Target Device:        %s\n", latestMAC)
	fmt.Printf(" Latest Sample Time:   %s\n", latestTime)
	fmt.Printf(" Total Survey Samples: %d\n", count)
	fmt.Printf(" Latest RSSI:          %d dBm\n", latestRSSI)
	fmt.Printf(" Min / Max / Avg RSSI: %d / %d / %.1f dBm\n", minRSSI, maxRSSI, avgRSSI)
	fmt.Printf(" Connection Successes: %d / %d\n", successCount, count)
	if successCount == 0 {
		fmt.Printf(" Last Link Error:      %s\n", latestErr)
		fmt.Println(" Status Summary:       Fringe RF attenuation (< -94 dBm threshold).")
		fmt.Println(" Action Needed:        Move laptop closer to solar controller (Target: -60 to -85 dBm).")
	} else {
		fmt.Println(" Status Summary:       CONNECTED! Live telemetry is streaming.")
	}

	// Check latest telemetry
	latestPath := filepath.Join(dataDir, "latest_status.json")
	if data, err := os.ReadFile(latestPath); err == nil && len(data) > 0 {
		fmt.Println("-----------------------------------------------------")
		fmt.Printf(" Latest Telemetry Snapshot (%s):\n", latestPath)
		fmt.Println(string(data))
	}
	fmt.Println("=====================================================")
}

// printRecentReport outputs an executive summary and time-series table for the last N minutes.
func printRecentReport(dataDir string, minutes int, raw bool) {
	store, err := storage.NewStorage(dataDir)
	if err != nil {
		log.Fatalf("Failed to open storage: %v", err)
	}
	defer store.Close()

	summary, rawRecords, err := store.GetRecentTelemetry(minutes, time.Now())
	if err != nil {
		log.Fatalf("Failed to query recent telemetry: %v", err)
	}

	fmt.Println("========================================================================================================")
	fmt.Printf("  RENOLOGY SOLAR TELEMETRY REPORT — LAST %d MINUTES\n", minutes)
	fmt.Printf("  Window:            %s to %s\n", summary.StartTime.Local().Format("15:04:05"), summary.EndTime.Local().Format("15:04:05"))
	fmt.Println("========================================================================================================")
	fmt.Printf("  Samples Recorded:  %d samples (~1 sample every 5s)\n", summary.TotalSamples)
	fmt.Printf("  Battery Tank:      %d%% Full (Avg %.2fV) • Lithium LFP\n", summary.BatterySOC, summary.AvgBatteryV)
	fmt.Printf("  Solar Sun Voltage: Avg %.1fV (Min %.1fV, Max %.1fV)\n", summary.AvgPVVoltage, summary.MinPVVoltage, summary.MaxPVVoltage)
	fmt.Printf("  Solar Power:       Avg %.1fW (Peak %dW)\n", summary.AvgSolarWatts, summary.PeakSolarWatts)
	fmt.Printf("  Today's Yield:     %d Wh (cumulative)\n", summary.TodayYieldWh)
	fmt.Printf("  Status Narrative:  %s\n", summary.StatusSummary)
	fmt.Println("--------------------------------------------------------------------------------------------------------")

	if len(summary.MinutePoints) == 0 && len(rawRecords) == 0 {
		fmt.Println("  No telemetry data found for this time window.")
		fmt.Println("========================================================================================================")
		return
	}

	if raw {
		fmt.Printf(" %-8s | %-10s | %-10s | %-8s | %-10s | %-10s | %-8s | %s\n",
			"TIME", "PV VOLTS", "PV POWER", "BATT SOC", "BATT VOLTS", "BATT AMPS", "TODAY WH", "STATUS")
		fmt.Println("--------------------------------------------------------------------------------------------------------")
		for _, r := range rawRecords {
			fmt.Printf(" %-8s | %8.1fV | %8dW | %7d%% | %8.2fV | %+8.2fA | %6dWh | %s\n",
				r.Timestamp.Local().Format("15:04:05"),
				r.PVVoltage,
				r.PVPower,
				r.BatterySOC,
				r.BatteryVoltage,
				r.BatteryCurrent,
				r.PowerGenerationTodayWh,
				r.ChargingStatus,
			)
		}
	} else {
		fmt.Printf(" %-6s | %-10s | %-14s | %-8s | %-10s | %-10s | %-8s | %s\n",
			"TIME", "SUN VOLTS", "SOLAR POWER", "BATT SOC", "BATT VOLTS", "NET AMPS", "TODAY WH", "SYSTEM MODE / STORY")
		fmt.Println("--------------------------------------------------------------------------------------------------------")
		for _, p := range summary.MinutePoints {
			powerStr := fmt.Sprintf("%dW (Pk %dW)", p.SolarPowerW, p.PeakSolarW)
			fmt.Printf(" %-6s | %8.1fV | %-14s | %7d%% | %8.2fV | %+8.2fA | %6dWh | %s\n",
				p.TimeLabel,
				p.PVVoltage,
				powerStr,
				p.BatterySOC,
				p.BatteryVoltage,
				p.BatteryCurrent,
				p.TodayYieldWh,
				p.Mode,
			)
		}
	}
	fmt.Println("========================================================================================================")
}

