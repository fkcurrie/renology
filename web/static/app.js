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
  let latestWeatherSolarRad = null;
  let lastTelemetry = null;

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

  // Human Story Banner
  const elHumanStoryBanner = document.getElementById('humanStoryBanner');
  const elStoryPulseDot = document.getElementById('storyPulseDot');
  const elStoryIcon = document.getElementById('storyIcon');
  const elStoryHeadline = document.getElementById('storyHeadline');
  const elStoryDesc = document.getElementById('storyDesc');
  const elStoryEquivText = document.getElementById('storyEquivText');

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

  // Solar Potential & Curtailment
  const elCurtailmentBadge = document.getElementById('curtailmentBadge');
  const elActualHarvestVal = document.getElementById('actualHarvestVal');
  const elCurtailmentTag = document.getElementById('curtailmentTag');
  const elCurtailmentBarFill = document.getElementById('curtailmentBarFill');
  const elSunPotentialVal = document.getElementById('sunPotentialVal');

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

  // History Chart & Timespan Selector Elements
  const elHistoryChartTitle = document.getElementById('historyChartTitle');
  const elHistoryChartLegend = document.getElementById('historyChartLegend');
  const elWindow24hLabel = document.getElementById('window24hLabel');
  const elLegItemVolts = document.getElementById('legItemVolts');
  const elLegItemPower = document.getElementById('legItemPower');
  const elLegItemBatt = document.getElementById('legItemBatt');
  const elLegItemSoc = document.getElementById('legItemSoc');
  const elTimespanSelector = document.getElementById('timespanSelector');

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
        ctxGauge.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
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
        ctxSpeedo.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
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

  let needleAnimId = null;

  // Smooth needle damping loop for both instrument dials
  function animateNeedles() {
    let changed = false;

    const diffSOC = targetSOC - displayedSOC;
    if (Math.abs(diffSOC) > 0.05) {
      displayedSOC += diffSOC * 0.12;
      drawFuelGauge();
      changed = true;
    } else if (displayedSOC !== targetSOC) {
      displayedSOC = targetSOC;
      drawFuelGauge();
    }

    const diffVolts = targetPvVolts - displayedPvVolts;
    if (Math.abs(diffVolts) > 0.05) {
      displayedPvVolts += diffVolts * 0.10;
      drawSpeedometer();
      changed = true;
    } else if (displayedPvVolts !== targetPvVolts) {
      displayedPvVolts = targetPvVolts;
      drawSpeedometer();
    }

    if (changed) {
      needleAnimId = requestAnimationFrame(animateNeedles);
    } else {
      needleAnimId = null;
    }
  }

  function triggerNeedleAnimation() {
    if (!needleAnimId) {
      needleAnimId = requestAnimationFrame(animateNeedles);
    }
  }
  triggerNeedleAnimation();

  // =========================================================================
  // 24-HOUR SOLAR POWER & VOLTAGE DUAL-AXIS CHART
  // =========================================================================
  let cachedPoints24h = null;
  let cachedMetrics24h = null;
  let activeHoverIdx24h = -1;

  function draw24hChart(points) {
    if (!ctx24h || !points || points.length === 0) return;
    cachedPoints24h = points;
    const dims = setupHiDPI(canvas24h, ctx24h);
    if (!dims) return;
    const w = dims.width;
    const h = dims.height;

    // Margins: left for Watts, right for Volts, bottom for timestamps
    const padLeft = 45;
    const padRight = 38;
    const padTop = 16;
    const padBottom = 26;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    ctx24h.clearRect(0, 0, w, h);

    let maxW = 50;
    let maxV = 40;
    let peakSolarW = 0;
    let peakSolarV = 0;

    points.forEach(p => {
      const sw = p.solar_power_w || 0;
      const bw = p.battery_power_w || 0;
      const pvV = p.pv_voltage_v || 0;
      if (sw > peakSolarW) peakSolarW = sw;
      if (pvV > peakSolarV) peakSolarV = pvV;
      if (sw > maxW) maxW = sw;
      if (bw > maxW) maxW = bw;
      if (pvV > maxV) maxV = pvV;
    });

    maxW = Math.ceil(maxW / 50) * 50;
    maxV = Math.ceil(maxV / 10) * 10;
    cachedMetrics24h = { padLeft, padRight, padTop, padBottom, plotW, plotH, maxW, maxV, w, h };

    if (elPeak24h) {
      elPeak24h.textContent = `24h Peak: ${peakSolarW} W • Max Solar: ${peakSolarV.toFixed(1)} V`;
    }

    // 1. Grid Lines & Dual Y-Axis Labels
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const yVal = Math.round((maxW / ySteps) * i);
      const vVal = Math.round((maxV / ySteps) * i);
      const yPos = padTop + plotH - (i / ySteps) * plotH;

      ctx24h.beginPath();
      ctx24h.moveTo(padLeft, yPos);
      ctx24h.lineTo(w - padRight, yPos);
      ctx24h.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx24h.lineWidth = 1;
      ctx24h.stroke();

      // Left Y-Axis: Watts (Amber / Gray)
      ctx24h.font = '10px var(--font-mono)';
      ctx24h.fillStyle = i === ySteps ? '#fbbf24' : '#64748b';
      ctx24h.textAlign = 'right';
      ctx24h.fillText(`${yVal}W`, padLeft - 6, yPos + 3);

      // Right Y-Axis: Solar Volts (Cyan / Sky Blue)
      ctx24h.fillStyle = i === ySteps ? '#38bdf8' : '#0284c7';
      ctx24h.textAlign = 'left';
      ctx24h.fillText(`${vVal}V`, w - padRight + 6, yPos + 3);
    }

    // Axis Unit Headers
    ctx24h.font = 'bold 9px var(--font-mono)';
    ctx24h.fillStyle = '#f59e0b';
    ctx24h.textAlign = 'right';
    ctx24h.fillText('WATTS', padLeft - 6, padTop - 4);

    ctx24h.fillStyle = '#38bdf8';
    ctx24h.textAlign = 'left';
    ctx24h.fillText('VOLTS', w - padRight + 6, padTop - 4);

    // 2. Build Coordinate Sets
    const coords = [];
    points.forEach((p, idx) => {
      const x = padLeft + (idx / (points.length - 1)) * plotW;
      const ySolar = padTop + plotH - ((p.solar_power_w || 0) / maxW) * plotH;
      const yBatt = padTop + plotH - ((p.battery_power_w || 0) / maxW) * plotH;
      const yVolt = padTop + plotH - ((p.pv_voltage_v || 0) / maxV) * plotH;
      const ySoc = padTop + plotH - ((p.battery_soc || 0) / 100) * plotH;
      coords.push({ x, ySolar, yBatt, yVolt, ySoc, p });
    });

    // 3. Layer A: Battery SOC Overlay (Subtle dotted line, 0-100%)
    ctx24h.beginPath();
    ctx24h.setLineDash([3, 4]);
    coords.forEach((pt, idx) => {
      if (idx === 0) ctx24h.moveTo(pt.x, pt.ySoc);
      else ctx24h.lineTo(pt.x, pt.ySoc);
    });
    ctx24h.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx24h.lineWidth = 1.2;
    ctx24h.stroke();
    ctx24h.setLineDash([]); // reset

    // 4. Layer B: Solar Voltage Curve (Vivid Sky Blue #38bdf8)
    // Maps out Solar Volts across the full 24 hours
    ctx24h.save();
    ctx24h.beginPath();
    coords.forEach((pt, i) => {
      if (i === 0) ctx24h.moveTo(pt.x, pt.yVolt);
      else ctx24h.lineTo(pt.x, pt.yVolt);
    });
    ctx24h.strokeStyle = '#38bdf8';
    ctx24h.lineWidth = 2.5;
    ctx24h.shadowColor = '#0284c7';
    ctx24h.shadowBlur = 6;
    ctx24h.stroke();
    ctx24h.restore();

    // 5. Layer C: Solar Power Area Fill (Warm Amber)
    ctx24h.beginPath();
    ctx24h.moveTo(coords[0].x, padTop + plotH);
    coords.forEach(pt => ctx24h.lineTo(pt.x, pt.ySolar));
    ctx24h.lineTo(coords[coords.length - 1].x, padTop + plotH);
    ctx24h.closePath();

    const areaGrad = ctx24h.createLinearGradient(0, padTop, 0, padTop + plotH);
    areaGrad.addColorStop(0, 'rgba(245, 158, 11, 0.35)');
    areaGrad.addColorStop(0.7, 'rgba(245, 158, 11, 0.08)');
    areaGrad.addColorStop(1, 'rgba(245, 158, 11, 0.0)');
    ctx24h.fillStyle = areaGrad;
    ctx24h.fill();

    // 6. Layer D: Solar Power Line (Amber)
    ctx24h.beginPath();
    coords.forEach((pt, i) => {
      if (i === 0) ctx24h.moveTo(pt.x, pt.ySolar);
      else ctx24h.lineTo(pt.x, pt.ySolar);
    });
    ctx24h.strokeStyle = '#f59e0b';
    ctx24h.lineWidth = 2.0;
    ctx24h.stroke();

    // 7. Layer E: Battery Routing Power Line (Emerald Green)
    ctx24h.beginPath();
    coords.forEach((pt, i) => {
      if (i === 0) ctx24h.moveTo(pt.x, pt.yBatt);
      else ctx24h.lineTo(pt.x, pt.yBatt);
    });
    ctx24h.strokeStyle = '#10b981';
    ctx24h.lineWidth = 1.8;
    ctx24h.stroke();

    // 8. Layer F: Active Hover / Touch Indicator Crosshair
    if (activeHoverIdx24h >= 0 && activeHoverIdx24h < coords.length) {
      const hPt = coords[activeHoverIdx24h];
      ctx24h.beginPath();
      ctx24h.moveTo(hPt.x, padTop);
      ctx24h.lineTo(hPt.x, padTop + plotH);
      ctx24h.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx24h.lineWidth = 1.5;
      ctx24h.setLineDash([2, 3]);
      ctx24h.stroke();
      ctx24h.setLineDash([]);

      // Solar Volts dot (blue)
      ctx24h.beginPath();
      ctx24h.arc(hPt.x, hPt.yVolt, 4.5, 0, 2 * Math.PI);
      ctx24h.fillStyle = '#38bdf8';
      ctx24h.fill();
      ctx24h.strokeStyle = '#fff';
      ctx24h.lineWidth = 1.5;
      ctx24h.stroke();

      // Solar Power dot (amber)
      ctx24h.beginPath();
      ctx24h.arc(hPt.x, hPt.ySolar, 4, 0, 2 * Math.PI);
      ctx24h.fillStyle = '#f59e0b';
      ctx24h.fill();
      ctx24h.strokeStyle = '#fff';
      ctx24h.lineWidth = 1.5;
      ctx24h.stroke();

      // Battery Power dot (emerald)
      ctx24h.beginPath();
      ctx24h.arc(hPt.x, hPt.yBatt, 3.5, 0, 2 * Math.PI);
      ctx24h.fillStyle = '#10b981';
      ctx24h.fill();
      ctx24h.strokeStyle = '#fff';
      ctx24h.lineWidth = 1.5;
      ctx24h.stroke();
    }

    // 9. X-Axis Time Labels
    ctx24h.font = '10px var(--font-family)';
    ctx24h.fillStyle = '#94a3b8';
    ctx24h.textAlign = 'center';

    const hourStep = Math.max(1, Math.floor(points.length / 6));
    for (let idx = 0; idx < points.length; idx += hourStep) {
      const pt = coords[idx];
      const timeStr = pt.p.timestamp ? (pt.p.timestamp.includes('T') ? pt.p.timestamp.split('T')[1].substring(0, 5) : pt.p.timestamp) : (pt.p.time_label || '');
      ctx24h.fillText(timeStr, pt.x, h - 8);
    }
  }

  // Hover and Touch interaction handlers for 24h chart
  function handle24hHover(clientX, clientY) {
    if (!canvas24h || !cachedPoints24h || !cachedMetrics24h || !tooltip24h) return;
    const rect = canvas24h.getBoundingClientRect();
    const xInCanvas = (clientX - rect.left) * (cachedMetrics24h.w / rect.width);
    const { padLeft, plotW } = cachedMetrics24h;

    const xRel = xInCanvas - padLeft;
    if (xRel < 0 || xRel > plotW) {
      tooltip24h.style.display = 'none';
      if (activeHoverIdx24h !== -1) {
        activeHoverIdx24h = -1;
        draw24hChart(cachedPoints24h);
      }
      return;
    }

    const ratio = Math.max(0, Math.min(1, xRel / plotW));
    const idx = Math.min(cachedPoints24h.length - 1, Math.round(ratio * (cachedPoints24h.length - 1)));
    activeHoverIdx24h = idx;
    draw24hChart(cachedPoints24h);

    const p = cachedPoints24h[idx];
    const pvV = (p.pv_voltage_v || 0).toFixed(1);
    const solW = p.solar_power_w || 0;
    const battW = p.battery_power_w || 0;
    const soc = p.battery_soc || 0;
    const battV = (p.battery_voltage_v || 0).toFixed(2);
    const timeStr = p.timestamp ? (p.timestamp.includes('T') ? p.timestamp.split('T')[1].substring(0, 5) : p.timestamp) : (p.time_label || '');

    let badge = '';
    if (p.pv_voltage_v >= 20.0 && solW === 0 && soc >= 98) {
      badge = '<div style="margin-top: 4px; padding: 2px 6px; background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.6); border-radius: 4px; font-size: 10px; color: #fef08a;">☀️ Sun Active • Solar Curtailed (Battery Full)</div>';
    } else if (p.pv_voltage_v >= 20.0 && solW > 0) {
      badge = '<div style="margin-top: 4px; padding: 2px 6px; background: rgba(16, 185, 129, 0.2); border: 1px solid rgba(16, 185, 129, 0.6); border-radius: 4px; font-size: 10px; color: #6ee7b7;">⚡ Active Solar Charging</div>';
    } else if (p.pv_voltage_v < 8.0) {
      badge = '<div style="margin-top: 4px; padding: 2px 6px; background: rgba(100, 116, 139, 0.2); border: 1px solid rgba(100, 116, 139, 0.4); border-radius: 4px; font-size: 10px; color: #94a3b8;">🌙 Night / No Sun</div>';
    }

    tooltip24h.innerHTML = `
      <div style="font-weight: 700; color: #f8fafc; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 2px;">🕒 ${timeStr}</div>
      <div style="color: #38bdf8; font-weight: 600;">☀️ Solar Panel: <strong>${pvV} V</strong></div>
      <div style="color: #f59e0b; font-weight: 600;">⚡ Solar Drawn: <strong>${solW} W</strong></div>
      <div style="color: #10b981; font-weight: 600;">🔋 Battery Power: <strong>${battW} W</strong></div>
      <div style="color: #cbd5e1; font-size: 10px;">🟢 Battery SOC: <strong>${soc}%</strong> (${battV}V)</div>
      ${badge}
    `;

    tooltip24h.style.display = 'block';
    const tipX = clientX - rect.left;
    const tipY = clientY - rect.top;
    
    if (tipX > rect.width * 0.6) {
      tooltip24h.style.left = `${tipX - 190}px`;
    } else {
      tooltip24h.style.left = `${tipX + 15}px`;
    }
    tooltip24h.style.top = `${Math.max(10, tipY - 50)}px`;
  }

  function handle24hLeave() {
    if (tooltip24h) tooltip24h.style.display = 'none';
    if (activeHoverIdx24h !== -1) {
      activeHoverIdx24h = -1;
      if (cachedPoints24h) draw24hChart(cachedPoints24h);
    }
  }

  // =========================================================================
  // MULTI-TIMESPAN SOLAR HARVEST CHARTS (Week, Month, Quarter, Half Year, Year)
  // =========================================================================
  let currentTimespan = 'today';
  try {
    const savedSpan = localStorage.getItem('renology_timespan');
    if (savedSpan) currentTimespan = savedSpan;
  } catch (_) {}

  let cachedMultiDays = null;
  let cachedMultiMetrics = null;
  let activeHoverIdxMulti = -1;

  let cachedYearMonths = null;
  let cachedYearMetrics = null;
  let activeHoverIdxYear = -1;

  function drawMultiDayChart(days, mode) {
    if (!ctx24h || !days || days.length === 0) return;
    cachedMultiDays = days;
    const dims = setupHiDPI(canvas24h, ctx24h);
    if (!dims) return;
    const w = dims.width;
    const h = dims.height;

    const padLeft = 48;
    const padRight = 42;
    const padTop = 20;
    const padBottom = 28;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    ctx24h.clearRect(0, 0, w, h);

    let maxWh = 100;
    let maxPeakW = 50;
    let totalWh = 0;

    days.forEach(d => {
      const wh = d.energy_wh ?? d.total_energy_wh ?? 0;
      const pw = d.peak_solar_w || 0;
      totalWh += wh;
      if (wh > maxWh) maxWh = wh;
      if (pw > maxPeakW) maxPeakW = pw;
    });

    maxWh = Math.ceil(maxWh / 100) * 100;
    maxPeakW = Math.ceil(maxPeakW / 50) * 50;
    cachedMultiMetrics = { padLeft, padRight, padTop, padBottom, plotW, plotH, maxWh, maxPeakW, w, h, days };

    const totalKWh = (totalWh / 1000.0).toFixed(2);
    const avgWh = Math.round(totalWh / days.length);

    if (elPeak24h) {
      if (mode === 'week') {
        elPeak24h.textContent = `7-Day Total: ${totalWh.toLocaleString()} Wh • Peak: ${maxPeakW} W`;
      } else if (mode === 'month') {
        elPeak24h.textContent = `30-Day: ${totalKWh} kWh (${totalWh.toLocaleString()} Wh) • Peak: ${maxPeakW} W`;
      } else if (mode === 'quarter') {
        elPeak24h.textContent = `Quarter: ${totalKWh} kWh • Daily Avg: ${avgWh} Wh • Peak: ${maxPeakW} W`;
      } else if (mode === 'halfyear') {
        elPeak24h.textContent = `6-Month: ${totalKWh} kWh • Daily Avg: ${avgWh} Wh • Peak: ${maxPeakW} W`;
      } else {
        elPeak24h.textContent = `Total: ${totalKWh} kWh • Peak: ${maxPeakW} W`;
      }
    }

    // 1. Grid Lines & Dual Y-Axes
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const yWh = Math.round((maxWh / ySteps) * i);
      const yWatts = Math.round((maxPeakW / ySteps) * i);
      const yPos = padTop + plotH - (i / ySteps) * plotH;

      ctx24h.beginPath();
      ctx24h.moveTo(padLeft, yPos);
      ctx24h.lineTo(w - padRight, yPos);
      ctx24h.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx24h.lineWidth = 1;
      ctx24h.stroke();

      // Left Y-Axis: Wh (Cyan)
      ctx24h.font = '10px var(--font-mono)';
      ctx24h.fillStyle = i === ySteps ? '#06b6d4' : '#64748b';
      ctx24h.textAlign = 'right';
      ctx24h.fillText(yWh >= 1000 ? `${(yWh / 1000).toFixed(1)}k` : `${yWh}`, padLeft - 6, yPos + 3);

      // Right Y-Axis: Peak Watts (Amber)
      ctx24h.fillStyle = i === ySteps ? '#fbbf24' : '#d97706';
      ctx24h.textAlign = 'left';
      ctx24h.fillText(`${yWatts}W`, w - padRight + 6, yPos + 3);
    }

    // Headers
    ctx24h.font = 'bold 9px var(--font-mono)';
    ctx24h.fillStyle = '#06b6d4';
    ctx24h.textAlign = 'right';
    ctx24h.fillText('YIELD (Wh)', padLeft - 6, padTop - 6);

    ctx24h.fillStyle = '#f59e0b';
    ctx24h.textAlign = 'left';
    ctx24h.fillText('PEAK WATTS', w - padRight + 6, padTop - 6);

    // 2. Draw Daily Bars
    const barCount = days.length;
    const slotW = plotW / barCount;
    const barW = Math.max(2, Math.min(32, slotW * 0.72));

    const coords = [];
    days.forEach((d, idx) => {
      const wh = d.energy_wh ?? d.total_energy_wh ?? 0;
      const pw = d.peak_solar_w || 0;
      const cx = padLeft + (idx + 0.5) * slotW;
      const barH = (wh / maxWh) * plotH;
      const bx = cx - barW / 2;
      const by = padTop + plotH - barH;
      const py = padTop + plotH - (pw / maxPeakW) * plotH;
      coords.push({ cx, bx, by, barW, barH, py, d });

      // Bar fill with gradient
      const isToday = d.day_label === 'Today';
      const isHovered = (activeHoverIdxMulti === idx);
      const barGrad = ctx24h.createLinearGradient(0, by, 0, padTop + plotH);
      if (isHovered) {
        barGrad.addColorStop(0, '#ffffff');
        barGrad.addColorStop(1, 'rgba(56, 189, 248, 0.7)');
      } else if (isToday) {
        barGrad.addColorStop(0, '#f59e0b');
        barGrad.addColorStop(1, 'rgba(245, 158, 11, 0.35)');
      } else {
        barGrad.addColorStop(0, '#06b6d4');
        barGrad.addColorStop(1, 'rgba(6, 182, 212, 0.25)');
      }

      ctx24h.fillStyle = barGrad;
      ctx24h.beginPath();
      if (barW >= 6) {
        ctx24h.roundRect(bx, by, barW, barH, [3, 3, 0, 0]);
      } else {
        ctx24h.rect(bx, by, barW, barH);
      }
      ctx24h.fill();
    });

    // 3. Rolling Moving Average Line (Emerald)
    const windowSize = barCount <= 7 ? 3 : (barCount <= 30 ? 5 : 7);
    ctx24h.beginPath();
    let started = false;
    coords.forEach((pt, idx) => {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, idx - windowSize + 1); j <= idx; j++) {
        sum += (days[j].energy_wh ?? days[j].total_energy_wh ?? 0);
        count++;
      }
      const avg = sum / count;
      const avgY = padTop + plotH - (avg / maxWh) * plotH;
      if (!started) {
        ctx24h.moveTo(pt.cx, avgY);
        started = true;
      } else {
        ctx24h.lineTo(pt.cx, avgY);
      }
    });
    ctx24h.strokeStyle = '#10b981';
    ctx24h.lineWidth = 2.0;
    ctx24h.stroke();

    // 4. Peak Watts Trend Line (Amber dotted)
    ctx24h.beginPath();
    ctx24h.setLineDash([2, 3]);
    coords.forEach((pt, idx) => {
      if (idx === 0) ctx24h.moveTo(pt.cx, pt.py);
      else ctx24h.lineTo(pt.cx, pt.py);
    });
    ctx24h.strokeStyle = 'rgba(245, 158, 11, 0.65)';
    ctx24h.lineWidth = 1.4;
    ctx24h.stroke();
    ctx24h.setLineDash([]);

    // Dots on Peak Watts for smaller sets
    if (barCount <= 30) {
      coords.forEach(pt => {
        if (pt.d.peak_solar_w > 0) {
          ctx24h.beginPath();
          ctx24h.arc(pt.cx, pt.py, 3, 0, 2 * Math.PI);
          ctx24h.fillStyle = '#fbbf24';
          ctx24h.fill();
        }
      });
    }

    // 5. Active Hover Crosshair
    if (activeHoverIdxMulti >= 0 && activeHoverIdxMulti < coords.length) {
      const hPt = coords[activeHoverIdxMulti];
      ctx24h.beginPath();
      ctx24h.moveTo(hPt.cx, padTop);
      ctx24h.lineTo(hPt.cx, padTop + plotH);
      ctx24h.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx24h.lineWidth = 1.5;
      ctx24h.setLineDash([2, 3]);
      ctx24h.stroke();
      ctx24h.setLineDash([]);

      ctx24h.beginPath();
      ctx24h.arc(hPt.cx, hPt.py, 5, 0, 2 * Math.PI);
      ctx24h.fillStyle = '#fbbf24';
      ctx24h.fill();
      ctx24h.strokeStyle = '#fff';
      ctx24h.lineWidth = 1.5;
      ctx24h.stroke();
    }

    // 6. X-Axis Labels
    ctx24h.font = '10px var(--font-family)';
    ctx24h.fillStyle = '#94a3b8';
    ctx24h.textAlign = 'center';

    let labelStep = 1;
    if (barCount > 60) labelStep = Math.ceil(barCount / 6);
    else if (barCount > 20) labelStep = Math.ceil(barCount / 7);
    else if (barCount > 10) labelStep = 2;

    for (let idx = 0; idx < barCount; idx += labelStep) {
      const pt = coords[idx];
      let lbl = pt.d.day_label || pt.d.date;
      if (barCount > 14 && pt.d.date && pt.d.date.length >= 10) {
        lbl = pt.d.date.substring(5);
      }
      ctx24h.fillText(lbl, pt.cx, h - 8);
    }
  }

  function drawYearlyChart(months) {
    if (!ctx24h || !months || months.length === 0) return;
    cachedYearMonths = months;
    const dims = setupHiDPI(canvas24h, ctx24h);
    if (!dims) return;
    const w = dims.width;
    const h = dims.height;

    const padLeft = 52;
    const padRight = 45;
    const padTop = 20;
    const padBottom = 28;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    ctx24h.clearRect(0, 0, w, h);

    let maxKWh = 1.0;
    let maxAvgWh = 100;
    let totalAnnualWh = 0;
    let peakMonth = months[0];

    months.forEach(m => {
      const wh = m.total_energy_wh || 0;
      const kwh = m.total_energy_kwh || (wh / 1000.0);
      const avg = m.daily_avg_wh || (m.days_counted ? Math.round(wh / m.days_counted) : Math.round(wh / 30));
      totalAnnualWh += wh;
      if (kwh > maxKWh) maxKWh = kwh;
      if (avg > maxAvgWh) maxAvgWh = avg;
      if (wh > (peakMonth.total_energy_wh || 0)) peakMonth = m;
    });

    maxKWh = Math.ceil(maxKWh * 1.15 * 10) / 10;
    maxAvgWh = Math.ceil(maxAvgWh / 100) * 100;
    cachedYearMetrics = { padLeft, padRight, padTop, padBottom, plotW, plotH, maxKWh, maxAvgWh, w, h, months };

    const totalAnnualKWh = (totalAnnualWh / 1000.0).toFixed(1);
    if (elPeak24h) {
      elPeak24h.textContent = `Annual: ${totalAnnualKWh} kWh • Peak Month: ${peakMonth.month_label || peakMonth.month_key} (${(peakMonth.total_energy_wh/1000).toFixed(1)} kWh)`;
    }

    // 1. Grid Lines & Dual Y-Axes
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const yKWh = ((maxKWh / ySteps) * i).toFixed(1);
      const yAvg = Math.round((maxAvgWh / ySteps) * i);
      const yPos = padTop + plotH - (i / ySteps) * plotH;

      ctx24h.beginPath();
      ctx24h.moveTo(padLeft, yPos);
      ctx24h.lineTo(w - padRight, yPos);
      ctx24h.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx24h.lineWidth = 1;
      ctx24h.stroke();

      // Left Y-Axis: kWh
      ctx24h.font = '10px var(--font-mono)';
      ctx24h.fillStyle = i === ySteps ? '#fbbf24' : '#64748b';
      ctx24h.textAlign = 'right';
      ctx24h.fillText(`${yKWh}k`, padLeft - 6, yPos + 3);

      // Right Y-Axis: Daily Avg Wh
      ctx24h.fillStyle = i === ySteps ? '#10b981' : '#059669';
      ctx24h.textAlign = 'left';
      ctx24h.fillText(`${yAvg}Wh/d`, w - padRight + 6, yPos + 3);
    }

    // Headers
    ctx24h.font = 'bold 9px var(--font-mono)';
    ctx24h.fillStyle = '#f59e0b';
    ctx24h.textAlign = 'right';
    ctx24h.fillText('MONTHLY (kWh)', padLeft - 6, padTop - 6);

    ctx24h.fillStyle = '#10b981';
    ctx24h.textAlign = 'left';
    ctx24h.fillText('DAILY AVG', w - padRight + 6, padTop - 6);

    // 2. Draw 12 Monthly Bars
    const barCount = months.length;
    const slotW = plotW / barCount;
    const barW = Math.min(38, slotW * 0.70);

    const coords = [];
    months.forEach((m, idx) => {
      const kwh = m.total_energy_kwh || ((m.total_energy_wh || 0) / 1000.0);
      const avg = m.daily_avg_wh || (m.days_counted ? Math.round(m.total_energy_wh / m.days_counted) : Math.round(m.total_energy_wh / 30));
      const cx = padLeft + (idx + 0.5) * slotW;
      const barH = (kwh / maxKWh) * plotH;
      const bx = cx - barW / 2;
      const by = padTop + plotH - barH;
      const avgY = padTop + plotH - (avg / maxAvgWh) * plotH;
      coords.push({ cx, bx, by, barW, barH, avgY, m });

      const isHovered = (activeHoverIdxYear === idx);
      const barGrad = ctx24h.createLinearGradient(0, by, 0, padTop + plotH);
      if (isHovered) {
        barGrad.addColorStop(0, '#ffffff');
        barGrad.addColorStop(1, 'rgba(245, 158, 11, 0.8)');
      } else {
        barGrad.addColorStop(0, '#f59e0b');
        barGrad.addColorStop(1, 'rgba(245, 158, 11, 0.3)');
      }

      ctx24h.fillStyle = barGrad;
      ctx24h.beginPath();
      ctx24h.roundRect(bx, by, barW, barH, [4, 4, 0, 0]);
      ctx24h.fill();

      // Top label with kWh
      if (barW >= 24 && kwh > 0) {
        ctx24h.fillStyle = '#fbbf24';
        ctx24h.font = '9px var(--font-mono)';
        ctx24h.textAlign = 'center';
        ctx24h.fillText(`${kwh.toFixed(1)}k`, cx, Math.max(padTop + 10, by - 5));
      }

      // X-Axis month label
      ctx24h.font = '10px var(--font-family)';
      ctx24h.fillStyle = isHovered ? '#f59e0b' : '#cbd5e1';
      ctx24h.textAlign = 'center';
      const label = m.month_label ? m.month_label.split(' ')[0] : (m.month_key ? m.month_key.substring(5) : '');
      ctx24h.fillText(label, cx, h - 8);
    });

    // 3. Daily Average Line (Emerald)
    ctx24h.beginPath();
    coords.forEach((pt, idx) => {
      if (idx === 0) ctx24h.moveTo(pt.cx, pt.avgY);
      else ctx24h.lineTo(pt.cx, pt.avgY);
    });
    ctx24h.strokeStyle = '#10b981';
    ctx24h.lineWidth = 2.2;
    ctx24h.stroke();

    coords.forEach(pt => {
      ctx24h.beginPath();
      ctx24h.arc(pt.cx, pt.avgY, 3.5, 0, 2 * Math.PI);
      ctx24h.fillStyle = '#10b981';
      ctx24h.fill();
    });

    // 4. Hover Crosshair
    if (activeHoverIdxYear >= 0 && activeHoverIdxYear < coords.length) {
      const hPt = coords[activeHoverIdxYear];
      ctx24h.beginPath();
      ctx24h.moveTo(hPt.cx, padTop);
      ctx24h.lineTo(hPt.cx, padTop + plotH);
      ctx24h.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx24h.lineWidth = 1.5;
      ctx24h.setLineDash([2, 3]);
      ctx24h.stroke();
      ctx24h.setLineDash([]);
    }
  }

  function handleMultiDayHover(clientX, clientY) {
    if (!canvas24h || !cachedMultiDays || !cachedMultiMetrics || !tooltip24h) return;
    const rect = canvas24h.getBoundingClientRect();
    const xInCanvas = (clientX - rect.left) * (cachedMultiMetrics.w / rect.width);
    const { padLeft, plotW, days } = cachedMultiMetrics;

    const xRel = xInCanvas - padLeft;
    if (xRel < 0 || xRel > plotW) {
      handleMultiDayLeave();
      return;
    }

    const slotW = plotW / days.length;
    const idx = Math.min(days.length - 1, Math.max(0, Math.floor(xRel / slotW)));
    activeHoverIdxMulti = idx;
    drawMultiDayChart(days, currentTimespan);

    const d = days[idx];
    const wh = d.energy_wh ?? d.total_energy_wh ?? 0;
    const kwh = (wh / 1000.0).toFixed(2);
    const peakW = d.peak_solar_w || 0;
    const soc = d.avg_battery_soc || 100;
    const maxV = d.max_pv_v ? d.max_pv_v.toFixed(1) : null;

    tooltip24h.innerHTML = `
      <div style="font-weight: 700; color: #f8fafc; font-size: 12px; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 3px;">
        📅 ${d.day_label || d.date} <span style="font-size: 10px; color: #94a3b8; font-weight: normal;">(${d.date || ''})</span>
      </div>
      <div style="display: flex; justify-content: space-between; gap: 12px; font-size: 11px;">
        <span style="color: #38bdf8;">⚡ Daily Yield:</span>
        <span style="font-weight: 700; color: #38bdf8;">${wh.toLocaleString()} Wh (${kwh} kWh)</span>
      </div>
      <div style="display: flex; justify-content: space-between; gap: 12px; font-size: 11px;">
        <span style="color: #fbbf24;">☀️ Peak Solar:</span>
        <span style="font-weight: 700; color: #fbbf24;">${peakW} W</span>
      </div>
      ${maxV ? `<div style="display: flex; justify-content: space-between; gap: 12px; font-size: 11px;"><span style="color: #38bdf8;">🔋 Max Solar Volts:</span><span style="font-weight: 700; color: #38bdf8;">${maxV} V</span></div>` : ''}
      <div style="display: flex; justify-content: space-between; gap: 12px; font-size: 11px;">
        <span style="color: #34d399;">🔋 Avg Battery SOC:</span>
        <span style="font-weight: 700; color: #34d399;">${soc}%</span>
      </div>
    `;

    tooltip24h.style.display = 'block';
    const tipX = clientX - rect.left;
    const tipY = clientY - rect.top;
    if (tipX > rect.width * 0.6) {
      tooltip24h.style.left = `${tipX - 195}px`;
    } else {
      tooltip24h.style.left = `${tipX + 15}px`;
    }
    tooltip24h.style.top = `${Math.max(10, tipY - 50)}px`;
  }

  function handleMultiDayLeave() {
    if (tooltip24h) tooltip24h.style.display = 'none';
    if (activeHoverIdxMulti !== -1) {
      activeHoverIdxMulti = -1;
      if (cachedMultiDays) drawMultiDayChart(cachedMultiDays, currentTimespan);
    }
  }

  function handleYearlyHover(clientX, clientY) {
    if (!canvas24h || !cachedYearMonths || !cachedYearMetrics || !tooltip24h) return;
    const rect = canvas24h.getBoundingClientRect();
    const xInCanvas = (clientX - rect.left) * (cachedYearMetrics.w / rect.width);
    const { padLeft, plotW, months } = cachedYearMetrics;

    const xRel = xInCanvas - padLeft;
    if (xRel < 0 || xRel > plotW) {
      handleYearlyLeave();
      return;
    }

    const slotW = plotW / months.length;
    const idx = Math.min(months.length - 1, Math.max(0, Math.floor(xRel / slotW)));
    activeHoverIdxYear = idx;
    drawYearlyChart(months);

    const m = months[idx];
    const kwh = m.total_energy_kwh || ((m.total_energy_wh || 0) / 1000.0);
    const avg = m.daily_avg_wh || (m.days_counted ? Math.round(m.total_energy_wh / m.days_counted) : Math.round(m.total_energy_wh / 30));

    tooltip24h.innerHTML = `
      <div style="font-weight: 700; color: #f8fafc; font-size: 12px; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 3px;">
        📅 ${m.month_label || m.month_key}
      </div>
      <div style="display: flex; justify-content: space-between; gap: 12px; font-size: 11px;">
        <span style="color: #fbbf24;">⚡ Total Generation:</span>
        <span style="font-weight: 700; color: #fbbf24;">${kwh.toFixed(1)} kWh</span>
      </div>
      <div style="display: flex; justify-content: space-between; gap: 12px; font-size: 11px;">
        <span style="color: #34d399;">☀️ Daily Average:</span>
        <span style="font-weight: 700; color: #34d399;">${avg} Wh/day</span>
      </div>
      <div style="display: flex; justify-content: space-between; gap: 12px; font-size: 11px;">
        <span style="color: #38bdf8;">⚡ Peak Solar Power:</span>
        <span style="font-weight: 700; color: #38bdf8;">${m.peak_watts || 0} W</span>
      </div>
    `;

    tooltip24h.style.display = 'block';
    const tipX = clientX - rect.left;
    const tipY = clientY - rect.top;
    if (tipX > rect.width * 0.6) {
      tooltip24h.style.left = `${tipX - 195}px`;
    } else {
      tooltip24h.style.left = `${tipX + 15}px`;
    }
    tooltip24h.style.top = `${Math.max(10, tipY - 50)}px`;
  }

  function handleYearlyLeave() {
    if (tooltip24h) tooltip24h.style.display = 'none';
    if (activeHoverIdxYear !== -1) {
      activeHoverIdxYear = -1;
      if (cachedYearMonths) drawYearlyChart(cachedYearMonths);
    }
  }

  function handleUnifiedHistoryHover(clientX, clientY) {
    if (currentTimespan === 'today') {
      handle24hHover(clientX, clientY);
    } else if (currentTimespan === 'year') {
      handleYearlyHover(clientX, clientY);
    } else {
      handleMultiDayHover(clientX, clientY);
    }
  }

  function handleUnifiedHistoryLeave() {
    if (currentTimespan === 'today') {
      handle24hLeave();
    } else if (currentTimespan === 'year') {
      handleYearlyLeave();
    } else {
      handleMultiDayLeave();
    }
  }

  function renderHistoryTimespanChart() {
    if (!historyData) return;

    if (currentTimespan === 'today') {
      if (elHistoryChartTitle) elHistoryChartTitle.textContent = 'SOLAR POWER — TODAY (24H)';
      if (elLegItemVolts) elLegItemVolts.style.display = 'flex';
      if (elLegItemPower) {
        elLegItemPower.style.display = 'flex';
        elLegItemPower.innerHTML = '<span class="legend-dot solar-dot"></span> Solar Power (W)';
      }
      if (elLegItemBatt) {
        elLegItemBatt.style.display = 'flex';
        elLegItemBatt.innerHTML = '<span class="legend-dot batt-dot"></span> Battery Power (W)';
      }
      if (elLegItemSoc) elLegItemSoc.style.display = 'flex';
      if (elWindow24hLabel) elWindow24hLabel.textContent = '24-Hour Solar & Battery Flow (15m buckets)';

      if (historyData.points_24h) {
        draw24hChart(historyData.points_24h);
      }
    } else if (currentTimespan === 'week') {
      if (elHistoryChartTitle) elHistoryChartTitle.textContent = 'SOLAR HARVEST — PAST 7 DAYS';
      if (elLegItemVolts) elLegItemVolts.style.display = 'none';
      if (elLegItemPower) {
        elLegItemPower.style.display = 'flex';
        elLegItemPower.innerHTML = '<span class="legend-dot bar-dot"></span> Daily Energy Yield (Wh)';
      }
      if (elLegItemBatt) {
        elLegItemBatt.style.display = 'flex';
        elLegItemBatt.innerHTML = '<span class="legend-dot peak-dot"></span> Peak Solar Power (W)';
      }
      if (elLegItemSoc) {
        elLegItemSoc.style.display = 'flex';
        elLegItemSoc.innerHTML = '<span class="legend-dot batt-dot"></span> 3-Day Moving Avg';
      }
      if (elWindow24hLabel) elWindow24hLabel.textContent = 'Past 7 Calendar Days Daily Yield';

      const days = historyData.days_7d || (historyData.days_30d ? historyData.days_30d.slice(-7) : []);
      drawMultiDayChart(days, 'week');
    } else if (currentTimespan === 'month') {
      if (elHistoryChartTitle) elHistoryChartTitle.textContent = 'SOLAR HARVEST — PAST 30 DAYS';
      if (elLegItemVolts) elLegItemVolts.style.display = 'none';
      if (elLegItemPower) {
        elLegItemPower.style.display = 'flex';
        elLegItemPower.innerHTML = '<span class="legend-dot bar-dot"></span> Daily Energy Yield (Wh)';
      }
      if (elLegItemBatt) {
        elLegItemBatt.style.display = 'flex';
        elLegItemBatt.innerHTML = '<span class="legend-dot peak-dot"></span> Peak Solar Power (W)';
      }
      if (elLegItemSoc) {
        elLegItemSoc.style.display = 'flex';
        elLegItemSoc.innerHTML = '<span class="legend-dot batt-dot"></span> 5-Day Moving Avg';
      }
      if (elWindow24hLabel) elWindow24hLabel.textContent = 'Past 30 Calendar Days Solar Harvest';

      const days = historyData.days_30d || historyData.days_7d || [];
      drawMultiDayChart(days, 'month');
    } else if (currentTimespan === 'quarter') {
      if (elHistoryChartTitle) elHistoryChartTitle.textContent = 'SOLAR HARVEST — PAST 90 DAYS (QUARTER)';
      if (elLegItemVolts) elLegItemVolts.style.display = 'none';
      if (elLegItemPower) {
        elLegItemPower.style.display = 'flex';
        elLegItemPower.innerHTML = '<span class="legend-dot bar-dot"></span> Daily Solar Harvest (Wh)';
      }
      if (elLegItemBatt) {
        elLegItemBatt.style.display = 'flex';
        elLegItemBatt.innerHTML = '<span class="legend-dot peak-dot"></span> Peak Solar Power (W)';
      }
      if (elLegItemSoc) {
        elLegItemSoc.style.display = 'flex';
        elLegItemSoc.innerHTML = '<span class="legend-dot batt-dot"></span> 7-Day Moving Avg';
      }
      if (elWindow24hLabel) elWindow24hLabel.textContent = 'Past 90 Calendar Days (3 Months)';

      const days = historyData.days_90d || historyData.days_30d || [];
      drawMultiDayChart(days, 'quarter');
    } else if (currentTimespan === 'halfyear') {
      if (elHistoryChartTitle) elHistoryChartTitle.textContent = 'SOLAR HARVEST — PAST 6 MONTHS (HALF YEAR)';
      if (elLegItemVolts) elLegItemVolts.style.display = 'none';
      if (elLegItemPower) {
        elLegItemPower.style.display = 'flex';
        elLegItemPower.innerHTML = '<span class="legend-dot bar-dot"></span> Daily Solar Harvest';
      }
      if (elLegItemBatt) {
        elLegItemBatt.style.display = 'flex';
        elLegItemBatt.innerHTML = '<span class="legend-dot peak-dot"></span> Peak Solar Power (W)';
      }
      if (elLegItemSoc) {
        elLegItemSoc.style.display = 'flex';
        elLegItemSoc.innerHTML = '<span class="legend-dot batt-dot"></span> 7-Day Moving Avg';
      }
      if (elWindow24hLabel) elWindow24hLabel.textContent = 'Past 180 Calendar Days (6 Months)';

      const days = historyData.days_180d || historyData.days_90d || [];
      drawMultiDayChart(days, 'halfyear');
    } else if (currentTimespan === 'year') {
      if (elHistoryChartTitle) elHistoryChartTitle.textContent = 'SOLAR HARVEST — PAST 12 MONTHS (WHOLE YEAR)';
      if (elLegItemVolts) elLegItemVolts.style.display = 'none';
      if (elLegItemPower) {
        elLegItemPower.style.display = 'flex';
        elLegItemPower.innerHTML = '<span class="legend-dot solar-dot"></span> Monthly Production (kWh)';
      }
      if (elLegItemBatt) {
        elLegItemBatt.style.display = 'flex';
        elLegItemBatt.innerHTML = '<span class="legend-dot batt-dot"></span> Daily Average Yield';
      }
      if (elLegItemSoc) elLegItemSoc.style.display = 'none';
      if (elWindow24hLabel) elWindow24hLabel.textContent = 'Past 12 Calendar Months Production';

      const months = historyData.months_12m || [];
      drawYearlyChart(months);
    }
  }

  function setTimespan(span) {
    currentTimespan = span;
    try {
      localStorage.setItem('renology_timespan', span);
    } catch (_) {}
    document.querySelectorAll('.span-btn').forEach(btn => {
      const isActive = (btn.dataset.span === span);
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    renderHistoryTimespanChart();
  }

  // Setup Timespan Tab Click & Touch Handlers
  document.querySelectorAll('.span-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      setTimespan(btn.dataset.span);
    });
  });

  // Apply initially saved timespan tab state
  if (currentTimespan !== 'today') {
    document.querySelectorAll('.span-btn').forEach(btn => {
      const isActive = (btn.dataset.span === currentTimespan);
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
  }

  if (canvas24h) {
    canvas24h.addEventListener('mousemove', e => handleUnifiedHistoryHover(e.clientX, e.clientY));
    canvas24h.addEventListener('mouseleave', handleUnifiedHistoryLeave);
    canvas24h.addEventListener('touchmove', e => {
      if (e.touches.length > 0) {
        handleUnifiedHistoryHover(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });
    canvas24h.addEventListener('touchend', handleUnifiedHistoryLeave);
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

        if (m.solar_radiation_wm2 !== undefined && m.solar_radiation_wm2 !== null) {
          latestWeatherSolarRad = Number(m.solar_radiation_wm2);
          if (lastTelemetry) {
            updateSolarPotentialAndCurtailment(
              lastTelemetry.pv_voltage_v,
              lastTelemetry.pv_power_w,
              lastTelemetry.battery_soc_percent,
              lastTelemetry.max_charging_power_today_w
            );
          }
        }

        if (elWeatherOutdoorTemp) elWeatherOutdoorTemp.innerHTML = `${m.outdoor_temperature_c}<span class="unit">°C</span>`;
        if (elWeatherTempF) elWeatherTempF.textContent = `${m.outdoor_temperature_f || '--'}°F`;
        if (elWeatherHumidity) elWeatherHumidity.innerHTML = `${m.outdoor_humidity_pct}<span class="unit">%</span>`;
        if (elWeatherPressure) elWeatherPressure.textContent = `${m.pressure_relative_hpa || '--'} hPa`;
        if (elWeatherWind) elWeatherWind.innerHTML = `${m.wind_speed_kmh || 0}<span class="unit">km/h</span>`;
        if (elWeatherGust) elWeatherGust.textContent = `Gust: ${m.wind_gust_kmh || '--'} km/h (${m.wind_direction_deg || 0}°)`;
        if (elWeatherSolarRad) elWeatherSolarRad.innerHTML = `${m.solar_radiation_wm2 || 0}<span class="unit">W/m²</span>`;
        if (elWeatherUv) elWeatherUv.textContent = `UV: ${m.uv_index || 0} • Rain: ${m.daily_rain_mm || 0}mm`;
        if (elWeatherStationSub) elWeatherStationSub.textContent = `EasyWeather DD85 (${data.updated_at || 'synced'})`;

        if (lastTelemetry) {
          updateSolarPotentialAndCurtailment(
            lastTelemetry.pv_voltage_v,
            lastTelemetry.pv_power_w,
            lastTelemetry.battery_soc_percent,
            lastTelemetry.max_charging_power_today_w
          );
          updateHumanNarrative(lastTelemetry);
        }
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
  // SOLAR POTENTIAL & CURTAILMENT ANALYTICS
  // =========================================================================
  function updateSolarPotentialAndCurtailment(pvVolts, pvWatts, battSoc, maxChargingToday) {
    if (!elCurtailmentBadge || !elActualHarvestVal || !elCurtailmentTag || !elCurtailmentBarFill || !elSunPotentialVal) return;

    pvVolts = Number(pvVolts) || 0;
    pvWatts = Number(pvWatts) || 0;
    battSoc = Number(battSoc) || 0;
    maxChargingToday = Number(maxChargingToday) || 286;

    // Nominal array rating: ~320W peak based on Rover 20 and 2-panel string
    const arrayCapacityW = Math.max(300, maxChargingToday);

    // Calculate Sun Potential Power:
    let sunPotentialW = 0;
    if (latestWeatherSolarRad !== null && latestWeatherSolarRad > 0) {
      // 1000 W/m² = STC full sun (100% array capacity)
      sunPotentialW = Math.round((latestWeatherSolarRad / 1000) * arrayCapacityW);
      // Floor under high panel voltage (if panels are at 38V+, sun is direct)
      if (pvVolts >= 38) {
        sunPotentialW = Math.max(sunPotentialW, Math.round(arrayCapacityW * 0.85));
      }
    } else {
      // Voltage heuristic fallback
      if (pvVolts >= 38) sunPotentialW = Math.round(arrayCapacityW * 0.90);
      else if (pvVolts >= 32) sunPotentialW = Math.round(arrayCapacityW * 0.60);
      else if (pvVolts >= 20) sunPotentialW = Math.round(arrayCapacityW * 0.30);
      else sunPotentialW = 0;
    }

    // Determine Curtailment State
    if (pvVolts >= 28 && battSoc >= 95 && pvWatts < 60) {
      // Battery is full (>95%) with high PV voltage, but controller is throttled
      const effectivePot = Math.max(pvWatts + 20, sunPotentialW);
      const throttledPct = Math.min(98, Math.max(50, Math.round((1 - (pvWatts / effectivePot)) * 100)));

      elCurtailmentBadge.textContent = '☀️ Full Sun • Tank Full';
      elCurtailmentBadge.className = 'badge curtailment-badge throttled';
      elCurtailmentTag.textContent = `TANK FULL • ${throttledPct}% SOLAR STANDBY`;
      elCurtailmentTag.style.color = '#fbbf24';
      elActualHarvestVal.textContent = `${pvWatts} W`;
      elSunPotentialVal.textContent = `~${effectivePot} W`;
      elCurtailmentBarFill.style.width = `${Math.max(5, Math.round((pvWatts / effectivePot) * 100))}%`;
      elCurtailmentBarFill.style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
    } else if (pvWatts >= 60 || (pvWatts > 10 && battSoc < 95)) {
      // Actively harvesting MPPT power into battery/load
      const effectivePot = Math.max(pvWatts, sunPotentialW);
      const harvestPct = Math.min(100, Math.round((pvWatts / Math.max(1, effectivePot)) * 100));

      elCurtailmentBadge.textContent = '⚡ Charging Battery';
      elCurtailmentBadge.className = 'badge curtailment-badge harvesting';
      elCurtailmentTag.textContent = `CHARGING AT ${pvWatts}W (${harvestPct}% SUN)`;
      elCurtailmentTag.style.color = '#34d399';
      elActualHarvestVal.textContent = `${pvWatts} W`;
      elSunPotentialVal.textContent = `~${effectivePot} W`;
      elCurtailmentBarFill.style.width = `${harvestPct}%`;
      elCurtailmentBarFill.style.background = 'linear-gradient(90deg, #10b981, #06b6d4)';
    } else {
      // Low sun / Night / Inactive
      elCurtailmentBadge.textContent = '🌙 Low Sun / Standby';
      elCurtailmentBadge.className = 'badge curtailment-badge night';
      elCurtailmentTag.textContent = 'RUNNING ON BATTERY STORAGE';
      elCurtailmentTag.style.color = '#94a3b8';
      elActualHarvestVal.textContent = `${pvWatts} W`;
      elSunPotentialVal.textContent = `0 W`;
      elCurtailmentBarFill.style.width = '0%';
      elCurtailmentBarFill.style.background = '#64748b';
    }
  }

  function updateHumanNarrative(t) {
    if (!elHumanStoryBanner) return;

    const pvVolts = Number(t.pv_voltage_v) || 0;
    const pvWatts = Number(t.pv_power_w) || 0;
    const battSoc = Number(t.battery_soc_percent) || 0;
    const battV = Number(t.battery_voltage_v) || 0;
    const todayWh = Number(t.power_generation_today_wh) || 0;
    const fault = Number(t.fault_code) || 0;

    // Calculate relatable everyday equivalents
    if (elStoryEquivText) {
      if (todayWh >= 300) {
        const laptopHrs = (todayWh / 65).toFixed(1);
        elStoryEquivText.textContent = `Today: ~${laptopHrs}h Laptop Run (${todayWh}Wh)`;
      } else if (todayWh >= 15) {
        const phones = Math.max(1, Math.round(todayWh / 15));
        elStoryEquivText.textContent = `Today: ~${phones} Phone Charges (${todayWh}Wh)`;
      } else {
        elStoryEquivText.textContent = `Today: Harvest Started (${todayWh}Wh)`;
      }
    }

    // Determine narrative state
    if (fault !== 0) {
      elHumanStoryBanner.className = 'human-story-banner alert';
      if (elStoryIcon) elStoryIcon.textContent = '⚠️';
      if (elStoryHeadline) elStoryHeadline.textContent = `SYSTEM ALERT • CODE 0x${fault.toString(16).toUpperCase()}`;
      if (elStoryDesc) elStoryDesc.textContent = 'Hardware fault detected on the solar charge controller. Check connection wiring.';
    } else if (battSoc >= 95 && pvVolts >= 28 && pvWatts < 60) {
      // Tank full in bright sun
      elHumanStoryBanner.className = 'human-story-banner';
      if (elStoryIcon) elStoryIcon.textContent = '☀️';
      if (elStoryHeadline) elStoryHeadline.textContent = 'BATTERY TANK 100% FULL • SOLAR ON STANDBY';
      if (elStoryDesc) elStoryDesc.textContent = 'Everything looks great! The sun is shining bright and your battery tank is topped up. Solar is resting on standby.';
    } else if (battSoc >= 95 && pvWatts >= 60) {
      // Tank full, powering active loads directly from sunlight
      elHumanStoryBanner.className = 'human-story-banner charging';
      if (elStoryIcon) elStoryIcon.textContent = '⚡';
      if (elStoryHeadline) elStoryHeadline.textContent = 'POWERING APPLIANCES DIRECT FROM SUN';
      if (elStoryDesc) elStoryDesc.textContent = `Battery is full! The sun is powering your appliances directly with ${pvWatts}W of free clean energy.`;
    } else if (pvWatts >= 25 && battSoc < 95) {
      // Active charging
      elHumanStoryBanner.className = 'human-story-banner charging';
      if (elStoryIcon) elStoryIcon.textContent = '⚡';
      if (elStoryHeadline) elStoryHeadline.textContent = `ACTIVELY CHARGING BATTERY (${pvWatts}W)`;
      if (elStoryDesc) elStoryDesc.textContent = `The solar panels are pouring ${pvWatts}W into your battery tank (currently ${battSoc}%).`;
    } else if (pvVolts < 15 || (latestWeatherSolarRad !== null && latestWeatherSolarRad < 20)) {
      // Night / resting
      elHumanStoryBanner.className = 'human-story-banner night';
      if (elStoryIcon) elStoryIcon.textContent = '🌙';
      if (elStoryHeadline) elStoryHeadline.textContent = 'SUN HAS SET • RUNNING SMOOTHLY ON BATTERY';
      if (elStoryDesc) elStoryDesc.textContent = `Panels are asleep for the night. Your battery has plenty of stored energy (${battSoc}%, ${battV.toFixed(1)}V).`;
    } else {
      // Daylight, but low solar / overcast
      elHumanStoryBanner.className = 'human-story-banner';
      if (elStoryIcon) elStoryIcon.textContent = '⛅';
      if (elStoryHeadline) elStoryHeadline.textContent = 'OVERCAST / LOW SUN • TRICKLE CHARGE';
      if (elStoryDesc) elStoryDesc.textContent = `Cloudy conditions outside. Harvesting ${pvWatts}W of diffuse daylight into the battery.`;
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
      if (t.charging_status && elChargingState) {
        if (t.charging_status === 'MPPT') {
          elChargingState.textContent = 'Smart Solar Active';
        } else {
          elChargingState.textContent = `${t.charging_status} Active`;
        }
      }

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
      triggerNeedleAnimation();
      if (elSolarPower) elSolarPower.innerHTML = `${t.pv_power_w || 0}<span class="unit">W</span>`;
      if (elPvV) elPvV.innerHTML = `${(t.pv_voltage_v || 0).toFixed(1)}<span class="unit">V</span>`;
      if (elPvA) elPvA.innerHTML = `${(t.pv_current_a || 0).toFixed(2)}<span class="unit">A</span>`;
      if (elPowerToday) elPowerToday.innerHTML = `${t.power_generation_today_wh || 0}<span class="unit">Wh</span>`;
      if (t.power_generation_total_kwh && elLifetimeKwh) {
        elLifetimeKwh.textContent = `${t.power_generation_total_kwh.toLocaleString()} kWh`;
      }

      // Update Solar Potential, Curtailment & Human Story Analytics
      lastTelemetry = t;
      updateSolarPotentialAndCurtailment(
        t.pv_voltage_v,
        t.pv_power_w,
        t.battery_soc_percent,
        t.max_charging_power_today_w
      );
      updateHumanNarrative(t);

      // Update System Hardware
      if (elCtrlTemp) elCtrlTemp.textContent = `${t.controller_temp_c || 0}°C`;
      if (elBattTemp) elBattTemp.textContent = `${t.battery_temp_c || 0}°C`;
      if (elLoadStatus) {
        const isLoadOn = t.load_status === 'On' || (t.load_power_w && t.load_power_w > 0);
        elLoadStatus.textContent = isLoadOn ? `Running (${t.load_power_w || 0}W)` : `Idle (0W)`;
      }

      if (elFaultCode) {
        if (t.fault_code === 0) {
          elFaultCode.textContent = '0 (Healthy)';
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

      renderHistoryTimespanChart();
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
      renderHistoryTimespanChart();
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
