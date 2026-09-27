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

	"renology/renogy"
	"renology/storage"
)

func main() {
	targetMAC := flag.String("mac", "60:98:66:F9:84:D6", "Target Renogy BT MAC address")
	pollSec := flag.Int("interval", 5, "Polling interval in seconds")
	outputDir := flag.String("out", "./data", "Directory to store telemetry logs (JSONL, CSV, latest)")
	deviceID := flag.Int("device-id", 255, "Modbus Device ID (default 255/0xFF for Renogy BT)")
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

	fmt.Println("Renology poller stopped.")
}
