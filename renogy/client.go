package renogy

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"renology/models"
	"renology/modbus"
	"renology/storage"

	"tinygo.org/x/bluetooth"
)

const (
	UUIDServiceWrite = "0000ffd0-0000-1000-8000-00805f9b34fb"
	UUIDCharWrite    = "0000ffd1-0000-1000-8000-00805f9b34fb"
	UUIDServiceRead  = "0000fff0-0000-1000-8000-00805f9b34fb"
	UUIDCharNotify   = "0000fff1-0000-1000-8000-00805f9b34fb"
)

// ClientConfig holds configuration for the Renogy BLE client.
type ClientConfig struct {
	TargetMAC    string
	DeviceID     byte
	PollInterval time.Duration
	Storage      *storage.Storage
	Verbose      bool
}

// Client manages the BLE connection, Modbus requests, and polling loop.
type Client struct {
	config  ClientConfig
	adapter *bluetooth.Adapter

	mu           sync.Mutex
	device       *bluetooth.Device
	writeChar    *bluetooth.DeviceCharacteristic
	notifyChar   *bluetooth.DeviceCharacteristic
	cachedModel  string
	latestTelem  *models.Telemetry
	respChan     chan []byte
	chunkBuffer  []byte
	expectedLen  int
	isConnected  bool
}

// NewClient initializes a new Renogy client.
func NewClient(cfg ClientConfig) *Client {
	if cfg.DeviceID == 0 {
		cfg.DeviceID = 0xFF // Default Renogy Modbus broadcast address
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = 5 * time.Second
	}
	return &Client{
		config:      cfg,
		adapter:     bluetooth.DefaultAdapter,
		respChan:    make(chan []byte, 10),
		chunkBuffer: make([]byte, 0, 256),
	}
}

// Start runs the main polling engine until context is canceled.
func (c *Client) Start(ctx context.Context) error {
	if err := c.adapter.Enable(); err != nil {
		return fmt.Errorf("failed to enable bluetooth adapter: %w", err)
	}

	backoff := 2 * time.Second
	const maxBackoff = 15 * time.Second

	for {
		select {
		case <-ctx.Done():
			c.Disconnect()
			return nil
		default:
		}

		log.Printf("[Renogy] Scanning for device %s...", c.config.TargetMAC)
		scanResult, err := c.scanForDevice(ctx, 10*time.Second)
		if err != nil {
			log.Printf("[Renogy] Scan issue: %v. Retrying in %v...", err, backoff)
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return nil
			}
			backoff = min(backoff*2, maxBackoff)
			continue
		}

		log.Printf("[Renogy] Found device: %s [%s] (RSSI: %d dBm)",
			scanResult.LocalName(), scanResult.Address.String(), scanResult.RSSI)

		if scanResult.RSSI < -95 {
			log.Printf("[Renogy] Note: Signal (%d dBm) is near or below CC2541 hardware receiver threshold (-94 dBm). If connection aborts, bring receiver closer or verify phone app is closed.", scanResult.RSSI)
		}

		// Wait briefly after scanning to let BlueZ and radio settle
		time.Sleep(400 * time.Millisecond)

		err = c.connectAndSetup(scanResult.Address)
		if err != nil {
			if c.config.Storage != nil {
				_ = c.config.Storage.RecordRFMeasurement(time.Now(), scanResult.Address.String(), scanResult.LocalName(), int(scanResult.RSSI), false, err.Error())
			}
			log.Printf("[Renogy] Connection failed (RSSI: %d dBm): %v. Retrying in %v...", scanResult.RSSI, err, backoff)
			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return nil
			}
			backoff = min(backoff*2, maxBackoff)
			continue
		}

		// Successfully connected!
		if c.config.Storage != nil {
			_ = c.config.Storage.RecordRFMeasurement(time.Now(), scanResult.Address.String(), scanResult.LocalName(), int(scanResult.RSSI), true, "")
		}
		backoff = 2 * time.Second
		log.Printf("*******************************************************************************")
		log.Printf("[Renogy] >>> CONNECTION ESTABLISHED at RSSI %d dBm! <<<", scanResult.RSSI)
		log.Printf("[Renogy] Starting 5-second Modbus telemetry polling loop...")
		log.Printf("*******************************************************************************")

		if err := c.pollLoop(ctx, scanResult.LocalName(), scanResult.Address.String(), int(scanResult.RSSI)); err != nil {
			log.Printf("[Renogy] Polling ended: %v. Reconnecting...", err)
			c.Disconnect()
		}
	}
}

