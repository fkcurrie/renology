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
	"strconv"
	"syscall"
	"time"

	"renology/models"
	"renology/renogy"
	"renology/storage"
)

func main() {
	targetMAC := flag.String("mac", "60:98:66:F9:84:D6", "Target Renogy BT MAC address")
	pollSec := flag.Int("interval", 5, "Polling interval in seconds")
	outputDir := flag.String("out", "./data", "Directory to store telemetry logs (JSONL, CSV, latest)")
	deviceID := flag.Int("device-id", 255, "Modbus Device ID (default 255/0xFF for Renogy BT)")
	simulate := flag.Bool("simulate", false, "Run in simulation mode for testing / offline verification")
	showStatus := flag.Bool("status", false, "Print summary of RF survey and latest telemetry status")
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

	store, err := storage.NewStorage(absOutDir)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}

	fmt.Println("=====================================================")
	fmt.Println("  Renogy Solar Telemetry Poller (Go Native)")
	fmt.Println("=====================================================")
	fmt.Printf(" Target MAC:       %s\n", *targetMAC)
	fmt.Printf(" Poll Interval:    %d seconds\n", *pollSec)
	fmt.Printf(" Modbus Device ID: 0x%02X (%d)\n", *deviceID, *deviceID)
	fmt.Printf(" Simulation Mode:  %v\n", *simulate)
	fmt.Printf(" Storage Dir:      %s\n", absOutDir)
	fmt.Println(" Output Files:")
	fmt.Printf("   - %s (append-only history)\n", filepath.Join(absOutDir, "renology_telemetry.jsonl"))
	fmt.Printf("   - %s (live snapshot)\n", filepath.Join(absOutDir, "latest_status.json"))
	fmt.Printf("   - %s (CSV spreadsheet)\n", filepath.Join(absOutDir, "renology_history.csv"))
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

	if *simulate {
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
