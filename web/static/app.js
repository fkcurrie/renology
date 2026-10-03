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
  const elGaugeCapacitySub = document.getElementById('gaugeCapacitySub');
  const elBattV = document.getElementById('battVoltageVal');
  const elBattA = document.getElementById('battCurrentVal');
  const elBattW = document.getElementById('battPowerVal');
  const elBattFreezeStatus = document.getElementById('battFreezeStatus');
  const elBattHealthRating = document.getElementById('battHealthRating');

  // Speedometer & Solar Card
  const elSpeedoVolts = document.getElementById('speedoVoltsVal');
  const elSolarPower = document.getElementById('solarPowerVal');
  const elPvV = document.getElementById('pvVoltageVal');
  const elPvA = document.getElementById('pvCurrentVal');
  const elPowerToday = document.getElementById('powerTodayVal');
  const elPvPeakTodayVal = document.getElementById('pvPeakTodayVal');
  const elChargingAhVal = document.getElementById('chargingAhVal');
  const elLifetimeKwh = document.getElementById('lifetimeKwhVal');

  // Solar Potential & Curtailment
  const elCurtailmentBadge = document.getElementById('curtailmentBadge');
  const elActualHarvestVal = document.getElementById('actualHarvestVal');
  const elCurtailmentTag = document.getElementById('curtailmentTag');
  const elCurtailmentBarFill = document.getElementById('curtailmentBarFill');
  const elSunPotentialVal = document.getElementById('sunPotentialVal');

  // Cabin & Environment Card
  const elCtrlTemp = document.getElementById('ctrlTempVal');
  const elBattTemp = document.getElementById('battTempVal');
  const elCabinTempVal = document.getElementById('cabinTempVal');
  const elCabinHumVal = document.getElementById('cabinHumVal');
  const elFaultCode = document.getElementById('faultCodeVal');
  const elRssi = document.getElementById('bleRssiVal');
  const elWeatherStatusBadge = document.getElementById('weatherStatusBadge');
  const elWeatherOutdoorTemp = document.getElementById('weatherOutdoorTemp');
  const elWeatherTempF = document.getElementById('weatherTempF');
  const elWeatherSolarRad = document.getElementById('weatherSolarRad');
  const elWeatherSolarFluxDesc = document.getElementById('weatherSolarFluxDesc');
  const elWeatherRainVal = document.getElementById('weatherRainVal');
  const elWeatherRainRate = document.getElementById('weatherRainRate');
  const elDorsetDayLength = document.getElementById('dorsetDayLength');
  const elDorsetSolarNoon = document.getElementById('dorsetSolarNoon');
  const elWeatherStationSub = document.getElementById('weatherStationSub');

  // Voltworks 1000W Inverter & Autonomy Hub
  const elAutonomyUsableWh = document.getElementById('autonomyUsableWh');
  const elAutonomySocSub = document.getElementById('autonomySocSub');
  const elRunStarlink = document.getElementById('runStarlink');
  const elRunLaptop = document.getElementById('runLaptop');
  const elRunFridge = document.getElementById('runFridge');
  const elRunLights = document.getElementById('runLights');
  const elRunStandby = document.getElementById('runStandby');
  const elHeadroomText = document.getElementById('headroomText');
  const elHeadroomBarFill = document.getElementById('headroomBarFill');

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
  const elLegItemPeak = document.getElementById('legItemPeak');
  const elLegItemSun = document.getElementById('legItemSun');
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

  // Official NOAA / NRC Canada astronomical ephemeris for Dorset, Ontario (45.2447° N, 78.8950° W)
  function getDorsetSunTimes(refDate) {
    if (historyData && historyData.sun_times && historyData.sun_times.sunrise && historyData.sun_times.sunset) {
      return historyData.sun_times;
    }
    const d = refDate || new Date();
    const lat = 45.2447;
    const lon = -78.8950;
    const startOfYear = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const dayOfYear = Math.floor((d.getTime() - startOfYear.getTime()) / (24 * 3600 * 1000)) + 1;
    const gamma = (2 * Math.PI / 365) * (dayOfYear - 1);
    const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
                             - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
    const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
                 - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
                 - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
    const zenithRad = 90.833 * Math.PI / 180;
    const latRad = lat * Math.PI / 180;
    const cosHA = (Math.cos(zenithRad) / (Math.cos(latRad) * Math.cos(decl))) - (Math.tan(latRad) * Math.tan(decl));
    if (cosHA > 1 || cosHA < -1) return null;
    const haDeg = Math.acos(cosHA) * 180 / Math.PI;
    const solarNoonUTCMin = 720 - (4 * lon) - eqtime;
    const sunriseUTCMin = solarNoonUTCMin - (haDeg * 4);
    const sunsetUTCMin = solarNoonUTCMin + (haDeg * 4);

    const midnightUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const sr = new Date(midnightUTC + sunriseUTCMin * 60000);
    const ss = new Date(midnightUTC + sunsetUTCMin * 60000);
    const sn = new Date(midnightUTC + solarNoonUTCMin * 60000);

    const pad = n => (n < 10 ? '0' + n : '' + n);
    const srTime = pad(sr.getHours()) + ':' + pad(sr.getMinutes());
    const ssTime = pad(ss.getHours()) + ':' + pad(ss.getMinutes());
    const snTime = pad(sn.getHours()) + ':' + pad(sn.getMinutes());
    const dayLenMin = Math.round((ss.getTime() - sr.getTime()) / 60000);
    const dayLength = Math.floor(dayLenMin / 60) + 'h ' + pad(dayLenMin % 60) + 'm';

    return {
      location: 'Dorset, Ontario',
      latitude: lat,
      longitude: lon,
      sunrise: sr.toISOString(),
      sunset: ss.toISOString(),
      solar_noon: sn.toISOString(),
      sunrise_time: srTime,
      sunset_time: ssTime,
      solar_noon_time: snTime,
      day_length: dayLength,
      source: 'NOAA / NRC Canada Astronomical Ephemeris'
    };
  }

  function draw24hChart(points, mode) {
    if (!ctx24h || !points || points.length === 0) return;
    if (!mode) mode = currentTimespan || 'today';
    cachedPoints24h = points;
    const dims = setupHiDPI(canvas24h, ctx24h);
    if (!dims) return;
    const w = dims.width;
    const h = dims.height;

    // Margins: left for Watts, right for Volts, bottom for timestamps
    const padLeft = 45;
    const padRight = 38;
    const padTop = 26;
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

    // Map peakSolarW to true Solar Power generation for the active period (not bucketed average)
    let periodTruePeakSolarW = 0;
    if (mode === 'today') {
      if (historyData && historyData.days_7d) {
        const todayRec = historyData.days_7d.find(d => d.day_label === 'Today' || (d.date && lastTelemetry && lastTelemetry.timestamp && d.date === lastTelemetry.timestamp.substring(0, 10)));
        if (todayRec && todayRec.peak_solar_w) periodTruePeakSolarW = Math.max(periodTruePeakSolarW, todayRec.peak_solar_w);
      }
      if (lastTelemetry) {
        if (lastTelemetry.max_charging_power_today_w) periodTruePeakSolarW = Math.max(periodTruePeakSolarW, lastTelemetry.max_charging_power_today_w);
        if (lastTelemetry.pv_power_w) periodTruePeakSolarW = Math.max(periodTruePeakSolarW, lastTelemetry.pv_power_w);
      }
    } else if (mode === 'week') {
      if (historyData && historyData.days_7d) {
        periodTruePeakSolarW = historyData.days_7d.reduce((m, d) => Math.max(m, d.peak_solar_w || 0), 0);
      }
    } else if (mode === 'month') {
      if (historyData && historyData.days_30d) {
        periodTruePeakSolarW = historyData.days_30d.reduce((m, d) => Math.max(m, d.peak_solar_w || 0), 0);
      }
    } else if (mode === 'quarter') {
      if (historyData && historyData.days_90d) {
        periodTruePeakSolarW = historyData.days_90d.reduce((m, d) => Math.max(m, d.peak_solar_w || 0), 0);
      }
    } else if (mode === 'halfyear') {
      if (historyData && historyData.days_180d) {
        periodTruePeakSolarW = historyData.days_180d.reduce((m, d) => Math.max(m, d.peak_solar_w || 0), 0);
      }
    } else if (mode === 'year') {
      if (historyData && historyData.days_365d) {
        periodTruePeakSolarW = historyData.days_365d.reduce((m, d) => Math.max(m, d.peak_solar_w || 0), 0);
      } else if (historyData && historyData.months_12m) {
        periodTruePeakSolarW = historyData.months_12m.reduce((m, d) => Math.max(m, d.peak_watts || 0), 0);
      }
    }

    if (periodTruePeakSolarW > peakSolarW) {
      peakSolarW = periodTruePeakSolarW;
    }

    if (peakSolarW > maxW) maxW = peakSolarW;
    maxW = Math.ceil(maxW / 50) * 50;
    maxV = Math.ceil(maxV / 10) * 10;
    cachedMetrics24h = { padLeft, padRight, padTop, padBottom, plotW, plotH, maxW, maxV, w, h, mode };

    if (elPeak24h) {
      if (mode === 'week') {
        elPeak24h.textContent = `7d Peak Solar: ${peakSolarW} W • Max Solar: ${peakSolarV.toFixed(1)} V`;
      } else if (mode === 'month') {
        elPeak24h.textContent = `30d Peak Solar: ${peakSolarW} W • Max Solar: ${peakSolarV.toFixed(1)} V`;
      } else if (mode === 'quarter') {
        elPeak24h.textContent = `Quarter Peak Solar: ${peakSolarW} W • Max Solar: ${peakSolarV.toFixed(1)} V`;
      } else if (mode === 'halfyear') {
        elPeak24h.textContent = `6-Month Peak Solar: ${peakSolarW} W • Max Solar: ${peakSolarV.toFixed(1)} V`;
      } else if (mode === 'year') {
        elPeak24h.textContent = `1-Year Peak Solar: ${peakSolarW} W • Max Solar: ${peakSolarV.toFixed(1)} V`;
      } else {
        elPeak24h.textContent = `24h Peak Solar: ${peakSolarW} W • Max Solar: ${peakSolarV.toFixed(1)} V`;
      }
    }

    // Toggle sun & peak legend items based on mode & peak
    if (elLegItemSun) {
      elLegItemSun.style.display = (mode === 'today') ? 'inline-flex' : 'none';
    }
    if (elLegItemPeak) {
      elLegItemPeak.style.display = (peakSolarW > 0) ? 'inline-flex' : 'none';
    }

    // Determine Sunrise and Sunset positions for Dorset, Ontario
    let xSunrise = null;
    let xSunset = null;
    let sunTimes = null;

    if (mode === 'today') {
      let tStart = 0;
      let tEnd = 0;
      if (points.length > 0 && points[0].timestamp && points[points.length - 1].timestamp) {
        tStart = new Date(points[0].timestamp).getTime();
        tEnd = new Date(points[points.length - 1].timestamp).getTime();
      }
      const tSpan = tEnd - tStart;
      sunTimes = getDorsetSunTimes(tEnd ? new Date(tEnd) : new Date());

      if (sunTimes && sunTimes.sunrise && sunTimes.sunset) {
        const srBase = new Date(sunTimes.sunrise).getTime();
        const ssBase = new Date(sunTimes.sunset).getTime();

        if (tSpan > 0) {
          // Check previous day, current day, and next day to locate instances in window
          [-86400000, 0, 86400000].forEach(offset => {
            const srT = srBase + offset;
            if (srT >= tStart && srT <= tEnd) {
              xSunrise = padLeft + ((srT - tStart) / tSpan) * plotW;
            }
            const ssT = ssBase + offset;
            if (ssT >= tStart && ssT <= tEnd) {
              xSunset = padLeft + ((ssT - tStart) / tSpan) * plotW;
            }
          });
        }

        // Proportional fallback within 24h
        if (xSunrise === null && sunTimes.sunrise_time) {
          const [h, m] = sunTimes.sunrise_time.split(':').map(Number);
          xSunrise = padLeft + ((h * 60 + m) / 1440) * plotW;
        }
        if (xSunset === null && sunTimes.sunset_time) {
          const [h, m] = sunTimes.sunset_time.split(':').map(Number);
          xSunset = padLeft + ((h * 60 + m) / 1440) * plotW;
        }
      }

      if (elWindow24hLabel && sunTimes) {
        elWindow24hLabel.innerHTML = `24-Hour Flow &bull; <span style="color:#fbbf24;">🌅 ${sunTimes.sunrise_time}</span> &bull; <span style="color:#f97316;">🌇 ${sunTimes.sunset_time}</span> <span style="color:#94a3b8;">(${sunTimes.day_length} day in Dorset, ON)</span>`;
      }
    } else if (elWindow24hLabel) {
      if (mode === 'week') elWindow24hLabel.textContent = '7-Day Continuous Solar & Battery Flow (15m avg)';
      else if (mode === 'month') elWindow24hLabel.textContent = '30-Day Continuous Solar & Battery Flow (3h avg)';
      else if (mode === 'quarter') elWindow24hLabel.textContent = 'Quarterly Solar & Battery Flow (6h avg)';
      else if (mode === 'halfyear') elWindow24hLabel.textContent = '6-Month Solar & Battery Flow (12h avg)';
      else if (mode === 'year') elWindow24hLabel.textContent = '1-Year Solar & Battery Flow (24h avg)';
      else elWindow24hLabel.textContent = 'Multi-Timespan Solar & Battery Flow';
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
    ctx24h.fillText('WATTS', padLeft - 6, padTop - 10);

    ctx24h.fillStyle = '#38bdf8';
    ctx24h.textAlign = 'left';
    ctx24h.fillText('VOLTS', w - padRight + 6, padTop - 10);

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

    // Background Daylight Shading Band for Dorset, Ontario
    if (mode === 'today' && xSunrise !== null && xSunset !== null) {
      const xLeft = Math.max(padLeft, Math.min(xSunrise, xSunset));
      const xRight = Math.min(w - padRight, Math.max(xSunrise, xSunset));
      if (xRight > xLeft) {
        ctx24h.save();
        const dayBandGrad = ctx24h.createLinearGradient(0, padTop, 0, padTop + plotH);
        dayBandGrad.addColorStop(0, 'rgba(251, 191, 36, 0.05)');
        dayBandGrad.addColorStop(0.5, 'rgba(251, 191, 36, 0.025)');
        dayBandGrad.addColorStop(1, 'rgba(251, 191, 36, 0.008)');
        ctx24h.fillStyle = dayBandGrad;
        ctx24h.fillRect(xLeft, padTop, xRight - xLeft, plotH);
        ctx24h.restore();
      }
    }

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

    // 4. Layer B: Solar Voltage Curve (Distinct Dashed Sky Blue #38bdf8 - Auxiliary Reference)
    // Rendered with a high-contrast [8, 6] dash pattern so it is distinctly visible without competing with solid power curves
    ctx24h.save();
    ctx24h.beginPath();
    ctx24h.setLineDash([8, 6]);
    coords.forEach((pt, i) => {
      if (i === 0) ctx24h.moveTo(pt.x, pt.yVolt);
      else ctx24h.lineTo(pt.x, pt.yVolt);
    });
    ctx24h.strokeStyle = '#38bdf8';
    ctx24h.lineWidth = 2.0;
    ctx24h.shadowColor = 'rgba(56, 189, 248, 0.45)';
    ctx24h.shadowBlur = 4;
    ctx24h.stroke();
    ctx24h.setLineDash([]);
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

    // 6. Layer D: Solar Power Line (Solid Amber - Primary Hero Metric)
    ctx24h.save();
    ctx24h.beginPath();
    coords.forEach((pt, i) => {
      if (i === 0) ctx24h.moveTo(pt.x, pt.ySolar);
      else ctx24h.lineTo(pt.x, pt.ySolar);
    });
    ctx24h.strokeStyle = '#f59e0b';
    ctx24h.lineWidth = 2.4;
    ctx24h.shadowColor = 'rgba(245, 158, 11, 0.45)';
    ctx24h.shadowBlur = 5;
    ctx24h.stroke();
    ctx24h.restore();

    // 7. Layer E: Battery Routing Power Line (Emerald Green)
    ctx24h.beginPath();
    coords.forEach((pt, i) => {
      if (i === 0) ctx24h.moveTo(pt.x, pt.yBatt);
      else ctx24h.lineTo(pt.x, pt.yBatt);
    });
    ctx24h.strokeStyle = '#10b981';
    ctx24h.lineWidth = 1.8;
    ctx24h.stroke();

    // Layer E.2: Vertical Lines for Sunrise and Sunset (Dorset, Ontario)
    if (mode === 'today' && sunTimes) {
      // --- SUNRISE VERTICAL LINE & BADGE ---
      if (xSunrise !== null && xSunrise >= padLeft && xSunrise <= w - padRight) {
        ctx24h.save();
        ctx24h.beginPath();
        ctx24h.setLineDash([5, 4]);
        ctx24h.moveTo(xSunrise, padTop);
        ctx24h.lineTo(xSunrise, padTop + plotH);
        ctx24h.strokeStyle = 'rgba(251, 191, 36, 0.9)';
        ctx24h.lineWidth = 1.8;
        ctx24h.shadowColor = '#fbbf24';
        ctx24h.shadowBlur = 6;
        ctx24h.stroke();
        ctx24h.setLineDash([]);

        // Top Pill Badge
        const srLabel = `🌅 ${sunTimes.sunrise_time || '07:11'}`;
        ctx24h.font = 'bold 10px var(--font-mono, monospace)';
        const pillW = ctx24h.measureText(srLabel).width + 12;
        const pillH = 18;
        const pillX = Math.max(padLeft + 2, Math.min(w - padRight - pillW - 2, xSunrise - pillW / 2));
        const pillY = padTop + 2;

        ctx24h.fillStyle = 'rgba(15, 23, 42, 0.92)';
        ctx24h.strokeStyle = '#fbbf24';
        ctx24h.lineWidth = 1.2;
        ctx24h.beginPath();
        if (ctx24h.roundRect) ctx24h.roundRect(pillX, pillY, pillW, pillH, 4);
        else ctx24h.rect(pillX, pillY, pillW, pillH);
        ctx24h.fill();
        ctx24h.stroke();

        ctx24h.fillStyle = '#fef08a';
        ctx24h.textAlign = 'center';
        ctx24h.fillText(srLabel, pillX + pillW / 2, pillY + 13);

        // Bottom Label
        ctx24h.font = 'bold 8px var(--font-mono, monospace)';
        ctx24h.fillStyle = '#fbbf24';
        ctx24h.textAlign = 'center';
        ctx24h.fillText('SUNRISE', xSunrise, padTop + plotH - 4);
        ctx24h.restore();
      }

      // --- SUNSET VERTICAL LINE & BADGE ---
      if (xSunset !== null && xSunset >= padLeft && xSunset <= w - padRight) {
        ctx24h.save();
        ctx24h.beginPath();
        ctx24h.setLineDash([5, 4]);
        ctx24h.moveTo(xSunset, padTop);
        ctx24h.lineTo(xSunset, padTop + plotH);
        ctx24h.strokeStyle = 'rgba(249, 115, 22, 0.9)';
        ctx24h.lineWidth = 1.8;
        ctx24h.shadowColor = '#f97316';
        ctx24h.shadowBlur = 6;
        ctx24h.stroke();
        ctx24h.setLineDash([]);

        // Top Pill Badge
        const ssLabel = `🌇 ${sunTimes.sunset_time || '19:00'}`;
        ctx24h.font = 'bold 10px var(--font-mono, monospace)';
        const pillW = ctx24h.measureText(ssLabel).width + 12;
        const pillH = 18;
        const pillX = Math.max(padLeft + 2, Math.min(w - padRight - pillW - 2, xSunset - pillW / 2));
        const pillY = padTop + 2;

        ctx24h.fillStyle = 'rgba(15, 23, 42, 0.92)';
        ctx24h.strokeStyle = '#f97316';
        ctx24h.lineWidth = 1.2;
        ctx24h.beginPath();
        if (ctx24h.roundRect) ctx24h.roundRect(pillX, pillY, pillW, pillH, 4);
        else ctx24h.rect(pillX, pillY, pillW, pillH);
        ctx24h.fill();
        ctx24h.stroke();

        ctx24h.fillStyle = '#fed7aa';
        ctx24h.textAlign = 'center';
        ctx24h.fillText(ssLabel, pillX + pillW / 2, pillY + 13);

        // Bottom Label
        ctx24h.font = 'bold 8px var(--font-mono, monospace)';
        ctx24h.fillStyle = '#f97316';
        ctx24h.textAlign = 'center';
        ctx24h.fillText('SUNSET', xSunset, padTop + plotH - 4);
        ctx24h.restore();
      }
    }

    // =========================================================================
    // LAYER E.3: PEAK SOLAR GENERATION REFERENCE LINE & HUD PILL BADGE
    // =========================================================================
    if (peakSolarW > 0 && maxW > 0) {
      const clampedPeak = Math.min(peakSolarW, maxW);
      const yPeak = padTop + plotH - (clampedPeak / maxW) * plotH;

      // 1. Draw Dotted Red Peak Datum Line across chart
      ctx24h.save();
      ctx24h.beginPath();
      ctx24h.setLineDash([4, 4]);
      ctx24h.moveTo(padLeft, yPeak);
      ctx24h.lineTo(w - padRight, yPeak);
      ctx24h.strokeStyle = '#ef4444';
      ctx24h.lineWidth = 1.5;
      ctx24h.shadowColor = 'rgba(239, 68, 68, 0.55)';
      ctx24h.shadowBlur = 5;
      ctx24h.stroke();
      ctx24h.setLineDash([]);
      ctx24h.restore();

      // 2. Format Badge Text per Timespan
      let timespanTag = 'PEAK SOLAR';
      if (mode === 'week') timespanTag = '7D PEAK SOLAR';
      else if (mode === 'month') timespanTag = '30D PEAK SOLAR';
      else if (mode === 'quarter') timespanTag = '90D PEAK SOLAR';
      else if (mode === 'halfyear') timespanTag = '180D PEAK SOLAR';
      else if (mode === 'year') timespanTag = '365D PEAK SOLAR';
      else timespanTag = '24H PEAK SOLAR';

      const badgeText = `▲ ${timespanTag}: ${Math.round(peakSolarW)}W`;

      // 3. Compute Pill Geometry
      ctx24h.save();
      ctx24h.font = 'bold 10px var(--font-mono, monospace)';
      const textMetrics = ctx24h.measureText(badgeText);
      const pillW = Math.round(textMetrics.width + 16);
      const pillH = 18;

      // 4. Horizontal Placement: Right-docked inside Volts axis
      const pillX = w - padRight - pillW - 8;

      // 5. Vertical Placement & Boundary Clamping
      let pillY = Math.round(yPeak - pillH / 2);

      // Clamp within plot vertical bounds
      if (pillY < padTop + 2) {
        pillY = padTop + 2;
      } else if (pillY + pillH > padTop + plotH - 2) {
        pillY = padTop + plotH - pillH - 2;
      }

      // Smart Evasion: If near top and overlapping sunset badge in Today mode
      if (mode === 'today' && xSunset !== null && yPeak < padTop + 24) {
        const sunsetPillApproxW = 75;
        const sunsetPillX = Math.max(padLeft + 2, Math.min(w - padRight - sunsetPillApproxW - 2, xSunset - sunsetPillApproxW / 2));
        if (Math.abs(pillX - sunsetPillX) < (pillW + sunsetPillApproxW) / 2) {
          pillY = Math.min(padTop + plotH - pillH - 2, Math.round(yPeak + 4));
        }
      }

      // 6. Render Automotive HUD Pill Container
      ctx24h.beginPath();
      if (ctx24h.roundRect) {
        ctx24h.roundRect(pillX, pillY, pillW, pillH, 4);
      } else {
        ctx24h.rect(pillX, pillY, pillW, pillH);
      }
      ctx24h.fillStyle = 'rgba(15, 23, 42, 0.94)';
      ctx24h.strokeStyle = 'rgba(239, 68, 68, 0.85)';
      ctx24h.lineWidth = 1.2;
      ctx24h.shadowColor = 'rgba(239, 68, 68, 0.40)';
      ctx24h.shadowBlur = 4;
      ctx24h.fill();
      ctx24h.stroke();

      // 7. Render High-Contrast Typography
      ctx24h.shadowBlur = 0;
      ctx24h.textAlign = 'center';
      ctx24h.textBaseline = 'middle';
      ctx24h.fillStyle = '#fee2e2';
      ctx24h.fillText(badgeText, pillX + pillW / 2, pillY + pillH / 2);

      ctx24h.restore();
    }

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

    const numLabels = w < 420 ? 4 : (w < 700 ? 5 : 6);
    const hourStep = Math.max(1, Math.floor(points.length / numLabels));
    for (let idx = 0; idx < points.length; idx += hourStep) {
      const pt = coords[idx];
      let timeStr = '';
      if (pt.p.timestamp) {
        const d = new Date(pt.p.timestamp);
        if (!isNaN(d.getTime())) {
          if (mode === 'today') {
            timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          } else if (mode === 'week') {
            timeStr = d.toLocaleDateString([], { weekday: 'short' });
          } else if (mode === 'year') {
            timeStr = d.toLocaleDateString([], { month: 'short' });
          } else {
            timeStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
          }
        }
      }
      if (!timeStr) timeStr = pt.p.time_label || '';
      ctx24h.fillText(timeStr, pt.x, h - 8);
    }
  }

  // Hover and Touch interaction handlers for 24h / timespan chart
  function handle24hHover(clientX, clientY) {
    if (!canvas24h || !cachedPoints24h || !cachedMetrics24h || !tooltip24h) return;
    const rect = canvas24h.getBoundingClientRect();
    const xInCanvas = (clientX - rect.left) * (cachedMetrics24h.w / rect.width);
    const { padLeft, plotW, mode } = cachedMetrics24h;

    const xRel = xInCanvas - padLeft;
    if (xRel < 0 || xRel > plotW) {
      tooltip24h.style.display = 'none';
      if (activeHoverIdx24h !== -1) {
        activeHoverIdx24h = -1;
        draw24hChart(cachedPoints24h, mode);
      }
      return;
    }

    const ratio = Math.max(0, Math.min(1, xRel / plotW));
    const idx = Math.min(cachedPoints24h.length - 1, Math.round(ratio * (cachedPoints24h.length - 1)));
    activeHoverIdx24h = idx;
    draw24hChart(cachedPoints24h, mode);

    const p = cachedPoints24h[idx];
    const pvV = (p.pv_voltage_v || 0).toFixed(1);
    const solW = p.solar_power_w || 0;
    const battW = p.battery_power_w || 0;
    const soc = p.battery_soc || 0;
    const battV = (p.battery_voltage_v || 0).toFixed(2);
    
    let timeStr = '';
    if (p.timestamp) {
      const d = new Date(p.timestamp);
      if (!isNaN(d.getTime())) {
        if (mode === 'today') {
          timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        } else if (mode === 'week') {
          const day = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
          const tm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          timeStr = `${day} ${tm}`;
        } else if (mode === 'year') {
          timeStr = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
        } else {
          const day = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
          const tm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
          timeStr = `${day} ${tm}`;
        }
      }
    }
    if (!timeStr) timeStr = p.time_label || '';

    let badge = '';
    if (mode === 'today' && p.timestamp) {
      const dPt = new Date(p.timestamp);
      const st = getDorsetSunTimes(dPt);
      if (st && st.sunrise && st.sunset) {
        const srT = new Date(st.sunrise).getTime();
        const ssT = new Date(st.sunset).getTime();
        const pT = dPt.getTime();
        if (Math.abs(pT - srT) <= 15 * 60000) {
          badge = `<div style="margin-top: 4px; padding: 2px 6px; background: rgba(251, 191, 36, 0.25); border: 1px solid rgba(251, 191, 36, 0.7); border-radius: 4px; font-size: 10px; color: #fef08a;">🌅 Sunrise in Dorset, ON (${st.sunrise_time})</div>`;
        } else if (Math.abs(pT - ssT) <= 15 * 60000) {
          badge = `<div style="margin-top: 4px; padding: 2px 6px; background: rgba(249, 115, 22, 0.25); border: 1px solid rgba(249, 115, 22, 0.7); border-radius: 4px; font-size: 10px; color: #fed7aa;">🌇 Sunset in Dorset, ON (${st.sunset_time})</div>`;
        }
      }
    }
    if (!badge) {
      if (p.pv_voltage_v >= 20.0 && solW === 0 && soc >= 98) {
        badge = '<div style="margin-top: 4px; padding: 2px 6px; background: rgba(245, 158, 11, 0.2); border: 1px solid rgba(245, 158, 11, 0.6); border-radius: 4px; font-size: 10px; color: #fef08a;">☀️ Sun Active • Solar Curtailed (Battery Full)</div>';
      } else if (p.pv_voltage_v >= 20.0 && solW > 0) {
        badge = '<div style="margin-top: 4px; padding: 2px 6px; background: rgba(16, 185, 129, 0.2); border: 1px solid rgba(16, 185, 129, 0.6); border-radius: 4px; font-size: 10px; color: #6ee7b7;">⚡ Active Solar Charging</div>';
      } else if (p.pv_voltage_v < 8.0) {
        badge = '<div style="margin-top: 4px; padding: 2px 6px; background: rgba(100, 116, 139, 0.2); border: 1px solid rgba(100, 116, 139, 0.4); border-radius: 4px; font-size: 10px; color: #94a3b8;">🌙 Night / No Sun</div>';
      }
    }

    tooltip24h.innerHTML = `
      <div style="font-weight: 700; color: #f8fafc; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 2px;">🕒 ${timeStr}</div>
      <div style="color: #38bdf8; font-weight: 600;">☀️ Solar Panel: <strong>${pvV} V</strong></div>
      <div style="color: #f59e0b; font-weight: 600;">⚡ Solar Power: <strong>${solW} W</strong></div>
      <div style="color: #10b981; font-weight: 600;">🔋 Battery Power: <strong>${battW} W</strong></div>
      <div style="color: #cbd5e1; font-size: 10px;">🟢 Battery SOC: <strong>${soc}%</strong> (${battV}V)</div>
      ${badge}
    `;

    tooltip24h.style.display = 'block';
    const tipX = clientX - rect.left;
    const tipY = clientY - rect.top;
    const maxTipX = Math.max(8, rect.width - 200);
    if (tipX > rect.width * 0.55) {
      tooltip24h.style.left = `${Math.max(8, tipX - 190)}px`;
    } else {
      tooltip24h.style.left = `${Math.min(maxTipX, tipX + 15)}px`;
    }
    tooltip24h.style.top = `${Math.max(10, tipY - 50)}px`;
  }

  function handle24hLeave() {
    if (tooltip24h) tooltip24h.style.display = 'none';
    if (activeHoverIdx24h !== -1) {
      activeHoverIdx24h = -1;
      if (cachedPoints24h) draw24hChart(cachedPoints24h, cachedMetrics24h ? cachedMetrics24h.mode : currentTimespan);
    }
  }

  // =========================================================================
  // MULTI-TIMESPAN SOLAR HARVEST CHARTS (Week, Month, Quarter, Half Year, Year)
  // =========================================================================
  let currentTimespan = 'today';
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const spanParam = urlParams.get('span');
    if (spanParam && ['today', 'week', 'month', 'quarter', 'halfyear', 'year'].includes(spanParam)) {
      currentTimespan = spanParam;
    } else {
      const savedSpan = localStorage.getItem('renology_timespan');
      if (savedSpan && ['today', 'week', 'month', 'quarter', 'halfyear', 'year'].includes(savedSpan)) {
        currentTimespan = savedSpan;
      }
    }
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

    const recordedDays = days.filter(d => (d.energy_wh ?? d.total_energy_wh ?? 0) > 0 || (d.peak_solar_w || 0) > 0);
    const totalKWh = (totalWh / 1000.0).toFixed(2);
    const avgWh = recordedDays.length > 0 ? Math.round(totalWh / recordedDays.length) : 0;

    if (elPeak24h) {
      const recNote = recordedDays.length < days.length ? ` (${recordedDays.length} of ${days.length}d recorded)` : '';
      if (mode === 'week') {
        elPeak24h.textContent = `7-Day Total: ${totalWh.toLocaleString()} Wh${recNote} • Peak: ${maxPeakW} W`;
      } else if (mode === 'month') {
        elPeak24h.textContent = `30-Day: ${totalKWh} kWh (${totalWh.toLocaleString()} Wh)${recNote} • Peak: ${maxPeakW} W`;
      } else if (mode === 'quarter') {
        elPeak24h.textContent = `Quarter: ${totalKWh} kWh${recNote} • Daily Avg: ${avgWh} Wh • Peak: ${maxPeakW} W`;
      } else if (mode === 'halfyear') {
        elPeak24h.textContent = `6-Month: ${totalKWh} kWh${recNote} • Daily Avg: ${avgWh} Wh • Peak: ${maxPeakW} W`;
      } else {
        elPeak24h.textContent = `Total: ${totalKWh} kWh${recNote} • Peak: ${maxPeakW} W`;
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
      ctx24h.strokeStyle = 'rgba(255, 255, 255, 0.05)';
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

    // 2. Line Graph Coordinates
    const barCount = days.length;
    const slotW = plotW / (barCount > 1 ? (barCount - 1) : 1);

    const coords = [];
    days.forEach((d, idx) => {
      const wh = d.energy_wh ?? d.total_energy_wh ?? 0;
      const pw = d.peak_solar_w || 0;
      const cx = barCount > 1 ? (padLeft + idx * slotW) : (padLeft + plotW / 2);
      const cyWh = padTop + plotH - (wh / maxWh) * plotH;
      const cyPeak = padTop + plotH - (pw / maxPeakW) * plotH;
      coords.push({ cx, cyWh, cyPeak, d, wh, pw, idx });
    });

    // 3. Daily Energy Yield (Wh) Area & Line
    const areaGrad = ctx24h.createLinearGradient(0, padTop, 0, padTop + plotH);
    areaGrad.addColorStop(0, 'rgba(6, 182, 212, 0.28)');
    areaGrad.addColorStop(1, 'rgba(6, 182, 212, 0.01)');

    ctx24h.beginPath();
    ctx24h.moveTo(coords[0].cx, padTop + plotH);
    coords.forEach(pt => ctx24h.lineTo(pt.cx, pt.cyWh));
    ctx24h.lineTo(coords[coords.length - 1].cx, padTop + plotH);
    ctx24h.closePath();
    ctx24h.fillStyle = areaGrad;
    ctx24h.fill();

    // Yield Line Stroke (Cyan)
    ctx24h.beginPath();
    coords.forEach((pt, i) => {
      if (i === 0) ctx24h.moveTo(pt.cx, pt.cyWh);
      else ctx24h.lineTo(pt.cx, pt.cyWh);
    });
    ctx24h.strokeStyle = '#06b6d4';
    ctx24h.lineWidth = 2.4;
    ctx24h.stroke();

    // 4. Peak Solar Watts (W) Line (Amber)
    ctx24h.beginPath();
    ctx24h.setLineDash([3, 3]);
    let startedPeak = false;
    coords.forEach((pt) => {
      if (pt.pw > 0) {
        if (!startedPeak) {
          ctx24h.moveTo(pt.cx, pt.cyPeak);
          startedPeak = true;
        } else {
          ctx24h.lineTo(pt.cx, pt.cyPeak);
        }
      }
    });
    if (startedPeak) {
      ctx24h.strokeStyle = 'rgba(245, 158, 11, 0.75)';
      ctx24h.lineWidth = 1.8;
      ctx24h.stroke();
    }
    ctx24h.setLineDash([]);

    // Dotted Red Horizontal Reference Line & HUD Pill Badge for Period Peak
    const periodPeakSolarW = days.reduce((max, d) => Math.max(max, d.peak_solar_w || 0), 0);
    if (periodPeakSolarW > 0 && maxPeakW > 0) {
      const clampedPeriodPeak = Math.min(periodPeakSolarW, maxPeakW);
      const yPeak = padTop + plotH - (clampedPeriodPeak / maxPeakW) * plotH;

      ctx24h.save();
      ctx24h.beginPath();
      ctx24h.setLineDash([4, 4]);
      ctx24h.moveTo(padLeft, yPeak);
      ctx24h.lineTo(w - padRight, yPeak);
      ctx24h.strokeStyle = '#ef4444';
      ctx24h.lineWidth = 1.5;
      ctx24h.shadowColor = 'rgba(239, 68, 68, 0.55)';
      ctx24h.shadowBlur = 5;
      ctx24h.stroke();
      ctx24h.setLineDash([]);

      let spanTag = 'PEAK SOLAR';
      if (mode === 'week') spanTag = '7D PEAK SOLAR';
      else if (mode === 'month') spanTag = '30D PEAK SOLAR';
      else if (mode === 'quarter') spanTag = '90D PEAK SOLAR';
      else if (mode === 'halfyear') spanTag = '180D PEAK SOLAR';
      else if (mode === 'year') spanTag = '365D PEAK SOLAR';

      const peakTag = `▲ ${spanTag}: ${Math.round(periodPeakSolarW)}W`;
      ctx24h.font = 'bold 10px var(--font-mono, monospace)';
      const textMetrics = ctx24h.measureText(peakTag);
      const pillW = Math.round(textMetrics.width + 16);
      const pillH = 18;
      const pillX = w - padRight - pillW - 8;
      let pillY = Math.round(yPeak - pillH / 2);
      if (pillY < padTop + 2) pillY = padTop + 2;
      else if (pillY + pillH > padTop + plotH - 2) pillY = padTop + plotH - pillH - 2;

      ctx24h.beginPath();
      if (ctx24h.roundRect) ctx24h.roundRect(pillX, pillY, pillW, pillH, 4);
      else ctx24h.rect(pillX, pillY, pillW, pillH);
      ctx24h.fillStyle = 'rgba(15, 23, 42, 0.94)';
      ctx24h.strokeStyle = 'rgba(239, 68, 68, 0.85)';
      ctx24h.lineWidth = 1.2;
      ctx24h.shadowColor = 'rgba(239, 68, 68, 0.40)';
      ctx24h.shadowBlur = 4;
      ctx24h.fill();
      ctx24h.stroke();

      ctx24h.shadowBlur = 0;
      ctx24h.textAlign = 'center';
      ctx24h.textBaseline = 'middle';
      ctx24h.fillStyle = '#fee2e2';
      ctx24h.fillText(peakTag, pillX + pillW / 2, pillY + pillH / 2);
      ctx24h.restore();
    }

    // 5. Data Points / Markers
    coords.forEach(pt => {
      const isToday = pt.d.day_label === 'Today';
      const isHovered = (activeHoverIdxMulti === pt.idx);
      const isRecorded = (pt.wh > 0 || pt.pw > 0);

      // Node on Yield Line
      if (isRecorded || isToday || barCount <= 7) {
        ctx24h.beginPath();
        ctx24h.arc(pt.cx, pt.cyWh, isHovered ? 6 : (isToday ? 4.5 : 3.5), 0, 2 * Math.PI);
        ctx24h.fillStyle = isHovered ? '#ffffff' : (isToday ? '#f59e0b' : (isRecorded ? '#06b6d4' : '#64748b'));
        ctx24h.fill();
        ctx24h.strokeStyle = '#0f172a';
        ctx24h.lineWidth = 1.5;
        ctx24h.stroke();
      }

      // Node on Peak Watts Line
      if (pt.pw > 0 && (barCount <= 30 || isHovered)) {
        ctx24h.beginPath();
        ctx24h.arc(pt.cx, pt.cyPeak, isHovered ? 5 : 3, 0, 2 * Math.PI);
        ctx24h.fillStyle = '#fbbf24';
        ctx24h.fill();
      }
    });

    // 6. Active Hover Crosshair
    if (activeHoverIdxMulti >= 0 && activeHoverIdxMulti < coords.length) {
      const hPt = coords[activeHoverIdxMulti];
      ctx24h.beginPath();
      ctx24h.moveTo(hPt.cx, padTop);
      ctx24h.lineTo(hPt.cx, padTop + plotH);
      ctx24h.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx24h.lineWidth = 1.2;
      ctx24h.setLineDash([2, 3]);
      ctx24h.stroke();
      ctx24h.setLineDash([]);

      // Highlight Yield node
      ctx24h.beginPath();
      ctx24h.arc(hPt.cx, hPt.cyWh, 6, 0, 2 * Math.PI);
      ctx24h.fillStyle = '#06b6d4';
      ctx24h.fill();
      ctx24h.strokeStyle = '#ffffff';
      ctx24h.lineWidth = 2;
      ctx24h.stroke();

      // Highlight Peak node if > 0
      if (hPt.pw > 0) {
        ctx24h.beginPath();
        ctx24h.arc(hPt.cx, hPt.cyPeak, 5, 0, 2 * Math.PI);
        ctx24h.fillStyle = '#fbbf24';
        ctx24h.fill();
        ctx24h.strokeStyle = '#ffffff';
        ctx24h.lineWidth = 1.5;
        ctx24h.stroke();
      }
    }

    // 7. X-Axis Labels
    ctx24h.font = '10px var(--font-family)';
    ctx24h.fillStyle = '#94a3b8';
    ctx24h.textAlign = 'center';

    let labelStep = 1;
    if (barCount > 60) labelStep = Math.ceil(barCount / (w < 450 ? 4 : 6));
    else if (barCount > 20) labelStep = Math.ceil(barCount / (w < 450 ? 4 : 7));
    else if (barCount > 10) labelStep = (w < 450 ? 3 : 2);
    else if (barCount > 6 && w < 420) labelStep = 2;

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

    // 2. Line Graph Coordinates
    const barCount = months.length;
    const slotW = plotW / (barCount > 1 ? (barCount - 1) : 1);

    const coords = [];
    months.forEach((m, idx) => {
      const wh = m.total_energy_wh || 0;
      const kwh = m.total_energy_kwh || (wh / 1000.0);
      const avg = m.daily_avg_wh || (m.days_counted ? Math.round(wh / m.days_counted) : 0);
      const cx = padLeft + idx * slotW;
      const cyKWh = padTop + plotH - (kwh / maxKWh) * plotH;
      const cyAvg = padTop + plotH - (avg / maxAvgWh) * plotH;
      coords.push({ cx, cyKWh, cyAvg, m, kwh, avg, wh, idx });
    });

    // 3. Monthly Production (kWh) Area & Line
    const areaGrad = ctx24h.createLinearGradient(0, padTop, 0, padTop + plotH);
    areaGrad.addColorStop(0, 'rgba(245, 158, 11, 0.25)');
    areaGrad.addColorStop(1, 'rgba(245, 158, 11, 0.01)');

    ctx24h.beginPath();
    ctx24h.moveTo(coords[0].cx, padTop + plotH);
    coords.forEach(pt => ctx24h.lineTo(pt.cx, pt.cyKWh));
    ctx24h.lineTo(coords[coords.length - 1].cx, padTop + plotH);
    ctx24h.closePath();
    ctx24h.fillStyle = areaGrad;
    ctx24h.fill();

    // Line stroke (Amber)
    ctx24h.beginPath();
    coords.forEach((pt, i) => {
      if (i === 0) ctx24h.moveTo(pt.cx, pt.cyKWh);
      else ctx24h.lineTo(pt.cx, pt.cyKWh);
    });
    ctx24h.strokeStyle = '#f59e0b';
    ctx24h.lineWidth = 2.4;
    ctx24h.stroke();

    // 4. Daily Average Harvest Line (Emerald dashed)
    ctx24h.beginPath();
    ctx24h.setLineDash([3, 3]);
    let startedYearAvg = false;
    coords.forEach((pt) => {
      const hasData = (pt.m.total_energy_wh > 0 || pt.m.days_counted > 0);
      if (hasData) {
        if (!startedYearAvg) {
          ctx24h.moveTo(pt.cx, pt.cyAvg);
          startedYearAvg = true;
        } else {
          ctx24h.lineTo(pt.cx, pt.cyAvg);
        }
      }
    });
    if (startedYearAvg) {
      ctx24h.strokeStyle = '#10b981';
      ctx24h.lineWidth = 2.0;
      ctx24h.stroke();
    }
    ctx24h.setLineDash([]);

    // 5. Data Point Nodes
    coords.forEach(pt => {
      const isHovered = (activeHoverIdxYear === pt.idx);
      const isRecorded = (pt.m.total_energy_wh > 0 || pt.m.days_counted > 0);

      // Monthly kWh Node
      ctx24h.beginPath();
      ctx24h.arc(pt.cx, pt.cyKWh, isHovered ? 6 : (isRecorded ? 4.5 : 3), 0, 2 * Math.PI);
      ctx24h.fillStyle = isHovered ? '#ffffff' : (isRecorded ? '#f59e0b' : '#64748b');
      ctx24h.fill();
      ctx24h.strokeStyle = '#0f172a';
      ctx24h.lineWidth = 1.5;
      ctx24h.stroke();

      // Daily Avg Node
      if (isRecorded) {
        ctx24h.beginPath();
        ctx24h.arc(pt.cx, pt.cyAvg, isHovered ? 5 : 3.5, 0, 2 * Math.PI);
        ctx24h.fillStyle = '#10b981';
        ctx24h.fill();
      }

      // X-Axis month label
      ctx24h.font = '10px var(--font-family)';
      ctx24h.fillStyle = isHovered ? '#f59e0b' : '#cbd5e1';
      ctx24h.textAlign = 'center';
      const rawLabel = pt.m.month_label ? pt.m.month_label.split(' ')[0] : (pt.m.month_key ? pt.m.month_key.substring(5) : '');
      const label = (w < 450 && rawLabel.length > 3) ? rawLabel.substring(0, 3) : rawLabel;
      ctx24h.fillText(label, pt.cx, h - 8);
    });

    // 6. Active Hover Crosshair
    if (activeHoverIdxYear >= 0 && activeHoverIdxYear < coords.length) {
      const hPt = coords[activeHoverIdxYear];
      ctx24h.beginPath();
      ctx24h.moveTo(hPt.cx, padTop);
      ctx24h.lineTo(hPt.cx, padTop + plotH);
      ctx24h.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx24h.lineWidth = 1.2;
      ctx24h.setLineDash([2, 3]);
      ctx24h.stroke();
      ctx24h.setLineDash([]);

      ctx24h.beginPath();
      ctx24h.arc(hPt.cx, hPt.cyKWh, 6, 0, 2 * Math.PI);
      ctx24h.fillStyle = '#f59e0b';
      ctx24h.fill();
      ctx24h.strokeStyle = '#ffffff';
      ctx24h.lineWidth = 2;
      ctx24h.stroke();
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

    const ratio = Math.max(0, Math.min(1, xRel / plotW));
    const idx = Math.min(days.length - 1, Math.round(ratio * (days.length - 1)));
    activeHoverIdxMulti = idx;
    drawMultiDayChart(days, currentTimespan);

    const d = days[idx];
    const wh = d.energy_wh ?? d.total_energy_wh ?? 0;
    const kwh = (wh / 1000.0).toFixed(2);
    const peakW = d.peak_solar_w || 0;
    const soc = d.avg_battery_soc || 0;
    const maxV = d.max_pv_v ? d.max_pv_v.toFixed(1) : null;
    const isUnrecorded = (wh === 0 && peakW === 0 && soc === 0);

    if (isUnrecorded) {
      tooltip24h.innerHTML = `
        <div style="font-weight: 700; color: #f8fafc; font-size: 12px; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 3px;">
          📅 ${d.day_label || d.date} <span style="font-size: 10px; color: #94a3b8; font-weight: normal;">(${d.date || ''})</span>
        </div>
        <div style="color: #94a3b8; font-size: 11px; margin-top: 4px; line-height: 1.4;">
          ⚪ <em>No telemetry recorded</em><br><span style="font-size: 10px; color: #64748b;">(Prior to monitoring setup on Sep 27, 2026)</span>
        </div>
      `;
    } else {
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
        ${soc > 0 ? `<div style="display: flex; justify-content: space-between; gap: 12px; font-size: 11px;"><span style="color: #34d399;">🔋 Avg Battery SOC:</span><span style="font-weight: 700; color: #34d399;">${soc}%</span></div>` : ''}
      `;
    }

    tooltip24h.style.display = 'block';
    const tipX = clientX - rect.left;
    const tipY = clientY - rect.top;
    const maxTipX = Math.max(8, rect.width - 200);
    if (tipX > rect.width * 0.55) {
      tooltip24h.style.left = `${Math.max(8, tipX - 195)}px`;
    } else {
      tooltip24h.style.left = `${Math.min(maxTipX, tipX + 15)}px`;
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

    const ratio = Math.max(0, Math.min(1, xRel / plotW));
    const idx = Math.min(months.length - 1, Math.round(ratio * (months.length - 1)));
    activeHoverIdxYear = idx;
    drawYearlyChart(months);

    const m = months[idx];
    const kwh = m.total_energy_kwh || ((m.total_energy_wh || 0) / 1000.0);
    const avg = m.daily_avg_wh || (m.days_counted ? Math.round(m.total_energy_wh / m.days_counted) : 0);
    const isUnrecordedMonth = (kwh === 0 && (m.total_energy_wh || 0) === 0 && (m.peak_watts || 0) === 0);

    if (isUnrecordedMonth) {
      tooltip24h.innerHTML = `
        <div style="font-weight: 700; color: #f8fafc; font-size: 12px; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 3px;">
          📅 ${m.month_label || m.month_key}
        </div>
        <div style="color: #94a3b8; font-size: 11px; margin-top: 4px; line-height: 1.4;">
          ⚪ <em>No telemetry recorded</em><br><span style="font-size: 10px; color: #64748b;">(Prior to monitoring setup on Sep 27, 2026)</span>
        </div>
      `;
    } else {
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
    }

    tooltip24h.style.display = 'block';
    const tipX = clientX - rect.left;
    const tipY = clientY - rect.top;
    const maxTipX = Math.max(8, rect.width - 200);
    if (tipX > rect.width * 0.55) {
      tooltip24h.style.left = `${Math.max(8, tipX - 195)}px`;
    } else {
      tooltip24h.style.left = `${Math.min(maxTipX, tipX + 15)}px`;
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
    handle24hHover(clientX, clientY);
  }

  function handleUnifiedHistoryLeave() {
    handle24hLeave();
  }

  function renderHistoryTimespanChart() {
    if (!historyData) return;

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
    if (elLegItemPeak) elLegItemPeak.style.display = 'flex';

    if (currentTimespan === 'today') {
      if (elHistoryChartTitle) elHistoryChartTitle.textContent = 'SOLAR POWER — TODAY (24H)';
      if (elWindow24hLabel) elWindow24hLabel.textContent = '24-Hour Solar & Battery Flow (15m avg buckets)';
      draw24hChart(historyData.points_24h || [], 'today');
    } else if (currentTimespan === 'week') {
      if (elHistoryChartTitle) elHistoryChartTitle.textContent = 'SOLAR POWER — PAST 7 DAYS';
      if (elWindow24hLabel) elWindow24hLabel.textContent = 'Past 7 Days Continuous Flow (15m avg buckets)';
      draw24hChart(historyData.points_7d || [], 'week');
    } else if (currentTimespan === 'month') {
      if (elHistoryChartTitle) elHistoryChartTitle.textContent = 'SOLAR POWER — PAST 30 DAYS';
      if (elWindow24hLabel) elWindow24hLabel.textContent = 'Past 30 Days Continuous Flow (3h avg buckets)';
      draw24hChart(historyData.points_30d || [], 'month');
    } else if (currentTimespan === 'quarter') {
      if (elHistoryChartTitle) elHistoryChartTitle.textContent = 'SOLAR POWER — PAST 90 DAYS (QUARTER)';
      if (elWindow24hLabel) elWindow24hLabel.textContent = 'Past 90 Days Continuous Flow (6h avg buckets)';
      draw24hChart(historyData.points_90d || [], 'quarter');
    } else if (currentTimespan === 'halfyear') {
      if (elHistoryChartTitle) elHistoryChartTitle.textContent = 'SOLAR POWER — PAST 6 MONTHS (HALF YEAR)';
      if (elWindow24hLabel) elWindow24hLabel.textContent = 'Past 180 Days Continuous Flow (12h avg buckets)';
      draw24hChart(historyData.points_180d || [], 'halfyear');
    } else if (currentTimespan === 'year') {
      if (elHistoryChartTitle) elHistoryChartTitle.textContent = 'SOLAR POWER — PAST 12 MONTHS (WHOLE YEAR)';
      if (elWindow24hLabel) elWindow24hLabel.textContent = 'Past 365 Days Continuous Flow (24h avg buckets)';
      draw24hChart(historyData.points_365d || [], 'year');
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
  // 7-DAY SOLAR PRODUCTION LINE CHART
  // =========================================================================
  let cached7dDays = null;
  let cached7dMetrics = null;
  let activeHoverIdx7d = -1;

  function draw7dChart(days) {
    if (!ctx7d || !days || days.length === 0) return;
    cached7dDays = days;
    const dims = setupHiDPI(canvas7d, ctx7d);
    if (!dims) return;
    const w = dims.width;
    const h = dims.height;

    const padLeft = 45;
    const padRight = 36;
    const padTop = 18;
    const padBottom = 26;
    const plotW = w - padLeft - padRight;
    const plotH = h - padTop - padBottom;

    ctx7d.clearRect(0, 0, w, h);

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
    cached7dMetrics = { padLeft, padRight, padTop, padBottom, plotW, plotH, maxWh, maxPeakW, w, h, days };

    const recordedDays = days.filter(d => (d.energy_wh ?? d.total_energy_wh ?? 0) > 0 || (d.peak_solar_w || 0) > 0);
    if (elTotal7d) elTotal7d.textContent = `7-Day: ${totalWh.toLocaleString()} Wh (${recordedDays.length} of 7d recorded)`;

    // 1. Grid Lines & Dual Y-Axes (Wh Left, Peak Watts Right)
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const yVal = Math.round((maxWh / ySteps) * i);
      const yWatts = Math.round((maxPeakW / ySteps) * i);
      const yPos = padTop + plotH - (i / ySteps) * plotH;

      ctx7d.beginPath();
      ctx7d.moveTo(padLeft, yPos);
      ctx7d.lineTo(w - padRight, yPos);
      ctx7d.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx7d.lineWidth = 1;
      ctx7d.stroke();

      // Left Y-Axis: Wh (Cyan)
      ctx7d.font = '10px var(--font-mono)';
      ctx7d.fillStyle = i === ySteps ? '#06b6d4' : '#64748b';
      ctx7d.textAlign = 'right';
      ctx7d.fillText(`${yVal}Wh`, padLeft - 6, yPos + 3);

      // Right Y-Axis: Peak Watts (Amber)
      ctx7d.fillStyle = i === ySteps ? '#fbbf24' : '#d97706';
      ctx7d.textAlign = 'left';
      ctx7d.fillText(`${yWatts}W`, w - padRight + 6, yPos + 3);
    }

    // 2. Line Graph Coordinates
    const barCount = days.length;
    const slotW = plotW / (barCount > 1 ? (barCount - 1) : 1);

    const coords = [];
    days.forEach((d, idx) => {
      const wh = d.energy_wh ?? d.total_energy_wh ?? 0;
      const pw = d.peak_solar_w || 0;
      const cx = barCount > 1 ? (padLeft + idx * slotW) : (padLeft + plotW / 2);
      const cyWh = padTop + plotH - (wh / maxWh) * plotH;
      const cyPeak = padTop + plotH - (pw / maxPeakW) * plotH;
      coords.push({ cx, cyWh, cyPeak, d, wh, pw, idx });
    });

    // 3. Daily Energy Yield (Wh) Area & Line
    const areaGrad = ctx7d.createLinearGradient(0, padTop, 0, padTop + plotH);
    areaGrad.addColorStop(0, 'rgba(6, 182, 212, 0.28)');
    areaGrad.addColorStop(1, 'rgba(6, 182, 212, 0.01)');

    ctx7d.beginPath();
    ctx7d.moveTo(coords[0].cx, padTop + plotH);
    coords.forEach(pt => ctx7d.lineTo(pt.cx, pt.cyWh));
    ctx7d.lineTo(coords[coords.length - 1].cx, padTop + plotH);
    ctx7d.closePath();
    ctx7d.fillStyle = areaGrad;
    ctx7d.fill();

    // Yield Line Stroke (Cyan)
    ctx7d.beginPath();
    coords.forEach((pt, i) => {
      if (i === 0) ctx7d.moveTo(pt.cx, pt.cyWh);
      else ctx7d.lineTo(pt.cx, pt.cyWh);
    });
    ctx7d.strokeStyle = '#06b6d4';
    ctx7d.lineWidth = 2.4;
    ctx7d.stroke();

    // 4. Peak Solar Watts (W) Line (Amber)
    ctx7d.beginPath();
    ctx7d.setLineDash([3, 3]);
    let startedPeak = false;
    coords.forEach((pt) => {
      if (pt.pw > 0) {
        if (!startedPeak) {
          ctx7d.moveTo(pt.cx, pt.cyPeak);
          startedPeak = true;
        } else {
          ctx7d.lineTo(pt.cx, pt.cyPeak);
        }
      }
    });
    if (startedPeak) {
      ctx7d.strokeStyle = 'rgba(245, 158, 11, 0.75)';
      ctx7d.lineWidth = 1.8;
      ctx7d.stroke();
    }
    ctx7d.setLineDash([]);

    // Dotted Red Horizontal Reference Line & HUD Pill Badge for 7D Period Peak
    const periodPeak7dW = days.reduce((max, d) => Math.max(max, d.peak_solar_w || 0), 0);
    if (periodPeak7dW > 0 && maxPeakW > 0) {
      const clamped7dPeak = Math.min(periodPeak7dW, maxPeakW);
      const yPeak = padTop + plotH - (clamped7dPeak / maxPeakW) * plotH;

      ctx7d.save();
      ctx7d.beginPath();
      ctx7d.setLineDash([4, 4]);
      ctx7d.moveTo(padLeft, yPeak);
      ctx7d.lineTo(w - padRight, yPeak);
      ctx7d.strokeStyle = '#ef4444';
      ctx7d.lineWidth = 1.5;
      ctx7d.shadowColor = 'rgba(239, 68, 68, 0.55)';
      ctx7d.shadowBlur = 5;
      ctx7d.stroke();
      ctx7d.setLineDash([]);

      const peakTag = `▲ 7D PEAK SOLAR: ${Math.round(periodPeak7dW)}W`;
      ctx7d.font = 'bold 10px var(--font-mono, monospace)';
      const textMetrics = ctx7d.measureText(peakTag);
      const pillW = Math.round(textMetrics.width + 16);
      const pillH = 18;
      const pillX = w - padRight - pillW - 8;
      let pillY = Math.round(yPeak - pillH / 2);
      if (pillY < padTop + 2) pillY = padTop + 2;
      else if (pillY + pillH > padTop + plotH - 2) pillY = padTop + plotH - pillH - 2;

      ctx7d.beginPath();
      if (ctx7d.roundRect) ctx7d.roundRect(pillX, pillY, pillW, pillH, 4);
      else ctx7d.rect(pillX, pillY, pillW, pillH);
      ctx7d.fillStyle = 'rgba(15, 23, 42, 0.94)';
      ctx7d.strokeStyle = 'rgba(239, 68, 68, 0.85)';
      ctx7d.lineWidth = 1.2;
      ctx7d.shadowColor = 'rgba(239, 68, 68, 0.40)';
      ctx7d.shadowBlur = 4;
      ctx7d.fill();
      ctx7d.stroke();

      ctx7d.shadowBlur = 0;
      ctx7d.textAlign = 'center';
      ctx7d.textBaseline = 'middle';
      ctx7d.fillStyle = '#fee2e2';
      ctx7d.fillText(peakTag, pillX + pillW / 2, pillY + pillH / 2);
      ctx7d.restore();
    }

    // 5. Data Points & Badges
    coords.forEach(pt => {
      const isToday = pt.d.day_label === 'Today';
      const isHovered = (activeHoverIdx7d === pt.idx);
      const isRecorded = (pt.wh > 0 || pt.pw > 0);

      // Node on Yield Line
      ctx7d.beginPath();
      ctx7d.arc(pt.cx, pt.cyWh, isHovered ? 6 : (isToday ? 5 : (isRecorded ? 4 : 3)), 0, 2 * Math.PI);
      ctx7d.fillStyle = isHovered ? '#ffffff' : (isToday ? '#f59e0b' : (isRecorded ? '#06b6d4' : '#64748b'));
      ctx7d.fill();
      ctx7d.strokeStyle = '#0f172a';
      ctx7d.lineWidth = 1.5;
      ctx7d.stroke();

      // Node on Peak Watts Line
      if (pt.pw > 0) {
        ctx7d.beginPath();
        ctx7d.arc(pt.cx, pt.cyPeak, isHovered ? 5 : 3.5, 0, 2 * Math.PI);
        ctx7d.fillStyle = '#fbbf24';
        ctx7d.fill();

        // Label above point
        ctx7d.font = 'bold 9px var(--font-mono)';
        ctx7d.fillStyle = '#fbbf24';
        ctx7d.textAlign = 'center';
        ctx7d.fillText(`${pt.pw}W`, pt.cx, Math.max(padTop + 10, pt.cyPeak - 6));
      }

      // X-Axis Day Label
      ctx7d.font = (isToday ? 'bold 10px ' : '9px ') + 'var(--font-family)';
      ctx7d.fillStyle = isToday ? '#f59e0b' : '#cbd5e1';
      ctx7d.textAlign = 'center';
      const dayLabel = (w < 420 && pt.d.day_label === 'Yesterday') ? 'Yest' : pt.d.day_label;
      ctx7d.fillText(dayLabel, pt.cx, h - 8);
    });

    // 6. Active Hover Crosshair
    if (activeHoverIdx7d >= 0 && activeHoverIdx7d < coords.length) {
      const hPt = coords[activeHoverIdx7d];
      ctx7d.beginPath();
      ctx7d.moveTo(hPt.cx, padTop);
      ctx7d.lineTo(hPt.cx, padTop + plotH);
      ctx7d.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx7d.lineWidth = 1.2;
      ctx7d.setLineDash([2, 3]);
      ctx7d.stroke();
      ctx7d.setLineDash([]);

      ctx7d.beginPath();
      ctx7d.arc(hPt.cx, hPt.cyWh, 6, 0, 2 * Math.PI);
      ctx7d.fillStyle = '#06b6d4';
      ctx7d.fill();
      ctx7d.strokeStyle = '#ffffff';
      ctx7d.lineWidth = 2;
      ctx7d.stroke();
    }
  }

  function handle7dHover(clientX, clientY) {
    if (!canvas7d || !cached7dDays || !cached7dMetrics || !tooltip7d) return;
    const rect = canvas7d.getBoundingClientRect();
    const xInCanvas = (clientX - rect.left) * (cached7dMetrics.w / rect.width);
    const { padLeft, plotW, days } = cached7dMetrics;

    const xRel = xInCanvas - padLeft;
    if (xRel < 0 || xRel > plotW) {
      handle7dLeave();
      return;
    }

    const ratio = Math.max(0, Math.min(1, xRel / plotW));
    const idx = Math.min(days.length - 1, Math.round(ratio * (days.length - 1)));
    activeHoverIdx7d = idx;
    draw7dChart(days);

    const d = days[idx];
    const wh = d.energy_wh ?? d.total_energy_wh ?? 0;
    const peakW = d.peak_solar_w || 0;
    const isUnrecorded = (wh === 0 && peakW === 0);

    if (isUnrecorded) {
      tooltip7d.innerHTML = `
        <div style="font-weight: 700; color: #f8fafc; font-size: 12px; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 3px;">
          📅 ${d.day_label || d.date} <span style="font-size: 10px; color: #94a3b8; font-weight: normal;">(${d.date || ''})</span>
        </div>
        <div style="color: #94a3b8; font-size: 11px;">⚪ <em>No telemetry recorded</em><br><span style="font-size: 10px; color: #64748b;">(Prior to monitoring setup)</span></div>
      `;
    } else {
      tooltip7d.innerHTML = `
        <div style="font-weight: 700; color: #f8fafc; font-size: 12px; margin-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 3px;">
          📅 ${d.day_label || d.date} <span style="font-size: 10px; color: #94a3b8; font-weight: normal;">(${d.date || ''})</span>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 12px; font-size: 11px;">
          <span style="color: #38bdf8;">⚡ Daily Yield:</span>
          <span style="font-weight: 700; color: #38bdf8;">${wh.toLocaleString()} Wh</span>
        </div>
        <div style="display: flex; justify-content: space-between; gap: 12px; font-size: 11px;">
          <span style="color: #fbbf24;">☀️ Peak Solar:</span>
          <span style="font-weight: 700; color: #fbbf24;">${peakW} W</span>
        </div>
      `;
    }

    tooltip7d.style.display = 'block';
    const tipX = clientX - rect.left;
    const tipY = clientY - rect.top;
    const maxTipX = Math.max(8, rect.width - 190);
    if (tipX > rect.width * 0.55) {
      tooltip7d.style.left = `${Math.max(8, tipX - 180)}px`;
    } else {
      tooltip7d.style.left = `${Math.min(maxTipX, tipX + 15)}px`;
    }
    tooltip7d.style.top = `${Math.max(10, tipY - 50)}px`;
  }

  function handle7dLeave() {
    if (tooltip7d) tooltip7d.style.display = 'none';
    if (activeHoverIdx7d !== -1) {
      activeHoverIdx7d = -1;
      if (cached7dDays) draw7dChart(cached7dDays);
    }
  }

  if (canvas7d) {
    canvas7d.addEventListener('mousemove', e => handle7dHover(e.clientX, e.clientY));
    canvas7d.addEventListener('mouseleave', handle7dLeave);
    canvas7d.addEventListener('touchmove', e => {
      if (e.touches.length > 0) {
        handle7dHover(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });
    canvas7d.addEventListener('touchend', handle7dLeave);
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
        if (elWeatherTempF) {
          const rhStr = m.outdoor_humidity_pct !== undefined ? ` • ${m.outdoor_humidity_pct}% RH` : '';
          elWeatherTempF.textContent = `${m.outdoor_temperature_f || '--'}°F${rhStr}`;
        }
        if (elCabinTempVal && m.indoor_temperature_c !== undefined) {
          elCabinTempVal.innerHTML = `${Number(m.indoor_temperature_c).toFixed(1)}<span class="unit">°C</span>`;
        }
        if (elCabinHumVal && m.indoor_humidity_pct !== undefined) {
          elCabinHumVal.textContent = `${m.indoor_humidity_pct}% RH`;
        }
        if (elWeatherSolarRad) elWeatherSolarRad.innerHTML = `${m.solar_radiation_wm2 || 0}<span class="unit">W/m²</span>`;
        if (elWeatherSolarFluxDesc) {
          const srad = Number(m.solar_radiation_wm2 || 0);
          if (srad >= 600) elWeatherSolarFluxDesc.textContent = 'Peak Direct Sunlight';
          else if (srad >= 200) elWeatherSolarFluxDesc.textContent = 'Moderate Sunlight';
          else if (srad > 0) elWeatherSolarFluxDesc.textContent = 'Low Sun / Overcast';
          else elWeatherSolarFluxDesc.textContent = 'Sun Below Horizon';
        }
        if (elWeatherRainVal) {
          const rainMm = (m.daily_rain_mm !== undefined && m.daily_rain_mm !== null) ? Number(m.daily_rain_mm) : 0;
          elWeatherRainVal.innerHTML = `${rainMm.toFixed(1)}<span class="unit">mm</span>`;
        }
        if (elWeatherRainRate) {
          const rate = Number(m.rain_rate_mm_hr || 0);
          const rainMm = Number(m.daily_rain_mm || 0);
          if (rate > 0) {
            elWeatherRainRate.textContent = `${rate.toFixed(1)} mm/h • Active Rain`;
          } else if (rainMm > 0) {
            elWeatherRainRate.textContent = `Overcast • Rain Earlier`;
          } else {
            elWeatherRainRate.textContent = `0.0 mm/h • Dry Skies`;
          }
        }
        
        // Update Dorset Ephemeris in Card 3
        const ephem = getDorsetSunTimes(new Date());
        if (ephem) {
          if (elDorsetDayLength) elDorsetDayLength.textContent = ephem.day_length || '11h 48m';
          if (elDorsetSolarNoon) elDorsetSolarNoon.textContent = `Noon: ${ephem.solar_noon_time || '13:05'} EDT`;
        }

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
        const ephem = getDorsetSunTimes(new Date());
        if (ephem) {
          if (elDorsetDayLength) elDorsetDayLength.textContent = ephem.day_length || '11h 48m';
          if (elDorsetSolarNoon) elDorsetSolarNoon.textContent = `Noon: ${ephem.solar_noon_time || '13:05'} EDT`;
        }
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

      // 100Ah @ 12.8V Nominal LiFePO4 Battery = 1,280 Wh Total Capacity
      const usableWh = Math.round((targetSOC / 100.0) * 1280);
      if (elGaugeCapacitySub) {
        elGaugeCapacitySub.textContent = `${usableWh.toLocaleString()} Wh Stored (100Ah)`;
      }

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

      // Battery Health & Cold-Weather Freeze Protection
      const bTemp = t.battery_temp_c !== undefined ? t.battery_temp_c : 20;
      if (elBattFreezeStatus) {
        if (bTemp <= 0) {
          elBattFreezeStatus.textContent = '❄️ FREEZE LOCKOUT (≤0°C)';
          elBattFreezeStatus.className = 'freeze-warn-tag';
        } else if (bTemp <= 4) {
          elBattFreezeStatus.textContent = `⚠️ Cold Caution (${bTemp}°C)`;
          elBattFreezeStatus.className = 'freeze-warn-tag';
        } else {
          elBattFreezeStatus.textContent = `🛡️ Freeze Safe (>0°C)`;
          elBattFreezeStatus.className = 'safe-freeze-tag';
        }
      }
      if (elBattHealthRating) {
        elBattHealthRating.textContent = `HEALTH: 100% (${t.battery_type || 'LFP'})`;
      }

      // Update Speedometer & Solar PV Metrics
      targetPvVolts = t.pv_voltage_v || 0;
      triggerNeedleAnimation();
      if (elSolarPower) elSolarPower.innerHTML = `${t.pv_power_w || 0}<span class="unit">W</span>`;
      if (elPvV) elPvV.innerHTML = `${(t.pv_voltage_v || 0).toFixed(1)}<span class="unit">V</span>`;
      if (elPvA) elPvA.innerHTML = `${(t.pv_current_a || 0).toFixed(2)}<span class="unit">A</span>`;
      if (elPowerToday) elPowerToday.innerHTML = `${t.power_generation_today_wh || 0}<span class="unit">Wh</span>`;
      
      const peakW = t.max_charging_power_today_w || 0;
      const chgAh = t.charging_ah_today || 0;
      if (elPvPeakTodayVal) elPvPeakTodayVal.innerHTML = `${peakW}<span class="unit">W</span>`;
      if (elChargingAhVal) elChargingAhVal.innerHTML = `${chgAh.toFixed(1)}<span class="unit">Ah</span>`;

      if (t.power_generation_total_kwh && elLifetimeKwh) {
        elLifetimeKwh.textContent = `${t.power_generation_total_kwh.toLocaleString()} kWh`;
      }

      // Update Voltworks 1000W Inverter & Autonomy Hub
      if (elAutonomyUsableWh) elAutonomyUsableWh.textContent = `${usableWh.toLocaleString()} Wh`;
      if (elAutonomySocSub) elAutonomySocSub.textContent = `100Ah LiFePO4 • ${targetSOC}% Full`;

      function formatRuntime(hours) {
        if (hours <= 0) return '0 hrs';
        if (hours < 1) return `~${Math.round(hours * 60)} mins`;
        if (hours >= 48) return `~${(hours / 24).toFixed(1)} Days`;
        return `~${hours.toFixed(1)} hrs`;
      }

      // Tare consumption of the Voltworks 1000W Pure Sine Inverter (~8W idle)
      const tareW = 8;
      const starlinkH = usableWh > 0 ? (usableWh / (50 + tareW)) : 0;
      const laptopH = usableWh > 0 ? (usableWh / (45 + tareW)) : 0;
      const fridgeH = usableWh > 0 ? (usableWh / (35 + tareW)) : 0;
      const lightsH = usableWh > 0 ? (usableWh / (15 + tareW)) : 0;
      const standbyH = usableWh > 0 ? (usableWh / tareW) : 0;

      if (elRunStarlink) elRunStarlink.textContent = formatRuntime(starlinkH);
      if (elRunLaptop) elRunLaptop.textContent = formatRuntime(laptopH);
      if (elRunFridge) elRunFridge.textContent = formatRuntime(fridgeH);
      if (elRunLights) elRunLights.textContent = formatRuntime(lightsH);
      if (elRunStandby) elRunStandby.textContent = formatRuntime(standbyH);

      // Inverter Power Headroom (1000W Continuous / 2000W Surge)
      const dischargeW = Math.max(0, -(Number(t.battery_power_w) || 0));
      const headroomW = Math.max(0, 1000 - Math.round(dischargeW));
      const headroomPct = Math.min(100, Math.max(0, Math.round((headroomW / 1000) * 100)));
      if (elHeadroomText) {
        elHeadroomText.textContent = `${headroomW}W Available (${headroomPct}%)`;
      }
      if (elHeadroomBarFill) {
        elHeadroomBarFill.style.width = `${headroomPct}%`;
        if (headroomPct < 20) {
          elHeadroomBarFill.style.background = '#ef4444';
        } else if (headroomPct < 50) {
          elHeadroomBarFill.style.background = '#f59e0b';
        } else {
          elHeadroomBarFill.style.background = 'linear-gradient(90deg, #10b981, #06b6d4)';
        }
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
      if (elLastUpdated && t.timestamp) {
        const d = new Date(t.timestamp);
        elLastUpdated.textContent = `Live Telemetry Synced: ${d.toLocaleTimeString()} (5s BLE loop • PV: ${(t.pv_voltage_v || 0).toFixed(1)}V)`;
      }
    } catch (err) {
      updateConnectionStatus(false);
      console.warn('Status poll error:', err);
    }
  }

  async function fetchHistory(retryCount = 0) {
    try {
      const resp = await fetch('/api/history');
      if (!resp.ok) {
        if (retryCount < 3) setTimeout(() => fetchHistory(retryCount + 1), 2000);
        return;
      }
      historyData = await resp.json();

      renderHistoryTimespanChart();
      if (historyData.days_7d) {
        draw7dChart(historyData.days_7d);
      }
    } catch (err) {
      console.warn('History poll error:', err);
      if (retryCount < 3) setTimeout(() => fetchHistory(retryCount + 1), 2000);
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
    document.querySelectorAll('.gauge-wrapper, .speedometer-wrapper, .chart-container').forEach(el => ro.observe(el));
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

  // Polling loops: 5s for live controller status (matches BLE loop), 10s for weather, 60s for historical aggregation
  let statusInterval = setInterval(fetchStatus, 5000);
  let weatherInterval = setInterval(fetchWeather, 10000);
  let historyInterval = setInterval(fetchHistory, 60000);

  // Surface Go 2 Power Optimization: Pause polling when screen is sleeping or tab is hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(statusInterval);
      clearInterval(weatherInterval);
      clearInterval(historyInterval);
    } else {
      fetchStatus();
      fetchWeather();
      fetchHistory();
      statusInterval = setInterval(fetchStatus, 5000);
      weatherInterval = setInterval(fetchWeather, 10000);
      historyInterval = setInterval(fetchHistory, 60000);
    }
  });

})();
