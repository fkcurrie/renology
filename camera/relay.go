package camera

import (
	"bytes"
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
	sub := make(chan []byte, 64)
	r.subscribers[sub] = struct{}{}

	// Signal trigger channel if viewers transition from 0 -> 1
	if r.activeViewers == 1 {
		select {
		case r.triggerChan <- struct{}{}:
		default:
		}
	}

	// Copy init segment if already sniffed
	var initCopy []byte
	if r.hasInit && len(r.initSegment) > 0 {
		initCopy = make([]byte, len(r.initSegment))
		copy(initCopy, r.initSegment)
	}

	return sub, initCopy
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

// HandleIngress processes the live fMP4 byte stream from Edge.
func (r *Relay) HandleIngress(ctx context.Context, reader io.Reader) error {
	r.mu.Lock()
	r.isStreaming = true
	r.streamStart = time.Now()
	r.bytesStreamed = 0
	r.hasInit = false
	r.initSegment = nil
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		r.isStreaming = false
		r.mu.Unlock()
		log.Println("[Camera Relay] Ingress stream completed.")
	}()

	log.Println("[Camera Relay] Ingress stream connected. Reading fMP4 chunks...")

	buf := make([]byte, 32*1024)
	var headerBuf bytes.Buffer

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-r.stopChan:
			log.Println("[Camera Relay] Stopping ingress stream due to inactivity.")
			return nil
		default:
		}

		n, err := reader.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])

			r.mu.Lock()
			r.bytesStreamed += int64(n)

			// 1. Sniff MP4 initialization box (ftyp + moov) if not yet identified
			if !r.hasInit {
				headerBuf.Write(chunk)
				initData, found := extractFMP4Init(headerBuf.Bytes())
				if found {
					r.initSegment = initData
					r.hasInit = true
					log.Printf("[Camera Relay] Captured fMP4 init segment (%d bytes). Ready for browsers.", len(initData))
				}
			}

			// 2. Broadcast chunk to all active subscribers
			for sub := range r.subscribers {
				select {
				case sub <- chunk:
				default:
					// Subscriber channel full, drop frame to maintain real-time latency
				}
			}
			r.mu.Unlock()
		}

		if err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("ingress read error: %w", err)
		}
	}
}

// ServeHTTPStream streams live fMP4 chunks to a browser client using HTTP chunked transfer.
func (r *Relay) ServeHTTPStream(w http.ResponseWriter, req *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported by HTTP server", http.StatusInternalServerError)
		return
	}

	sub, initSegment := r.RegisterViewer()
	defer r.UnregisterViewer(sub)

	// Set streaming headers
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // Disable nginx / proxy buffering
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	// If init segment was already sniffed, send it immediately so decoder starts
	if len(initSegment) > 0 {
		if _, err := w.Write(initSegment); err != nil {
			return
		}
		flusher.Flush()
	}

	ctx := req.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case chunk, ok := <-sub:
			if !ok {
				return
			}
			if _, err := w.Write(chunk); err != nil {
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
