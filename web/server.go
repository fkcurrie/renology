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
	"strconv"
	"strings"
	"sync"
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
	CloudRelay bool   // Running in cloud relay mode
	CloudToken string // Authentication token for /api/telemetry/push
}

// Server serves the kiosk web UI and telemetry REST APIs.
type Server struct {
	config        ServerConfig
	httpServer    *http.Server
	mu            sync.RWMutex
	cachedLatest  *models.Telemetry
	cachedWeather []byte
	cachedHistory *models.HistoryResponse
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
	mux.HandleFunc("/api/history/recent", s.handleRecentHistory)
	mux.HandleFunc("/api/telemetry/push", s.handlePushTelemetry)
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

	s.mu.RLock()
	cached := s.cachedLatest
	s.mu.RUnlock()

	if cached != nil {
		_ = json.NewEncoder(w).Encode(cached)
		return
	}

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

	s.mu.RLock()
	cachedHistory := s.cachedHistory
	s.mu.RUnlock()

	if cachedHistory != nil {
		_ = json.NewEncoder(w).Encode(cachedHistory)
		return
	}

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

// handleRecentHistory returns telemetry aggregates and minute points for the last N minutes.
func (s *Server) handleRecentHistory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	if s.config.Storage == nil {
		http.Error(w, `{"error":"storage not initialized"}`, http.StatusInternalServerError)
		return
	}

	minutes := 60
	if mStr := r.URL.Query().Get("minutes"); mStr != "" {
		if m, err := strconv.Atoi(mStr); err == nil && m > 0 {
			minutes = m
		}
	}

	summary, _, err := s.config.Storage.GetRecentTelemetry(minutes, time.Now())
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"failed to query recent history: %s"}`, err), http.StatusInternalServerError)
		return
	}

	_ = json.NewEncoder(w).Encode(summary)
}

// handleHealth returns a basic health status check.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok","time":"` + time.Now().Format(time.RFC3339) + `"}`))
}

// handleWeather proxies telemetry from the local weather station HTTP server (port 8088),
// or returns cached weather data when running in cloud relay mode.
func (s *Server) handleWeather(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	s.mu.RLock()
	cached := s.cachedWeather
	s.mu.RUnlock()

	// If running in cloud relay mode and we have cached weather, serve it immediately
	if s.config.CloudRelay && cached != nil {
		w.WriteHeader(http.StatusOK)
		w.Write(cached)
		return
	}

	client := http.Client{
		Timeout: 2 * time.Second,
	}

	resp, err := client.Get("http://127.0.0.1:8088/api/weather/current")
	if err != nil {
		// If local weather service unreachable but we have cached weather, serve cached
		if cached != nil {
			w.WriteHeader(http.StatusOK)
			w.Write(cached)
			return
		}
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

// handlePushTelemetry ingests live telemetry and weather pushed from the edge Surface Go 2.
func (s *Server) handlePushTelemetry(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"POST method required"}`, http.StatusMethodNotAllowed)
		return
	}

	// Validate authorization token if configured
	if s.config.CloudToken != "" {
		token := r.Header.Get("X-Renology-Token")
		if token == "" {
			authHeader := r.Header.Get("Authorization")
			token = strings.TrimPrefix(authHeader, "Bearer ")
		}
		if token != s.config.CloudToken {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
	}

	var payload models.CloudSyncPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"invalid json: %s"}`, err), http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	if payload.Telemetry != nil {
		s.cachedLatest = payload.Telemetry
	}
	if payload.Weather != nil {
		if wBytes, err := json.Marshal(payload.Weather); err == nil {
			s.cachedWeather = wBytes
		}
	}
	if payload.History != nil {
		s.cachedHistory = payload.History
	}
	s.mu.Unlock()

	// If storage engine is active, persist the telemetry record to SQLite
	if s.config.Storage != nil && payload.Telemetry != nil {
		_ = s.config.Storage.Save(payload.Telemetry)
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":      "ok",
		"received_at": time.Now().Format(time.RFC3339),
	})
}

