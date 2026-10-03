package storage

import (
	"bufio"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"strconv"
	"time"

	_ "modernc.org/sqlite"
	"renology/models"
)

const schemaSQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -16000;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;

CREATE TABLE IF NOT EXISTS telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL,
    device_name TEXT,
    mac_address TEXT,
    model TEXT,
    battery_type TEXT,
    rated_voltage_v INTEGER,
    rated_current_a INTEGER,
    battery_soc INTEGER,
    battery_v REAL,
    battery_a REAL,
    battery_w REAL,
    controller_temp_c INTEGER,
    battery_temp_c INTEGER,
    charging_status TEXT,
    pv_v REAL,
    pv_a REAL,
    pv_w INTEGER,
    load_status TEXT,
    load_v REAL,
    load_a REAL,
    load_w INTEGER,
    power_gen_today_wh INTEGER,
    power_gen_total_kwh REAL,
    charging_ah_today INTEGER,
    fault_code INTEGER,
    rssi INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp);
CREATE INDEX IF NOT EXISTS idx_telemetry_pv_v ON telemetry(pv_v DESC, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_pv_w ON telemetry(pv_w DESC, timestamp DESC);

CREATE TABLE IF NOT EXISTS rf_survey (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME NOT NULL,
    mac_address TEXT,
    device_name TEXT,
    rssi_dbm INTEGER,
    connected BOOLEAN,
    error_detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_rf_timestamp ON rf_survey(timestamp);
`

// initDB opens or creates the SQLite database, configures WAL mode, runs schema migrations,
// and auto-imports legacy JSONL and CSV records.
func (s *Storage) initDB() error {
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=cache_size(-16000)&_pragma=temp_store(MEMORY)&_pragma=mmap_size(268435456)", s.dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("failed to open sqlite database %s: %w", s.dbPath, err)
	}

	// Allow concurrent readers in WAL mode while preserving low footprint
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(0)

	// Execute schema
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return fmt.Errorf("failed to execute sqlite schema: %w", err)
	}

	s.db = db

	// Check if telemetry table needs migration from existing legacy logs
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM telemetry").Scan(&count); err == nil && count < 50 {
		_ = s.migrateLegacyJSONL()
		_ = s.migrateLegacyCSV()
	}

	return nil
}

// insertTelemetrySQL inserts a single telemetry record into SQLite.
func (s *Storage) insertTelemetrySQL(t *models.Telemetry) error {
	if s.db == nil {
		return nil
	}

	query := `
INSERT OR IGNORE INTO telemetry (
    timestamp, device_name, mac_address, model, battery_type,
    rated_voltage_v, rated_current_a, battery_soc, battery_v, battery_a, battery_w,
    controller_temp_c, battery_temp_c, charging_status,
    pv_v, pv_a, pv_w, load_status, load_v, load_a, load_w,
    power_gen_today_wh, power_gen_total_kwh, charging_ah_today, fault_code, rssi
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	_, err := s.db.Exec(
		query,
		t.Timestamp.Format(time.RFC3339Nano),
		t.DeviceName,
		t.MACAddress,
		t.Model,
		t.BatteryType,
		t.RatedVoltageVolts,
		t.RatedCurrentAmps,
		t.BatterySOC,
		t.BatteryVoltage,
		t.BatteryCurrent,
		t.BatteryPower,
		t.ControllerTemperatureC,
		t.BatteryTemperatureC,
		t.ChargingStatus,
		t.PVVoltage,
		t.PVCurrent,
		t.PVPower,
		t.LoadStatus,
		t.LoadVoltage,
		t.LoadCurrent,
		t.LoadPower,
		t.PowerGenerationTodayWh,
		t.PowerGenerationTotalKWh,
		t.ChargingAmpHoursToday,
		t.FaultCode,
		t.RSSI,
	)
	return err
}

// insertRFMeasurementSQL inserts an RF log entry into SQLite.
func (s *Storage) insertRFMeasurementSQL(t time.Time, mac, name string, rssi int, connected bool, errStr string) error {
	if s.db == nil {
		return nil
	}

	query := `
INSERT INTO rf_survey (timestamp, mac_address, device_name, rssi_dbm, connected, error_detail)
VALUES (?, ?, ?, ?, ?, ?)`

	_, err := s.db.Exec(query, t.Format(time.RFC3339Nano), mac, name, rssi, connected, errStr)
	return err
}

// queryTelemetryRange returns telemetry records between startTime and endTime indexed by timestamp.
func (s *Storage) queryTelemetryRange(start, end time.Time) ([]models.Telemetry, error) {
	if s.db == nil {
		return nil, fmt.Errorf("sqlite db not initialized")
	}

	query := `
SELECT timestamp, device_name, mac_address, model, battery_type,
       rated_voltage_v, rated_current_a, battery_soc, battery_v, battery_a, battery_w,
       controller_temp_c, battery_temp_c, charging_status,
       pv_v, pv_a, pv_w, load_status, load_v, load_a, load_w,
       power_gen_today_wh, power_gen_total_kwh, charging_ah_today, fault_code, COALESCE(rssi, 0)
FROM telemetry
WHERE timestamp >= ? AND timestamp <= ?
ORDER BY timestamp ASC`

	rows, err := s.db.Query(query, start.Format(time.RFC3339Nano), end.Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var records []models.Telemetry
	for rows.Next() {
		var t models.Telemetry
		var tsStr string
		err := rows.Scan(
			&tsStr,
			&t.DeviceName,
			&t.MACAddress,
			&t.Model,
			&t.BatteryType,
			&t.RatedVoltageVolts,
			&t.RatedCurrentAmps,
			&t.BatterySOC,
			&t.BatteryVoltage,
			&t.BatteryCurrent,
			&t.BatteryPower,
			&t.ControllerTemperatureC,
			&t.BatteryTemperatureC,
			&t.ChargingStatus,
			&t.PVVoltage,
			&t.PVCurrent,
			&t.PVPower,
			&t.LoadStatus,
			&t.LoadVoltage,
			&t.LoadCurrent,
			&t.LoadPower,
			&t.PowerGenerationTodayWh,
			&t.PowerGenerationTotalKWh,
			&t.ChargingAmpHoursToday,
			&t.FaultCode,
			&t.RSSI,
		)
		if err == nil {
			if parsedTime, pErr := time.Parse(time.RFC3339Nano, tsStr); pErr == nil {
				t.Timestamp = parsedTime
			} else if parsedTime, pErr := time.Parse(time.RFC3339, tsStr); pErr == nil {
				t.Timestamp = parsedTime
			}
			records = append(records, t)
		}
	}
	return records, rows.Err()
}

// queryDailyAggregates returns daily aggregated solar statistics from SQLite.
func (s *Storage) queryDailyAggregates(start, end time.Time) (map[string]models.DailySummaryRecord, error) {
	if s.db == nil {
		return nil, fmt.Errorf("sqlite db not initialized")
	}

	query := `
SELECT date(timestamp) as day,
       COALESCE(MAX(pv_w), 0) as peak_w,
       COALESCE(MAX(power_gen_today_wh), 0) as max_wh,
       COALESCE(ROUND(AVG(battery_soc)), 100) as avg_soc,
       COALESCE(MAX(pv_v), 0.0) as max_pv_v
FROM telemetry
WHERE timestamp >= ? AND timestamp <= ?
GROUP BY date(timestamp)
ORDER BY day ASC`

	rows, err := s.db.Query(query, start.Format(time.RFC3339Nano), end.Format(time.RFC3339Nano))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]models.DailySummaryRecord)
	for rows.Next() {
		var r models.DailySummaryRecord
		var dayStr string
		var avgSoc float64
		if err := rows.Scan(&dayStr, &r.PeakSolarWatts, &r.EnergyWh, &avgSoc, &r.MaxPVVoltage); err == nil {
			r.Date = dayStr
			r.AvgBatterySOC = int(avgSoc)
			r.EnergyKWh = math.Round((float64(r.EnergyWh)/1000.0)*100) / 100
			result[dayStr] = r
		}
	}
	return result, rows.Err()
}

// queryTelemetryBuckets returns time-series buckets aggregated by SQLite.
func (s *Storage) queryTelemetryBuckets(start, end time.Time, bucketSeconds int) (map[int64]models.HistoryPoint24h, error) {
	if s.db == nil {
		return nil, fmt.Errorf("sqlite db not initialized")
	}

	query := `
SELECT
    (strftime('%s', timestamp) / ?) * ? as b_epoch,
    CAST(ROUND(MAX(pv_w)) AS INTEGER) as max_pv_w,
    CAST(ROUND(MAX(CASE WHEN battery_w > 0 THEN battery_w ELSE battery_v * battery_a END)) AS INTEGER) as max_batt_w,
    COALESCE(ROUND(MAX(pv_v), 1), 0.0) as max_pv_v,
    CAST(ROUND(AVG(battery_soc)) AS INTEGER) as avg_soc,
    COALESCE(ROUND(AVG(battery_v), 2), 0.0) as avg_batt_v
FROM telemetry
WHERE timestamp >= ? AND timestamp <= ?
GROUP BY (strftime('%s', timestamp) / ?)
ORDER BY b_epoch ASC`

	rows, err := s.db.Query(query, bucketSeconds, bucketSeconds, start.Format(time.RFC3339Nano), end.Format(time.RFC3339Nano), bucketSeconds)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make(map[int64]models.HistoryPoint24h)
	for rows.Next() {
		var epoch int64
		var p models.HistoryPoint24h
		if err := rows.Scan(&epoch, &p.SolarPowerW, &p.BatteryPowerW, &p.PVVoltage, &p.BatterySOC, &p.BatteryVoltage); err == nil {
			p.Timestamp = time.Unix(epoch, 0)
			results[epoch] = p
		}
	}
	return results, rows.Err()
}

// migrateLegacyJSONL reads existing JSONL lines and batch-inserts them into SQLite.
func (s *Storage) migrateLegacyJSONL() error {
	f, err := os.Open(s.jsonlPath)
	if err != nil {
		return nil
	}
	defer f.Close()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
INSERT OR IGNORE INTO telemetry (
    timestamp, device_name, mac_address, model, battery_type,
    rated_voltage_v, rated_current_a, battery_soc, battery_v, battery_a, battery_w,
    controller_temp_c, battery_temp_c, charging_status,
    pv_v, pv_a, pv_w, load_status, load_v, load_a, load_w,
    power_gen_today_wh, power_gen_total_kwh, charging_ah_today, fault_code, rssi
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	scanner := bufio.NewScanner(f)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 64*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var t models.Telemetry
		if err := json.Unmarshal(line, &t); err == nil && !t.Timestamp.IsZero() {
			_, _ = stmt.Exec(
				t.Timestamp.Format(time.RFC3339Nano),
				t.DeviceName,
				t.MACAddress,
				t.Model,
				t.BatteryType,
				t.RatedVoltageVolts,
				t.RatedCurrentAmps,
				t.BatterySOC,
				t.BatteryVoltage,
				t.BatteryCurrent,
				t.BatteryPower,
				t.ControllerTemperatureC,
				t.BatteryTemperatureC,
				t.ChargingStatus,
				t.PVVoltage,
				t.PVCurrent,
				t.PVPower,
				t.LoadStatus,
				t.LoadVoltage,
				t.LoadCurrent,
				t.LoadPower,
				t.PowerGenerationTodayWh,
				t.PowerGenerationTotalKWh,
				t.ChargingAmpHoursToday,
				t.FaultCode,
				t.RSSI,
			)
		}
	}

	return tx.Commit()
}

// migrateLegacyCSV reads existing rows from renology_history.csv and inserts them into SQLite.
func (s *Storage) migrateLegacyCSV() error {
	f, err := os.Open(s.csvPath)
	if err != nil {
		return nil // No legacy CSV file to migrate
	}
	defer f.Close()

	r := csv.NewReader(f)
	// Skip header
	header, err := r.Read()
	if err != nil || len(header) < 10 {
		return nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.Prepare(`
INSERT OR IGNORE INTO telemetry (
    timestamp, device_name, mac_address, model, battery_type,
    rated_voltage_v, rated_current_a, battery_soc, battery_v, battery_a, battery_w,
    controller_temp_c, battery_temp_c, charging_status,
    pv_v, pv_a, pv_w, load_status, load_v, load_a, load_w,
    power_gen_today_wh, power_gen_total_kwh, charging_ah_today, fault_code, rssi
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	hasFullCols := len(header) >= 24

	for {
		record, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil || len(record) < 21 {
			continue
		}

		var parsedTime time.Time
		tsStr := record[0]
		if pt, pErr := time.Parse(time.RFC3339Nano, tsStr); pErr == nil {
			parsedTime = pt
		} else if pt, pErr := time.Parse(time.RFC3339, tsStr); pErr == nil {
			parsedTime = pt
		} else {
			continue
		}

		devName := record[1]
		mac := record[2]
		model := record[3]

		var battType string
		var ratedV, ratedA, soc int
		var battV, battA, battW float64
		var ctrlTemp, battTemp int
		var chargeStatus string
		var pvV, pvA float64
		var pvW int
		var loadStatus string
		var loadV, loadA float64
		var loadW, powerTodayWh int
		var powerTotalKWh float64
		var faultCode int

		if hasFullCols && len(record) >= 24 {
			battType = record[4]
			ratedV, _ = strconv.Atoi(record[5])
			ratedA, _ = strconv.Atoi(record[6])
			soc, _ = strconv.Atoi(record[7])
			battV, _ = strconv.ParseFloat(record[8], 64)
			battA, _ = strconv.ParseFloat(record[9], 64)
			battW, _ = strconv.ParseFloat(record[10], 64)
			ctrlTemp, _ = strconv.Atoi(record[11])
			battTemp, _ = strconv.Atoi(record[12])
			chargeStatus = record[13]
			pvV, _ = strconv.ParseFloat(record[14], 64)
			pvA, _ = strconv.ParseFloat(record[15], 64)
			pvW, _ = strconv.Atoi(record[16])
			loadStatus = record[17]
			loadV, _ = strconv.ParseFloat(record[18], 64)
			loadA, _ = strconv.ParseFloat(record[19], 64)
			loadW, _ = strconv.Atoi(record[20])
			powerTodayWh, _ = strconv.Atoi(record[21])
			powerTotalKWh, _ = strconv.ParseFloat(record[22], 64)
			faultCode, _ = strconv.Atoi(record[23])
		} else {
			// Legacy 21-column layout
			soc, _ = strconv.Atoi(record[4])
			battV, _ = strconv.ParseFloat(record[5], 64)
			battA, _ = strconv.ParseFloat(record[6], 64)
			battW, _ = strconv.ParseFloat(record[7], 64)
			ctrlTemp, _ = strconv.Atoi(record[8])
			battTemp, _ = strconv.Atoi(record[9])
			chargeStatus = record[10]
			pvV, _ = strconv.ParseFloat(record[11], 64)
			pvA, _ = strconv.ParseFloat(record[12], 64)
			pvW, _ = strconv.Atoi(record[13])
			loadStatus = record[14]
			loadV, _ = strconv.ParseFloat(record[15], 64)
			loadA, _ = strconv.ParseFloat(record[16], 64)
			loadW, _ = strconv.Atoi(record[17])
			powerTodayWh, _ = strconv.Atoi(record[18])
			powerTotalKWh, _ = strconv.ParseFloat(record[19], 64)
			faultCode, _ = strconv.Atoi(record[20])
		}

		_, _ = stmt.Exec(
			parsedTime.Format(time.RFC3339Nano),
			devName, mac, model, battType,
			ratedV, ratedA, soc, battV, battA, battW,
			ctrlTemp, battTemp, chargeStatus,
			pvV, pvA, pvW, loadStatus, loadV, loadA, loadW,
			powerTodayWh, powerTotalKWh, 0, faultCode, 0,
		)
	}

	return tx.Commit()
}

// GetDBStats returns telemetry record count and file size of the SQLite database.
func (s *Storage) GetDBStats() (int64, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var count int64
	if s.db != nil {
		if err := s.db.QueryRow("SELECT COUNT(*) FROM telemetry").Scan(&count); err != nil {
			return 0, 0, err
		}
	}

	var fileSize int64
	if fi, err := os.Stat(s.dbPath); err == nil {
		fileSize = fi.Size()
	}

	return count, fileSize, nil
}

// queryPeakRecord returns the highest voltage and highest solar power records within [start, end].
func (s *Storage) queryPeakRecord(start, end time.Time, referenceTime time.Time) models.PeakRecord {
	var pr models.PeakRecord
	if s.db == nil {
		return pr
	}

	startStr := start.Format(time.RFC3339Nano)
	endStr := end.Format(time.RFC3339Nano)

	// 1. Query max voltage record
	vQuery := `
SELECT timestamp, pv_v, pv_w, battery_v, battery_soc, COALESCE(charging_status, 'MPPT')
FROM telemetry
WHERE timestamp >= ? AND timestamp <= ?
ORDER BY pv_v DESC, timestamp DESC
LIMIT 1`
	var vTsStr, vStatus string
	var vVolts, vWatts, vBattV float64
	var vSoc int
	if err := s.db.QueryRow(vQuery, startStr, endStr).Scan(&vTsStr, &vVolts, &vWatts, &vBattV, &vSoc, &vStatus); err == nil && vVolts > 0 {
		pr.Voltage = vVolts
		if t, err := time.Parse(time.RFC3339Nano, vTsStr); err == nil {
			tLoc := t.In(referenceTime.Location())
			pr.VoltageTime = &tLoc
			pr.VoltageTimeStr = formatRecordTime(tLoc, referenceTime)
		} else if t, err := time.Parse(time.RFC3339, vTsStr); err == nil {
			tLoc := t.In(referenceTime.Location())
			pr.VoltageTime = &tLoc
			pr.VoltageTimeStr = formatRecordTime(tLoc, referenceTime)
		}
		pr.BatterySOC = vSoc
		pr.BatteryVoltage = vBattV
		pr.ChargingStatus = vStatus
	}

	// 2. Query max solar power record
	wQuery := `
SELECT timestamp, pv_v, pv_w, battery_v, battery_soc, COALESCE(charging_status, 'MPPT')
FROM telemetry
WHERE timestamp >= ? AND timestamp <= ?
ORDER BY pv_w DESC, timestamp DESC
LIMIT 1`
	var wTsStr, wStatus string
	var wVolts, wWatts, wBattV float64
	var wSoc int
	if err := s.db.QueryRow(wQuery, startStr, endStr).Scan(&wTsStr, &wVolts, &wWatts, &wBattV, &wSoc, &wStatus); err == nil && wWatts > 0 {
		pr.SolarPowerW = int(wWatts)
		if t, err := time.Parse(time.RFC3339Nano, wTsStr); err == nil {
			tLoc := t.In(referenceTime.Location())
			pr.SolarPowerTime = &tLoc
			pr.SolarPowerTimeStr = formatRecordTime(tLoc, referenceTime)
		} else if t, err := time.Parse(time.RFC3339, wTsStr); err == nil {
			tLoc := t.In(referenceTime.Location())
			pr.SolarPowerTime = &tLoc
			pr.SolarPowerTimeStr = formatRecordTime(tLoc, referenceTime)
		}
		if pr.ChargingStatus == "" {
			pr.ChargingStatus = wStatus
		}
		if pr.BatterySOC == 0 {
			pr.BatterySOC = wSoc
		}
		if pr.BatteryVoltage == 0 {
			pr.BatteryVoltage = wBattV
		}
	}

	return pr
}

// formatRecordTime formats a record timestamp into a friendly, human-readable string.
func formatRecordTime(t time.Time, referenceTime time.Time) string {
	if t.IsZero() {
		return ""
	}
	tInLoc := t.In(referenceTime.Location())
	refInLoc := referenceTime.In(referenceTime.Location())

	y1, m1, d1 := tInLoc.Date()
	y2, m2, d2 := refInLoc.Date()

	if y1 == y2 && m1 == m2 && d1 == d2 {
		return fmt.Sprintf("Today at %s", tInLoc.Format("3:04 PM"))
	}
	yesterday := refInLoc.AddDate(0, 0, -1)
	yY, mY, dY := yesterday.Date()
	if y1 == yY && m1 == mY && d1 == dY {
		return fmt.Sprintf("Yesterday at %s", tInLoc.Format("3:04 PM"))
	}
	if refInLoc.Sub(tInLoc) < 7*24*time.Hour && refInLoc.Sub(tInLoc) >= 0 {
		return tInLoc.Format("Mon, Jan 02 at 3:04 PM")
	}
	return tInLoc.Format("Jan 02, 2006 at 3:04 PM")
}

