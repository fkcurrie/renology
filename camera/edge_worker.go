package camera

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// EdgeWorker runs on the Surface Go 2 edge host to manage on-demand streaming to Cloud Run.
type EdgeWorker struct {
	cloudURL   string
	cloudToken string
	pipeline   *Pipeline
	httpClient *http.Client
}

// NewEdgeWorker creates a new edge streaming worker.
func NewEdgeWorker(cloudURL, token string, pipeline *Pipeline) *EdgeWorker {
	if pipeline == nil {
		pipeline = NewPipeline(PipelineConfig{
			Width:       1280,
			Height:      720,
			Framerate:   30,
			VideoSource: DetectAvailableSource(),
		})
	}

	return &EdgeWorker{
		cloudURL:   strings.TrimRight(cloudURL, "/"),
		cloudToken: token,
		pipeline:   pipeline,
		httpClient: &http.Client{
			Timeout: 35 * time.Second,
		},
	}
}

// Start begins the edge worker loop. It blocks until ctx is canceled.
func (w *EdgeWorker) Start(ctx context.Context) {
	log.Printf("[Camera Edge] Starting on-demand camera worker -> %s", w.cloudURL)

	backoff := 1 * time.Second

	for {
		select {
		case <-ctx.Done():
			w.pipeline.Stop()
			return
		default:
		}

		// 1. Long-poll Cloud Run to check if any viewer is waiting
		shouldStream, err := w.checkViewerWait(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("[Camera Edge] Wait check note: %v (retry in %v)", err, backoff)
			time.Sleep(backoff)
			if backoff < 10*time.Second {
				backoff *= 2
			}
			continue
		}

		backoff = 1 * time.Second

		if !shouldStream {
			continue
		}

		// 2. Viewer detected! Launch GStreamer hardware pipeline and stream to Cloud Run
		log.Println("[Camera Edge] Live viewer connected on Cloud Run! Starting hardware camera capture...")
		if err := w.streamToCloud(ctx); err != nil {
			log.Printf("[Camera Edge] Streaming session ended: %v", err)
		}

		// Ensure pipeline is stopped and resources released
		w.pipeline.Stop()
		time.Sleep(1 * time.Second)
	}
}

func (w *EdgeWorker) checkViewerWait(ctx context.Context) (bool, error) {
	waitURL := fmt.Sprintf("%s/api/camera/wait-request", w.cloudURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, waitURL, nil)
	if err != nil {
		return false, err
	}

	if w.cloudToken != "" {
		req.Header.Set("X-Renology-Token", w.cloudToken)
	}

	resp, err := w.httpClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		var actionResp struct {
			Action string `json:"action"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&actionResp); err == nil {
			return actionResp.Action == "start", nil
		}
	} else if resp.StatusCode == http.StatusNoContent {
		// Timeout without viewer; loop again
		return false, nil
	}

	return false, nil
}

func (w *EdgeWorker) prepareCameraHardware() {
	// If the display is asleep, surface-motion-wake.service holds the OV5693 camera sensor.
	// Wake the display via DPMS to signal surface-motion-wake to release the sensor immediately.
	asleepFlag := "/run/user/1000/screen_asleep"
	wasAsleep := false
	if _, err := os.Stat(asleepFlag); err == nil {
		wasAsleep = true
	}

	cmd := exec.Command("xset", "-display", ":0", "dpms", "force", "on")
	if err := cmd.Run(); err != nil {
		log.Printf("[Camera Edge] Note: xset display wake: %v", err)
	}

	if wasAsleep {
		log.Println("[Camera Edge] Display was asleep. Woke display; pausing 1s for motion-wake to release camera sensor...")
		time.Sleep(1000 * time.Millisecond)
	}
}

func (w *EdgeWorker) streamToCloud(ctx context.Context) error {
	// Ensure camera hardware is free and screen is awake
	w.prepareCameraHardware()

	stdout, err := w.pipeline.Start(ctx)
	if err != nil {
		return fmt.Errorf("pipeline start error: %w", err)
	}
	defer w.pipeline.Stop()

	// Keep display awake during active streaming so motion-wake doesn't try to reclaim camera
	keepAwakeCtx, cancelKeepAwake := context.WithCancel(ctx)
	defer cancelKeepAwake()
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-keepAwakeCtx.Done():
				return
			case <-ticker.C:
				_ = exec.Command("xset", "-display", ":0", "dpms", "force", "on").Run()
			}
		}
	}()

	ingressURL := fmt.Sprintf("%s/api/camera/ingress", w.cloudURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ingressURL, stdout)
	if err != nil {
		return fmt.Errorf("failed to create ingress request: %w", err)
	}

	req.Header.Set("Content-Type", "video/mp4")
	if w.cloudToken != "" {
		req.Header.Set("X-Renology-Token", w.cloudToken)
	}

	// Use streaming HTTP client without aggressive timeout
	streamClient := &http.Client{
		Timeout: 0, // Keep connection open as long as streaming persists
	}

	log.Printf("[Camera Edge] Piping fMP4 stream to %s...", ingressURL)
	resp, err := streamClient.Do(req)
	if err != nil {
		return fmt.Errorf("ingress post error: %w", err)
	}
	defer resp.Body.Close()

	// Drain response body
	_, _ = io.Copy(io.Discard, resp.Body)
	log.Printf("[Camera Edge] Cloud ingress closed with status %s", resp.Status)
	return nil
}
