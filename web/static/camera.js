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
    if (isStreaming) {
      stopStream(videoEl);
    }
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

    async function onSourceOpen() {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mime);
        // Use default 'segments' mode for multi-track audio+video

        sourceBuffer.addEventListener('updateend', () => {
          if (queue.length > 0 && !sourceBuffer.updating) {
            try {
              sourceBuffer.appendBuffer(queue.shift());
            } catch (e) {}
          }

          // Crucial for reloads: If video currentTime is at 0 or behind the live buffer, seek to live edge!
          if (sourceBuffer.buffered.length > 0) {
            const bStart = sourceBuffer.buffered.start(0);
            const bEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
            if (videoEl.currentTime < bStart || videoEl.currentTime > bEnd) {
              videoEl.currentTime = bStart;
            }
          }

          if (videoEl.paused) {
            videoEl.play().catch(() => {});
          }

          // Prune buffer to keep latency minimal (< 5s memory window)
          if (sourceBuffer.buffered.length > 0) {
            const bStart = sourceBuffer.buffered.start(0);
            if (videoEl.currentTime - bStart > 8 && !sourceBuffer.updating) {
              try {
                sourceBuffer.remove(bStart, videoEl.currentTime - 3);
              } catch (err) {}
            }
          }
        });

        // Hide overlay as soon as playback advances
        videoEl.addEventListener('timeupdate', () => {
          if (videoEl.currentTime > 0) {
            if (loadingOverlay) loadingOverlay.style.display = 'none';
            if (statusBadge) {
              statusBadge.textContent = '● LIVE';
              statusBadge.className = 'camera-live-badge';
            }
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
            if (queue.length > 30) {
              queue.shift(); // Drop oldest fragment to prevent memory ballooning
            }
            queue.push(value);
          } else {
            try {
              sourceBuffer.appendBuffer(value);
            } catch (e) {
              console.warn('[Camera Stream] appendBuffer retry queued:', e);
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
    }

    if (mediaSource.readyState === 'open') {
      onSourceOpen();
    } else {
      mediaSource.addEventListener('sourceopen', onSourceOpen, { once: true });
    }

    videoEl.src = URL.createObjectURL(mediaSource);
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
    if (eventPollTimer) {
      clearInterval(eventPollTimer);
      eventPollTimer = null;
    }
  }

  let currentPlayingEvent = null;
  let activeFilter = '';
  let eventPollTimer = null;

  async function loadEvents(filterType) {
    if (filterType !== undefined) {
      activeFilter = filterType;
    }
    const container = document.getElementById('cameraEventsList');
    const countBadge = document.getElementById('cameraEventsCount');
    if (!container) return;

    try {
      const url = '/api/camera/events' + (activeFilter ? '?type=' + encodeURIComponent(activeFilter) : '');
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const events = data.events || [];

      if (countBadge) {
        countBadge.textContent = `${events.length} clip${events.length === 1 ? '' : 's'}`;
      }

      if (events.length === 0) {
        container.innerHTML = '<div class="camera-events-empty">No activity clips recorded yet. Events appear here automatically on sound spikes or motion.</div>';
        return;
      }

      container.innerHTML = events.map(evt => {
        const isSelected = currentPlayingEvent && currentPlayingEvent.id === evt.id;
        const icon = evt.trigger_type === 'sound' ? '🔊' : (evt.trigger_type === 'motion' ? '🏃' : '📹');
        const badgeColor = evt.trigger_type === 'sound' ? '#38bdf8' : (evt.trigger_type === 'motion' ? '#10b981' : '#f59e0b');
        const timeStr = formatEventTime(evt.timestamp);
        const durationStr = `${Math.round(evt.duration_sec)}s total`;
        const preRollStr = `${Math.round(evt.pre_roll_sec || 20)}s pre-roll`;
        const sizeMb = (evt.size_bytes / (1024 * 1024)).toFixed(1) + ' MB';

        return `
          <div class="camera-event-card ${isSelected ? 'active' : ''}" data-event-id="${escapeHtml(evt.id)}">
            <div class="camera-event-info">
              <div class="camera-event-icon" style="border-color: ${badgeColor};">${icon}</div>
              <div class="camera-event-meta">
                <span class="camera-event-title">${escapeHtml(evt.title)}</span>
                <span class="camera-event-subtext">
                  <span>${escapeHtml(timeStr)}</span> • 
                  <span class="camera-event-pill">${escapeHtml(preRollStr)}</span> • 
                  <span>${escapeHtml(durationStr)}</span> • 
                  <span>${sizeMb}</span>
                </span>
              </div>
            </div>
            <button class="camera-event-play-btn ${isSelected ? 'playing' : ''}" data-event-id="${escapeHtml(evt.id)}">
              ${isSelected ? '⏸ Playing' : '▶ Play Clip'}
            </button>
          </div>
        `;
      }).join('');

      // Attach play listeners
      container.querySelectorAll('.camera-event-play-btn, .camera-event-card').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const evtId = el.getAttribute('data-event-id');
          const found = events.find(item => item.id === evtId);
          if (found) {
            playEvent(found);
          }
        });
      });
    } catch (e) {
      console.warn('[Camera Events] Failed to load events:', e);
    }
  }

  function formatEventTime(ts) {
    if (!ts) return 'Just now';
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' • ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  function playEvent(evt) {
    currentPlayingEvent = evt;
    const videoEl = document.getElementById('cameraVideo');
    const banner = document.getElementById('cameraEventBanner');
    const bannerText = document.getElementById('cameraEventBannerText');
    const statusBadge = document.getElementById('cameraStatusBadge');
    const overlay = document.getElementById('cameraLoadingOverlay');

    if (!videoEl) return;

    // 1. Stop active MSE live stream if running
    if (isStreaming) {
      stopStream(videoEl);
    }

    if (overlay) overlay.style.display = 'none';

    // 2. Point video directly to event MP4 URL
    videoEl.src = evt.video_url;
    videoEl.controls = true; // Enable native scrubber for recorded event!
    videoEl.muted = false;
    videoEl.currentTime = 0;
    videoEl.play().catch(() => {});

    // 3. Update status UI
    if (banner) {
      banner.style.display = 'flex';
      if (bannerText) {
        bannerText.textContent = `⏮ Event Playback: ${evt.title} (${Math.round(evt.duration_sec)}s)`;
      }
    }

    if (statusBadge) {
      statusBadge.textContent = '⏮ CLIP PLAYBACK';
      statusBadge.className = 'camera-live-badge';
      statusBadge.style.background = 'rgba(249, 115, 22, 0.2)';
      statusBadge.style.color = '#fb923c';
      statusBadge.style.borderColor = 'rgba(249, 115, 22, 0.5)';
    }

    // Refresh active state in list
    loadEvents();
  }

  function returnToLive() {
    currentPlayingEvent = null;
    const videoEl = document.getElementById('cameraVideo');
    const banner = document.getElementById('cameraEventBanner');
    const statusBadge = document.getElementById('cameraStatusBadge');
    const overlay = document.getElementById('cameraLoadingOverlay');

    if (!videoEl) return;

    // Reset banner and controls
    if (banner) banner.style.display = 'none';
    videoEl.controls = false;
    if (statusBadge) {
      statusBadge.style.background = '';
      statusBadge.style.color = '';
      statusBadge.style.borderColor = '';
    }

    // Restart live stream
    startStream(videoEl, overlay, statusBadge);

    // Refresh active state in list
    loadEvents();
  }

  async function triggerManualClip() {
    const btn = document.getElementById('cameraTriggerClipBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Capturing...';
    }

    try {
      const res = await fetch('/api/camera/events/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'manual',
          title: 'Manual On-Demand Capture',
          summary: 'User captured 30s clip with rolling pre-roll context',
          pre_roll_sec: 30
        })
      });

      if (res.ok) {
        const data = await res.json();
        await loadEvents();
        if (data && data.id) {
          playEvent(data);
        }
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Failed to trigger event capture: buffer priming or camera starting');
      }
    } catch (e) {
      alert('Error triggering clip: ' + e);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '📸 Record Clip';
      }
    }
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

    // Fullscreen Toggle & Floating Exit Button
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

    const overlayExitBtn = document.getElementById('cameraOverlayExitBtn');
    if (overlayExitBtn) {
      overlayExitBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          closeModal();
        }
      });
    }

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        if (fullscreenBtn) fullscreenBtn.textContent = '✕ Exit Fullscreen';
      } else {
        if (fullscreenBtn) fullscreenBtn.textContent = '⛶ Fullscreen';
      }
    });

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

    // Event clips controls wiring
    const returnLiveBtn = document.getElementById('cameraReturnLiveBtn');
    if (returnLiveBtn) {
      returnLiveBtn.addEventListener('click', returnToLive);
    }

    const triggerClipBtn = document.getElementById('cameraTriggerClipBtn');
    if (triggerClipBtn) {
      triggerClipBtn.addEventListener('click', triggerManualClip);
    }

    modal.querySelectorAll('.camera-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.camera-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadEvents(btn.getAttribute('data-filter') || '');
      });
    });

    cameraBtn.addEventListener('click', () => {
      loadEvents('');
      if (eventPollTimer) clearInterval(eventPollTimer);
      eventPollTimer = setInterval(() => loadEvents(), 10000);
    });
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

    const floatExitBtn = document.getElementById('cameraFloatingExitBtn');
    if (floatExitBtn) {
      floatExitBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
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

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        if (fullscreenBtn) fullscreenBtn.textContent = '✕ Exit Fullscreen';
      } else {
        if (fullscreenBtn) fullscreenBtn.textContent = '⛶ Fullscreen';
      }
    });

    // Event clips controls wiring for Popout View
    const returnLiveBtn = document.getElementById('cameraReturnLiveBtn');
    if (returnLiveBtn) {
      returnLiveBtn.addEventListener('click', returnToLive);
    }

    const triggerClipBtn = document.getElementById('cameraTriggerClipBtn');
    if (triggerClipBtn) {
      triggerClipBtn.addEventListener('click', triggerManualClip);
    }

    document.querySelectorAll('.camera-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.camera-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        loadEvents(btn.getAttribute('data-filter') || '');
      });
    });

    loadEvents('');
    if (eventPollTimer) clearInterval(eventPollTimer);
    eventPollTimer = setInterval(() => loadEvents(), 10000);

    startStream(videoEl, overlay, statusBadge);



    window.addEventListener('beforeunload', () => {
      stopStream(videoEl);
    });
    window.addEventListener('pagehide', () => {
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
