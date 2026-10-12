package camera

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

// RelayStatus holds current camera relay status information.
type RelayStatus struct {
	Available     bool      `json:"available"`
	Active        bool      `json:"active"`
	Viewers       int       `json:"viewers"`
	Resolution    string    `json:"resolution"`
	VideoSource   string    `json:"video_source"`
	BytesStreamed int64     `json:"bytes_streamed"`
	StreamUptime  float64   `json:"stream_uptime_sec"`
	LastActive    time.Time `json:"last_active"`
}

// Relay coordinates on-demand camera streaming between Edge and Browsers.
type Relay struct {
	mu            sync.RWMutex
	subscribers   map[chan []byte]struct{}
	initSegment   []byte
	hasInit       bool
	lastFragment  []byte
	activeViewers int
	bytesStreamed int64
	streamStart   time.Time
	isStreaming   bool

	// Signal channels for on-demand edge trigger
	triggerChan chan struct{}
	stopChan    chan struct{}

	gracePeriod time.Duration
	graceTimer  *time.Timer
}

// NewRelay initializes a new camera streaming relay.
func NewRelay() *Relay {
	return &Relay{
		subscribers: make(map[chan []byte]struct{}),
		triggerChan: make(chan struct{}, 1),
		stopChan:    make(chan struct{}, 1),
		gracePeriod: 30 * time.Second,
	}
}

// GetStatus returns the current relay status.
func (r *Relay) GetStatus() RelayStatus {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var uptime float64
	if r.isStreaming && !r.streamStart.IsZero() {
		uptime = time.Since(r.streamStart).Seconds()
	}

	return RelayStatus{
		Available:     true,
		Active:        r.isStreaming,
		Viewers:       r.activeViewers,
		Resolution:    "720p HD",
		VideoSource:   "Surface Go 2 / Intel VA-API H.264",
		BytesStreamed: r.bytesStreamed,
		StreamUptime:  uptime,
		LastActive:    r.streamStart,
	}
}

// WaitForStreamRequest is called by the Edge worker (via long-polling).
// It blocks until at least one viewer requests the camera, or until timeout.
func (r *Relay) WaitForStreamRequest(ctx context.Context, timeout time.Duration) bool {
	// First check if viewers are already waiting
	r.mu.RLock()
	viewers := r.activeViewers
	r.mu.RUnlock()

	if viewers > 0 {
		return true
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return false
	case <-r.triggerChan:
		return true
	}
}

// RegisterViewer increments active viewer count and triggers stream start if needed.
func (r *Relay) RegisterViewer() (chan []byte, []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Cancel grace timer if running
	if r.graceTimer != nil {
		r.graceTimer.Stop()
		r.graceTimer = nil
	}

	r.activeViewers++
	sub := make(chan []byte, 32)
	r.subscribers[sub] = struct{}{}

	// Signal trigger channel if viewers transition from 0 -> 1
	if r.activeViewers == 1 {
		select {
		case r.triggerChan <- struct{}{}:
		default:
		}
	}

	// Prepare initial burst: initSegment + lastFragment (if available)
	var initBurst []byte
	if r.hasInit && len(r.initSegment) > 0 {
		burstLen := len(r.initSegment) + len(r.lastFragment)
		initBurst = make([]byte, burstLen)
		copy(initBurst, r.initSegment)
		if len(r.lastFragment) > 0 {
			copy(initBurst[len(r.initSegment):], r.lastFragment)
		}
	}

	return sub, initBurst
}

// UnregisterViewer decrements active viewer count and triggers stop grace timer if 0.
func (r *Relay) UnregisterViewer(sub chan []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, ok := r.subscribers[sub]; ok {
		delete(r.subscribers, sub)
		close(sub)
	}

	if r.activeViewers > 0 {
		r.activeViewers--
	}

	// When active viewers hit 0, start countdown before stopping edge stream
	if r.activeViewers == 0 {
		if r.graceTimer != nil {
			r.graceTimer.Stop()
		}
		r.graceTimer = time.AfterFunc(r.gracePeriod, func() {
			r.mu.Lock()
			viewers := r.activeViewers
			r.mu.Unlock()
			if viewers == 0 {
				log.Printf("[Camera Relay] 0 viewers for %v. Signalling stream stop.", r.gracePeriod)
				select {
				case r.stopChan <- struct{}{}:
				default:
				}
			}
		})
	}
}

// readBox reads a single complete ISO BMFF box from reader.
func readBox(r io.Reader) (string, []byte, error) {
	var header [8]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return "", nil, err
	}
	boxSize := binary.BigEndian.Uint32(header[0:4])
	boxType := string(header[4:8])

	if boxSize < 8 {
		return "", nil, fmt.Errorf("invalid box size %d for box %s", boxSize, boxType)
	}

	// Safety cap: single box cannot exceed 20MB
	if boxSize > 20*1024*1024 {
		return "", nil, fmt.Errorf("box size %d exceeds safety limit for box %s", boxSize, boxType)
	}

	boxData := make([]byte, boxSize)
	copy(boxData[:8], header[:])
	payloadSize := int(boxSize) - 8

	if payloadSize > 0 {
		if _, err := io.ReadFull(r, boxData[8:]); err != nil {
			return "", nil, fmt.Errorf("failed to read payload for box %s (%d bytes): %w", boxType, payloadSize, err)
		}
	}

	return boxType, boxData, nil
}

