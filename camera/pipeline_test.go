package camera

import (
	"bytes"
	"context"
	"encoding/binary"
	"testing"
	"time"
)

func TestBuildGStreamerArgs(t *testing.T) {
	cfg := PipelineConfig{
		Width:       1280,
		Height:      720,
		Framerate:   30,
		VideoSource: SourceTest,
	}

	p := NewPipeline(cfg)
	args := p.BuildGStreamerArgs()

	if len(args) == 0 {
		t.Fatalf("expected non-empty args")
	}

	if args[0] != "-q" || args[1] != "-e" {
		t.Errorf("expected args to start with -q -e, got %v", args[:2])
	}

	foundMux := false
	foundVAAPI := false
	for _, arg := range args {
		if arg == "vaapih264enc" {
			foundVAAPI = true
		}
		if arg == "mp4mux" {
			foundMux = true
		}
	}

	if !foundVAAPI {
		t.Errorf("expected vaapih264enc in args: %v", args)
	}
	if !foundMux {
		t.Errorf("expected mp4mux in args: %v", args)
	}
}

func TestExtractFMP4Init(t *testing.T) {
	// Synthesize a fake ftyp box (16 bytes)
	ftyp := make([]byte, 16)
	binary.BigEndian.PutUint32(ftyp[0:4], 16)
	copy(ftyp[4:8], "ftyp")
	copy(ftyp[8:12], "isom")

	// Synthesize a fake moov box (24 bytes)
	moov := make([]byte, 24)
	binary.BigEndian.PutUint32(moov[0:4], 24)
	copy(moov[4:8], "moov")

	// Synthesize a fake moof box (20 bytes)
	moof := make([]byte, 20)
	binary.BigEndian.PutUint32(moof[0:4], 20)
	copy(moof[4:8], "moof")

	var stream bytes.Buffer
	stream.Write(ftyp)
	stream.Write(moov)
	stream.Write(moof)

	initData, found := extractFMP4Init(stream.Bytes())
	if !found {
		t.Fatalf("failed to extract init box from synthetic fMP4 stream")
	}

	expectedLen := len(ftyp) + len(moov)
	if len(initData) != expectedLen {
		t.Errorf("expected init data len %d, got %d", expectedLen, len(initData))
	}
}

func TestRelayViewerLifecycle(t *testing.T) {
	relay := NewRelay()
	relay.gracePeriod = 50 * time.Millisecond

	status := relay.GetStatus()
	if status.Viewers != 0 {
		t.Errorf("expected 0 viewers initially, got %d", status.Viewers)
	}

	// Register 1st viewer
	sub1, _ := relay.RegisterViewer()
	status = relay.GetStatus()
	if status.Viewers != 1 {
		t.Errorf("expected 1 viewer, got %d", status.Viewers)
	}

	// WaitForStreamRequest should return true immediately
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if !relay.WaitForStreamRequest(ctx, 50*time.Millisecond) {
		t.Errorf("expected WaitForStreamRequest to succeed when viewer is active")
	}

	// Register 2nd viewer
	sub2, _ := relay.RegisterViewer()
	status = relay.GetStatus()
	if status.Viewers != 2 {
		t.Errorf("expected 2 viewers, got %d", status.Viewers)
	}

	// Unregister 1st viewer
	relay.UnregisterViewer(sub1)
	status = relay.GetStatus()
	if status.Viewers != 1 {
		t.Errorf("expected 1 viewer after 1 unregisters, got %d", status.Viewers)
	}

	// Unregister 2nd viewer
	relay.UnregisterViewer(sub2)
	status = relay.GetStatus()
	if status.Viewers != 0 {
		t.Errorf("expected 0 viewers, got %d", status.Viewers)
	}
}
