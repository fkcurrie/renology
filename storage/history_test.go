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
	if len(hist.Points7d) != 672 {
		t.Errorf("Expected 672 7d points (15m buckets), got %d", len(hist.Points7d))
	}
	if len(hist.Points30d) != 240 {
		t.Errorf("Expected 240 30d points (3h buckets), got %d", len(hist.Points30d))
	}
	if len(hist.Points90d) != 360 {
		t.Errorf("Expected 360 90d points (6h buckets), got %d", len(hist.Points90d))
	}
	if len(hist.Points180d) != 360 {
		t.Errorf("Expected 360 180d points (12h buckets), got %d", len(hist.Points180d))
	}
	if len(hist.Points365d) != 365 {
		t.Errorf("Expected 365 365d points (24h buckets), got %d", len(hist.Points365d))
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

	// Verify multi-timespan fields
	if len(hist.Days30d) != 30 {
		t.Errorf("Expected 30 days in Days30d, got %d", len(hist.Days30d))
	}
	if len(hist.Days90d) != 90 {
		t.Errorf("Expected 90 days in Days90d, got %d", len(hist.Days90d))
	}
	if len(hist.Days180d) != 180 {
		t.Errorf("Expected 180 days in Days180d, got %d", len(hist.Days180d))
	}
	if len(hist.Days365d) != 365 {
		t.Errorf("Expected 365 days in Days365d, got %d", len(hist.Days365d))
	}
	if len(hist.Months12m) != 12 {
		t.Errorf("Expected 12 months in Months12m, got %d", len(hist.Months12m))
	}
}

func TestBucketingPreservesPeakValuesOverTime(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "renology_peak_persist_test_*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	defer os.RemoveAll(tempDir)

	s, err := NewStorage(tempDir)
	if err != nil {
		t.Fatalf("NewStorage failed: %v", err)
	}

	now := time.Date(2026, 9, 27, 12, 15, 0, 0, time.Local)

	// Save one high peak record
	peakRec := &models.Telemetry{
		Timestamp:              now.Add(-10 * time.Minute),
		DeviceName:             "BT-TH-66F984D6",
		Model:                  "RNG-CTRL-RVR20",
		BatterySOC:             100,
		BatteryVoltage:         13.6,
		PVVoltage:              44.4,
		PVPower:                286,
		ChargingStatus:         "MPPT",
		PowerGenerationTodayWh: 500,
	}
	if err := s.Save(peakRec); err != nil {
		t.Fatalf("Save peak error: %v", err)
	}

	// Save several zero or low records in the same bucket interval
	for i := 1; i <= 5; i++ {
		lowRec := &models.Telemetry{
			Timestamp:              now.Add(time.Duration(-10+i) * time.Minute),
			DeviceName:             "BT-TH-66F984D6",
			Model:                  "RNG-CTRL-RVR20",
			BatterySOC:             100,
			BatteryVoltage:         13.2,
			PVVoltage:              0.0,
			PVPower:                0,
			ChargingStatus:         "Deactivated",
			PowerGenerationTodayWh: 500,
		}
		if err := s.Save(lowRec); err != nil {
			t.Fatalf("Save low error: %v", err)
		}
	}

	hist, err := s.GetHistory(now)
	if err != nil {
		t.Fatalf("GetHistory failed: %v", err)
	}

	// Find the max solar power and voltage across 24h, 7d, 30d, 365d points
	findMaxPoints := func(pts []models.HistoryPoint24h) (int, float64) {
		maxW := 0
		maxV := 0.0
		for _, p := range pts {
			if p.SolarPowerW > maxW {
				maxW = p.SolarPowerW
			}
			if p.PVVoltage > maxV {
				maxV = p.PVVoltage
			}
		}
		return maxW, maxV
	}

	w24, v24 := findMaxPoints(hist.Points24h)
	if w24 != 286 || v24 != 44.4 {
		t.Errorf("Points24h lost peak: got W=%d, V=%.1f, expected W=286, V=44.4", w24, v24)
	}

	w7, v7 := findMaxPoints(hist.Points7d)
	if w7 != 286 || v7 != 44.4 {
		t.Errorf("Points7d lost peak: got W=%d, V=%.1f, expected W=286, V=44.4", w7, v7)
	}

	w30, v30 := findMaxPoints(hist.Points30d)
	if w30 != 286 || v30 != 44.4 {
		t.Errorf("Points30d lost peak (averaged away): got W=%d, V=%.1f, expected W=286, V=44.4", w30, v30)
	}

	w365, v365 := findMaxPoints(hist.Points365d)
	if w365 != 286 || v365 != 44.4 {
		t.Errorf("Points365d lost peak (averaged away): got W=%d, V=%.1f, expected W=286, V=44.4", w365, v365)
	}

	// Also verify daily summaries preserved max_pv_v
	if len(hist.Days7d) > 0 {
		last7 := hist.Days7d[len(hist.Days7d)-1]
		if last7.MaxPVVoltage != 44.4 {
			t.Errorf("Days7d lost MaxPVVoltage: got %.1f, expected 44.4", last7.MaxPVVoltage)
		}
		if last7.PeakSolarWatts != 286 {
			t.Errorf("Days7d lost PeakSolarWatts: got %d, expected 286", last7.PeakSolarWatts)
		}
	}
	if len(hist.Days30d) > 0 {
		last30 := hist.Days30d[len(hist.Days30d)-1]
		if last30.MaxPVVoltage != 44.4 {
			t.Errorf("Days30d lost MaxPVVoltage: got %.1f, expected 44.4", last30.MaxPVVoltage)
		}
		if last30.PeakSolarWatts != 286 {
			t.Errorf("Days30d lost PeakSolarWatts: got %d, expected 286", last30.PeakSolarWatts)
		}
	}
}


