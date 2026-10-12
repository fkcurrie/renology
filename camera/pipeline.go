package camera

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// VideoSourceType defines how video is captured.
type VideoSourceType string

const (
	SourceLibcamera VideoSourceType = "libcamera" // Surface Go 2 internal camera (OV5693 / OV8865)
	SourceV4L2      VideoSourceType = "v4l2"      // Standard USB webcam or V4L2 loopback (/dev/video*)
	SourceTest      VideoSourceType = "test"      // Diagnostic test pattern slate with live audio
)

// PipelineConfig configures GStreamer video and audio capture.
type PipelineConfig struct {
	Width       int
	Height      int
	Framerate   int
	VideoSource VideoSourceType
	DevicePath  string        // For V4L2 (e.g. /dev/video0)
	CameraName  string        // For libcamera (e.g. \_SB_.PCI0.I2C2.CAMF)
	MaxDuration time.Duration // Watchdog timeout (e.g. 15 minutes)
}

// Pipeline supervises a running GStreamer process.
type Pipeline struct {
	config    PipelineConfig
	mu        sync.Mutex
	cmd       *exec.Cmd
	stdout    io.ReadCloser
	cancel    context.CancelFunc
	isRunning bool
	startTime time.Time
}

// NewPipeline creates a new camera and audio streaming pipeline.
func NewPipeline(cfg PipelineConfig) *Pipeline {
	if cfg.Width <= 0 {
		cfg.Width = 1280
	}
	if cfg.Height <= 0 {
		cfg.Height = 720
	}
	if cfg.Framerate <= 0 {
		cfg.Framerate = 30
	}
	if cfg.MaxDuration <= 0 {
		cfg.MaxDuration = 15 * time.Minute
	}
	if cfg.VideoSource == "" {
		cfg.VideoSource = DetectAvailableSource()
	}
	if cfg.VideoSource == SourceLibcamera && cfg.CameraName == "" {
		// Default to front camera on Surface Go 2 (OV5693 / CSI-2 receiver 1)
		// Double-escaped for GStreamer CLI parser
		cfg.CameraName = `\\\\_SB_.PCI0.LNK1`
	}

	return &Pipeline{
		config: cfg,
	}
}

// isSurfaceIPU3Hardware checks if the host is a Surface Go device with Intel IPU3 camera subsystem.
func isSurfaceIPU3Hardware() bool {
	// 1. Check for Intel IPU3 CIO2 driver in sysfs
	if _, err := os.Stat("/sys/bus/pci/drivers/ipu3-cio2"); err == nil {
		return true
	}
	// 2. Check DMI product name for Surface Go
	if data, err := os.ReadFile("/sys/class/dmi/id/product_name"); err == nil {
		name := strings.ToLower(string(data))
		if strings.Contains(name, "surface go") {
			return true
		}
	}
	return false
}

// DetectAvailableSource inspects system devices to pick the best video source.
func DetectAvailableSource() VideoSourceType {
	// 1. Check for standard external V4L2 capture devices (e.g. external USB webcam)
	matches, err := filepath.Glob("/dev/video*")
	if err == nil {
		for _, dev := range matches {
			// Test if device can be opened for reading
			if f, err := os.Open(dev); err == nil {
				f.Close()
				// Only choose V4L2 if it's not the unlinked IPU3 dummy node
				// External USB webcams generally appear at /dev/video0 or higher with uvcvideo
				if isUVCVideo(dev) {
					return SourceV4L2
				}
			}
		}
	}

	// 2. Surface Go internal IPU3 CSI-2 camera check (OV5693 front / OV8865 back)
	// Surface hardware has dedicated MIPI CSI-2 sensors driven via libcamerasrc.
	// Even if cam -l fails temporarily because surface-motion-wake holds /dev/media0
	// while the screen is asleep, the physical sensors exist and will be used once the screen wakes.
	if isSurfaceIPU3Hardware() {
		return SourceLibcamera
	}

	// 3. Check if libcamera has enumerated cameras
	if _, err := exec.LookPath("cam"); err == nil {
		out, err := exec.Command("cam", "-l").Output()
		if err == nil && len(out) > 0 {
			outStr := string(out)
			if containsAny(outStr, "Internal front camera", "Internal back camera", "OV5693", "OV8865") {
				return SourceLibcamera
			}
		}
	}

	// 4. Fallback to live diagnostic slate with real-time audio
	return SourceTest
}