// scanForDevice looks for the target device by MAC address or Renogy name prefix.
func (c *Client) scanForDevice(ctx context.Context, timeout time.Duration) (bluetooth.ScanResult, error) {
	foundChan := make(chan bluetooth.ScanResult, 1)

	err := c.adapter.Scan(func(ad *bluetooth.Adapter, result bluetooth.ScanResult) {
		mac := result.Address.String()
		if strings.EqualFold(mac, c.config.TargetMAC) || strings.HasPrefix(result.LocalName(), "BT-TH-") {
			_ = ad.StopScan()
			select {
			case foundChan <- result:
			default:
			}
		}
	})
	if err != nil {
		return bluetooth.ScanResult{}, fmt.Errorf("adapter scan: %w", err)
	}

	select {
	case res := <-foundChan:
		return res, nil
	case <-time.After(timeout):
		_ = c.adapter.StopScan()
		return bluetooth.ScanResult{}, fmt.Errorf("timeout waiting for device advertisement")
	case <-ctx.Done():
		_ = c.adapter.StopScan()
		return bluetooth.ScanResult{}, ctx.Err()
	}
}

// connectAndSetup connects to the peripheral, discovers services, and sets up GATT.
func (c *Client) connectAndSetup(addr bluetooth.Address) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	var device bluetooth.Device
	var err error
	for attempt := 1; attempt <= 2; attempt++ {
		device, err = c.adapter.Connect(addr, bluetooth.ConnectionParams{})
		if err == nil {
			break
		}
		if attempt < 2 {
			time.Sleep(600 * time.Millisecond)
		}
	}
	if err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	c.device = &device

	services, err := device.DiscoverServices(nil)
	if err != nil {
		device.Disconnect()
		return fmt.Errorf("discover services: %w", err)
	}

	var writeFound, notifyFound bool

	for _, s := range services {
		sUUID := strings.ToLower(s.UUID().String())
		chars, err := s.DiscoverCharacteristics(nil)
		if err != nil {
			continue
		}

		for _, ch := range chars {
			cUUID := strings.ToLower(ch.UUID().String())
			if strings.Contains(cUUID, "ffd1") || sUUID == UUIDServiceWrite {
				chCopy := ch
				c.writeChar = &chCopy
				writeFound = true
				if c.config.Verbose {
					log.Printf("[Renogy] Found Write characteristic: %s", cUUID)
				}
			}
			if strings.Contains(cUUID, "fff1") || sUUID == UUIDServiceRead {
				chCopy := ch
				c.notifyChar = &chCopy
				notifyFound = true
				if c.config.Verbose {
					log.Printf("[Renogy] Found Notify characteristic: %s", cUUID)
				}
			}
		}
	}

	if !writeFound || !notifyFound {
		device.Disconnect()
		return fmt.Errorf("missing required characteristics (writeFound=%v, notifyFound=%v)", writeFound, notifyFound)
	}

	// Enable notifications on RX characteristic
	err = c.notifyChar.EnableNotifications(func(buf []byte) {
		c.handleIncomingChunk(buf)
	})
	if err != nil {
		device.Disconnect()
		return fmt.Errorf("enable notifications: %w", err)
	}

	c.isConnected = true
	return nil
}

// handleIncomingChunk reassembles incoming BLE notification chunks into full Modbus frames.
func (c *Client) handleIncomingChunk(chunk []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if len(chunk) == 0 {
		return
	}

	c.chunkBuffer = append(c.chunkBuffer, chunk...)

	if len(c.chunkBuffer) >= 3 && c.expectedLen == 0 {
		// Modbus RTU Response: [DeviceID, FuncCode, ByteCount, Data..., CRCLo, CRCHi]
		byteCount := int(c.chunkBuffer[2])
		c.expectedLen = byteCount + 5
	}

	if c.expectedLen > 0 && len(c.chunkBuffer) >= c.expectedLen {
		frame := make([]byte, c.expectedLen)
		copy(frame, c.chunkBuffer[:c.expectedLen])
		c.chunkBuffer = c.chunkBuffer[c.expectedLen:]
		c.expectedLen = 0

		select {
		case c.respChan <- frame:
		default:
			log.Printf("[Renogy] Warning: response channel full, dropping frame")
		}
	}
}

