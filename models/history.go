package models

import "time"

// HistoryPoint24h represents a downsampled time-series point for the 24-hour solar power chart.
type HistoryPoint24h struct {
	Timestamp      time.Time `json:"timestamp"`
	TimeLabel      string    `json:"time_label"`       // e.g. "08:15"
	SolarPowerW    int       `json:"solar_power_w"`    // Solar Watts
	PVVoltage      float64   `json:"pv_voltage_v"`     // Panel Voltage
	BatterySOC     int       `json:"battery_soc"`      // Battery State of Charge %
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

// HistoryResponse encapsulates both 24-hour and 7-day historical telemetry data.
type HistoryResponse struct {
	Points24h []HistoryPoint24h `json:"points_24h"`
	Days7d    []DailySummary7d  `json:"days_7d"`
}
