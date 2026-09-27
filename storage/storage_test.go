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

	// Verify SQLite database
	dbData, err := os.ReadFile(filepath.Join(tempDir, "renology.db"))
	if err != nil || len(dbData) == 0 {
		t.Fatalf("SQLite database missing or empty")
	}

	// Verify GetDBStats
	count, size, err := s.GetDBStats()
	if err != nil {
		t.Fatalf("GetDBStats failed: %v", err)
	}
	if count != 1 {
		t.Errorf("Expected 1 record in SQLite, got %d", count)
	}
	if size == 0 {
		t.Errorf("Expected positive db file size, got %d", size)
	}

	// Verify RecordRFMeasurement
	if err := s.RecordRFMeasurement(time.Now(), "60:98:66:F9:84:D6", "BT-TH-66F984D6", -88, true, ""); err != nil {
		t.Fatalf("RecordRFMeasurement error: %v", err)
	}

	rfData, err := os.ReadFile(filepath.Join(tempDir, "rf_survey.csv"))
	if err != nil || len(rfData) == 0 {
		t.Fatalf("rf_survey.csv missing or empty")
	}

	if err := s.Close(); err != nil {
		t.Fatalf("Storage.Close failed: %v", err)
	}
}

func TestLegacyCSVMigration(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "renology_csv_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create a dummy CSV file
	csvContent := `timestamp,device_name,mac_address,model,battery_type,rated_voltage_v,rated_current_a,battery_soc,battery_v,battery_a,battery_w,controller_temp_c,battery_temp_c,charging_status,pv_v,pv_a,pv_w,load_status,load_v,load_a,load_w,power_gen_today_wh,power_gen_total_kwh,fault_code
2026-09-27T08:00:00Z,BT-TH-66F984D6,60:98:66:F9:84:D6,RNG-CTRL-RVR20,Lithium,24,20,95,13.20,5.00,66.0,24,24,MPPT,28.50,2.50,71,Off,0.00,0.00,0,120,500.0,0
2026-09-27T09:00:00Z,BT-TH-66F984D6,60:98:66:F9:84:D6,RNG-CTRL-RVR20,Lithium,24,20,99,13.40,8.00,107.2,26,25,MPPT,32.00,3.50,112,Off,0.00,0.00,0,250,500.2,0
`
	if err := os.WriteFile(filepath.Join(tempDir, "renology_history.csv"), []byte(csvContent), 0644); err != nil {
		t.Fatalf("Failed to write mock CSV: %v", err)
	}

	// Initializing Storage should auto-migrate the 2 CSV records into SQLite
	s, err := NewStorage(tempDir)
	if err != nil {
		t.Fatalf("NewStorage failed: %v", err)
	}
	defer s.Close()

	count, _, err := s.GetDBStats()
	if err != nil {
		t.Fatalf("GetDBStats failed: %v", err)
	}
	if count != 2 {
		t.Errorf("Expected 2 records migrated into SQLite, got %d", count)
	}
}

func TestGetRecentTelemetry(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "renology_recent_test_*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	s, err := NewStorage(tempDir)
	if err != nil {
		t.Fatalf("NewStorage failed: %v", err)
	}
	defer s.Close()

	now := time.Now()
	// Insert 10 samples across the last 30 minutes
	for i := 0; i < 10; i++ {
		sampleTime := now.Add(-time.Duration(25-i*2) * time.Minute)
		telem := &models.Telemetry{
			Timestamp:              sampleTime,
			DeviceName:             "BT-TH-66F984D6",
			MACAddress:             "60:98:66:F9:84:D6",
			Model:                  "RNG-CTRL-RVR20",
			BatterySOC:             100,
			BatteryVoltage:         13.35,
			BatteryCurrent:         0.0,
			PVVoltage:              35.0,
			PVPower:                0,
			ChargingStatus:         "MPPT",
			PowerGenerationTodayWh: 95,
		}
		if err := s.Save(telem); err != nil {
			t.Fatalf("Save failed: %v", err)
		}
	}

	recent, raw, err := s.GetRecentTelemetry(60, now)
	if err != nil {
		t.Fatalf("GetRecentTelemetry failed: %v", err)
	}
	if recent.TotalSamples != 10 {
		t.Errorf("Expected 10 total samples, got %d", recent.TotalSamples)
	}
	if len(raw) != 10 {
		t.Errorf("Expected 10 raw records, got %d", len(raw))
	}
	if recent.BatterySOC != 100 {
		t.Errorf("Expected BatterySOC 100, got %d", recent.BatterySOC)
	}
	if recent.AvgPVVoltage < 34.0 || recent.AvgPVVoltage > 36.0 {
		t.Errorf("Expected AvgPVVoltage ~35.0, got %f", recent.AvgPVVoltage)
	}
	if len(recent.MinutePoints) == 0 {
		t.Errorf("Expected non-empty MinutePoints")
	}
}