func isUVCVideo(devPath string) bool {
	// Check sysfs driver link for uvcvideo
	base := filepath.Base(devPath)
	driverPath := filepath.Join("/sys/class/video4linux", base, "device/driver")
	target, err := os.Readlink(driverPath)
	if err == nil && filepath.Base(target) == "uvcvideo" {
		return true
	}
	return false
}

func containsAny(s string, substrates ...string) bool {
	for _, sub := range substrates {
		if len(sub) > 0 && len(s) >= len(sub) {
			for i := 0; i+len(sub) <= len(s); i++ {
				if s[i:i+len(sub)] == sub {
					return true
				}
			}
		}
	}
	return false
}

// BuildGStreamerArgs constructs the gst-launch-1.0 command line.
func (p *Pipeline) BuildGStreamerArgs() []string {
	var videoSrc string

	switch p.config.VideoSource {
	case SourceLibcamera:
		camName := p.config.CameraName
		if camName == "" {
			camName = "_SB_.PCI0.LNK1"
		}
		cleanName := strings.TrimLeft(camName, `\`)
		gstCamName := "\\\\" + cleanName
		videoSrc = fmt.Sprintf("libcamerasrc camera-name='%s' ! video/x-raw,width=%d,height=%d,framerate=%d/1",
			gstCamName, p.config.Width, p.config.Height, p.config.Framerate)

		case SourceV4L2:
		dev := p.config.DevicePath
		if dev == "" {
			dev = "/dev/video0"
		}
		videoSrc = fmt.Sprintf("v4l2src device=%s ! video/x-raw,width=%d,height=%d,framerate=%d/1",
			dev, p.config.Width, p.config.Height, p.config.Framerate)

	default: // SourceTest
		videoSrc = fmt.Sprintf("videotestsrc is-live=true pattern=ball ! video/x-raw,width=%d,height=%d,framerate=%d/1",
			p.config.Width, p.config.Height, p.config.Framerate)
	}

	// Hardware VA-API encoding is tested and verified on Intel UHD 615 GPU
	// -q is critical to prevent gst-launch from printing status text to stdout (which corrupts fMP4 stream)
	args := []string{
		"-q",
		"-e",
	}

	// Video Branch: source -> VAAPI H.264 encode -> parse -> queue -> muxer
	videoPipeline := fmt.Sprintf("%s ! vaapih264enc ! h264parse ! queue ! mux.video_0", videoSrc)

	// Audio Branch: PulseAudio/PipeWire -> convert -> AAC encode -> parse -> queue -> muxer
	audioPipeline := "pulsesrc ! audioconvert ! avenc_aac bitrate=128000 ! aacparse ! queue ! mux.audio_0"

	// Muxer & Output: fragmented MP4 streaming to stdout (fd=1)
	muxPipeline := "mp4mux name=mux fragment-duration=500 streamable=true ! fdsink fd=1"

	// Split pipeline into elements for exec.Command
	// Note: We run gst-launch-1.0 with raw bash string or parsed tokens
	fullPipeline := fmt.Sprintf("%s %s %s", videoPipeline, audioPipeline, muxPipeline)
	args = append(args, stringsFields(fullPipeline)...)

	return args
}

// Start launches the GStreamer streaming subprocess and returns stdout stream.
func (p *Pipeline) Start(parentCtx context.Context) (io.ReadCloser, error) {
	p.mu.Lock()
	if p.isRunning {
		p.mu.Unlock()
		return nil, fmt.Errorf("camera pipeline is already running")
	}

	gstBin, err := exec.LookPath("gst-launch-1.0")
	if err != nil {
		p.mu.Unlock()
		return nil, fmt.Errorf("gst-launch-1.0 not found in PATH: %w", err)
	}

	ctx, cancel := context.WithTimeout(parentCtx, p.config.MaxDuration)
	p.cancel = cancel

	args := p.BuildGStreamerArgs()
	cmd := exec.CommandContext(ctx, gstBin, args...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		p.mu.Unlock()
		cancel()
		return nil, fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	cmd.Stderr = os.Stderr // Log GStreamer warnings/errors to daemon logs

	if err := cmd.Start(); err != nil {
		p.mu.Unlock()
		cancel()
		return nil, fmt.Errorf("failed to start gstreamer: %w", err)
	}

	p.cmd = cmd
	p.stdout = stdout
	p.isRunning = true
	p.startTime = time.Now()
	p.mu.Unlock()

	log.Printf("[Camera Pipeline] Started GStreamer PID %d (source: %s, %dx%d @ %dfps)",
		cmd.Process.Pid, p.config.VideoSource, p.config.Width, p.config.Height, p.config.Framerate)

	// Monitor exit in background
	go func() {
		err := cmd.Wait()
		p.mu.Lock()
		p.isRunning = false
		p.mu.Unlock()
		if err != nil {
			log.Printf("[Camera Pipeline] Process exited with: %v", err)
		} else {
			log.Printf("[Camera Pipeline] Process stopped cleanly.")
		}
	}()

	// Brief check to verify pipeline didn't fail immediately on device link/caps error
	time.Sleep(150 * time.Millisecond)
	if !p.IsRunning() {
		cancel()
		return nil, fmt.Errorf("gstreamer process exited immediately during pipeline initialization")
	}

	return stdout, nil
}

// Stop cleanly terminates the GStreamer pipeline without deadlocking the mutex.
func (p *Pipeline) Stop() {
	p.mu.Lock()
	if !p.isRunning || p.cmd == nil || p.cmd.Process == nil {
		p.mu.Unlock()
		return
	}

	proc := p.cmd.Process
	cancel := p.cancel
	p.mu.Unlock()

	log.Printf("[Camera Pipeline] Stopping GStreamer PID %d...", proc.Pid)

	// Send SIGINT first to allow mp4mux to flush cleanly
	_ = proc.Signal(syscall.SIGINT)

	// Wait up to 2 seconds for process to exit outside of mutex lock
	done := make(chan struct{})
	go func() {
		for i := 0; i < 20; i++ {
			if !p.IsRunning() {
				close(done)
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
		// If still running after 2s, force kill
		_ = proc.Kill()
		close(done)
	}()

	<-done
	if cancel != nil {
		cancel()
	}

	p.mu.Lock()
	p.isRunning = false
	p.mu.Unlock()
}

// IsRunning returns whether the pipeline process is currently active.
func (p *Pipeline) IsRunning() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.isRunning
}

// SetVideoSource updates the configured video source and applies defaults if needed.
func (p *Pipeline) SetVideoSource(src VideoSourceType) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.config.VideoSource = src
	if src == SourceLibcamera && p.config.CameraName == "" {
		p.config.CameraName = `\\\\_SB_.PCI0.LNK1`
	}
}

// GetVideoSource returns the current configured video source.
func (p *Pipeline) GetVideoSource() VideoSourceType {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.config.VideoSource
}

// stringsFields splits pipeline string taking simple quotes into account.
func stringsFields(s string) []string {
	var args []string
	var current []rune
	inQuote := false
	quoteChar := rune(0)

	for _, r := range s {
		if inQuote {
			if r == quoteChar {
				inQuote = false
			} else {
				current = append(current, r)
			}
		} else {
			if r == '\'' || r == '"' {
				inQuote = true
				quoteChar = r
			} else if r == ' ' || r == '\t' || r == '\n' {
				if len(current) > 0 {
					args = append(args, string(current))
					current = nil
				}
			} else {
				current = append(current, r)
			}
		}
	}
	if len(current) > 0 {
		args = append(args, string(current))
	}
	return args
}
