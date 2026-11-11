package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"renology/camera"
)

func TestPushTelemetryOnceTriggersCameraWorker(t *testing.T) {
	action := "idle"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/telemetry/push" {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get("X-Renology-Token") != "tok123" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status":        "ok",
			"camera_action": action,
		})
	}))
	defer srv.Close()

	pipeline := camera.NewPipeline(camera.PipelineConfig{VideoSource: camera.SourceTest})
	worker := camera.NewEdgeWorker(srv.URL, "tok123", pipeline)
	worker.SetPushTriggered(true)

	client := &http.Client{Timeout: 2 * time.Second}
	pushURL := srv.URL + "/api/telemetry/push"

	// 1. Idle response should not trigger camera
	pushTelemetryOnce(context.Background(), client, pushURL, "tok123", []byte(`{}`), false, worker)
	if worker.HasPendingTrigger() {
		t.Fatalf("expected no camera trigger when camera_action=idle")
	}

	// 2. Start response should trigger camera
	action = "start"
	pushTelemetryOnce(context.Background(), client, pushURL, "tok123", []byte(`{}`), false, worker)
	if !worker.HasPendingTrigger() {
		t.Fatalf("expected camera trigger when camera_action=start")
	}
}