// HandleIngress processes the live fMP4 byte stream from Edge.
func (r *Relay) HandleIngress(ctx context.Context, reader io.Reader) error {
	r.mu.Lock()
	r.isStreaming = true
	r.streamStart = time.Now()
	r.bytesStreamed = 0
	r.hasInit = false
	r.initSegment = nil
	r.lastFragment = nil
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		r.isStreaming = false
		for sub := range r.subscribers {
			close(sub)
			delete(r.subscribers, sub)
		}
		r.mu.Unlock()
		log.Println("[Camera Relay] Ingress stream completed.")
	}()

	log.Println("[Camera Relay] Ingress stream connected. Reading box-aligned fMP4 stream...")

	var initBuf []byte
	var currentMoof []byte

	// Background worker to monitor stopChan or context
	stopDone := make(chan struct{})
	defer close(stopDone)
	go func() {
		select {
		case <-ctx.Done():
		case <-r.stopChan:
			log.Println("[Camera Relay] Stopping ingress stream due to inactivity.")
		case <-stopDone:
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-r.stopChan:
			return nil
		default:
		}

		boxType, boxData, err := readBox(reader)
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("ingress read error: %w", err)
		}

		r.mu.Lock()
		r.bytesStreamed += int64(len(boxData))

		switch boxType {
		case "ftyp":
			initBuf = append(initBuf, boxData...)
		case "moov":
			initBuf = append(initBuf, boxData...)
			r.initSegment = make([]byte, len(initBuf))
			copy(r.initSegment, initBuf)
			r.hasInit = true
			log.Printf("[Camera Relay] Captured fMP4 init segment (%d bytes). Ready for browsers.", len(r.initSegment))

			// Deliver initSegment immediately to any subscribers waiting before hasInit
			for sub := range r.subscribers {
				initCopy := make([]byte, len(r.initSegment))
				copy(initCopy, r.initSegment)
				select {
				case sub <- initCopy:
				default:
				}
			}

		case "moof":
			currentMoof = boxData

		case "mdat":
			if len(currentMoof) > 0 {
				fragment := make([]byte, len(currentMoof)+len(boxData))
				copy(fragment, currentMoof)
				copy(fragment[len(currentMoof):], boxData)
				currentMoof = nil

				// Cache last fragment for instant playback on new viewer joins
				r.lastFragment = fragment

				// Broadcast complete fragment to all active subscribers
				for sub := range r.subscribers {
					select {
					case sub <- fragment:
					default:
						// Subscriber channel full, drop fragment to keep real-time latency
					}
				}
			}

		default:
			if !r.hasInit {
				initBuf = append(initBuf, boxData...)
			} else if len(currentMoof) > 0 {
				currentMoof = append(currentMoof, boxData...)
			}
		}
		r.mu.Unlock()
	}
}

// ServeHTTPStream streams live fMP4 chunks to a browser client using HTTP chunked transfer.
func (r *Relay) ServeHTTPStream(w http.ResponseWriter, req *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported by HTTP server", http.StatusInternalServerError)
		return
	}

	sub, initBurst := r.RegisterViewer()
	defer r.UnregisterViewer(sub)

	// Set streaming headers
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx / proxy buffering
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// If init burst was already sniffed, send it immediately so decoder starts with video instantly
	if len(initBurst) > 0 {
		if _, err := w.Write(initBurst); err != nil {
			return
		}
		flusher.Flush()
	}

	ctx := req.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case fragment, ok := <-sub:
			if !ok {
				return
			}
			if _, err := w.Write(fragment); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// extractFMP4Init scans byte buffer for ftyp followed by moov boxes.
// In ISO BMFF, each box has: [uint32 length] [4-byte type] [payload].
func extractFMP4Init(data []byte) ([]byte, bool) {
	if len(data) < 8 {
		return nil, false
	}

	var offset int
	hasFtyp := false
	hasMoov := false
	var initEnd int

	for offset+8 <= len(data) {
		boxSize := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		boxType := string(data[offset+4 : offset+8])

		if boxSize < 8 {
			break
		}
		if offset+boxSize > len(data) {
			break // Incomplete box in buffer
		}

		if boxType == "ftyp" {
			hasFtyp = true
		} else if boxType == "moov" {
			hasMoov = true
			initEnd = offset + boxSize
			break
		} else if boxType == "moof" {
			// Hit the first media fragment box without seeing moov
			break
		}

		offset += boxSize
	}

	if hasFtyp && hasMoov && initEnd > 0 {
		initBytes := make([]byte, initEnd)
		copy(initBytes, data[:initEnd])
		return initBytes, true
	}

	return nil, false
}