// sendModbusQuery sends a Modbus read request and waits for the reassembled response.
func (c *Client) sendModbusQuery(ctx context.Context, startReg, numRegs uint16, timeout time.Duration) ([]byte, error) {
	req := modbus.BuildReadRequest(c.config.DeviceID, startReg, numRegs)

	// Flush any stale responses
	for len(c.respChan) > 0 {
		<-c.respChan
	}
	c.mu.Lock()
	c.chunkBuffer = c.chunkBuffer[:0]
	c.expectedLen = 0
	writeChar := c.writeChar
	c.mu.Unlock()

	if writeChar == nil {
		return nil, fmt.Errorf("write characteristic not available")
	}

	if c.config.Verbose {
		log.Printf("[Renogy] TX Request: %X", req)
	}

	_, err := writeChar.WriteWithoutResponse(req)
	if err != nil {
		return nil, fmt.Errorf("write characteristic: %w", err)
	}

	select {
	case resp := <-c.respChan:
		if !modbus.ValidateCRC(resp) {
			return nil, fmt.Errorf("CRC mismatch in received frame (%X)", resp)
		}
		if c.config.Verbose {
			log.Printf("[Renogy] RX Response: %X", resp)
		}
		return resp, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("timed out waiting for response")
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// pollLoop performs periodic polling every PollInterval.
func (c *Client) pollLoop(ctx context.Context, deviceName, mac string, rssi int) error {
	ticker := time.NewTicker(c.config.PollInterval)
	defer ticker.Stop()

	// Initial query immediately upon connection
	c.pollOnce(ctx, deviceName, mac, rssi)

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := c.pollOnce(ctx, deviceName, mac, rssi); err != nil {
				return err
			}
		}
	}
}

// pollOnce executes one polling cycle: queries device info (if needed) and live telemetry.
func (c *Client) pollOnce(ctx context.Context, deviceName, mac string, rssi int) error {
	now := time.Now()
	telem := &models.Telemetry{
		Timestamp:  now,
		DeviceName: deviceName,
		MACAddress: mac,
		RSSI:       rssi,
	}

	// 1. Query Device Info / Model if not cached (Register 12, 8 words)
	if c.cachedModel == "" {
		resp, err := c.sendModbusQuery(ctx, 12, 8, 2*time.Second)
		if err == nil {
			model, err := ParseDeviceInfo(resp)
			if err == nil && model != "" {
				c.cachedModel = model
				log.Printf("[Renogy] Device Model: %s", model)
			}
		} else if c.config.Verbose {
			log.Printf("[Renogy] Model query skipped: %v", err)
		}
	}
	telem.Model = c.cachedModel

	// 2. Query Live Controller Telemetry (Register 256, 34 words)
	resp, err := c.sendModbusQuery(ctx, 256, 34, 3*time.Second)
	if err != nil {
		return fmt.Errorf("failed to read operational data: %w", err)
	}

	if err := ParseControllerTelemetry(resp, telem); err != nil {
		return fmt.Errorf("failed to parse telemetry: %w", err)
	}

	// 3. Save to local storage
	if c.config.Storage != nil {
		if err := c.config.Storage.Save(telem); err != nil {
			log.Printf("[Renogy] Storage save error: %v", err)
		}
	}

	c.mu.Lock()
	c.latestTelem = telem
	c.mu.Unlock()

	// 4. Output summary to stdout
	c.printTelemetrySummary(telem)
	return nil
}

// printTelemetrySummary prints a concise, human-readable status line.
func (c *Client) printTelemetrySummary(t *models.Telemetry) {
	fmt.Printf("[%s] %s | Battery: %d%% %.1fV %.2fA (%.1fW) | Solar PV: %.1fV %.2fA (%dW) | State: %s | Today: %d Wh\n",
		t.Timestamp.Format("15:04:05"),
		t.Model,
		t.BatterySOC,
		t.BatteryVoltage,
		t.BatteryCurrent,
		t.BatteryPower,
		t.PVVoltage,
		t.PVCurrent,
		t.PVPower,
		t.ChargingStatus,
		t.PowerGenerationTodayWh,
	)
}

// Disconnect cleanly disconnects the BLE device.
func (c *Client) Disconnect() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.device != nil {
		_ = c.device.Disconnect()
		c.device = nil
	}
	c.writeChar = nil
	c.notifyChar = nil
	c.isConnected = false
}

// LatestTelemetry returns the most recently received telemetry snapshot.
func (c *Client) LatestTelemetry() *models.Telemetry {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.latestTelem
}
