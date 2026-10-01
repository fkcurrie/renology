package modbus

import (
	"bytes"
	"testing"
)

func TestBuildReadRequest(t *testing.T) {
	// Standard Renogy live operational data request (Register 256, 34 words)
	// Expected from verified Renogy BT trace: [255, 3, 1, 0, 0, 34, 209, 241]
	req := BuildReadRequest(0xFF, 256, 34)
	expected := []byte{255, 3, 1, 0, 0, 34, 209, 241}

	if !bytes.Equal(req, expected) {
		t.Fatalf("BuildReadRequest mismatch. Got %v, expected %v", req, expected)
	}

	if !ValidateCRC(req) {
		t.Fatalf("ValidateCRC failed on generated frame")
	}
}

func TestBuildReadRequestDeviceInfo(t *testing.T) {
	// Device info request (Register 12, 8 words)
	req := BuildReadRequest(0xFF, 12, 8)
	if !ValidateCRC(req) {
		t.Fatalf("ValidateCRC failed on device info request")
	}
}

func TestValidateCRCEdgeCases(t *testing.T) {
	// 1. Empty and short frames
	if ValidateCRC(nil) {
		t.Errorf("ValidateCRC(nil) expected false, got true")
	}
	if ValidateCRC([]byte{}) {
		t.Errorf("ValidateCRC([]) expected false, got true")
	}
	if ValidateCRC([]byte{0xFF, 0x03, 0x00, 0x0A}) {
		t.Errorf("ValidateCRC(4 bytes) expected false, got true")
	}

	// 2. Corrupted CRC
	corrupt := []byte{255, 3, 1, 0, 0, 34, 0x00, 0x00}
	if ValidateCRC(corrupt) {
		t.Errorf("ValidateCRC on corrupt frame expected false, got true")
	}

	// 3. Known Renogy telemetry response tail (valid CRC)
	validFrame := []byte{
		0xFF, 0x03, 0x46,
		0x00, 0x64, 0x05, 0x28, 0x00, 0x00, 0x00, 0x18,
		0x00, 0x1A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00,
	}
	lo, hi := CRC16Modbus(validFrame)
	validFrame = append(validFrame, lo, hi)

	if !ValidateCRC(validFrame) {
		t.Errorf("ValidateCRC on dynamically calculated frame expected true, got false")
	}
}
