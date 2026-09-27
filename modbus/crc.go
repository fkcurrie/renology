package modbus

// CRC16Modbus calculates the Modbus RTU CRC-16 checksum (polynomial 0xA001, initial 0xFFFF).
// It returns the CRC as two bytes in Little-Endian order: [lowByte, highByte].
func CRC16Modbus(data []byte) (byte, byte) {
	var crc uint16 = 0xFFFF
	for _, b := range data {
		crc ^= uint16(b)
		for i := 0; i < 8; i++ {
			if (crc & 0x0001) != 0 {
				crc = (crc >> 1) ^ 0xA001
			} else {
				crc >>= 1
			}
		}
	}
	// Modbus RTU transmits CRC low byte first, then high byte
	return byte(crc & 0xFF), byte((crc >> 8) & 0xFF)
}

// BuildReadRequest builds a Modbus RTU Read Holding Registers (function 0x03) frame.
func BuildReadRequest(deviceID byte, startRegister uint16, numRegisters uint16) []byte {
	buf := make([]byte, 6, 8)
	buf[0] = deviceID
	buf[1] = 0x03 // Read Holding Registers
	buf[2] = byte((startRegister >> 8) & 0xFF)
	buf[3] = byte(startRegister & 0xFF)
	buf[4] = byte((numRegisters >> 8) & 0xFF)
	buf[5] = byte(numRegisters & 0xFF)

	crcLow, crcHigh := CRC16Modbus(buf)
	buf = append(buf, crcLow, crcHigh)
	return buf
}

// ValidateCRC verifies whether a Modbus RTU frame ends with a valid CRC16.
func ValidateCRC(frame []byte) bool {
	if len(frame) < 4 {
		return false
	}
	dataLen := len(frame) - 2
	expectedLow, expectedHigh := CRC16Modbus(frame[:dataLen])
	return frame[dataLen] == expectedLow && frame[dataLen+1] == expectedHigh
}
