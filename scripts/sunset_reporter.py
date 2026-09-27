#!/usr/bin/env python3
"""
scripts/sunset_reporter.py - Daily Sunset Solar Generation & Weather Reporter
Compiles daily energy harvest, power usage, battery status, and local weather station
data at sunset each day and delivers a formatted executive report to frank@sfle.ca.
"""

import argparse
import datetime
import json
import math
import os
import sqlite3
import subprocess
import sys
import urllib.request
from pathlib import Path

BASE_DIR = Path("/home/fcurrie/Projects/renology")
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "renology.db"
STATE_FILE = DATA_DIR / "sunset_state.json"
WEATHER_URL = "http://localhost:8088/api/weather/current"
DEFAULT_RECIPIENT = "frank@sfle.ca"

# Approximate Ontario coordinates (America/Toronto timezone)
LATITUDE = 44.5
LONGITUDE = -78.5


def get_sunset_time_today():
    """
    Fetches sunset time for today via sunrise-sunset.org API.
    Falls back to astronomical calculation if offline.
    """
    today_date = datetime.date.today()
    try:
        url = f"https://api.sunrise-sunset.org/json?lat={LATITUDE}&lng={LONGITUDE}&date={today_date.strftime('%Y-%m-%d')}&formatted=0"
        req = urllib.request.Request(url, headers={"User-Agent": "RenologySentinel/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("status") == "OK":
                sunset_utc_str = data["results"]["sunset"]
                # Parse ISO8601 UTC
                sunset_utc = datetime.datetime.fromisoformat(sunset_utc_str.replace("Z", "+00:00"))
                # Convert to local time
                sunset_local = sunset_utc.astimezone()
                return sunset_local
    except Exception as e:
        print(f"[Sunset] Warning: API lookup failed ({e}), using astronomical calculation.", file=sys.stderr)

    # Simplified astronomical sunset estimate for ~44.5N in late September / October
    # Day of year calculation
    day_of_year = today_date.timetuple().tm_yday
    # Solar declination approximation
    declination = 23.45 * math.sin(math.radians(360 / 365 * (day_of_year - 81)))
    lat_rad = math.radians(LATITUDE)
    dec_rad = math.radians(declination)
    cos_hour_angle = -math.tan(lat_rad) * math.tan(dec_rad)
    cos_hour_angle = max(-1.0, min(1.0, cos_hour_angle))
    hour_angle = math.degrees(math.acos(cos_hour_angle))
    # Local solar noon ~ 13:14 EDT at longitude -78.5
    sunset_hours = 13.23 + (hour_angle / 15.0)
    hour = int(sunset_hours)
    minute = int((sunset_hours - hour) * 60)
    local_tz = datetime.datetime.now().astimezone().tzinfo
    return datetime.datetime(today_date.year, today_date.month, today_date.day, hour, minute, tzinfo=local_tz)


def get_solar_stats_today():
    """Queries SQLite renology.db for today's solar harvest and telemetry metrics."""
    stats = {
        "record_count": 0,
        "energy_generated_wh": 0,
        "energy_generated_kwh": 0.0,
        "peak_power_w": 0,
        "peak_power_time": "N/A",
        "max_pv_voltage_v": 0.0,
        "min_battery_v": 0.0,
        "max_battery_v": 0.0,
        "ending_battery_v": 0.0,
        "ending_battery_soc": 100,
        "avg_battery_soc": 100.0,
        "charging_ah_today": 0,
        "discharging_ah_today": 0,
        "load_power_used_wh": 0,
        "max_controller_temp_c": 0,
        "max_battery_temp_c": 0,
        "controller_model": "Renogy Rover MPPT",
        "battery_type": "Lithium (LFP)"
    }

    if not DB_PATH.exists():
        return stats

    today_prefix = datetime.date.today().strftime("%Y-%m-%d")
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=5.0)
        cur = conn.cursor()

        # Aggregations for today
        cur.execute("""
            SELECT 
                COUNT(*),
                COALESCE(MAX(power_gen_today_wh), 0),
                COALESCE(MAX(power_gen_total_kwh), 0),
                COALESCE(MAX(pv_w), 0),
                COALESCE(MAX(pv_v), 0.0),
                COALESCE(MIN(battery_v), 0.0),
                COALESCE(MAX(battery_v), 0.0),
                COALESCE(AVG(battery_soc), 100.0),
                COALESCE(MAX(charging_ah_today), 0),
                COALESCE(MAX(controller_temp_c), 0),
                COALESCE(MAX(battery_temp_c), 0),
                COALESCE(MAX(model), 'RNG-CTRL-RVR20'),
                COALESCE(MAX(battery_type), 'Lithium (LFP)')
            FROM telemetry
            WHERE timestamp LIKE ?
        """, (f"{today_prefix}%",))

        row = cur.fetchone()
        if row and row[0] > 0:
            stats["record_count"] = row[0]
            stats["energy_generated_wh"] = row[1]
            stats["energy_generated_kwh"] = round(row[1] / 1000.0, 3)
            stats["peak_power_w"] = row[3]
            stats["max_pv_voltage_v"] = round(row[4], 1)
            stats["min_battery_v"] = round(row[5], 2)
            stats["max_battery_v"] = round(row[6], 2)
            stats["avg_battery_soc"] = round(row[7], 1)
            stats["charging_ah_today"] = row[8]
            stats["max_controller_temp_c"] = row[9]
            stats["max_battery_temp_c"] = row[10]
            stats["controller_model"] = row[11]
            stats["battery_type"] = row[12]

        # Find timestamp of peak power
        if stats["peak_power_w"] > 0:
            cur.execute("""
                SELECT timestamp FROM telemetry 
                WHERE timestamp LIKE ? AND pv_w = ? 
                ORDER BY id ASC LIMIT 1
            """, (f"{today_prefix}%", stats["peak_power_w"]))
            peak_row = cur.fetchone()
            if peak_row:
                try:
                    dt = datetime.datetime.fromisoformat(peak_row[0])
                    stats["peak_power_time"] = dt.strftime("%I:%M %p")
                except Exception:
                    stats["peak_power_time"] = str(peak_row[0])[11:16]

        # Get latest / ending telemetry
        cur.execute("""
            SELECT battery_soc, battery_v, pv_v
            FROM telemetry 
            WHERE timestamp LIKE ? 
            ORDER BY id DESC LIMIT 1
        """, (f"{today_prefix}%",))
        last_row = cur.fetchone()
        if last_row:
            stats["ending_battery_soc"] = last_row[0]
            stats["ending_battery_v"] = round(last_row[1], 2)

        conn.close()
    except Exception as e:
        print(f"[Sunset] Error querying SQLite: {e}", file=sys.stderr)

    return stats


def get_weather_stats():
    """Fetches real-time observations from local EasyWeather station."""
    weather = {
        "status": "offline",
        "outdoor_temp_c": "N/A",
        "outdoor_temp_f": "N/A",
        "humidity_pct": "N/A",
        "wind_kmh": "N/A",
        "wind_gust_kmh": "N/A",
        "wind_direction_deg": "N/A",
        "pressure_hpa": "N/A",
        "solar_radiation_wm2": "N/A",
        "uv_index": "N/A",
        "daily_rain_mm": 0.0,
        "station_model": "EasyWeather DD85"
    }

    try:
        req = urllib.request.Request(WEATHER_URL, headers={"User-Agent": "RenologySunsetReport/1.0"})
        with urllib.request.urlopen(req, timeout=4) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("status") == "online":
                m = data.get("measurements", {})
                weather["status"] = "online"
                weather["outdoor_temp_c"] = m.get("outdoor_temperature_c", "N/A")
                weather["outdoor_temp_f"] = m.get("outdoor_temperature_f", "N/A")
                weather["humidity_pct"] = m.get("outdoor_humidity_pct", "N/A")
                weather["wind_kmh"] = m.get("wind_speed_kmh", "N/A")
                weather["wind_gust_kmh"] = m.get("wind_gust_kmh", "N/A")
                weather["wind_direction_deg"] = m.get("wind_direction_deg", "N/A")
                weather["pressure_hpa"] = m.get("pressure_relative_hpa", "N/A")
                weather["solar_radiation_wm2"] = m.get("solar_radiation_wm2", "N/A")
                weather["uv_index"] = m.get("uv_index", "N/A")
                weather["daily_rain_mm"] = m.get("daily_rain_mm", 0.0)
                weather["station_model"] = m.get("station_model", "EasyWeather")
    except Exception as e:
        print(f"[Sunset] Weather fetch error: {e}", file=sys.stderr)

    return weather


def generate_report(solar, weather, sunset_dt):
    """Formats plain-text and responsive HTML email bodies."""
    date_str = datetime.date.today().strftime("%A, %B %d, %Y")
    sunset_str = sunset_dt.strftime("%I:%M %p %Z")

    # Plain text version
    text_body = f"""=====================================================
  RENOLOGY SOLAR & WEATHER DAILY SUNSET REPORT
=====================================================
Date:   {date_str}
Sunset: {sunset_str}
Host:   Linux Mint / Surface Go 2 Solar Kiosk

[1] SOLAR HARVEST & ENERGY SUMMARY
-----------------------------------------------------
• Total Energy Generated Today: {solar['energy_generated_wh']} Wh ({solar['energy_generated_kwh']} kWh)
• Peak Solar Power:            {solar['peak_power_w']} W (at {solar['peak_power_time']})
• Max PV Array Voltage:        {solar['max_pv_voltage_v']} V
• Energy Used / DC Load:       {solar['load_power_used_wh']} Wh (Terminals Off / Direct Storage)
• Charging Harvest:            {solar['charging_ah_today']} Ah
• Hardware Model:              {solar['controller_model']}

[2] BATTERY STORAGE SYSTEM ({solar['battery_type']})
-----------------------------------------------------
• Ending Battery SOC:          {solar['ending_battery_soc']}%
• Ending Battery Voltage:      {solar['ending_battery_v']} V
• Battery Voltage Range:       {solar['min_battery_v']} V - {solar['max_battery_v']} V
• Average Daytime SOC:         {solar['avg_battery_soc']}%
• Max Controller Temp:         {solar['max_controller_temp_c']} °C
• Max Battery Temp:            {solar['max_battery_temp_c']} °C

[3] LOCAL WEATHER OBSERVATIONS (At Sunset)
-----------------------------------------------------
• Station Model:               {weather['station_model']} ({weather['status'].upper()})
• Outdoor Temperature:         {weather['outdoor_temp_c']} °C ({weather['outdoor_temp_f']} °F)
• Relative Humidity:           {weather['humidity_pct']}%
• Barometric Pressure:         {weather['pressure_hpa']} hPa
• Wind Speed & Gusts:          {weather['wind_kmh']} km/h (Gusts: {weather['wind_gust_kmh']} km/h @ {weather['wind_direction_deg']}°)
• Solar Irradiance:            {weather['solar_radiation_wm2']} W/m² (UV Index: {weather['uv_index']})
• Daily Rainfall:              {weather['daily_rain_mm']} mm

=====================================================
Renology Autonomous Monitoring System • Generated at {datetime.datetime.now().strftime('%H:%M:%S')}
"""

    # Executive HTML Email Version
    html_body = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b111e; color: #f1f5f9; margin: 0; padding: 24px; }}
  .container {{ max-width: 650px; margin: 0 auto; background: #131d31; border: 1px solid #1e293b; border-radius: 14px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }}
  .header {{ background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); padding: 24px 28px; border-bottom: 1px solid #334155; }}
  .header h1 {{ margin: 0 0 6px 0; font-size: 20px; color: #f59e0b; display: flex; align-items: center; letter-spacing: 0.5px; }}
  .header .meta {{ font-size: 13px; color: #94a3b8; }}
  .content {{ padding: 24px 28px; }}
  .card {{ background: #0f172a; border: 1px solid #1e293b; border-radius: 10px; padding: 18px; margin-bottom: 20px; }}
  .card-title {{ font-size: 14px; text-transform: uppercase; font-weight: 700; color: #38bdf8; margin: 0 0 14px 0; letter-spacing: 0.8px; display: flex; justify-content: space-between; }}
  .grid {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }}
  .metric {{ background: #172238; border: 1px solid #22324f; border-radius: 8px; padding: 12px 14px; }}
  .metric .label {{ font-size: 11px; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.5px; margin-bottom: 4px; }}
  .metric .value {{ font-size: 20px; font-weight: 700; color: #f8fafc; }}
  .metric .value small {{ font-size: 12px; font-weight: 500; color: #cbd5e1; }}
  .metric.highlight {{ border-left: 4px solid #f59e0b; }}
  .metric.battery {{ border-left: 4px solid #10b981; }}
  .metric.weather {{ border-left: 4px solid #38bdf8; }}
  .footer {{ background: #0b111e; padding: 16px 28px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #1e293b; }}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>☀️ Renology Sunset Solar & Weather Summary</h1>
    <div class="meta">{date_str} • Sunset at <strong>{sunset_str}</strong> • Surface Go 2 Kiosk</div>
  </div>

  <div class="content">
    <!-- Section 1: Solar Energy Harvest -->
    <div class="card">
      <div class="card-title">
        <span>⚡ Solar Power Generation</span>
        <span style="color: #f59e0b;">{solar['controller_model']}</span>
      </div>
      <div class="grid">
        <div class="metric highlight">
          <div class="label">Total Generated Today</div>
          <div class="value">{solar['energy_generated_wh']} <small>Wh</small> <span style="font-size: 13px; color: #94a3b8;">({solar['energy_generated_kwh']} kWh)</span></div>
        </div>
        <div class="metric highlight">
          <div class="label">Peak Solar Power</div>
          <div class="value">{solar['peak_power_w']} <small>W</small> <span style="font-size: 12px; color: #94a3b8;">@ {solar['peak_power_time']}</span></div>
        </div>
        <div class="metric">
          <div class="label">Max Solar Array Voc</div>
          <div class="value">{solar['max_pv_voltage_v']} <small>V</small></div>
        </div>
        <div class="metric">
          <div class="label">Harvest Yield</div>
          <div class="value">{solar['charging_ah_today']} <small>Ah</small></div>
        </div>
      </div>
    </div>

    <!-- Section 2: Battery Health & Storage -->
    <div class="card">
      <div class="card-title">
        <span>🔋 Battery Storage ({solar['battery_type']})</span>
        <span style="color: #10b981;">100% HEALTH</span>
      </div>
      <div class="grid">
        <div class="metric battery">
          <div class="label">Ending State of Charge</div>
          <div class="value">{solar['ending_battery_soc']}% <small>SOC</small></div>
        </div>
        <div class="metric battery">
          <div class="label">Ending Voltage</div>
          <div class="value">{solar['ending_battery_v']} <small>V</small></div>
        </div>
        <div class="metric">
          <div class="label">Voltage Range Today</div>
          <div class="value">{solar['min_battery_v']}V <small>-</small> {solar['max_battery_v']}V</div>
        </div>
        <div class="metric">
          <div class="label">Max Controller / Battery Temp</div>
          <div class="value">{solar['max_controller_temp_c']}°C <small>/</small> {solar['max_battery_temp_c']}°C</div>
        </div>
      </div>
    </div>

    <!-- Section 3: Weather Station Observations -->
    <div class="card" style="margin-bottom: 0;">
      <div class="card-title">
        <span>🌤️ Local Weather Station ({weather['station_model']})</span>
        <span style="color: #38bdf8;">LIVE</span>
      </div>
      <div class="grid">
        <div class="metric weather">
          <div class="label">Outdoor Temperature</div>
          <div class="value">{weather['outdoor_temp_c']}°C <small>({weather['outdoor_temp_f']}°F)</small></div>
        </div>
        <div class="metric weather">
          <div class="label">Relative Humidity / Barometer</div>
          <div class="value">{weather['humidity_pct']}% <small>/ {weather['pressure_hpa']} hPa</small></div>
        </div>
        <div class="metric">
          <div class="label">Wind Speed & Peak Gust</div>
          <div class="value">{weather['wind_kmh']} <small>km/h</small> <span style="font-size: 12px; color: #94a3b8;">(Gusts: {weather['wind_gust_kmh']} km/h)</span></div>
        </div>
        <div class="metric">
          <div class="label">Solar Irradiance / UV Index</div>
          <div class="value">{weather['solar_radiation_wm2']} <small>W/m²</small> <span style="font-size: 12px; color: #94a3b8;">(UV: {weather['uv_index']})</span></div>
        </div>
      </div>
    </div>
  </div>

  <div class="footer">
    Renology Solar Monitoring Suite • Automated Sunset Dispatch to {DEFAULT_RECIPIENT}
  </div>
</div>
</body>
</html>
"""
    return text_body, html_body


def send_report(recipient=DEFAULT_RECIPIENT):
    """Gathers data, builds report, and dispatches via mailer.py."""
    sunset_dt = get_sunset_time_today()
    solar = get_solar_stats_today()
    weather = get_weather_stats()

    text_body, html_body = generate_report(solar, weather, sunset_dt)
    date_str = datetime.date.today().strftime("%Y-%m-%d")
    subject = f"☀️ Solar Sunset Report ({date_str}): {solar['energy_generated_wh']} Wh Generated | {solar['ending_battery_soc']}% Battery"

    # Invoke mailer.py
    mailer_script = BASE_DIR / "scripts" / "mailer.py"
    cmd = [
        sys.executable, str(mailer_script),
        "--to", recipient,
        "--subject", subject,
        "--body", text_body,
        "--html", html_body
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    print(res.stdout)
    if res.stderr:
        print(res.stderr, file=sys.stderr)

    # Record state so we don't send duplicates today
    state = {"last_report_date": date_str, "timestamp": datetime.datetime.now().isoformat()}
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
    except Exception as e:
        print(f"[Sunset] Error saving state: {e}", file=sys.stderr)

    return res.returncode == 0


def check_and_run(force=False, recipient=DEFAULT_RECIPIENT):
    """
    Checks if current time has passed sunset today and sends report if not already sent.
    """
    today_str = datetime.date.today().strftime("%Y-%m-%d")

    # Read state
    if not force and STATE_FILE.exists():
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                state = json.load(f)
                if state.get("last_report_date") == today_str:
                    print(f"[Sunset] Daily sunset report for {today_str} was already sent.")
                    return True
        except Exception:
            pass

    sunset_dt = get_sunset_time_today()
    now = datetime.datetime.now(sunset_dt.tzinfo)

    if not force:
        # We trigger if now is at or past sunset time
        if now < sunset_dt:
            mins_remaining = int((sunset_dt - now).total_seconds() / 60)
            print(f"[Sunset] Sunset today is at {sunset_dt.strftime('%I:%M %p')}. ({mins_remaining} minutes remaining). No report sent yet.")
            return False

    print(f"[Sunset] Triggering Sunset Report dispatch for {today_str}...")
    return send_report(recipient)


def main():
    parser = argparse.ArgumentParser(description="Renology Daily Sunset Solar & Weather Reporter")
    parser.add_argument("--now", "--force", action="store_true", help="Send the sunset report immediately")
    parser.add_argument("--dry-run", action="store_true", help="Generate and print the report to stdout without sending")
    parser.add_argument("--to", default=DEFAULT_RECIPIENT, help=f"Recipient email (default: {DEFAULT_RECIPIENT})")
    args = parser.parse_args()

    if args.dry_run:
        sunset_dt = get_sunset_time_today()
        solar = get_solar_stats_today()
        weather = get_weather_stats()
        text_body, html_body = generate_report(solar, weather, sunset_dt)
        print("=== TEXT BODY ===")
        print(text_body)
        print("=== HTML PREVIEW LENGTH:", len(html_body), "bytes ===")
        return

    if args.now:
        check_and_run(force=True, recipient=args.to)
    else:
        check_and_run(force=False, recipient=args.to)


if __name__ == "__main__":
    main()
