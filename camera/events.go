package camera

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// CameraEvent represents a recorded sound or motion event with pre-roll context.
type CameraEvent struct {
	ID          string    `json:"id"`
	Timestamp   time.Time `json:"timestamp"`
	TriggerType string    `json:"trigger_type"` // "sound", "motion", or "manual"
	Title       string    `json:"title"`
	DurationSec float64   `json:"duration_sec"`
	PreRollSec  float64   `json:"pre_roll_sec"`
	SizeBytes   int64     `json:"size_bytes"`
	VideoURL    string    `json:"video_url"`
	Summary     string    `json:"summary"`
}

// EventStore manages recorded event clips on disk and in memory.
type EventStore struct {
	dir        string
	mu         sync.RWMutex
	events     map[string]CameraEvent
	indexPath  string
	maxEvents  int
	maxStorage int64 // Maximum bytes to keep on disk
}

// NewEventStore initializes the event store directory and loads existing metadata.
func NewEventStore(baseDir string) *EventStore {
	eventDir := filepath.Join(baseDir, "events")
	_ = os.MkdirAll(eventDir, 0755)

	store := &EventStore{
		dir:        eventDir,
		events:     make(map[string]CameraEvent),
		indexPath:  filepath.Join(eventDir, "events.json"),
		maxEvents:  50,
		maxStorage: 1024 * 1024 * 1024, // 1 GB cap
	}

	store.loadIndex()
	return store
}

// loadIndex loads existing event metadata from events.json on disk.
func (s *EventStore) loadIndex() {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.indexPath)
	if err != nil {
		return
	}

	var list []CameraEvent
	if err := json.Unmarshal(data, &list); err == nil {
		for _, evt := range list {
			s.events[evt.ID] = evt
		}
	}
}

// saveIndex persists the metadata index to disk.
func (s *EventStore) saveIndex() error {
	list := make([]CameraEvent, 0, len(s.events))
	for _, evt := range s.events {
		list = append(list, evt)
	}

	// Sort newest first
	sort.Slice(list, func(i, j int) bool {
		return list[i].Timestamp.After(list[j].Timestamp)
	})

	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(s.indexPath, data, 0644)
}

// List returns all recorded events, newest first, optionally filtered by triggerType.
func (s *EventStore) List(limit int, triggerType string) []CameraEvent {
	s.mu.RLock()
	defer s.mu.RUnlock()

	list := make([]CameraEvent, 0, len(s.events))
	for _, evt := range s.events {
		if triggerType == "" || evt.TriggerType == triggerType {
			list = append(list, evt)
		}
	}

	sort.Slice(list, func(i, j int) bool {
		return list[i].Timestamp.After(list[j].Timestamp)
	})

	if limit > 0 && len(list) > limit {
		list = list[:limit]
	}

	return list
}

// Get returns the event metadata and the absolute file path to its MP4 file.
func (s *EventStore) Get(id string) (*CameraEvent, string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	evt, exists := s.events[id]
	if !exists {
		return nil, "", fmt.Errorf("event %s not found", id)
	}

	filePath := filepath.Join(s.dir, id+".mp4")
	return &evt, filePath, nil
}

// Save stores a new event with its MP4 binary data and updates the index.
func (s *EventStore) Save(evt CameraEvent, mp4Data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if evt.ID == "" {
		evt.ID = generateEventID(evt.Timestamp, evt.TriggerType)
	}
	if evt.Timestamp.IsZero() {
		evt.Timestamp = time.Now()
	}

	filePath := filepath.Join(s.dir, evt.ID+".mp4")
	if err := os.WriteFile(filePath, mp4Data, 0644); err != nil {
		return fmt.Errorf("failed to save event MP4: %w", err)
	}

	evt.SizeBytes = int64(len(mp4Data))
	evt.VideoURL = "/api/camera/events/" + evt.ID + ".mp4"

	s.events[evt.ID] = evt
	_ = s.saveIndex()

	s.pruneOldEventsLocked()
	return nil
}

// pruneOldEventsLocked removes oldest events when exceeding maxEvents or maxStorage.
func (s *EventStore) pruneOldEventsLocked() {
	if len(s.events) <= s.maxEvents {
		return
	}

	list := make([]CameraEvent, 0, len(s.events))
	for _, evt := range s.events {
		list = append(list, evt)
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].Timestamp.Before(list[j].Timestamp) // Oldest first
	})

	for len(list) > s.maxEvents {
		oldest := list[0]
		list = list[1:]
		delete(s.events, oldest.ID)
		_ = os.Remove(filepath.Join(s.dir, oldest.ID+".mp4"))
		log.Printf("[Camera EventStore] Pruned old event: %s", oldest.ID)
	}

	_ = s.saveIndex()
}

func generateEventID(t time.Time, triggerType string) string {
	if t.IsZero() {
		t = time.Now()
	}
	randBytes := make([]byte, 3)
	_, _ = rand.Read(randBytes)
	suffix := hex.EncodeToString(randBytes)
	return fmt.Sprintf("evt_%s_%s_%s", t.Format("20060102_150405"), triggerType, suffix)
}
