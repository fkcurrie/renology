package web

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"time"

	"renology/models"
	"renology/storage"
)

//go:embed static/*
var staticFiles embed.FS

// ServerConfig configures the embedded dashboard web server.
type ServerConfig struct {
	ListenAddr string
	Storage    *storage.Storage
	Verbose    bool
}

// Server serves the kiosk web UI and telemetry REST APIs.
type Server struct {
	config     ServerConfig
	httpServer *http.Server
}

// NewServer creates a new kiosk dashboard web server.
func NewServer(cfg ServerConfig) (*Server, error) {
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = ":8080"
	}

	s := &Server{
		config: cfg,
	}

	mux := http.NewServeMux()

	// 1. API Endpoints
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/history", s.handleHistory)
	mux.HandleFunc("/api/weather", s.handleWeather)
	mux.HandleFunc("/api/health", s.handleHealth)

	// 2. Embedded Static Assets
	staticSubFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		return nil, fmt.Errorf("embedded static fs error: %w", err)
	}

	fileServer := http.FileServer(http.FS(staticSubFS))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Set caching headers for static assets
		if strings.HasSuffix(r.URL.Path, ".css") {
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		} else if strings.HasSuffix(r.URL.Path, ".js") {
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		}
		fileServer.ServeHTTP(w, r)
	})

	s.httpServer = &http.Server{
		Addr:         cfg.ListenAddr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	return s, nil
}

// Start runs the HTTP server. It blocks until ctx is canceled or an error occurs.
func (s *Server) Start(ctx context.Context) error {
	errChan := make(chan error, 1)

	go func() {
		log.Printf("[Web] Renology Kiosk Dashboard listening on http://localhost%s (and LAN %s)", s.config.ListenAddr, s.config.ListenAddr)
		if err := s.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errChan <- err
		}
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		log.Printf("[Web] Shutting down kiosk web server...")
		return s.httpServer.Shutdown(shutdownCtx)
	case err := <-errChan:
		return err
	}
}

// handleStatus returns the current telemetry snapshot as JSON.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	if s.config.Storage == nil {
		http.Error(w, `{"error":"storage not initialized"}`, http.StatusInternalServerError)
		return
	}

	latest, err := s.config.Storage.GetLatest()
	if err != nil {
		// If no record written yet, return default standby payload
		latest = &models.Telemetry{
			Timestamp:      time.Now(),
			DeviceName:     "Searching for Renogy Controller...",
			ChargingStatus: "Standby",
		}
	}

	_ = json.NewEncoder(w).Encode(latest)
}

// handleHistory returns 24-hour and 7-day historical telemetry.
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	if s.config.Storage == nil {
		http.Error(w, `{"error":"storage not initialized"}`, http.StatusInternalServerError)
		return
	}

	history, err := s.config.Storage.GetHistory(time.Now())
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"failed to generate history: %s"}`, err), http.StatusInternalServerError)
		return
	}

	_ = json.NewEncoder(w).Encode(history)
}

// handleHealth returns a basic health status check.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok","time":"` + time.Now().Format(time.RFC3339) + `"}`))
}

// handleWeather proxies telemetry from the local weather station HTTP server (port 8088).
func (s *Server) handleWeather(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	client := http.Client{
		Timeout: 2 * time.Second,
	}

	resp, err := client.Get("http://127.0.0.1:8088/api/weather/current")
	if err != nil {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"offline","error":"weather service unreachable","measurements":{}}`))
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"error","error":"failed to read weather response","measurements":{}}`))
		return
	}

	w.WriteHeader(resp.StatusCode)
	w.Write(body)
}
