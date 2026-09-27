package renogy

import (
	"encoding/binary"
	"testing"
	"time"

	"renology/models"
	"renology/modbus"
)

func TestParseDeviceInfo(t *testing.T) {
	// Frame: [dev_id, 3, 16, "ROVER40A        ", crc_lo, crc_hi]
	data := []byte{0xFF, 0x03, 16}
	modelStr := []byte("RNG-CTRL-RVR40  ")
	data = append(data, modelStr...)
	lo, hi := modbus.CRC16Modbus(data)
	data = append(data, lo, hi)

	model, err := ParseDeviceInfo(data)
	if err != nil {
		t.Fatalf("ParseDeviceInfo error: %v", err)
	}
	if model != "RNG-CTRL-RVR40" {
		t.Fatalf("Model mismatch. Expected RNG-CTRL-RVR40, got '%s'", model)
	}
}

func TestParseControllerTelemetry(t *testing.T) {
	// Build a valid 73-byte controller response payload
	payload := make([]byte, 73)
	payload[0] = 0xFF // Device ID
	payload[1] = 0x03 // Read Holding Registers
	payload[2] = 68   // Byte count

	// Battery SOC = 95%
	binary.BigEndian.PutUint16(payload[3:5], 95)
	// Battery Voltage = 13.6V (136 * 0.1)
	binary.BigEndian.PutUint16(payload[5:7], 136)
	// Battery Current = 15.42A (1542 * 0.01)
	binary.BigEndian.PutUint16(payload[7:9], 1542)
	// Controller Temp = 28 C, Battery Temp = 22 C
	payload[9] = 28
	payload[10] = 22
	// PV Voltage = 36.2V (362 * 0.1)
	binary.BigEndian.PutUint16(payload[17:19], 362)
	// PV Current = 5.80A (580 * 0.01)
	binary.BigEndian.PutUint16(payload[19:21], 580)
	// PV Power = 210W
	binary.BigEndian.PutUint16(payload[21:23], 210)
	// Charging status: 2 = MPPT
	payload[68] = 2

	var telem models.Telemetry
	telem.Timestamp = time.Now()
	err := ParseControllerTelemetry(payload, &telem)
	if err != nil {
		t.Fatalf("ParseControllerTelemetry error: %v", err)
	}

	if telem.BatterySOC != 95 {
		t.Errorf("Expected SOC 95, got %d", telem.BatterySOC)
	}
	if telem.BatteryVoltage != 13.6 {
		t.Errorf("Expected Voltage 13.6, got %f", telem.BatteryVoltage)
	}
	if telem.BatteryCurrent != 15.42 {
		t.Errorf("Expected Current 15.42, got %f", telem.BatteryCurrent)
	}
	if telem.ControllerTemperatureC != 28 {
		t.Errorf("Expected Controller Temp 28, got %d", telem.ControllerTemperatureC)
	}
	if telem.BatteryTemperatureC != 22 {
		t.Errorf("Expected Battery Temp 22, got %d", telem.BatteryTemperatureC)
	}
	if telem.PVVoltage != 36.2 {
		t.Errorf("Expected PV Voltage 36.2, got %f", telem.PVVoltage)
	}
	if telem.PVPower != 210 {
		t.Errorf("Expected PV Power 210, got %d", telem.PVPower)
	}
	if telem.ChargingStatus != "MPPT" {
		t.Errorf("Expected ChargingStatus MPPT, got %s", telem.ChargingStatus)
	}
}
