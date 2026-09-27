package renogy

import (
	"encoding/binary"
	"fmt"
	"strings"

	"renology/models"
)

// ParseTemperature decodes a signed 8-bit temperature byte.
func ParseTemperature(raw byte) int {
	if (raw & 0x80) != 0 {
		return -int(raw & 0x7F)
	}
	return int(raw)
}

// ParseDeviceInfo parses registers 0x000C-0x0013 (model string).
func ParseDeviceInfo(payload []byte) (string, error) {
	// Standard Modbus response: [dev_id, func(3), byte_count, data..., crc_lo, crc_hi]
	if len(payload) < 5 {
		return "", fmt.Errorf("payload too short for device info: %d bytes", len(payload))
	}
	byteCount := int(payload[2])
	if len(payload) < 3+byteCount {
		return "", fmt.Errorf("incomplete payload: expected %d bytes, got %d", 3+byteCount, len(payload))
	}
	modelBytes := payload[3 : 3+byteCount]
	model := strings.TrimRight(string(modelBytes), "\x00 ")
	return model, nil
}

// ParseSystemRatings parses register 0x000A (rated system voltage & charging current).
func ParseSystemRatings(payload []byte) (int, int, error) {
	if len(payload) < 7 {
		return 0, 0, fmt.Errorf("payload too short for ratings: %d bytes", len(payload))
	}
	if payload[1] != 0x03 {
		return 0, 0, fmt.Errorf("unexpected function code: 0x%02X", payload[1])
	}
	ratedVoltage := int(payload[3])
	ratedCurrent := int(payload[4])
	return ratedVoltage, ratedCurrent, nil
}

