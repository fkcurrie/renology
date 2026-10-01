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

func TestParseSystemRatings(t *testing.T) {
	// Frame for 12V system, 40A controller: [0xFF, 0x03, 0x02, 12, 40, crc_lo, crc_hi]
	data := []byte{0xFF, 0x03, 0x02, 12, 40}
	lo, hi := modbus.CRC16Modbus(data)
	data = append(data, lo, hi)

	voltage, current, err := ParseSystemRatings(data)
	if err != nil {
		t.Fatalf("ParseSystemRatings error: %v", err)
	}
	if voltage != 12 {
		t.Errorf("Expected voltage 12V, got %dV", voltage)
	}
	if current != 40 {
		t.Errorf("Expected current 40A, got %dA", current)
	}
}

func TestParseBatteryType(t *testing.T) {
	// Reg 0xE004: 4 = Lithium (LFP)
	data := []byte{0xFF, 0x03, 0x02, 0x00, 0x04}
	lo, hi := modbus.CRC16Modbus(data)
	data = append(data, lo, hi)

	var telem models.Telemetry
	err := ParseBatteryType(data, &telem)
	if err != nil {
		t.Fatalf("ParseBatteryType error: %v", err)
	}
	if telem.BatteryType != "Lithium (LFP)" {
		t.Errorf("Expected 'Lithium (LFP)', got '%s'", telem.BatteryType)
	}
}

func TestParseControllerTelemetry75Bytes(t *testing.T) {
	// Build a valid 75-byte controller response payload (35 words = 70 bytes data)
	payload := make([]byte, 75)
	payload[0] = 0xFF // Device ID
	payload[1] = 0x03 // Read Holding Registers
	payload[2] = 70   // Byte count (35 registers * 2)

	// Battery SOC = 98%
	binary.BigEndian.PutUint16(payload[3:5], 98)
	// Battery Voltage = 13.6V (136 * 0.1)
	binary.BigEndian.PutUint16(payload[5:7], 136)
	// Battery Current = 15.5A (1550 * 0.01)
	binary.BigEndian.PutUint16(payload[7:9], 1550)
	// Controller Temp = 28 C, Battery Temp = 22 C
	payload[9] = 28
	payload[10] = 22
	// PV Voltage = 36.2V (362 * 0.1)
	binary.BigEndian.PutUint16(payload[17:19], 362)
	// PV Current = 5.80A (580 * 0.01)
	binary.BigEndian.PutUint16(payload[19:21], 580)
	// PV Power = 210W
	binary.BigEndian.PutUint16(payload[21:23], 210)
	// Power Gen Today = 484 Wh
	binary.BigEndian.PutUint16(payload[41:43], 484)
	// Charging status: 2 = MPPT
	payload[68] = 2

	// Fault code in Registers 0x0121 & 0x0122 (offsets 69-72):
	// Bit 1 = Battery Over-Voltage (0x00000002)
	binary.BigEndian.PutUint32(payload[69:73], 0x00000002)

	// CRC at bytes 73 and 74
	lo, hi := modbus.CRC16Modbus(payload[:73])
	payload[73] = lo
	payload[74] = hi

	var telem models.Telemetry
	telem.Timestamp = time.Now()
	err := ParseControllerTelemetry(payload, &telem)
	if err != nil {
		t.Fatalf("ParseControllerTelemetry error: %v", err)
	}

	if telem.BatterySOC != 98 {
		t.Errorf("Expected SOC 98, got %d", telem.BatterySOC)
	}
	if telem.BatteryVoltage != 13.6 {
		t.Errorf("Expected Voltage 13.6, got %f", telem.BatteryVoltage)
	}
	if telem.BatteryCurrent != 15.5 {
		t.Errorf("Expected Current 15.5, got %f", telem.BatteryCurrent)
	}
	if telem.PVPower != 210 {
		t.Errorf("Expected PV Power 210, got %d", telem.PVPower)
	}
	if telem.ChargingStatus != "MPPT" {
		t.Errorf("Expected ChargingStatus MPPT, got %s", telem.ChargingStatus)
	}
	if telem.FaultCode != 2 {
		t.Errorf("Expected FaultCode 2, got %d", telem.FaultCode)
	}
	if len(telem.FaultDescriptions) != 1 || telem.FaultDescriptions[0] != "Battery Over-Voltage" {
		t.Errorf("Expected 'Battery Over-Voltage', got %v", telem.FaultDescriptions)
	}
}

