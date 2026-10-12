package web

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	"renology/camera"
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
	cameraRelay   *camera.Relay
	ticketSecret  []byte
}

// CameraRelay returns the underlying camera streaming relay.
func (s *Server) CameraRelay() *camera.Relay {
	return s.cameraRelay
}

// NewServer creates a new kiosk dashboard web server.
func NewServer(cfg ServerConfig) (*Server, error) {
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = ":8080"
	}

	secret := make([]byte, 32)
	if cfg.CloudToken != "" {
		h := sha256.Sum256([]byte("renology-ticket-salt:" + cfg.CloudToken))
		copy(secret, h[:])
	} else {
		if _, err := rand.Read(secret); err != nil {
			return nil, fmt.Errorf("failed to generate ticket secret: %w", err)
		}
	}

	s := &Server{
		config:       cfg,
		cameraRelay:  camera.NewRelay(),
		ticketSecret: secret,
	}

	mux := http.NewServeMux()

	// 1. API Endpoints
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/history", s.handleHistory)
	mux.HandleFunc("/api/history/recent", s.handleRecentHistory)
	mux.HandleFunc("/api/telemetry/push", s.handlePushTelemetry)
	mux.HandleFunc("/api/weather", s.handleWeather)
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/display", s.handleDisplay)

	// Camera streaming endpoints
	mux.HandleFunc("/api/camera/status", s.handleCameraStatus)
	mux.HandleFunc("/api/camera/wait-request", s.handleCameraWaitRequest)
	mux.HandleFunc("/api/camera/ingress", s.handleCameraIngress)
	mux.HandleFunc("/api/camera/ticket", s.handleCameraTicket)
	mux.HandleFunc("/api/camera/stream", s.handleCameraStream)

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
			w.Header().Set("Cache-Control", "public, max-age=3600")
		} else if strings.HasSuffix(r.URL.Path, ".js") {
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "public, max-age=3600")
		}
		fileServer.ServeHTTP(w, r)
	})

	// Security middleware wrapping all incoming HTTP requests
	secureHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob: data:; connect-src 'self' blob: http://localhost:* http://127.0.0.1:* https://*.run.app https://solar.sfle.ca")
		mux.ServeHTTP(w, r)
	})

	h2s := &http2.Server{
		MaxConcurrentStreams: 250,
	}
	h2Handler := h2c.NewHandler(secureHandler, h2s)

	s.httpServer = &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           h2Handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 * 1024,
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
			if m > 1440 {
				m = 1440
			}
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

// handleDisplay returns the physical screen power status (screen asleep or awake) on the edge host.
func (s *Server) handleDisplay(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	asleep := false

	// 1. Check flag file maintained by surface-motion-wake daemon
	if _, err := os.Stat("/run/user/1000/screen_asleep"); err == nil {
		asleep = true
	}

	// 2. Direct DRM DPMS query fallback
	if !asleep {
		if data, err := os.ReadFile("/sys/class/drm/card1-eDP-1/dpms"); err == nil {
			if strings.TrimSpace(strings.ToLower(string(data))) == "off" {
				asleep = true
			}
		}
	}

	// 3. Backlight brightness query fallback
	if !asleep {
		if data, err := os.ReadFile("/sys/class/backlight/intel_backlight/actual_brightness"); err == nil {
			if strings.TrimSpace(string(data)) == "0" {
				asleep = true
			}
		}
	}

	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"screen_asleep": asleep,
		"time":          time.Now().Format(time.RFC3339),
	})
}

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
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
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

	body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
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

	// Validate authorization token if configured or in CloudRelay mode
	if s.config.CloudToken != "" || s.config.CloudRelay {
		token := r.Header.Get("X-Renology-Token")
		if token == "" {
			authHeader := r.Header.Get("Authorization")
			token = strings.TrimPrefix(authHeader, "Bearer ")
		}
		if s.config.CloudToken == "" || subtle.ConstantTimeCompare([]byte(token), []byte(s.config.CloudToken)) != 1 {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
	}

	// Bound request body to 512KB to protect against memory exhaustion DoS
	r.Body = http.MaxBytesReader(w, r.Body, 512*1024)

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

// handleCameraStatus returns the current status of the camera relay and viewer count.
func (s *Server) handleCameraStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	status := s.cameraRelay.GetStatus()
	resp := map[string]interface{}{
		"available":         status.Available,
		"active":            status.Active,
		"viewers":           status.Viewers,
		"resolution":        status.Resolution,
		"video_source":      status.VideoSource,
		"bytes_streamed":    status.BytesStreamed,
		"stream_uptime_sec": status.StreamUptime,
		"is_cloud_relay":    s.config.CloudRelay,
	}
	_ = json.NewEncoder(w).Encode(resp)
}

// isValidDashboardOrigin verifies that a request originates from an authorized dashboard.
func (s *Server) isValidDashboardOrigin(originHeader, refererHeader string) bool {
	rawURL := originHeader
	if rawURL == "" {
		rawURL = refererHeader
	}
	if rawURL == "" {
		return false
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}

	hostname := parsed.Hostname()
	if hostname == "" {
		return false
	}

	// Allow local development and Surface Go 2 kiosk loopback
	if hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1" {
		return true
	}

	// Allow custom domain
	if hostname == "solar.sfle.ca" {
		return true
	}

	// Allow Cloud Run generated hostnames (*.run.app)
	if strings.HasSuffix(hostname, ".run.app") {
		return true
	}

	return false
}

