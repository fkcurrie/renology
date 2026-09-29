package models

import "time"

// HistoryPoint24h represents a downsampled time-series point for the 24-hour solar power chart.
type HistoryPoint24h struct {
	Timestamp      time.Time `json:"timestamp"`
	TimeLabel      string    `json:"time_label"`        // e.g. "08:15"
	SolarPowerW    int       `json:"solar_power_w"`     // Solar Watts actually drawn
	BatteryPowerW  int       `json:"battery_power_w"`   // Battery Routing Watts (Vbat * Ibat)
	PVVoltage      float64   `json:"pv_voltage_v"`      // Solar Panel Voltage
	BatterySOC     int       `json:"battery_soc"`       // Battery State of Charge %
	BatteryVoltage float64   `json:"battery_voltage_v"` // Battery Voltage
}

// DailySummary7d represents a daily solar production record for the 7-day history chart.
type DailySummary7d struct {
	Date           string  `json:"date"`            // "2026-09-27"
	DayLabel       string  `json:"day_label"`       // e.g. "Mon", "Tue", "Today"
	PeakSolarWatts int     `json:"peak_solar_w"`    // Peak solar generation (Watts)
	EnergyWh       int     `json:"energy_wh"`       // Total daily energy generated (Wh)
	EnergyKWh      float64 `json:"energy_kwh"`      // Total daily energy generated (kWh)
	AvgBatterySOC  int     `json:"avg_battery_soc"` // Average battery SOC %
}

// DailySummaryRecord represents a daily solar production record across multiple timespans.
type DailySummaryRecord struct {
	Date           string  `json:"date"`            // "2026-09-27"
	DayLabel       string  `json:"day_label"`       // e.g. "Mon", "Sep 27"
	PeakSolarWatts int     `json:"peak_solar_w"`    // Peak solar generation (Watts)
	EnergyWh       int     `json:"energy_wh"`       // Total daily energy generated (Wh)
	EnergyKWh      float64 `json:"energy_kwh"`      // Total daily energy generated (kWh)
	AvgBatterySOC  int     `json:"avg_battery_soc"` // Average battery SOC %
	MaxPVVoltage   float64 `json:"max_pv_v"`        // Max solar volts recorded
}

// MonthlySummaryRecord represents an aggregated monthly production record for the 1-year view.
type MonthlySummaryRecord struct {
	MonthKey       string  `json:"month_key"`       // "2026-09"
	MonthLabel     string  `json:"month_label"`     // e.g. "Sep 2026"
	TotalEnergyWh  int     `json:"total_energy_wh"` // Total generation in month (Wh)
	TotalEnergyKWh float64 `json:"total_energy_kwh"`// Total generation in month (kWh)
	PeakWatts      int     `json:"peak_watts"`      // Peak power observed in month (Watts)
	DaysCounted    int     `json:"days_counted"`    // Number of days in month
	DailyAvgWh     int     `json:"daily_avg_wh"`    // Daily average generation in Wh
}

// HistoryResponse encapsulates both 24-hour and multi-timespan historical telemetry data.
type HistoryResponse struct {
	Points24h []HistoryPoint24h      `json:"points_24h"`
	Days7d    []DailySummary7d       `json:"days_7d"`
	Days30d   []DailySummaryRecord   `json:"days_30d"`
	Days90d   []DailySummaryRecord   `json:"days_90d"`
	Days180d  []DailySummaryRecord   `json:"days_180d"`
	Days365d  []DailySummaryRecord   `json:"days_365d"`
	Months12m []MonthlySummaryRecord `json:"months_12m"`
}

// RecentMinutePoint represents an aggregated 1-minute point in a recent telemetry report.
type RecentMinutePoint struct {
	Timestamp      time.Time `json:"timestamp"`
	TimeLabel      string    `json:"time_label"`        // e.g. "11:45"
	PVVoltage      float64   `json:"pv_voltage_v"`      // Average Solar Panel Voltage
	SolarPowerW    int       `json:"solar_power_w"`     // Average Solar Power (Watts)
	PeakSolarW     int       `json:"peak_solar_w"`      // Peak Solar Power in minute
	BatterySOC     int       `json:"battery_soc"`       // Battery SOC %
	BatteryVoltage float64   `json:"battery_voltage_v"`  // Battery Voltage
	BatteryCurrent float64   `json:"battery_current_a"`  // Net Battery Current
	TodayYieldWh   int       `json:"today_yield_wh"`    // Today's cumulative generation
	Mode           string    `json:"mode"`              // e.g. "Float / Standby", "Active MPPT"
}

// RecentHistoryResponse represents telemetry data and aggregates for a recent time window (e.g. last 60 minutes).
type RecentHistoryResponse struct {
	WindowMinutes  int                 `json:"window_minutes"`
	StartTime      time.Time           `json:"start_time"`
	EndTime        time.Time           `json:"end_time"`
	TotalSamples   int                 `json:"total_samples"`
	BatterySOC     int                 `json:"battery_soc"`
	AvgBatteryV    float64             `json:"avg_battery_v"`
	AvgPVVoltage   float64             `json:"avg_pv_v"`
	MinPVVoltage   float64             `json:"min_pv_v"`
	MaxPVVoltage   float64             `json:"max_pv_v"`
	AvgSolarWatts  float64             `json:"avg_solar_w"`
	PeakSolarWatts int                 `json:"peak_solar_w"`
	TodayYieldWh   int                 `json:"today_yield_wh"`
	StatusSummary  string              `json:"status_summary"`
	MinutePoints   []RecentMinutePoint `json:"minute_points"`
}

