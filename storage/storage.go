package storage

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"renology/models"
)

// Storage handles local persistence of Renogy telemetry records.
type Storage struct {
	mu           sync.Mutex
	outputDir    string
	jsonlPath    string
	latestPath   string
	csvPath      string
	csvHeaderSet bool
	rfSurveyPath string
	rfHeaderSet  bool
}

// NewStorage initializes storage files in the specified directory.
func NewStorage(dir string) (*Storage, error) {
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create storage dir: %w", err)
	}

	s := &Storage{
		outputDir:    dir,
		jsonlPath:    filepath.Join(dir, "renology_telemetry.jsonl"),
		latestPath:   filepath.Join(dir, "latest_status.json"),
		csvPath:      filepath.Join(dir, "renology_history.csv"),
		rfSurveyPath: filepath.Join(dir, "rf_survey.csv"),
	}

	// Check if CSV already has header
	if fi, err := os.Stat(s.csvPath); err == nil && fi.Size() > 0 {
		s.csvHeaderSet = true
	}
	if fi, err := os.Stat(s.rfSurveyPath); err == nil && fi.Size() > 0 {
		s.rfHeaderSet = true
	}

	return s, nil
}

// Save records a new telemetry reading to JSONL, updates latest_status.json, and appends to CSV.
func (s *Storage) Save(t *models.Telemetry) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if t.Timestamp.IsZero() {
		t.Timestamp = time.Now()
	}

	// 1. Append to JSON Lines
	jsonData, err := json.Marshal(t)
	if err != nil {
		return fmt.Errorf("marshal telemetry error: %w", err)
	}

	f, err := os.OpenFile(s.jsonlPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("open jsonl error: %w", err)
	}
	if _, err := f.Write(append(jsonData, '\n')); err != nil {
		f.Close()
		return fmt.Errorf("write jsonl error: %w", err)
	}
	f.Close()

	// 2. Atomically update latest_status.json
	prettyJSON, err := json.MarshalIndent(t, "", "  ")
	if err == nil {
		tmpLatest := s.latestPath + ".tmp"
		if err := os.WriteFile(tmpLatest, prettyJSON, 0644); err == nil {
			_ = os.Rename(tmpLatest, s.latestPath)
		}
	}

	// 3. Append to CSV
	csvFile, err := os.OpenFile(s.csvPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err == nil {
		writer := csv.NewWriter(csvFile)
		if !s.csvHeaderSet {
			_ = writer.Write([]string{
				"timestamp", "device_name", "mac_address", "model",
				"battery_soc", "battery_v", "battery_a", "battery_w",
				"controller_temp_c", "battery_temp_c", "charging_status",
				"pv_v", "pv_a", "pv_w",
				"load_status", "load_v", "load_a", "load_w",
				"power_gen_today_wh", "power_gen_total_kwh", "fault_code",
			})
			s.csvHeaderSet = true
		}
		_ = writer.Write([]string{
			t.Timestamp.Format(time.RFC3339),
			t.DeviceName,
			t.MACAddress,
			t.Model,
			fmt.Sprintf("%d", t.BatterySOC),
			fmt.Sprintf("%.2f", t.BatteryVoltage),
			fmt.Sprintf("%.2f", t.BatteryCurrent),
			fmt.Sprintf("%.1f", t.BatteryPower),
			fmt.Sprintf("%d", t.ControllerTemperatureC),
			fmt.Sprintf("%d", t.BatteryTemperatureC),
			t.ChargingStatus,
			fmt.Sprintf("%.2f", t.PVVoltage),
			fmt.Sprintf("%.2f", t.PVCurrent),
			fmt.Sprintf("%d", t.PVPower),
			t.LoadStatus,
			fmt.Sprintf("%.2f", t.LoadVoltage),
			fmt.Sprintf("%.2f", t.LoadCurrent),
			fmt.Sprintf("%d", t.LoadPower),
			fmt.Sprintf("%d", t.PowerGenerationTodayWh),
			fmt.Sprintf("%.2f", t.PowerGenerationTotalKWh),
			fmt.Sprintf("%d", t.FaultCode),
		})
		writer.Flush()
		csvFile.Close()
	}

	return nil
}

// RecordRFMeasurement appends an RF advertisement and connection attempt log entry.
func (s *Storage) RecordRFMeasurement(t time.Time, mac, name string, rssi int, connected bool, errStr string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if t.IsZero() {
		t = time.Now()
	}

	f, err := os.OpenFile(s.rfSurveyPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("open rf_survey.csv error: %w", err)
	}
	defer f.Close()

	writer := csv.NewWriter(f)
	if !s.rfHeaderSet {
		_ = writer.Write([]string{
			"timestamp", "mac_address", "device_name", "rssi_dbm", "connected", "error_detail",
		})
		s.rfHeaderSet = true
	}

	connStr := "false"
	if connected {
		connStr = "true"
	}

	_ = writer.Write([]string{
		t.Format(time.RFC3339),
		mac,
		name,
		fmt.Sprintf("%d", rssi),
		connStr,
		errStr,
	})
	writer.Flush()
	return nil
}
