package camera

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestEdgeWorkerPushTriggeredSkipsWaitRequest(t *testing.T) {
	var waitRequests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/camera/wait-request" {
			waitRequests.Add(1)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	pipeline := NewPipeline(PipelineConfig{VideoSource: SourceTest})
	worker := NewEdgeWorker(srv.URL, "tok", pipeline)
	worker.SetPushTriggered(true)

	var streamCalls atomic.Int32
	streamStarted := make(chan struct{}, 1)
	worker.streamFn = func(ctx context.Context) error {
		streamCalls.Add(1)
		select {
		case streamStarted <- struct{}{}:
		default:
		}
		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() {
		worker.Start(ctx)
		close(done)
	}()

	// Give Start a moment to enter wait loop; it must NOT poll /api/camera/wait-request
	time.Sleep(150 * time.Millisecond)
	if got := waitRequests.Load(); got != 0 {
		t.Fatalf("expected 0 /api/camera/wait-request calls in push-triggered mode, got %d", got)
	}
	if got := streamCalls.Load(); got != 0 {
		t.Fatalf("expected 0 stream calls before Trigger(), got %d", got)
	}

	worker.Trigger()
	select {
	case <-streamStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for Trigger() to start stream")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for EdgeWorker.Start to exit")
	}

	if got := waitRequests.Load(); got != 0 {
		t.Fatalf("expected 0 /api/camera/wait-request calls overall, got %d", got)
	}
}

func TestCheckViewerWaitErrorsOnUnexpectedStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	pipeline := NewPipeline(PipelineConfig{VideoSource: SourceTest})
	worker := NewEdgeWorker(srv.URL, "tok", pipeline)

	shouldStream, err := worker.checkViewerWait(context.Background())
	if err == nil {
		t.Fatalf("expected error on HTTP 503, got nil (shouldStream=%v)", shouldStream)
	}
	if shouldStream {
		t.Fatalf("expected shouldStream=false on HTTP 503")
	}
}
