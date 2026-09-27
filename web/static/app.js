/**
 * Renology Solar Kiosk — Frontend Engine
 * 100% Pure Vanilla JS — Zero External Dependencies — 100% Offline
 */

(function () {
  'use strict';

  // --- State ---
  let currentSOC = 100;
  let targetSOC = 100;
  let displayedSOC = 0; // for smooth needle animation
  let historyData = null;
  let isFullscreen = false;

  // --- DOM Elements ---
  const elClock = document.getElementById('clockDisplay');
  const elDeviceName = document.getElementById('deviceName');
  const elModel = document.getElementById('controllerModel');
  const elBattType = document.getElementById('batteryTypeBadge');
  const elChargingState = document.getElementById('chargingStateBadge');
  const elSystemRating = document.getElementById('systemRatingBadge');
  
  const elGaugeSoc = document.getElementById('gaugeSocVal');
  const elGaugeSub = document.getElementById('gaugeStatusSub');
  const elBattV = document.getElementById('battVoltageVal');
  const elBattA = document.getElementById('battCurrentVal');
  const elBattW = document.getElementById('battPowerVal');

  const elSolarPower = document.getElementById('solarPowerVal');
  const elPvV = document.getElementById('pvVoltageVal');
  const elPvA = document.getElementById('pvCurrentVal');
  const elPowerToday = document.getElementById('powerTodayVal');
  const elLifetimeKwh = document.getElementById('lifetimeKwhVal');

  const elCtrlTemp = document.getElementById('ctrlTempVal');
  const elBattTemp = document.getElementById('battTempVal');
  const elLoadStatus = document.getElementById('loadStatusVal');
  const elFaultCode = document.getElementById('faultCodeVal');
  const elRssi = document.getElementById('bleRssiVal');
  const elFullscreenBtn = document.getElementById('fullscreenBtn');

  const elPeak24h = document.getElementById('peak24hBadge');
  const elTotal7d = document.getElementById('total7dBadge');
  const tooltip24h = document.getElementById('tooltip24h');
  const tooltip7d = document.getElementById('tooltip7d');

  // --- Canvases ---
  const canvasGauge = document.getElementById('fuelGaugeCanvas');
  const ctxGauge = canvasGauge ? canvasGauge.getContext('2d') : null;

  const canvas24h = document.getElementById('chart24hCanvas');
  const ctx24h = canvas24h ? canvas24h.getContext('2d') : null;

  const canvas7d = document.getElementById('chart7dCanvas');
  const ctx7d = canvas7d ? canvas7d.getContext('2d') : null;

  // --- Clock ---
  function updateClock() {
    const now = new Date();
    elClock.textContent = now.toTimeString().split(' ')[0];
  }
  setInterval(updateClock, 1000);
  updateClock();

  // --- High-DPI Canvas Scaling ---
  function setupHiDPI(canvas, ctx) {
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.width;
    const height = rect.height || canvas.height;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.resetTransform();
    ctx.scale(dpr, dpr);
    return { width, height };
  }

  // =========================================================================
  // AUTOMOTIVE FUEL GAUGE DIAL
  // =========================================================================
  // Sweeps from 145 deg (left, E) to 35 deg (right, F)
  const START_ANGLE = 0.82 * Math.PI; // ~147 degrees
  const END_ANGLE = 2.18 * Math.PI;   // ~392 degrees (32 degrees past circle)
  const SWEEP_ANGLE = END_ANGLE - START_ANGLE;

  function socToAngle(soc) {
    const clamped = Math.max(0, Math.min(100, soc));
    return START_ANGLE + (clamped / 100.0) * SWEEP_ANGLE;
  }

  function drawFuelGauge() {
    if (!ctxGauge) return;
    const dims = setupHiDPI(canvasGauge, ctxGauge);
    if (!dims) return;
    const w = dims.width;
    const h = dims.height;
    const cx = w / 2;
    const cy = h * 0.72;
    const r = Math.min(w * 0.44, h * 0.62);

    ctxGauge.clearRect(0, 0, w, h);

    // 1. Gauge Background Track
    ctxGauge.beginPath();
    ctxGauge.arc(cx, cy, r, START_ANGLE, END_ANGLE);
    ctxGauge.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctxGauge.lineWidth = 14;
    ctxGauge.lineCap = 'round';
    ctxGauge.stroke();

    // 2. Color-Coded Zones
    // Red reserve (0-20%)
    ctxGauge.beginPath();
    ctxGauge.arc(cx, cy, r, socToAngle(0), socToAngle(20));
    ctxGauge.strokeStyle = '#ef4444';
    ctxGauge.lineWidth = 14;
    ctxGauge.stroke();

    // Amber mid zone (20-50%)
    ctxGauge.beginPath();
    ctxGauge.arc(cx, cy, r, socToAngle(20), socToAngle(50));
    ctxGauge.strokeStyle = '#f59e0b';
    ctxGauge.lineWidth = 14;
    ctxGauge.stroke();

    // Emerald full zone (50-100%)
    ctxGauge.beginPath();
    ctxGauge.arc(cx, cy, r, socToAngle(50), socToAngle(100));
    ctxGauge.strokeStyle = '#10b981';
    ctxGauge.lineWidth = 14;
    ctxGauge.lineCap = 'round';
    ctxGauge.stroke();

    // 3. Active Fill Glow Arc up to displayedSOC
    if (displayedSOC > 1) {
      ctxGauge.beginPath();
      ctxGauge.arc(cx, cy, r, START_ANGLE, socToAngle(displayedSOC));
      ctxGauge.strokeStyle = displayedSOC <= 20 ? '#ef4444' : displayedSOC <= 50 ? '#f59e0b' : '#34d399';
      ctxGauge.lineWidth = 6;
      ctxGauge.shadowColor = ctxGauge.strokeStyle;
      ctxGauge.shadowBlur = 10;
      ctxGauge.stroke();
      ctxGauge.shadowBlur = 0; // reset
    }

    // 4. Tick Marks & Calibrations
    const tickCount = 20; // Every 5%
    for (let i = 0; i <= tickCount; i++) {
      const pct = (i / tickCount) * 100;
      const angle = socToAngle(pct);
      const isMajor = (i % 5 === 0); // 0, 25, 50, 75, 100
      const innerR = isMajor ? r - 22 : r - 15;
      const outerR = r - 8;

      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      ctxGauge.beginPath();
      ctxGauge.moveTo(cx + innerR * cos, cy + innerR * sin);
      ctxGauge.lineTo(cx + outerR * cos, cy + outerR * sin);
      ctxGauge.strokeStyle = isMajor ? '#ffffff' : 'rgba(255, 255, 255, 0.3)';
      ctxGauge.lineWidth = isMajor ? 2.5 : 1.2;
      ctxGauge.stroke();

      // Major labels (E, 1/4, 1/2, 3/4, F)
      if (isMajor) {
        const textR = r - 35;
        const tx = cx + textR * cos;
        const ty = cy + textR * sin;
        ctxGauge.save();
        ctxGauge.font = 'bold 12px ' + getComputedStyle(document.body).fontFamily;
        ctxGauge.textAlign = 'center';
        ctxGauge.textBaseline = 'middle';
        
        let label = '';
        if (pct === 0) {
          label = 'E';
          ctxGauge.fillStyle = '#ef4444';
        } else if (pct === 25) {
          label = '1/4';
          ctxGauge.fillStyle = '#94a3b8';
        } else if (pct === 50) {
          label = '1/2';
          ctxGauge.fillStyle = '#e2e8f0';
        } else if (pct === 75) {
          label = '3/4';
          ctxGauge.fillStyle = '#94a3b8';
        } else if (pct === 100) {
          label = 'F';
          ctxGauge.fillStyle = '#10b981';
        }
        ctxGauge.fillText(label, tx, ty);
        ctxGauge.restore();
      }
    }

    // 5. Automotive Needle
    const needleAngle = socToAngle(displayedSOC);
    const needleLen = r - 6;
    const needleBaseW = 7;

    ctxGauge.save();
    ctxGauge.translate(cx, cy);
    ctxGauge.rotate(needleAngle);

    // Needle shadow
    ctxGauge.beginPath();
    ctxGauge.moveTo(0, -needleBaseW);
    ctxGauge.lineTo(needleLen, 0);
    ctxGauge.lineTo(0, needleBaseW);
    ctxGauge.lineTo(-16, 0);
    ctxGauge.closePath();
    ctxGauge.fillStyle = '#f87171';
    ctxGauge.shadowColor = '#ef4444';
    ctxGauge.shadowBlur = 12;
    ctxGauge.fill();

    // Needle tip highlight
    ctxGauge.beginPath();
    ctxGauge.moveTo(needleLen - 30, 0);
    ctxGauge.lineTo(needleLen, 0);
    ctxGauge.strokeStyle = '#ffffff';
    ctxGauge.lineWidth = 2.5;
    ctxGauge.stroke();

    ctxGauge.restore();

    // 6. Needle Metallic Center Hub Cap
    ctxGauge.beginPath();
    ctxGauge.arc(cx, cy, 18, 0, 2 * Math.PI);
    const hubGrad = ctxGauge.createRadialGradient(cx - 3, cy - 3, 2, cx, cy, 18);
    hubGrad.addColorStop(0, '#64748b');
    hubGrad.addColorStop(0.6, '#1e293b');
    hubGrad.addColorStop(1, '#0f172a');
    ctxGauge.fillStyle = hubGrad;
    ctxGauge.fill();
    ctxGauge.strokeStyle = '#94a3b8';
    ctxGauge.lineWidth = 2;
    ctxGauge.stroke();

    ctxGauge.beginPath();
    ctxGauge.arc(cx, cy, 6, 0, 2 * Math.PI);
    ctxGauge.fillStyle = '#f87171';
    ctxGauge.fill();
  }

  // Smooth needle damping loop
  function animateNeedle() {
    const diff = targetSOC - displayedSOC;
    if (Math.abs(diff) > 0.1) {
      displayedSOC += diff * 0.12;
      drawFuelGauge();
    }
    requestAnimationFrame(animateNeedle);
  }
  requestAnimationFrame(animateNeedle);

  // =========================================================================
  // 24-HOUR SOLAR POWER CHART
  // =========================================================================
  function draw24hChart(points) {
    if (!ctx24h || !points || points.length === 0) return;
    const dims = setupHiDPI(canvas24h, ctx24h);
    if (!dims) return;
    const w = dims.width;
    const h = dims.height;

    const padLeft = 45;
    const padRight = 20;
    const padTop = 15;
    const padBottom = 28;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    ctx24h.clearRect(0, 0, w, h);

    // Find max Watts
    let maxW = 50;
    points.forEach(p => {
      if (p.solar_power_w > maxW) maxW = p.solar_power_w;
    });
    maxW = Math.ceil(maxW / 50) * 50; // round up to multiple of 50W
    elPeak24h.textContent = `24h Peak: ${maxW} W`;

    // 1. Grid Lines & Y-Axis Labels
    ctx24h.font = '10px var(--font-mono)';
    ctx24h.fillStyle = '#64748b';
    ctx24h.textAlign = 'right';

    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const yVal = Math.round((maxW / ySteps) * i);
      const yPos = padTop + plotH - (i / ySteps) * plotH;

      ctx24h.beginPath();
      ctx24h.moveTo(padLeft, yPos);
      ctx24h.lineTo(w - padRight, yPos);
      ctx24h.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx24h.lineWidth = 1;
      ctx24h.stroke();

      ctx24h.fillText(`${yVal}W`, padLeft - 6, yPos + 3);
    }

    // 2. Build Solar Path Points
    const coords = [];
    points.forEach((p, idx) => {
      const x = padLeft + (idx / (points.length - 1)) * plotW;
      const y = padTop + plotH - (p.solar_power_w / maxW) * plotH;
      coords.push({ x, y, p });
    });

    // 3. Fill Gradient Area
    ctx24h.beginPath();
    ctx24h.moveTo(coords[0].x, padTop + plotH);
    coords.forEach(pt => ctx24h.lineTo(pt.x, pt.y));
    ctx24h.lineTo(coords[coords.length - 1].x, padTop + plotH);
    ctx24h.closePath();

    const areaGrad = ctx24h.createLinearGradient(0, padTop, 0, padTop + plotH);
    areaGrad.addColorStop(0, 'rgba(245, 158, 11, 0.45)');
    areaGrad.addColorStop(0.7, 'rgba(245, 158, 11, 0.08)');
    areaGrad.addColorStop(1, 'rgba(245, 158, 11, 0.00)');
    ctx24h.fillStyle = areaGrad;
    ctx24h.fill();

    // 4. Solar Watts Stroke Line
    ctx24h.beginPath();
    coords.forEach((pt, idx) => {
      if (idx === 0) ctx24h.moveTo(pt.x, pt.y);
      else ctx24h.lineTo(pt.x, pt.y);
    });
    ctx24h.strokeStyle = '#f59e0b';
    ctx24h.lineWidth = 2.5;
    ctx24h.shadowColor = 'rgba(245, 158, 11, 0.6)';
    ctx24h.shadowBlur = 8;
    ctx24h.stroke();
    ctx24h.shadowBlur = 0;

    // 5. Battery SOC Overlay Line (Dashed Emerald)
    ctx24h.beginPath();
    ctx24h.setLineDash([4, 4]);
    points.forEach((p, idx) => {
      const x = padLeft + (idx / (points.length - 1)) * plotW;
      const y = padTop + plotH - (p.battery_soc / 100.0) * plotH;
      if (idx === 0) ctx24h.moveTo(x, y);
      else ctx24h.lineTo(x, y);
    });
    ctx24h.strokeStyle = 'rgba(16, 185, 129, 0.65)';
    ctx24h.lineWidth = 1.5;
    ctx24h.stroke();
    ctx24h.setLineDash([]); // reset

    // 6. X-Axis Time Labels (e.g. every 6 hours)
    ctx24h.textAlign = 'center';
    ctx24h.fillStyle = '#94a3b8';
    const xInterval = Math.floor(points.length / 4);
    for (let i = 0; i < points.length; i += xInterval) {
      const pt = coords[i];
      if (pt) {
        ctx24h.fillText(pt.p.time_label, pt.x, h - 8);
      }
    }
  }

  // =========================================================================
  // 7-DAY SOLAR ENERGY CHART
  // =========================================================================
  function draw7dChart(days) {
    if (!ctx7d || !days || days.length === 0) return;
    const dims = setupHiDPI(canvas7d, ctx7d);
    if (!dims) return;
    const w = dims.width;
    const h = dims.height;

    const padLeft = 40;
    const padRight = 15;
    const padTop = 22;
    const padBottom = 28;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    ctx7d.clearRect(0, 0, w, h);

    // Calculate max Energy Wh
    let maxWh = 200;
    let totalWh = 0;
    days.forEach(d => {
      totalWh += d.energy_wh;
      if (d.energy_wh > maxWh) maxWh = d.energy_wh;
    });
    maxWh = Math.ceil(maxWh / 100) * 100;
    elTotal7d.textContent = `7-Day Total: ${(totalWh / 1000).toFixed(2)} kWh`;

    // 1. Grid Lines
    ctx7d.font = '10px var(--font-mono)';
    ctx7d.fillStyle = '#64748b';
    ctx7d.textAlign = 'right';

    const ySteps = 3;
    for (let i = 0; i <= ySteps; i++) {
      const yVal = Math.round((maxWh / ySteps) * i);
      const yPos = padTop + plotH - (i / ySteps) * plotH;

      ctx7d.beginPath();
      ctx7d.moveTo(padLeft, yPos);
      ctx7d.lineTo(w - padRight, yPos);
      ctx7d.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx7d.stroke();

      ctx7d.fillText(`${yVal}Wh`, padLeft - 4, yPos + 3);
    }

    // 2. Bars
    const barCount = days.length;
    const colW = plotW / barCount;
    const barW = Math.max(16, colW * 0.58);

    days.forEach((d, idx) => {
      const cx = padLeft + idx * colW + colW / 2;
      const barH = (d.energy_wh / maxWh) * plotH;
      const bx = cx - barW / 2;
      const by = padTop + plotH - barH;

      // Bar gradient
      const barGrad = ctx7d.createLinearGradient(0, by, 0, padTop + plotH);
      if (d.day_label === 'Today') {
        barGrad.addColorStop(0, '#f59e0b');
        barGrad.addColorStop(1, '#78350f');
      } else {
        barGrad.addColorStop(0, '#06b6d4');
        barGrad.addColorStop(1, '#0e3a47');
      }

      ctx7d.beginPath();
      ctx7d.roundRect ? ctx7d.roundRect(bx, by, barW, barH, [4, 4, 0, 0]) : ctx7d.rect(bx, by, barW, barH);
      ctx7d.fillStyle = barGrad;
      ctx7d.fill();

      // Peak Watts Badge above bar
      if (d.peak_solar_w > 0) {
        ctx7d.font = 'bold 9px var(--font-mono)';
        ctx7d.textAlign = 'center';
        ctx7d.fillStyle = '#fbbf24';
        ctx7d.fillText(`${d.peak_solar_w}W`, cx, by - 6);
      }

      // X-Axis Day Label
      ctx7d.font = (d.day_label === 'Today' ? 'bold 11px ' : '10px ') + 'var(--font-family)';
      ctx7d.fillStyle = d.day_label === 'Today' ? '#f59e0b' : '#cbd5e1';
      ctx7d.textAlign = 'center';
      ctx7d.fillText(d.day_label, cx, h - 8);
    });
  }

  // =========================================================================
  // API FETCH & REAL-TIME POLLING
  // =========================================================================
  async function fetchStatus() {
    try {
      const resp = await fetch('/api/status');
      if (!resp.ok) return;
      const t = await resp.json();

      // Update Device Header
      if (t.device_name) elDeviceName.textContent = t.device_name;
      if (t.model) elModel.textContent = t.model;
      if (t.battery_type) elBattType.textContent = t.battery_type;
      if (t.charging_status) elChargingState.textContent = `${t.charging_status} Active`;

      if (t.rated_voltage_v && t.rated_current_a) {
        elSystemRating.textContent = `${t.rated_current_a}A • ${t.rated_voltage_v}V System`;
      }

      // Update Battery Dial & Metrics
      targetSOC = t.battery_soc_percent || 0;
      elGaugeSoc.innerHTML = `${targetSOC}<span class="unit">%</span>`;

      if (targetSOC >= 98) {
        elGaugeSub.textContent = 'FULLY CHARGED';
        elGaugeSub.style.color = '#10b981';
      } else if (targetSOC <= 20) {
        elGaugeSub.textContent = 'LOW BATTERY RESERVE';
        elGaugeSub.style.color = '#ef4444';
      } else {
        elGaugeSub.textContent = 'NORMAL DISCHARGE';
        elGaugeSub.style.color = '#f59e0b';
      }

      elBattV.innerHTML = `${(t.battery_voltage_v || 0).toFixed(1)}<span class="unit">V</span>`;
      elBattA.innerHTML = `${(t.battery_current_a || 0).toFixed(2)}<span class="unit">A</span>`;
      elBattW.innerHTML = `${(t.battery_power_w || 0).toFixed(1)}<span class="unit">W</span>`;

      // Update Solar PV
      elSolarPower.textContent = t.pv_power_w || 0;
      elPvV.innerHTML = `${(t.pv_voltage_v || 0).toFixed(1)}<span class="unit">V</span>`;
      elPvA.innerHTML = `${(t.pv_current_a || 0).toFixed(2)}<span class="unit">A</span>`;
      elPowerToday.innerHTML = `${t.power_generation_today_wh || 0}<span class="unit">Wh</span>`;
      if (t.power_generation_total_kwh) {
        elLifetimeKwh.textContent = `${t.power_generation_total_kwh.toLocaleString()} kWh`;
      }

      // Update System Thermals & Status
      elCtrlTemp.textContent = `${t.controller_temp_c || 0}°C`;
      elBattTemp.textContent = `${t.battery_temp_c || 0}°C`;
      elLoadStatus.textContent = `${t.load_status || 'Off'} (${t.load_power_w || 0}W)`;

      if (t.fault_code === 0) {
        elFaultCode.textContent = '0 (Normal)';
        elFaultCode.className = 'stat-number normal-status';
      } else {
        elFaultCode.textContent = `Alert (0x${t.fault_code.toString(16)})`;
        elFaultCode.className = 'stat-number highlight-val';
      }

      if (t.rssi) {
        elRssi.textContent = `${t.rssi} dBm`;
      }
    } catch (err) {
      console.warn('Status poll error:', err);
    }
  }

  async function fetchHistory() {
    try {
      const resp = await fetch('/api/history');
      if (!resp.ok) return;
      historyData = await resp.json();

      if (historyData.points_24h) {
        draw24hChart(historyData.points_24h);
      }
      if (historyData.days_7d) {
        draw7dChart(historyData.days_7d);
      }
    } catch (err) {
      console.warn('History poll error:', err);
    }
  }

  // --- Fullscreen API ---
  if (elFullscreenBtn) {
    elFullscreenBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => {
          console.warn('Fullscreen error:', err);
        });
      } else {
        document.exitFullscreen();
      }
    });

    document.addEventListener('fullscreenchange', () => {
      isFullscreen = !!document.fullscreenElement;
      elFullscreenBtn.textContent = isFullscreen ? '✕ Exit' : '⛶ Fullscreen';
      // Redraw charts on resize
      setTimeout(() => {
        drawFuelGauge();
        if (historyData) {
          if (historyData.points_24h) draw24hChart(historyData.points_24h);
          if (historyData.days_7d) draw7dChart(historyData.days_7d);
        }
      }, 100);
    });
  }

  window.addEventListener('resize', () => {
    drawFuelGauge();
    if (historyData) {
      if (historyData.points_24h) draw24hChart(historyData.points_24h);
      if (historyData.days_7d) draw7dChart(historyData.days_7d);
    }
  });

  // --- Initial Launch ---
  drawFuelGauge();
  fetchStatus();
  fetchHistory();

  // Polling intervals: 2s for live status, 60s for historical aggregation
  setInterval(fetchStatus, 2000);
  setInterval(fetchHistory, 60000);

})();
