/**
 * Renology Solar Kiosk — Frontend Engine
 * 100% Pure Vanilla JS — Zero External Dependencies — 100% Offline
 * Features:
 *   - Automotive Battery Fuel Gauge (E to F, 0-100%, damping physics)
 *   - Automotive Solar Panel Voltage Speedometer (0-100V, redline, dial ticks)
 *   - Local Weather Station Integration (192.168.0.163:8088 /api/weather)
 *   - Dynamic Viewport Scaling & HiDPI Retina support
 *   - Animated Heartbeat Connection Monitor (< 18s freshness check)
 *   - 24-Hour Diurnal Cycle & 7-Day Production Charts
 */

(function () {
  'use strict';

  // --- State ---
  let targetSOC = 100;
  let displayedSOC = 0; // for smooth needle animation
  let targetPvVolts = 0;
  let displayedPvVolts = 0; // for smooth speedometer needle animation
  let historyData = null;
  let isFullscreen = false;

  // --- DOM Elements ---
  const elClock = document.getElementById('clockDisplay');
  const elHeartbeatContainer = document.getElementById('heartbeatContainer');
  const elHeartbeatIcon = document.getElementById('heartbeatIcon');
  const elHeartbeatLabel = document.getElementById('heartbeatLabel');
  const elDeviceName = document.getElementById('deviceName');
  const elModel = document.getElementById('controllerModel');
  const elBattType = document.getElementById('batteryTypeBadge');
  const elChargingState = document.getElementById('chargingStateBadge');
  const elSystemRating = document.getElementById('systemRatingBadge');
  
  // Header Weather Capsule
  const elHdrWeatherTemp = document.getElementById('hdrWeatherTemp');
  const elHdrWeatherHum = document.getElementById('hdrWeatherHum');
  const elHdrWeatherSolar = document.getElementById('hdrWeatherSolar');

  // Battery Card
  const elGaugeSoc = document.getElementById('gaugeSocVal');
  const elGaugeSub = document.getElementById('gaugeStatusSub');
  const elBattV = document.getElementById('battVoltageVal');
  const elBattA = document.getElementById('battCurrentVal');
  const elBattW = document.getElementById('battPowerVal');

  // Speedometer & Solar Card
  const elSpeedoVolts = document.getElementById('speedoVoltsVal');
  const elSolarPower = document.getElementById('solarPowerVal');
  const elPvV = document.getElementById('pvVoltageVal');
  const elPvA = document.getElementById('pvCurrentVal');
  const elPowerToday = document.getElementById('powerTodayVal');
  const elLifetimeKwh = document.getElementById('lifetimeKwhVal');

  // System & Environment Card
  const elCtrlTemp = document.getElementById('ctrlTempVal');
  const elBattTemp = document.getElementById('battTempVal');
  const elLoadStatus = document.getElementById('loadStatusVal');
  const elFaultCode = document.getElementById('faultCodeVal');
  const elRssi = document.getElementById('bleRssiVal');
  const elWeatherStatusBadge = document.getElementById('weatherStatusBadge');
  const elWeatherOutdoorTemp = document.getElementById('weatherOutdoorTemp');
  const elWeatherTempF = document.getElementById('weatherTempF');
  const elWeatherHumidity = document.getElementById('weatherHumidity');
  const elWeatherPressure = document.getElementById('weatherPressure');
  const elWeatherWind = document.getElementById('weatherWind');
  const elWeatherGust = document.getElementById('weatherGust');
  const elWeatherSolarRad = document.getElementById('weatherSolarRad');
  const elWeatherUv = document.getElementById('weatherUv');
  const elWeatherStationSub = document.getElementById('weatherStationSub');

  // Controls & Charts
  const elFullscreenBtn = document.getElementById('fullscreenBtn');
  const elPeak24h = document.getElementById('peak24hBadge');
  const elTotal7d = document.getElementById('total7dBadge');
  const tooltip24h = document.getElementById('tooltip24h');
  const tooltip7d = document.getElementById('tooltip7d');

  // --- Canvases ---
  const canvasGauge = document.getElementById('fuelGaugeCanvas');
  const ctxGauge = canvasGauge ? canvasGauge.getContext('2d') : null;

  const canvasSpeedo = document.getElementById('speedometerCanvas');
  const ctxSpeedo = canvasSpeedo ? canvasSpeedo.getContext('2d') : null;

  const canvas24h = document.getElementById('chart24hCanvas');
  const ctx24h = canvas24h ? canvas24h.getContext('2d') : null;

  const canvas7d = document.getElementById('chart7dCanvas');
  const ctx7d = canvas7d ? canvas7d.getContext('2d') : null;

  // --- Clock ---
  function updateClock() {
    const now = new Date();
    if (elClock) elClock.textContent = now.toTimeString().split(' ')[0];
  }
  setInterval(updateClock, 1000);
  updateClock();

  // --- High-DPI & Responsive Canvas Scaling ---
  function setupHiDPI(canvas, ctx) {
    if (!canvas || !ctx) return null;
    const dpr = window.devicePixelRatio || 1;
    const parent = canvas.parentElement;
    let width = parent ? parent.clientWidth : canvas.width;
    let height = parent ? parent.clientHeight : canvas.height;
    if (width <= 0) width = 300;
    if (height <= 0) height = 200;

    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.resetTransform();
    ctx.scale(dpr, dpr);
    return { width, height };
  }

  // =========================================================================
  // AUTOMOTIVE FUEL GAUGE DIAL (BATTERY SOC: 0 - 100%)
  // =========================================================================
  const START_ANGLE_FUEL = 0.82 * Math.PI; // ~147 degrees
  const END_ANGLE_FUEL = 2.18 * Math.PI;   // ~392 degrees
  const SWEEP_ANGLE_FUEL = END_ANGLE_FUEL - START_ANGLE_FUEL;

  function socToAngle(soc) {
    const clamped = Math.max(0, Math.min(100, soc));
    return START_ANGLE_FUEL + (clamped / 100.0) * SWEEP_ANGLE_FUEL;
  }

  function drawFuelGauge() {
    if (!ctxGauge) return;
    const dims = setupHiDPI(canvasGauge, ctxGauge);
    if (!dims) return;
    const w = dims.width;
    const h = dims.height;
    const cx = w / 2;
    const cy = h * 0.70;
    const r = Math.min(w * 0.44, h * 0.58);

    ctxGauge.clearRect(0, 0, w, h);

    // 1. Gauge Background Track
    ctxGauge.beginPath();
    ctxGauge.arc(cx, cy, r, START_ANGLE_FUEL, END_ANGLE_FUEL);
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
      ctxGauge.arc(cx, cy, r, START_ANGLE_FUEL, socToAngle(displayedSOC));
      ctxGauge.strokeStyle = displayedSOC <= 20 ? '#ef4444' : displayedSOC <= 50 ? '#f59e0b' : '#34d399';
      ctxGauge.lineWidth = 6;
      ctxGauge.shadowColor = ctxGauge.strokeStyle;
      ctxGauge.shadowBlur = 10;
      ctxGauge.stroke();
      ctxGauge.shadowBlur = 0;
    }

    // 4. Tick Marks & Calibrations
    const tickCount = 20; // Every 5%
    for (let i = 0; i <= tickCount; i++) {
      const pct = (i / tickCount) * 100;
      const angle = socToAngle(pct);
      const isMajor = (i % 5 === 0); // 0, 25, 50, 75, 100
      const innerR = isMajor ? r - 20 : r - 14;
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
        const textR = r - 32;
        const tx = cx + textR * cos;
        const ty = cy + textR * sin;
        ctxGauge.save();
        ctxGauge.font = 'bold 11px ' + getComputedStyle(document.body).fontFamily;
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
    ctxGauge.arc(cx, cy, 17, 0, 2 * Math.PI);
    const hubGrad = ctxGauge.createRadialGradient(cx - 3, cy - 3, 2, cx, cy, 17);
    hubGrad.addColorStop(0, '#64748b');
    hubGrad.addColorStop(0.6, '#1e293b');
    hubGrad.addColorStop(1, '#0f172a');
    ctxGauge.fillStyle = hubGrad;
    ctxGauge.fill();
    ctxGauge.strokeStyle = '#94a3b8';
    ctxGauge.lineWidth = 2;
    ctxGauge.stroke();

    ctxGauge.beginPath();
    ctxGauge.arc(cx, cy, 5, 0, 2 * Math.PI);
    ctxGauge.fillStyle = '#f87171';
    ctxGauge.fill();
  }

  // =========================================================================
  // AUTOMOTIVE SPEEDOMETER DIAL (SOLAR PV VOLTAGE: 0 - 100V)
  // =========================================================================
  // Sweeps 240 degrees from 150 deg (bottom-left) to 390 deg (bottom-right)
  const START_ANGLE_SPEEDO = 0.83 * Math.PI; // ~150 degrees
  const END_ANGLE_SPEEDO = 2.17 * Math.PI;   // ~390 degrees
  const SWEEP_ANGLE_SPEEDO = END_ANGLE_SPEEDO - START_ANGLE_SPEEDO;

  function voltsToAngle(volts) {
    const clamped = Math.max(0, Math.min(100, volts));
    return START_ANGLE_SPEEDO + (clamped / 100.0) * SWEEP_ANGLE_SPEEDO;
  }

  function drawSpeedometer() {
    if (!ctxSpeedo) return;
    const dims = setupHiDPI(canvasSpeedo, ctxSpeedo);
    if (!dims) return;
    const w = dims.width;
    const h = dims.height;
    const cx = w / 2;
    const cy = h * 0.70;
    const r = Math.min(w * 0.44, h * 0.58);

    ctxSpeedo.clearRect(0, 0, w, h);

    // 1. Dial Outer Housing & Bezel Track
    ctxSpeedo.beginPath();
    ctxSpeedo.arc(cx, cy, r, START_ANGLE_SPEEDO, END_ANGLE_SPEEDO);
    ctxSpeedo.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctxSpeedo.lineWidth = 14;
    ctxSpeedo.lineCap = 'round';
    ctxSpeedo.stroke();

    // 2. Color-Coded Zones
    // Normal MPPT operating zone (0 - 60V): Cyan
    ctxSpeedo.beginPath();
    ctxSpeedo.arc(cx, cy, r, voltsToAngle(0), voltsToAngle(60));
    ctxSpeedo.strokeStyle = '#06b6d4';
    ctxSpeedo.lineWidth = 14;
    ctxSpeedo.stroke();

    // High string voltage zone (60 - 85V): Amber
    ctxSpeedo.beginPath();
    ctxSpeedo.arc(cx, cy, r, voltsToAngle(60), voltsToAngle(85));
    ctxSpeedo.strokeStyle = '#f59e0b';
    ctxSpeedo.lineWidth = 14;
    ctxSpeedo.stroke();

    // REDLINE ZONE (85 - 100V Max Voc): Racing Red
    ctxSpeedo.beginPath();
    ctxSpeedo.arc(cx, cy, r, voltsToAngle(85), voltsToAngle(100));
    ctxSpeedo.strokeStyle = '#ef4444';
    ctxSpeedo.lineWidth = 14;
    ctxSpeedo.lineCap = 'round';
    ctxSpeedo.stroke();

    // 3. Active Glow Arc up to displayedPvVolts
    if (displayedPvVolts > 0.5) {
      ctxSpeedo.beginPath();
      ctxSpeedo.arc(cx, cy, r, START_ANGLE_SPEEDO, voltsToAngle(displayedPvVolts));
      ctxSpeedo.strokeStyle = displayedPvVolts >= 85 ? '#ef4444' : (displayedPvVolts >= 60 ? '#f59e0b' : '#38bdf8');
      ctxSpeedo.lineWidth = 6;
      ctxSpeedo.shadowColor = ctxSpeedo.strokeStyle;
      ctxSpeedo.shadowBlur = 10;
      ctxSpeedo.stroke();
      ctxSpeedo.shadowBlur = 0;
    }

    // 4. Speedometer Tick Marks & Calibrations (0 to 100V)
    for (let v = 0; v <= 100; v += 2) {
      const angle = voltsToAngle(v);
      const isMajor = (v % 10 === 0);  // 0, 10, 20... 100
      const isMedium = (v % 5 === 0); // 5, 15, 25...
      const isRedline = (v >= 85);

      const innerR = isMajor ? r - 20 : (isMedium ? r - 14 : r - 9);
      const outerR = r - 8;

      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      ctxSpeedo.beginPath();
      ctxSpeedo.moveTo(cx + innerR * cos, cy + innerR * sin);
      ctxSpeedo.lineTo(cx + outerR * cos, cy + outerR * sin);
      ctxSpeedo.strokeStyle = isRedline ? '#ef4444' : (isMajor ? '#ffffff' : 'rgba(255, 255, 255, 0.35)');
      ctxSpeedo.lineWidth = isMajor ? 2.5 : (isMedium ? 1.5 : 1.0);
      ctxSpeedo.stroke();

      // Number labels at major ticks
      if (isMajor) {
        const textR = r - 32;
        const tx = cx + textR * cos;
        const ty = cy + textR * sin;
        ctxSpeedo.save();
        ctxSpeedo.font = 'bold 11px ' + getComputedStyle(document.body).fontFamily;
        ctxSpeedo.textAlign = 'center';
        ctxSpeedo.textBaseline = 'middle';
        ctxSpeedo.fillStyle = isRedline ? '#f87171' : '#f1f5f9';
        ctxSpeedo.fillText(v.toString(), tx, ty);
        ctxSpeedo.restore();
      }
    }

    // 5. Automotive Speedometer Needle
    const needleAngle = voltsToAngle(displayedPvVolts);
    const needleLen = r - 6;
    const needleBaseW = 6;

    ctxSpeedo.save();
    ctxSpeedo.translate(cx, cy);
    ctxSpeedo.rotate(needleAngle);

    // Needle drop shadow
    ctxSpeedo.beginPath();
    ctxSpeedo.moveTo(0, -needleBaseW);
    ctxSpeedo.lineTo(needleLen, 0);
    ctxSpeedo.lineTo(0, needleBaseW);
    ctxSpeedo.lineTo(-16, 0);
    ctxSpeedo.closePath();
    ctxSpeedo.fillStyle = '#fb923c';
    ctxSpeedo.shadowColor = '#f97316';
    ctxSpeedo.shadowBlur = 12;
    ctxSpeedo.fill();

    // Needle luminous white stripe
    ctxSpeedo.beginPath();
    ctxSpeedo.moveTo(needleLen - 30, 0);
    ctxSpeedo.lineTo(needleLen, 0);
    ctxSpeedo.strokeStyle = '#ffffff';
    ctxSpeedo.lineWidth = 2.5;
    ctxSpeedo.stroke();

    ctxSpeedo.restore();

    // 6. Needle Hub Cap (Chrome and graphite gradient)
    ctxSpeedo.beginPath();
    ctxSpeedo.arc(cx, cy, 17, 0, 2 * Math.PI);
    const hubGrad = ctxSpeedo.createRadialGradient(cx - 3, cy - 3, 2, cx, cy, 17);
    hubGrad.addColorStop(0, '#94a3b8');
    hubGrad.addColorStop(0.5, '#334155');
    hubGrad.addColorStop(1, '#0f172a');
    ctxSpeedo.fillStyle = hubGrad;
    ctxSpeedo.fill();
    ctxSpeedo.strokeStyle = '#cbd5e1';
    ctxSpeedo.lineWidth = 2;
    ctxSpeedo.stroke();

    ctxSpeedo.beginPath();
    ctxSpeedo.arc(cx, cy, 5, 0, 2 * Math.PI);
    ctxSpeedo.fillStyle = '#f97316';
    ctxSpeedo.fill();

    // Update Digital Center Readout
    if (elSpeedoVolts) {
      elSpeedoVolts.innerHTML = `${displayedPvVolts.toFixed(1)}<span class="unit">V</span>`;
    }
  }

  // Smooth needle damping loop for both instrument dials
  function animateNeedles() {
    let changed = false;

    const diffSOC = targetSOC - displayedSOC;
    if (Math.abs(diffSOC) > 0.05) {
      displayedSOC += diffSOC * 0.12;
      drawFuelGauge();
      changed = true;
    }

    const diffVolts = targetPvVolts - displayedPvVolts;
    if (Math.abs(diffVolts) > 0.05) {
      displayedPvVolts += diffVolts * 0.10;
      drawSpeedometer();
      changed = true;
    }

    requestAnimationFrame(animateNeedles);
  }
  requestAnimationFrame(animateNeedles);

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
    const padBottom = 26;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    ctx24h.clearRect(0, 0, w, h);

    let maxW = 50;
    points.forEach(p => {
      if (p.solar_power_w > maxW) maxW = p.solar_power_w;
    });
    maxW = Math.ceil(maxW / 50) * 50;
    if (elPeak24h) elPeak24h.textContent = `24h Peak: ${maxW} W`;

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
    areaGrad.addColorStop(0, 'rgba(245, 158, 11, 0.35)');
    areaGrad.addColorStop(0.7, 'rgba(245, 158, 11, 0.05)');
    areaGrad.addColorStop(1, 'rgba(245, 158, 11, 0.0)');
    ctx24h.fillStyle = areaGrad;
    ctx24h.fill();

    // 4. Stroke Solar Power Line
    ctx24h.beginPath();
    coords.forEach((pt, i) => {
      if (i === 0) ctx24h.moveTo(pt.x, pt.y);
      else ctx24h.lineTo(pt.x, pt.y);
    });
    ctx24h.strokeStyle = '#f59e0b';
    ctx24h.lineWidth = 2.5;
    ctx24h.stroke();

    // 5. Battery SOC Overlay (Dotted emerald line, 0-100%)
    ctx24h.beginPath();
    ctx24h.setLineDash([3, 4]);
    points.forEach((p, idx) => {
      const x = padLeft + (idx / (points.length - 1)) * plotW;
      const soc = p.battery_soc || 0;
      const y = padTop + plotH - (soc / 100) * plotH;
      if (idx === 0) ctx24h.moveTo(x, y);
      else ctx24h.lineTo(x, y);
    });
    ctx24h.strokeStyle = 'rgba(16, 185, 129, 0.5)';
    ctx24h.lineWidth = 1.5;
    ctx24h.stroke();
    ctx24h.setLineDash([]); // reset

    // 6. X-Axis Time Labels
    ctx24h.font = '10px var(--font-family)';
    ctx24h.fillStyle = '#94a3b8';
    ctx24h.textAlign = 'center';

    const hourStep = Math.max(1, Math.floor(points.length / 6));
    for (let idx = 0; idx < points.length; idx += hourStep) {
      const pt = coords[idx];
      const timeStr = pt.p.timestamp ? pt.p.timestamp.split('T')[1].substring(0, 5) : '';
      ctx24h.fillText(timeStr, pt.x, h - 8);
    }
  }

  // =========================================================================
  // 7-DAY SOLAR PRODUCTION BAR CHART
  // =========================================================================
  function draw7dChart(days) {
    if (!ctx7d || !days || days.length === 0) return;
    const dims = setupHiDPI(canvas7d, ctx7d);
    if (!dims) return;
    const w = dims.width;
    const h = dims.height;

    const padLeft = 45;
    const padRight = 15;
    const padTop = 15;
    const padBottom = 26;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    ctx7d.clearRect(0, 0, w, h);

    let maxWh = 100;
    let totalWh = 0;
    days.forEach(d => {
      const wh = d.energy_wh ?? d.total_energy_wh ?? 0;
      totalWh += wh;
      if (wh > maxWh) maxWh = wh;
    });
    maxWh = Math.ceil(maxWh / 100) * 100;
    if (elTotal7d) elTotal7d.textContent = `7-Day: ${totalWh.toLocaleString()} Wh`;

    // 1. Grid Lines & Y-Axis Labels
    ctx7d.font = '10px var(--font-mono)';
    ctx7d.fillStyle = '#64748b';
    ctx7d.textAlign = 'right';

    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const yVal = Math.round((maxWh / ySteps) * i);
      const yPos = padTop + plotH - (i / ySteps) * plotH;

      ctx7d.beginPath();
      ctx7d.moveTo(padLeft, yPos);
      ctx7d.lineTo(w - padRight, yPos);
      ctx7d.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx7d.lineWidth = 1;
      ctx7d.stroke();

      ctx7d.fillText(`${yVal}Wh`, padLeft - 6, yPos + 3);
    }

    // 2. Draw Daily Bars
    const barCount = days.length;
    const slotW = plotW / barCount;
    const barW = Math.min(36, slotW * 0.65);

    days.forEach((d, idx) => {
      const wh = d.energy_wh ?? d.total_energy_wh ?? 0;
      const cx = padLeft + (idx + 0.5) * slotW;
      const barH = (wh / maxWh) * plotH;
      const bx = cx - barW / 2;
      const by = padTop + plotH - barH;

      // Bar gradient fill
      const barGrad = ctx7d.createLinearGradient(0, by, 0, padTop + plotH);
      if (d.day_label === 'Today') {
        barGrad.addColorStop(0, '#f59e0b');
        barGrad.addColorStop(1, 'rgba(245, 158, 11, 0.4)');
      } else {
        barGrad.addColorStop(0, '#06b6d4');
        barGrad.addColorStop(1, 'rgba(6, 182, 212, 0.3)');
      }

      ctx7d.fillStyle = barGrad;
      ctx7d.beginPath();
      ctx7d.roundRect(bx, by, barW, barH, [4, 4, 0, 0]);
      ctx7d.fill();

      // Peak Power Marker
      if (d.peak_solar_w > 0) {
        ctx7d.fillStyle = '#fbbf24';
        ctx7d.font = '9px var(--font-mono)';
        ctx7d.textAlign = 'center';
        ctx7d.fillText(`${d.peak_solar_w}W`, cx, Math.max(padTop + 10, by - 5));
      }

      // X-Axis Day Label
      ctx7d.font = (d.day_label === 'Today' ? 'bold 10px ' : '9px ') + 'var(--font-family)';
      ctx7d.fillStyle = d.day_label === 'Today' ? '#f59e0b' : '#cbd5e1';
      ctx7d.textAlign = 'center';
      ctx7d.fillText(d.day_label, cx, h - 8);
    });
  }

  // =========================================================================
  // CONNECTION STATUS (HEARTBEAT VS ALARM BELL)
  // =========================================================================
  function updateConnectionStatus(isOnline, lastTime) {
    if (!elHeartbeatContainer || !elHeartbeatIcon || !elHeartbeatLabel) return;
    if (isOnline) {
      elHeartbeatContainer.className = 'connection-heartbeat online';
      elHeartbeatIcon.textContent = '❤️';
      elHeartbeatIcon.className = 'heartbeat-icon beating';
      elHeartbeatLabel.textContent = 'LINK ACTIVE';
      elHeartbeatContainer.title = `Bluetooth Link Active • Last packet: ${lastTime || 'just now'}`;
    } else {
      elHeartbeatContainer.className = 'connection-heartbeat offline';
      elHeartbeatIcon.textContent = '🔔';
      elHeartbeatIcon.className = 'heartbeat-icon alarm';
      elHeartbeatLabel.textContent = 'LINK DOWN';
      elHeartbeatContainer.title = 'Bluetooth Link Interrupted — No response from controller';
    }
  }

  // =========================================================================
  // WEATHER STATION TELEMETRY (PORT 8088 PROXY)
  // =========================================================================
  async function fetchWeather() {
    try {
      const resp = await fetch('/api/weather');
      if (!resp.ok) return;
      const data = await resp.json();
      const m = data.measurements || {};
      const status = data.status;

      if (status === 'online' && m.outdoor_temperature_c !== undefined) {
        // Online station with live sensor measurements
        if (elWeatherStatusBadge) {
          elWeatherStatusBadge.textContent = 'Station Active';
          elWeatherStatusBadge.className = 'badge weather-badge online';
        }
        if (elHdrWeatherTemp) elHdrWeatherTemp.textContent = `${m.outdoor_temperature_c}°C`;
        if (elHdrWeatherHum) elHdrWeatherHum.textContent = `${m.outdoor_humidity_pct}%`;
        if (elHdrWeatherSolar) elHdrWeatherSolar.textContent = `${m.solar_radiation_wm2 ?? '--'} W/m²`;

        if (elWeatherOutdoorTemp) elWeatherOutdoorTemp.innerHTML = `${m.outdoor_temperature_c}<span class="unit">°C</span>`;
        if (elWeatherTempF) elWeatherTempF.textContent = `${m.outdoor_temperature_f || '--'}°F`;
        if (elWeatherHumidity) elWeatherHumidity.innerHTML = `${m.outdoor_humidity_pct}<span class="unit">%</span>`;
        if (elWeatherPressure) elWeatherPressure.textContent = `${m.pressure_relative_hpa || '--'} hPa`;
        if (elWeatherWind) elWeatherWind.innerHTML = `${m.wind_speed_kmh || 0}<span class="unit">km/h</span>`;
        if (elWeatherGust) elWeatherGust.textContent = `Gust: ${m.wind_gust_kmh || '--'} km/h (${m.wind_direction_deg || 0}°)`;
        if (elWeatherSolarRad) elWeatherSolarRad.innerHTML = `${m.solar_radiation_wm2 || 0}<span class="unit">W/m²</span>`;
        if (elWeatherUv) elWeatherUv.textContent = `UV: ${m.uv_index || 0} • Rain: ${m.daily_rain_mm || 0}mm`;
        if (elWeatherStationSub) elWeatherStationSub.textContent = `EasyWeather DD85 (${data.updated_at || 'synced'})`;
      } else {
        // Standby or waiting for report
        if (elWeatherStatusBadge) {
          elWeatherStatusBadge.textContent = 'Station Standby';
          elWeatherStatusBadge.className = 'badge weather-badge';
        }
        if (elHdrWeatherTemp) elHdrWeatherTemp.textContent = '--°C';
        if (elHdrWeatherHum) elHdrWeatherHum.textContent = '--%';
        if (elHdrWeatherSolar) elHdrWeatherSolar.textContent = '-- W/m²';
        if (elWeatherStationSub) elWeatherStationSub.textContent = '192.168.0.163:8088';
      }
    } catch (err) {
      console.warn('Weather fetch error:', err);
    }
  }

  // =========================================================================
  // API FETCH & REAL-TIME POLLING
  // =========================================================================
  async function fetchStatus() {
    try {
      const resp = await fetch('/api/status');
      if (!resp.ok) {
        updateConnectionStatus(false);
        return;
      }
      const t = await resp.json();

      // Check packet freshness (< 18 seconds)
      let isFresh = false;
      let syncStr = '';
      if (t.timestamp) {
        const syncDate = new Date(t.timestamp);
        const ageSec = (Date.now() - syncDate.getTime()) / 1000;
        syncStr = syncDate.toLocaleTimeString();
        if (ageSec < 18) {
          isFresh = true;
        }
      }
      updateConnectionStatus(isFresh, syncStr);

      // Update Device Header
      if (t.device_name && elDeviceName) elDeviceName.textContent = t.device_name;
      if (t.model && elModel) elModel.textContent = t.model;
      if (t.battery_type && elBattType) elBattType.textContent = t.battery_type;
      if (t.charging_status && elChargingState) elChargingState.textContent = `${t.charging_status} Active`;

      if (t.rated_voltage_v && t.rated_current_a && elSystemRating) {
        elSystemRating.textContent = `${t.rated_current_a}A • ${t.rated_voltage_v}V System`;
      }

      // Update Battery Dial & Metrics
      targetSOC = t.battery_soc_percent || 0;
      if (elGaugeSoc) elGaugeSoc.innerHTML = `${targetSOC}<span class="unit">%</span>`;

      if (elGaugeSub) {
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
      }

      if (elBattV) elBattV.innerHTML = `${(t.battery_voltage_v || 0).toFixed(1)}<span class="unit">V</span>`;
      if (elBattA) elBattA.innerHTML = `${(t.battery_current_a || 0).toFixed(2)}<span class="unit">A</span>`;
      if (elBattW) elBattW.innerHTML = `${(t.battery_power_w || 0).toFixed(1)}<span class="unit">W</span>`;

      // Update Speedometer & Solar PV Metrics
      targetPvVolts = t.pv_voltage_v || 0;
      if (elSolarPower) elSolarPower.innerHTML = `${t.pv_power_w || 0}<span class="unit">W</span>`;
      if (elPvV) elPvV.innerHTML = `${(t.pv_voltage_v || 0).toFixed(1)}<span class="unit">V</span>`;
      if (elPvA) elPvA.innerHTML = `${(t.pv_current_a || 0).toFixed(2)}<span class="unit">A</span>`;
      if (elPowerToday) elPowerToday.innerHTML = `${t.power_generation_today_wh || 0}<span class="unit">Wh</span>`;
      if (t.power_generation_total_kwh && elLifetimeKwh) {
        elLifetimeKwh.textContent = `${t.power_generation_total_kwh.toLocaleString()} kWh`;
      }

      // Update System Hardware
      if (elCtrlTemp) elCtrlTemp.textContent = `${t.controller_temp_c || 0}°C`;
      if (elBattTemp) elBattTemp.textContent = `${t.battery_temp_c || 0}°C`;
      if (elLoadStatus) elLoadStatus.textContent = `${t.load_status || 'Off'} (${t.load_power_w || 0}W)`;

      if (elFaultCode) {
        if (t.fault_code === 0) {
          elFaultCode.textContent = '0 (Normal)';
          elFaultCode.className = 'stat-number normal-status';
        } else {
          elFaultCode.textContent = `Alert (0x${t.fault_code.toString(16)})`;
          elFaultCode.className = 'stat-number highlight-val';
        }
      }

      if (t.rssi && elRssi) {
        elRssi.textContent = `${t.rssi} dBm`;
      }

      // Update Live Sync Status Indicator
      const elLastUpdated = document.getElementById('lastUpdatedText');
      const elPulse = document.getElementById('blePulse');
      if (elLastUpdated && t.timestamp) {
        const d = new Date(t.timestamp);
        elLastUpdated.textContent = `Live Telemetry Synced: ${d.toLocaleTimeString()} (5s BLE loop • PV: ${(t.pv_voltage_v || 0).toFixed(1)}V)`;
      }
      if (elPulse) {
        elPulse.style.animation = 'none';
        void elPulse.offsetWidth;
        elPulse.style.animation = 'pulse-animation 1.5s ease-in-out';
      }
    } catch (err) {
      updateConnectionStatus(false);
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

  function redrawAll() {
    drawFuelGauge();
    drawSpeedometer();
    if (historyData) {
      if (historyData.points_24h) draw24hChart(historyData.points_24h);
      if (historyData.days_7d) draw7dChart(historyData.days_7d);
    }
  }

  // --- Dynamic Screen & Container Resizing ---
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      redrawAll();
    });
    document.querySelectorAll('.gauge-wrapper, .chart-container').forEach(el => ro.observe(el));
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
      setTimeout(redrawAll, 80);
    });
  }

  window.addEventListener('resize', redrawAll);

  // --- Initial Launch ---
  redrawAll();
  fetchStatus();
  fetchHistory();
  fetchWeather();

  // Polling loops: 2s for live controller status, 5s for weather, 60s for historical aggregation
  setInterval(fetchStatus, 2000);
  setInterval(fetchWeather, 5000);
  setInterval(fetchHistory, 60000);

})();
