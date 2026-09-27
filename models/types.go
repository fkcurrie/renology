package models

import "time"

// ChargingStatusText maps Renogy charging status code to human readable text.
var ChargingStatusText = map[byte]string{
	0: "Deactivated",
	1: "Activated",
	2: "MPPT",
	3: "Equalizing",
	4: "Boost",
	5: "Floating",
	6: "Current Limiting",
	8: "Alternator Direct",
}

// BatteryTypeText maps battery type code to human readable text.
var BatteryTypeText = map[uint16]string{
	1: "Open (Flooded)",
	2: "Sealed (AGM)",
	3: "Gel",
	4: "Lithium (LFP)",
	5: "Custom",
}

// Telemetry represents a decoded snapshot of Renogy device data.
type Telemetry struct {
	Timestamp               time.Time `json:"timestamp"`
	MACAddress              string    `json:"mac_address"`
	DeviceName              string    `json:"device_name"`
	Model                   string    `json:"model,omitempty"`
	DeviceID                byte      `json:"device_id"`
	DeviceType              string    `json:"device_type"`
	RSSI                    int       `json:"rssi,omitempty"`

	// Real-time metrics
	BatterySOC              int       `json:"battery_soc_percent"`     // % (0-100)
	BatteryVoltage          float64   `json:"battery_voltage_v"`       // Volts
	BatteryCurrent          float64   `json:"battery_current_a"`       // Amps
	BatteryPower            float64   `json:"battery_power_w"`         // Calculated Watts
	ControllerTemperatureC  int       `json:"controller_temp_c"`       // °C
	BatteryTemperatureC     int       `json:"battery_temp_c"`          // °C
	ChargingStatus          string    `json:"charging_status"`         // e.g. "MPPT", "Floating", etc.
	BatteryType             string    `json:"battery_type,omitempty"`  // e.g. "Lithium (LFP)"
	RatedVoltageVolts       int       `json:"rated_voltage_v,omitempty"`
	RatedCurrentAmps        int       `json:"rated_current_a,omitempty"`

	// Solar PV metrics
	PVVoltage               float64   `json:"pv_voltage_v"`            // Volts
	PVCurrent               float64   `json:"pv_current_a"`            // Amps
	PVPower                 int       `json:"pv_power_w"`              // Watts

	// Load metrics
	LoadStatus              string    `json:"load_status"`             // "On" / "Off"
	LoadVoltage             float64   `json:"load_voltage_v"`          // Volts
	LoadCurrent             float64   `json:"load_current_a"`          // Amps
	LoadPower               int       `json:"load_power_w"`            // Watts

	// Historical & Daily Stats
	MaxChargingPowerToday   int       `json:"max_charging_power_today_w"`
	MaxDischargingPowerToday int      `json:"max_discharging_power_today_w"`
	ChargingAmpHoursToday   int       `json:"charging_ah_today"`
	DischargingAmpHoursToday int      `json:"discharging_ah_today"`
	PowerGenerationTodayWh  int       `json:"power_generation_today_wh"`
	PowerConsumptionTodayWh int       `json:"power_consumption_today_wh"`
	PowerGenerationTotalKWh float64   `json:"power_generation_total_kwh"`

	// Alternator / DC Charger specific
	AlternatorVoltage       float64   `json:"alternator_voltage_v,omitempty"`
	AlternatorCurrent       float64   `json:"alternator_current_a,omitempty"`
	AlternatorPower         int       `json:"alternator_power_w,omitempty"`

	// Faults & Alarms
	FaultCode               uint32    `json:"fault_code"`
	FaultDescriptions       []string  `json:"fault_descriptions,omitempty"`
}