// generateCameraTicket mints an ephemeral HMAC-SHA256 signed ticket valid for 60 seconds.
func (s *Server) generateCameraTicket() (string, int64) {
	now := time.Now().Unix()
	nonceBytes := make([]byte, 16)
	_, _ = rand.Read(nonceBytes)
	nonce := hex.EncodeToString(nonceBytes)

	payload := fmt.Sprintf("%d:%s", now, nonce)
	mac := hmac.New(sha256.New, s.ticketSecret)
	mac.Write([]byte(payload))
	sig := hex.EncodeToString(mac.Sum(nil))

	ticket := fmt.Sprintf("%d.%s.%s", now, nonce, sig)
	return ticket, 60
}

// validateCameraTicket checks that the ticket has a valid HMAC signature and has not expired.
func (s *Server) validateCameraTicket(ticket string) bool {
	parts := strings.Split(ticket, ".")
	if len(parts) != 3 {
		return false
	}

	ts, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return false
	}

	now := time.Now().Unix()
	// Ticket must be within 60 seconds old (allow up to 5s future drift)
	if now-ts > 60 || ts-now > 5 {
		return false
	}

	payload := fmt.Sprintf("%d:%s", ts, parts[1])
	mac := hmac.New(sha256.New, s.ticketSecret)
	mac.Write([]byte(payload))
	expectedSig := hex.EncodeToString(mac.Sum(nil))

	return subtle.ConstantTimeCompare([]byte(expectedSig), []byte(parts[2])) == 1
}

// handleCameraTicket mints a secure, ephemeral session ticket for the Cloud Run dashboard.
func (s *Server) handleCameraTicket(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")

	// Camera stream is restricted strictly to Cloud Run relay
	if !s.config.CloudRelay {
		http.Error(w, `{"error":"Camera stream is only accessible via the Cloud Run dashboard"}`, http.StatusForbidden)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"POST method required"}`, http.StatusMethodNotAllowed)
		return
	}

	// Validate Origin / Referer from Cloud Run dashboard
	origin := r.Header.Get("Origin")
	referer := r.Header.Get("Referer")
	if !s.isValidDashboardOrigin(origin, referer) {
		http.Error(w, `{"error":"Unauthorized request origin. Tickets are only issued from the Cloud Run dashboard"}`, http.StatusForbidden)
		return
	}

	// Optional Cottage Cam Key protection via RENOLOGY_CAM_KEY environment variable
	expectedCamKey := os.Getenv("RENOLOGY_CAM_KEY")
	if expectedCamKey != "" {
		var reqBody struct {
			Key string `json:"key"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&reqBody)
		if reqBody.Key == "" || subtle.ConstantTimeCompare([]byte(reqBody.Key), []byte(expectedCamKey)) != 1 {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"error":        "Valid Cottage Cam key required",
				"key_required": true,
			})
			return
		}
	}

	ticket, expiresIn := s.generateCameraTicket()
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"ticket":     ticket,
		"expires_in": expiresIn,
	})
}

// handleCameraWaitRequest is long-polled by the edge worker to wait for active viewers.
func (s *Server) handleCameraWaitRequest(w http.ResponseWriter, r *http.Request) {
	if s.config.CloudToken != "" || s.config.CloudRelay {
		token := r.Header.Get("X-Renology-Token")
		if token == "" {
			authHeader := r.Header.Get("Authorization")
			token = strings.TrimPrefix(authHeader, "Bearer ")
		}
		if s.config.CloudToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.config.CloudToken)) != 1 {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
	}

	// Disable HTTP write timeout for long polling
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

	shouldStream := s.cameraRelay.WaitForStreamRequest(r.Context(), 25*time.Second)
	if shouldStream {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"action": "start"})
	} else {
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleCameraIngress receives the live fMP4 byte stream from the Edge host.
func (s *Server) handleCameraIngress(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"POST method required"}`, http.StatusMethodNotAllowed)
		return
	}

	if s.config.CloudToken != "" || s.config.CloudRelay {
		token := r.Header.Get("X-Renology-Token")
		if token == "" {
			authHeader := r.Header.Get("Authorization")
			token = strings.TrimPrefix(authHeader, "Bearer ")
		}
		if s.config.CloudToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(s.config.CloudToken)) != 1 {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
	}

	// Disable read and write deadlines for long-lived media ingestion
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	if err := s.cameraRelay.HandleIngress(r.Context(), r.Body); err != nil {
		log.Printf("[Web] Camera ingress error: %v", err)
	}

	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "completed"})
}

// handleCameraStream serves the live fragmented MP4 stream to web browsers via HTTP chunked transfer.
// Strictly available ONLY via the Cloud Run dashboard with an ephemeral ticket.
func (s *Server) handleCameraStream(w http.ResponseWriter, r *http.Request) {
	// Strictly prohibit direct streaming on Edge host
	if !s.config.CloudRelay {
		http.Error(w, `{"error":"Camera stream is only accessible via the Cloud Run dashboard"}`, http.StatusForbidden)
		return
	}

	// Validate ephemeral ticket
	ticket := r.URL.Query().Get("ticket")
	if ticket == "" || !s.validateCameraTicket(ticket) {
		http.Error(w, `{"error":"Forbidden: invalid or expired camera ticket. Access must originate from the Cloud Run dashboard"}`, http.StatusForbidden)
		return
	}

	// Validate origin or referer if provided
	origin := r.Header.Get("Origin")
	referer := r.Header.Get("Referer")
	if (origin != "" || referer != "") && !s.isValidDashboardOrigin(origin, referer) {
		http.Error(w, `{"error":"Forbidden: invalid dashboard origin"}`, http.StatusForbidden)
		return
	}

	// Disable write timeout for continuous streaming
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})

	s.cameraRelay.ServeHTTPStream(w, r)
}

