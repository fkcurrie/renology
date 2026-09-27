package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"renology/models"
	"renology/storage"
)

func TestWebServerEndpoints(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "renology_web_test_*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	defer os.RemoveAll(tempDir)

	store, err := storage.NewStorage(tempDir)
	if err != nil {
		t.Fatalf("NewStorage failed: %v", err)
	}

	// Seed sample telemetry
	now := time.Now()
	sample := &models.Telemetry{
		Timestamp:              now,
		DeviceName:             "BT-TH-66F984D6",
		Model:                  "RNG-CTRL-RVR20",
		BatterySOC:             100,
		BatteryVoltage:         13.2,
		PVVoltage:              28.5,
		PVPower:                160,
		ChargingStatus:         "MPPT",
		BatteryType:            "Lithium (LFP)",
		RatedCurrentAmps:       20,
		RatedVoltageVolts:      24,
		PowerGenerationTodayWh: 420,
	}
	if err := store.Save(sample); err != nil {
		t.Fatalf("store.Save failed: %v", err)
	}

	server, err := NewServer(ServerConfig{
		ListenAddr: ":0",
		Storage:    store,
	})
	if err != nil {
		t.Fatalf("NewServer failed: %v", err)
	}

	// Test 1: GET / (index.html)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	server.httpServer.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("Expected GET / 200 OK, got %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "RENOLOGY") || !strings.Contains(body, "fuelGaugeCanvas") {
		t.Errorf("Index page missing expected HTML markers")
	}

	// Test 2: GET /style.css
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/style.css", nil)
	server.httpServer.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("Expected GET /style.css 200 OK, got %d", rec.Code)
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), "text/css") {
		t.Errorf("Expected Content-Type text/css, got %s", rec.Header().Get("Content-Type"))
	}

	// Test 3: GET /app.js
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/app.js", nil)
	server.httpServer.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("Expected GET /app.js 200 OK, got %d", rec.Code)
	}
	if !strings.Contains(rec.Header().Get("Content-Type"), "javascript") {
		t.Errorf("Expected javascript content type, got %s", rec.Header().Get("Content-Type"))
	}

	// Test 4: GET /api/status
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/status", nil)
	server.httpServer.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("Expected GET /api/status 200 OK, got %d", rec.Code)
	}
	var telem models.Telemetry
	if err := json.Unmarshal(rec.Body.Bytes(), &telem); err != nil {
		t.Fatalf("Failed to parse /api/status JSON: %v", err)
	}
	if telem.BatterySOC != 100 {
		t.Errorf("Expected SOC 100, got %d", telem.BatterySOC)
	}
	if telem.Model != "RNG-CTRL-RVR20" {
		t.Errorf("Expected model RNG-CTRL-RVR20, got %s", telem.Model)
	}

	// Test 5: GET /api/history
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/history", nil)
	server.httpServer.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("Expected GET /api/history 200 OK, got %d", rec.Code)
	}
	var hist models.HistoryResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &hist); err != nil {
		t.Fatalf("Failed to parse /api/history JSON: %v", err)
	}
	if len(hist.Points24h) != 96 {
		t.Errorf("Expected 96 24h points, got %d", len(hist.Points24h))
	}
	if len(hist.Days7d) != 7 {
		t.Errorf("Expected 7 days, got %d", len(hist.Days7d))
	}

	// Test 6: GET /api/health
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/health", nil)
	server.httpServer.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("Expected GET /api/health 200 OK, got %d", rec.Code)
	}

	// Test 7: GET /api/weather
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/weather", nil)
	server.httpServer.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("Expected GET /api/weather 200 OK, got %d", rec.Code)
	}
	var weatherMap map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &weatherMap); err != nil {
		t.Fatalf("Failed to parse /api/weather JSON: %v", err)
	}

	// Test 8: GET /api/history/recent?minutes=60
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/history/recent?minutes=60", nil)
	server.httpServer.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("Expected GET /api/history/recent 200 OK, got %d", rec.Code)
	}
	var recentResp models.RecentHistoryResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &recentResp); err != nil {
		t.Fatalf("Failed to parse /api/history/recent JSON: %v", err)
	}
	if recentResp.TotalSamples != 1 {
		t.Errorf("Expected 1 sample in recent history, got %d", recentResp.TotalSamples)
	}
}

func TestCloudRelayPush(t *testing.T) {
	// Initialize server in Cloud Relay mode with a secret token
	server, err := NewServer(ServerConfig{
		ListenAddr: ":0",
		CloudRelay: true,
		CloudToken: "secret123",
	})
	if err != nil {
		t.Fatalf("NewServer failed: %v", err)
	}

	pushPayload := models.CloudSyncPayload{
		Telemetry: &models.Telemetry{
			Timestamp:      time.Now(),
			DeviceName:     "BT-TH-66F984D6",
			Model:          "RNG-CTRL-RVR20",
			BatterySOC:     99,
			BatteryVoltage: 13.4,
			PVVoltage:      35.2,
			PVPower:        220,
			ChargingStatus: "MPPT",
		},
		Weather: map[string]interface{}{
			"outdoor_temp_c": 21.5,
			"solar_wm2":      650,
			"status":         "online",
		},
		History: &models.HistoryResponse{
			Points24h: []models.HistoryPoint24h{
				{TimeLabel: "12:00", SolarPowerW: 220, PVVoltage: 35.2},
			},
			Days7d: []models.DailySummary7d{
				{DayLabel: "Today", PeakSolarWatts: 220, EnergyWh: 1500},
			},
		},
		Timestamp: time.Now(),
	}
	bodyBytes, _ := json.Marshal(pushPayload)

	// 1. Test unauthorized push (wrong token)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/telemetry/push", strings.NewReader(string(bodyBytes)))
	req.Header.Set("X-Renology-Token", "wrong_token")
	server.httpServer.Handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("Expected 401 Unauthorized, got %d", rec.Code)
	}

	// 2. Test authorized push (correct token)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("POST", "/api/telemetry/push", strings.NewReader(string(bodyBytes)))
	req.Header.Set("X-Renology-Token", "secret123")
	server.httpServer.Handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK, got %d: %s", rec.Code, rec.Body.String())
	}

	// 3. Test GET /api/status returns pushed telemetry
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/status", nil)
	server.httpServer.Handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("Expected GET /api/status 200 OK, got %d", rec.Code)
	}
	var status models.Telemetry
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("Failed to parse status JSON: %v", err)
	}
	if status.BatterySOC != 99 || status.PVPower != 220 {
		t.Errorf("Unexpected status data: SOC=%d PV=%d", status.BatterySOC, status.PVPower)
	}

	// 4. Test GET /api/weather returns pushed weather
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/weather", nil)
	server.httpServer.Handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("Expected GET /api/weather 200 OK, got %d", rec.Code)
	}
	var weather map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &weather); err != nil {
		t.Fatalf("Failed to parse weather JSON: %v", err)
	}
	if weather["outdoor_temp_c"] != 21.5 {
		t.Errorf("Unexpected weather temp: %v", weather["outdoor_temp_c"])
	}

	// 5. Test GET /api/history returns pushed history
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/history", nil)
	server.httpServer.Handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("Expected GET /api/history 200 OK, got %d", rec.Code)
	}
	var hist models.HistoryResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &hist); err != nil {
		t.Fatalf("Failed to parse history JSON: %v", err)
	}
	if len(hist.Points24h) != 1 || hist.Points24h[0].SolarPowerW != 220 {
		t.Errorf("Unexpected history response: %+v", hist)
	}
}

