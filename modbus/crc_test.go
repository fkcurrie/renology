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
