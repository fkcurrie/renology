// ============================================================================
// Renology Cottage Live Camera Module (MSE fMP4 Stream + Audio Controls)
// ============================================================================
const RenologyCamera = (function() {
  let mediaSource = null;
  let sourceBuffer = null;
  let abortController = null;
  let queue = [];
  let isStreaming = false;

  const mimeCodecs = [
    'video/mp4; codecs="avc1.64001f, mp4a.40.2"',
    'video/mp4; codecs="avc1.4d401f, mp4a.40.2"',
    'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
    'video/mp4'
  ];

  function getSupportedMime() {
    if (!window.MediaSource) return null;
    for (const mime of mimeCodecs) {
      if (MediaSource.isTypeSupported(mime)) {
        return mime;
      }
    }
    return null;
  }

  async function checkAvailability() {
    try {
      const res = await fetch('/api/camera/status');
      if (!res.ok) return;
      const data = await res.json();
      const btn = document.getElementById('cameraBtn');
      if (btn && data.available && (data.is_cloud_relay || window.location.search.includes('cam=1'))) {
        btn.style.display = 'inline-flex';
      }
    } catch (e) {
      console.warn('Failed to probe camera status:', e);
    }
  }

  async function fetchTicket() {
    let key = sessionStorage.getItem('renology_cam_key') || '';
    const res = await fetch('/api/camera/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key })
    });

    if (res.status === 401 || res.status === 403) {
      const data = await res.json().catch(() => ({}));
      if (data.key_required) {
        key = prompt('Enter Cottage Cam Access Key:');
        if (!key) {
          throw new Error('Cottage Cam Access Key is required');
        }
        sessionStorage.setItem('renology_cam_key', key);
        return fetchTicket();
      }
      throw new Error(data.error || 'Access denied: camera stream is strictly restricted to Cloud Run dashboard');
    }

    if (!res.ok) {
      throw new Error('Failed to acquire secure camera ticket: HTTP ' + res.status);
    }

    const data = await res.json();
    return data.ticket;
  }

  function startStream(videoEl, loadingOverlay, statusBadge) {
    if (isStreaming) return;
    isStreaming = true;

    if (loadingOverlay) loadingOverlay.style.display = 'flex';
    if (statusBadge) {
      statusBadge.textContent = '● CONNECTING';
      statusBadge.className = 'camera-live-badge connecting';
    }

    const mime = getSupportedMime();
    if (!mime) {
      alert('Your browser does not support HTML5 MediaSource MP4 video playback.');
      stopStream(videoEl);
      return;
    }

    abortController = new AbortController();
    queue = [];
    mediaSource = new MediaSource();
    videoEl.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener('sourceopen', async () => {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mime);
        sourceBuffer.mode = 'sequence';

        sourceBuffer.addEventListener('updateend', () => {
          if (queue.length > 0 && !sourceBuffer.updating) {
            try {
              sourceBuffer.appendBuffer(queue.shift());
            } catch (e) {}
          }

          if (videoEl.paused) {
            videoEl.play().catch(() => {});
          }

          // Prune buffer to keep latency minimal (< 5s memory window)
          if (videoEl.currentTime > 15 && !sourceBuffer.updating) {
            try {
              sourceBuffer.remove(0, videoEl.currentTime - 5);
            } catch (err) {}
          }
        });

        // 1. Acquire secure ephemeral session ticket
        const ticket = await fetchTicket();

        // 2. Begin fetching live chunked stream with ticket
        const response = await fetch('/api/camera/stream?ticket=' + encodeURIComponent(ticket), {
          signal: abortController.signal
        });

        if (!response.ok) {
          throw new Error('Stream request returned HTTP ' + response.status);
        }

        const reader = response.body.getReader();

        // When video starts playing, hide loading overlay and mark LIVE
        videoEl.onplaying = () => {
          if (loadingOverlay) loadingOverlay.style.display = 'none';
          if (statusBadge) {
            statusBadge.textContent = '● LIVE';
            statusBadge.className = 'camera-live-badge';
          }
        };

        // Ensure muted for reliable autoplay policy
        videoEl.muted = true;

        while (isStreaming) {
          const { done, value } = await reader.read();
          if (done) break;

          if (sourceBuffer.updating || queue.length > 0) {
            queue.push(value);
          } else {
            try {
              sourceBuffer.appendBuffer(value);
            } catch (e) {
              queue.push(value);
            }
          }

          if (videoEl.paused) {
            videoEl.play().catch(() => {});
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.error('[Camera Stream] Playback error:', err);
          if (loadingOverlay) {
            const text = loadingOverlay.querySelector('.camera-loading-text');
            if (text) text.textContent = err.message || 'Camera stream ended or reconnecting...';
          }
        }
      }
    });
  }

  function stopStream(videoEl) {
    isStreaming = false;
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    queue = [];
    if (videoEl) {
      videoEl.pause();
      if (videoEl.src) {
        URL.revokeObjectURL(videoEl.src);
        videoEl.removeAttribute('src');
        videoEl.load();
      }
    }
    if (mediaSource && mediaSource.readyState === 'open') {
      try {
        mediaSource.endOfStream();
      } catch (e) {}
    }
    mediaSource = null;
    sourceBuffer = null;
  }

  function initModalView() {
    const cameraBtn = document.getElementById('cameraBtn');
    const modal = document.getElementById('cameraModal');
    const closeBtn = document.getElementById('cameraCloseBtn');
    const popoutBtn = document.getElementById('cameraPopoutBtn');
    const fullscreenBtn = document.getElementById('cameraFullscreenBtn');
    const videoEl = document.getElementById('cameraVideo');
    const overlay = document.getElementById('cameraLoadingOverlay');
    const statusBadge = document.getElementById('cameraStatusBadge');
    const audioToggle = document.getElementById('cameraAudioToggle');
    const audioIcon = document.getElementById('cameraAudioIcon');
    const audioLabel = document.getElementById('cameraAudioLabel');
    const volumeSlider = document.getElementById('cameraVolumeSlider');

    if (!cameraBtn || !modal || !videoEl) return;

    checkAvailability();

    // Open Modal
    cameraBtn.addEventListener('click', () => {
      modal.style.display = 'flex';
      videoEl.muted = true; // Strict autoplay policy
      videoEl.volume = volumeSlider ? parseFloat(volumeSlider.value) : 1.0;
      updateAudioUI(true);
      startStream(videoEl, overlay, statusBadge);
    });

    // Close Modal
    function closeModal() {
      modal.style.display = 'none';
      stopStream(videoEl);
    }

    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    // Close on escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.style.display === 'flex') {
        closeModal();
      }
    });

    // Close on click backdrop outside dialog
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });

    // Popout Button
    if (popoutBtn) {
      popoutBtn.addEventListener('click', () => {
        closeModal();
        const popW = 960;
        const popH = 640;
        const left = (window.screen.width - popW) / 2;
        const top = (window.screen.height - popH) / 2;
        window.open(
          'camera.html',
          'RenologyCottageCamera',
          `width=${popW},height=${popH},left=${left},top=${top},resizable=yes,scrollbars=no,status=no`
        );
      });
    }

    // Fullscreen Toggle
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          const wrapper = document.querySelector('.camera-video-wrapper');
          if (wrapper && wrapper.requestFullscreen) {
            wrapper.requestFullscreen().catch(() => {});
          }
        } else {
          document.exitFullscreen().catch(() => {});
        }
      });
    }

    // Audio Toggle
    function updateAudioUI(muted) {
      if (!audioToggle) return;
      if (muted) {
        audioToggle.className = 'camera-audio-btn muted';
        if (audioIcon) audioIcon.textContent = '🔇';
        if (audioLabel) audioLabel.textContent = 'Audio Muted (Click to Unmute)';
      } else {
        audioToggle.className = 'camera-audio-btn';
        if (audioIcon) audioIcon.textContent = '🔊';
        if (audioLabel) audioLabel.textContent = 'Live Audio Active';
      }
    }

    if (audioToggle) {
      audioToggle.addEventListener('click', () => {
        videoEl.muted = !videoEl.muted;
        updateAudioUI(videoEl.muted);
      });
    }

    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        videoEl.volume = parseFloat(e.target.value);
        if (videoEl.volume > 0 && videoEl.muted) {
          videoEl.muted = false;
          updateAudioUI(false);
        }
      });
    }
  }

  function initPopoutView() {
    const videoEl = document.getElementById('cameraVideo');
    const overlay = document.getElementById('cameraLoadingOverlay');
    const statusBadge = document.getElementById('cameraStatusBadge');
    const fullscreenBtn = document.getElementById('cameraFullscreenBtn');
    const audioToggle = document.getElementById('cameraAudioToggle');
    const audioIcon = document.getElementById('cameraAudioIcon');
    const audioLabel = document.getElementById('cameraAudioLabel');
    const volumeSlider = document.getElementById('cameraVolumeSlider');

    if (!videoEl) return;

    videoEl.muted = true;
    videoEl.volume = volumeSlider ? parseFloat(volumeSlider.value) : 1.0;

    function updateAudioUI(muted) {
      if (!audioToggle) return;
      if (muted) {
        audioToggle.className = 'camera-audio-btn muted';
        if (audioIcon) audioIcon.textContent = '🔇';
        if (audioLabel) audioLabel.textContent = 'Audio Muted (Click to Unmute)';
      } else {
        audioToggle.className = 'camera-audio-btn';
        if (audioIcon) audioIcon.textContent = '🔊';
        if (audioLabel) audioLabel.textContent = 'Live Audio Active';
      }
    }

    if (audioToggle) {
      audioToggle.addEventListener('click', () => {
        videoEl.muted = !videoEl.muted;
        updateAudioUI(videoEl.muted);
      });
    }

    if (volumeSlider) {
      volumeSlider.addEventListener('input', (e) => {
        videoEl.volume = parseFloat(e.target.value);
        if (videoEl.volume > 0 && videoEl.muted) {
          videoEl.muted = false;
          updateAudioUI(false);
        }
      });
    }

    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      });
    }

    startStream(videoEl, overlay, statusBadge);

    window.addEventListener('beforeunload', () => {
      stopStream(videoEl);
    });
  }

  return {
    initModalView,
    initPopoutView,
    startStream,
    stopStream
  };
})();

window.RenologyCamera = RenologyCamera;

// Auto-initialize modal view on main dashboard if element is present
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('cameraBtn')) {
    RenologyCamera.initModalView();
  }
});