func TestParseControllerTelemetry34Words(t *testing.T) {
	// Build a valid 73-byte controller response payload (34 words = 68 bytes data)
	payload := make([]byte, 73)
	payload[0] = 0xFF // Device ID
	payload[1] = 0x03 // Read Holding Registers
	payload[2] = 68   // Byte count

	binary.BigEndian.PutUint16(payload[3:5], 95)
	binary.BigEndian.PutUint16(payload[5:7], 136)
	binary.BigEndian.PutUint16(payload[7:9], 1542)
	payload[9] = 28
	payload[10] = 22
	binary.BigEndian.PutUint16(payload[17:19], 362)
	binary.BigEndian.PutUint16(payload[19:21], 580)
	binary.BigEndian.PutUint16(payload[21:23], 210)
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
	if telem.ChargingStatus != "MPPT" {
		t.Errorf("Expected ChargingStatus MPPT, got %s", telem.ChargingStatus)
	}
}

func TestParserValidationEdgeCases(t *testing.T) {
	// 1. ParseDeviceInfo with bad function code
	badFunc := []byte{0xFF, 0x01, 16, 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 0x00, 0x00}
	if _, err := ParseDeviceInfo(badFunc); err == nil {
		t.Errorf("Expected error for bad function code in ParseDeviceInfo, got nil")
	}

	// 2. ParseDeviceInfo with truncated frame
	shortInfo := []byte{0xFF, 0x03, 16, 'A', 'B'}
	if _, err := ParseDeviceInfo(shortInfo); err == nil {
		t.Errorf("Expected error for truncated ParseDeviceInfo, got nil")
	}

	// 3. ParseSystemRatings with bad function code
	badRatingsFunc := []byte{0xFF, 0x04, 0x02, 12, 40, 0x00, 0x00}
	if _, _, err := ParseSystemRatings(badRatingsFunc); err == nil {
		t.Errorf("Expected error for bad function code in ParseSystemRatings, got nil")
	}

	// 4. ParseControllerTelemetry with truncated frame
	var telem models.Telemetry
	shortTelem := make([]byte, 50)
	shortTelem[0] = 0xFF
	shortTelem[1] = 0x03
	shortTelem[2] = 70
	if err := ParseControllerTelemetry(shortTelem, &telem); err == nil {
		t.Errorf("Expected error for truncated controller telemetry frame, got nil")
	}

	// 5. ParseControllerTelemetry with bad function code
	badTelemFunc := make([]byte, 75)
	badTelemFunc[0] = 0xFF
	badTelemFunc[1] = 0x83 // Exception code
	badTelemFunc[2] = 70
	if err := ParseControllerTelemetry(badTelemFunc, &telem); err == nil {
		t.Errorf("Expected error for exception function code in ParseControllerTelemetry, got nil")
	}

	// 6. Unknown battery type
	unkBatt := []byte{0xFF, 0x03, 0x02, 0x00, 0x99, 0x00, 0x00}
	if err := ParseBatteryType(unkBatt, &telem); err != nil {
		t.Fatalf("ParseBatteryType failed on unknown type: %v", err)
	}
	if telem.BatteryType != "Type 153" {
		t.Errorf("Expected 'Type 153', got '%s'", telem.BatteryType)
	}

	// 7. DecodeFaultCode multi-bit check
	faults := DecodeFaultCode(0x00000005) // Bit 0 (Battery Over-Discharge) and Bit 2 (Battery Under-Voltage Warning)
	if len(faults) != 2 {
		t.Fatalf("Expected 2 fault descriptions, got %d (%v)", len(faults), faults)
	}
}
