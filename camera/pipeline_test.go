package camera

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
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

func TestPipelineSetVideoSource(t *testing.T) {
	p := NewPipeline(PipelineConfig{
		Width:       1280,
		Height:      720,
		Framerate:   30,
		VideoSource: SourceTest,
	})

	if p.GetVideoSource() != SourceTest {
		t.Errorf("expected initial source SourceTest, got %v", p.GetVideoSource())
	}

	// Switch to SourceLibcamera dynamically
	p.SetVideoSource(SourceLibcamera)
	if p.GetVideoSource() != SourceLibcamera {
		t.Errorf("expected switched source SourceLibcamera, got %v", p.GetVideoSource())
	}

	args := p.BuildGStreamerArgs()
	foundLibcamera := false
	for _, a := range args {
		if a == "libcamerasrc" {
			foundLibcamera = true
			break
		}
	}
	if !foundLibcamera {
		t.Errorf("expected libcamerasrc in args after switching to SourceLibcamera: %v", args)
	}
}

func TestDetectAvailableSource(t *testing.T) {
	src := DetectAvailableSource()
	if src != SourceLibcamera && src != SourceV4L2 && src != SourceTest {
		t.Errorf("unexpected VideoSourceType returned: %v", src)
	}
}

func makeBox(boxType string, payload []byte) []byte {
	size := len(payload) + 8
	buf := make([]byte, size)
	binary.BigEndian.PutUint32(buf[0:4], uint32(size))
	copy(buf[4:8], boxType)
	copy(buf[8:], payload)
	return buf
}

func TestRelayBoxAlignedIngress(t *testing.T) {
	relay := NewRelay()
	relay.gracePeriod = 100 * time.Millisecond

	// Prepare synthetic boxes
	ftyp := makeBox("ftyp", []byte("isom0001"))
	moov := makeBox("moov", []byte("fake_moov_metadata"))
	moof := makeBox("moof", []byte("fake_fragment_header"))
	mdat := makeBox("mdat", []byte("fake_media_payload_sample_data"))

	pr, pw := io.Pipe()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ingressErr := make(chan error, 1)
	go func() {
		ingressErr <- relay.HandleIngress(ctx, pr)
	}()

	// 1. Write ftyp and moov
	_, _ = pw.Write(ftyp)
	_, _ = pw.Write(moov)

	time.Sleep(20 * time.Millisecond)

	// 2. Register viewer mid-stream
	sub, initBurst := relay.RegisterViewer()
	if len(initBurst) == 0 {
		t.Fatalf("expected non-empty initBurst, got 0 bytes")
	}

	expectedInitLen := len(ftyp) + len(moov)
	if len(initBurst) < expectedInitLen {
		t.Fatalf("expected at least %d bytes in initBurst, got %d", expectedInitLen, len(initBurst))
	}

	// 3. Write fragment 1
	_, _ = pw.Write(moof)
	_, _ = pw.Write(mdat)

	select {
	case frag := <-sub:
		expectedFragLen := len(moof) + len(mdat)
		if len(frag) != expectedFragLen {
			t.Errorf("expected fragment len %d, got %d", expectedFragLen, len(frag))
		}
		// Verify box headers
		boxType := string(frag[4:8])
		if boxType != "moof" {
			t.Errorf("expected fragment to start with moof, got %s", boxType)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatalf("timed out waiting for complete fragment on subscriber channel")
	}

	pw.Close()
	cancel()
}

func TestRingBufferPreRoll(t *testing.T) {
	relay := NewRelay()
	relay.initSegment = []byte("fake_init_ftyp_moov")
	relay.hasInit = true

	now := time.Now()
	relay.ringBuffer = []ringFragment{
		{timestamp: now.Add(-40 * time.Second), data: []byte("frag_40s_ago")},
		{timestamp: now.Add(-20 * time.Second), data: []byte("frag_20s_ago")},
		{timestamp: now.Add(-5 * time.Second), data: []byte("frag_5s_ago")},
	}

	// Request 25 seconds of pre-roll (should get 20s and 5s fragments)
	preRoll, actualDuration := relay.GetPreRoll(25 * time.Second)
	if len(preRoll) == 0 {
		t.Fatalf("expected non-empty preRoll")
	}

	expectedPrefix := "fake_init_ftyp_moov"
	if string(preRoll[:len(expectedPrefix)]) != expectedPrefix {
		t.Errorf("preRoll must start with initSegment")
	}

	if actualDuration <= 0 {
		t.Errorf("expected positive actualDuration, got %f", actualDuration)
	}
}

func TestEventStoreSaveAndList(t *testing.T) {
	tmpDir := t.TempDir()
	store := NewEventStore(tmpDir)

	evt := CameraEvent{
		TriggerType: "sound",
		Title:       "Test Sound Spike",
		DurationSec: 25.0,
		PreRollSec:  20.0,
	}

	err := store.Save(evt, []byte("fake_mp4_video_data"))
	if err != nil {
		t.Fatalf("failed to save event: %v", err)
	}

	list := store.List(10, "")
	if len(list) != 1 {
		t.Fatalf("expected 1 event in store, got %d", len(list))
	}

	if list[0].TriggerType != "sound" {
		t.Errorf("expected trigger type sound, got %s", list[0].TriggerType)
	}

	// Test Get
	gotEvt, filePath, err := store.Get(list[0].ID)
	if err != nil {
		t.Fatalf("failed to get event: %v", err)
	}
	if gotEvt.Title != "Test Sound Spike" {
		t.Errorf("unexpected title: %s", gotEvt.Title)
	}
	if len(filePath) == 0 {
		t.Errorf("expected valid filePath")
	}
}
