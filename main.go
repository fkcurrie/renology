package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
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
	verbose := flag.Bool("verbose", false, "Enable verbose packet-level debug output")
	flag.Parse()

	absOutDir, err := filepath.Abs(*outputDir)
	if err != nil {
		log.Fatalf("Invalid output directory: %v", err)
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
