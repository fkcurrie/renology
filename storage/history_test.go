package storage

import (
	"os"
	"testing"
	"time"

	"renology/models"
)

func TestGetHistoryAndLatest(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "renology_hist_test_*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	defer os.RemoveAll(tempDir)

	s, err := NewStorage(tempDir)
	if err != nil {
		t.Fatalf("NewStorage failed: %v", err)
	}

	now := time.Date(2026, 9, 27, 12, 0, 0, 0, time.Local)

	// Save a test record
	rec := &models.Telemetry{
		Timestamp:              now,
		DeviceName:             "BT-TH-66F984D6",
		Model:                  "RNG-CTRL-RVR20",
		BatterySOC:             100,
		BatteryVoltage:         13.2,
		PVVoltage:              28.5,
		PVPower:                150,
		ChargingStatus:         "MPPT",
		PowerGenerationTodayWh: 350,
	}

	if err := s.Save(rec); err != nil {
		t.Fatalf("Save error: %v", err)
	}

	// Test GetLatest
	latest, err := s.GetLatest()
	if err != nil {
		t.Fatalf("GetLatest failed: %v", err)
	}
	if latest.BatterySOC != 100 {
		t.Errorf("Expected SOC 100, got %d", latest.BatterySOC)
	}
	if latest.PVPower != 150 {
		t.Errorf("Expected PVPower 150, got %d", latest.PVPower)
	}

	// Test GetHistory
	hist, err := s.GetHistory(now)
	if err != nil {
		t.Fatalf("GetHistory failed: %v", err)
	}

	if len(hist.Points24h) != 96 {
		t.Errorf("Expected 96 24h points, got %d", len(hist.Points24h))
	}

	if len(hist.Days7d) != 7 {
		t.Errorf("Expected 7 days summary, got %d", len(hist.Days7d))
	}

	// Check today's entry
	todaySummary := hist.Days7d[6]
	if todaySummary.DayLabel != "Today" {
		t.Errorf("Expected last day label 'Today', got '%s'", todaySummary.DayLabel)
	}
	if todaySummary.PeakSolarWatts != 150 {
		t.Errorf("Expected peak solar 150W, got %d", todaySummary.PeakSolarWatts)
	}
	if todaySummary.EnergyWh != 350 {
		t.Errorf("Expected today energy 350 Wh, got %d", todaySummary.EnergyWh)
	}
}
