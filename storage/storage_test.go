package storage

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"renology/models"
)

func TestStorageSave(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "renology_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	s, err := NewStorage(tempDir)
	if err != nil {
		t.Fatalf("NewStorage failed: %v", err)
	}

	telem := &models.Telemetry{
		Timestamp:      time.Now(),
		DeviceName:     "BT-TH-66F984D6",
		MACAddress:     "60:98:66:F9:84:D6",
		Model:          "RNG-CTRL-RVR40",
		BatterySOC:     90,
		BatteryVoltage: 13.4,
		BatteryCurrent: 10.2,
		PVVoltage:      34.5,
		PVPower:        150,
		ChargingStatus: "MPPT",
	}

	if err := s.Save(telem); err != nil {
		t.Fatalf("Save error: %v", err)
	}

	// Verify JSONL
	jsonlData, err := os.ReadFile(filepath.Join(tempDir, "renology_telemetry.jsonl"))
	if err != nil || len(jsonlData) == 0 {
		t.Fatalf("JSONL file missing or empty")
	}

	// Verify latest_status.json
	latestData, err := os.ReadFile(filepath.Join(tempDir, "latest_status.json"))
	if err != nil || len(latestData) == 0 {
		t.Fatalf("latest_status.json missing or empty")
	}

	// Verify CSV
	csvData, err := os.ReadFile(filepath.Join(tempDir, "renology_history.csv"))
	if err != nil || len(csvData) == 0 {
		t.Fatalf("CSV missing or empty")
	}
}