// ParseControllerTelemetry parses registers starting from 0x0100 (34 or 35 words).
func ParseControllerTelemetry(payload []byte, t *models.Telemetry) error {
	if len(payload) < 73 {
		return fmt.Errorf("payload too short for controller telemetry: %d bytes (expected >= 73)", len(payload))
	}
	if payload[1] != 0x03 {
		return fmt.Errorf("unexpected function code: 0x%02X", payload[1])
	}
	byteCount := int(payload[2])
	if byteCount < 68 {
		return fmt.Errorf("unexpected byte count: %d (expected >= 68)", byteCount)
	}

	t.DeviceType = "Solar Charge Controller"
	t.DeviceID = payload[0]

	// Offset 3: Battery SOC (2 bytes)
	t.BatterySOC = int(binary.BigEndian.Uint16(payload[3:5]))

	// Offset 5: Battery Voltage (0.1 V)
	t.BatteryVoltage = float64(binary.BigEndian.Uint16(payload[5:7])) * 0.1
	t.BatteryVoltage = float64(int(t.BatteryVoltage*10+0.5)) / 10.0

	// Offset 7: Battery Charging Current (0.01 A)
	t.BatteryCurrent = float64(binary.BigEndian.Uint16(payload[7:9])) * 0.01
	t.BatteryCurrent = float64(int(t.BatteryCurrent*100+0.5)) / 100.0

	// Battery Power = V * I
	t.BatteryPower = float64(int(t.BatteryVoltage*t.BatteryCurrent*10+0.5)) / 10.0

	// Offset 9: Controller Temp, Offset 10: Battery Temp
	t.ControllerTemperatureC = ParseTemperature(payload[9])
	t.BatteryTemperatureC = ParseTemperature(payload[10])

	// Offset 11: Load Voltage (0.1 V)
	t.LoadVoltage = float64(int(float64(binary.BigEndian.Uint16(payload[11:13]))+0.5)) / 10.0

	// Offset 13: Load Current (0.01 A)
	t.LoadCurrent = float64(int(float64(binary.BigEndian.Uint16(payload[13:15]))+0.5)) / 100.0

	// Offset 15: Load Power (Watts)
	t.LoadPower = int(binary.BigEndian.Uint16(payload[15:17]))

	// Offset 17: PV Voltage (0.1 V)
	t.PVVoltage = float64(int(float64(binary.BigEndian.Uint16(payload[17:19]))+0.5)) / 10.0

	// Offset 19: PV Current (0.01 A)
	t.PVCurrent = float64(int(float64(binary.BigEndian.Uint16(payload[19:21]))+0.5)) / 100.0

	// Offset 21: PV Power (Watts)
	t.PVPower = int(binary.BigEndian.Uint16(payload[21:23]))

	// Offset 33: Max Charging Power Today (Watts)
	t.MaxChargingPowerToday = int(binary.BigEndian.Uint16(payload[33:35]))

	// Offset 35: Max Discharging Power Today (Watts)
	t.MaxDischargingPowerToday = int(binary.BigEndian.Uint16(payload[35:37]))

	// Offset 37: Charging Ah Today
	t.ChargingAmpHoursToday = int(binary.BigEndian.Uint16(payload[37:39]))

	// Offset 39: Discharging Ah Today
	t.DischargingAmpHoursToday = int(binary.BigEndian.Uint16(payload[39:41]))

	// Offset 41: Power Generation Today (Wh)
	t.PowerGenerationTodayWh = int(binary.BigEndian.Uint16(payload[41:43]))

	// Offset 43: Power Consumption Today (Wh)
	t.PowerConsumptionTodayWh = int(binary.BigEndian.Uint16(payload[43:45]))

	// Offset 59: Total Power Generated (kWh, uint32)
	totalKWh := binary.BigEndian.Uint32(payload[59:63])
	t.PowerGenerationTotalKWh = float64(totalKWh)

	// Offset 67: Load Status (bit 7)
	if (payload[67] >> 7) != 0 {
		t.LoadStatus = "On"
	} else {
		t.LoadStatus = "Off"
	}

	// Offset 68: Charging Status
	statusByte := payload[68]
	if status, ok := models.ChargingStatusText[statusByte]; ok {
		t.ChargingStatus = status
	} else {
		t.ChargingStatus = fmt.Sprintf("Unknown (0x%02X)", statusByte)
	}

	// Fault codes: Register 0x0121 (Word 33) and 0x0122 (Word 34)
	if len(payload) >= 75 {
		// Full 35-word query: payload[69:73] contains registers 0x0121 and 0x0122 (4 bytes)
		t.FaultCode = binary.BigEndian.Uint32(payload[69:73])
		t.FaultDescriptions = DecodeFaultCode(t.FaultCode)
	} else if len(payload) >= 73 {
		// Legacy 34-word query: only low 16 bits in payload[69:71] (payload[71:73] is CRC!)
		t.FaultCode = uint32(binary.BigEndian.Uint16(payload[69:71]))
		t.FaultDescriptions = DecodeFaultCode(t.FaultCode)
	}

	return nil
}

// DecodeFaultCode translates Renogy 32-bit fault code flags into descriptive strings.
func DecodeFaultCode(code uint32) []string {
	if code == 0 {
		return nil
	}
	var faults []string
	faultMap := map[uint]string{
		0:  "Battery Over-Discharge",
		1:  "Battery Over-Voltage",
		2:  "Battery Under-Voltage Warning",
		3:  "Load Short Circuit",
		4:  "Load Over-Current",
		5:  "Controller Over-Temperature",
		6:  "Battery Over-Temperature",
		7:  "PV Input Over-Power",
		8:  "PV Input Short Circuit",
		9:  "PV Input Over-Voltage",
		10: "PV Counter-Current",
		11: "PV Reverse Polarity",
		12: "Battery Reverse Polarity",
	}
	for bit, desc := range faultMap {
		if (code & (1 << bit)) != 0 {
			faults = append(faults, desc)
		}
	}
	return faults
}

// ParseBatteryType parses register 0xE004 response (1 word).
func ParseBatteryType(payload []byte, t *models.Telemetry) error {
	if len(payload) < 7 {
		return fmt.Errorf("payload too short for battery type: %d bytes", len(payload))
	}
	rawType := binary.BigEndian.Uint16(payload[3:5])
	if bType, ok := models.BatteryTypeText[rawType]; ok {
		t.BatteryType = bType
	} else {
		t.BatteryType = fmt.Sprintf("Type %d", rawType)
	}
	return nil
}
