#!/usr/bin/env python3
"""
scripts/health_check.py - Multi-Pillar System Health Inspector for Renology & Weather Station
Performs deterministic diagnostics across Renology BLE poller, SQLite database, Weather Ingestion,
Firefox Kiosk, and Surface Go 2 hardware thermals. Returns machine-readable JSON or CLI triage.
"""

import argparse
import datetime
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import urllib.request
from pathlib import Path

BASE_DIR = Path("/home/fcurrie/Projects/renology")
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "renology.db"
LATEST_JSON = DATA_DIR / "latest_status.json"
OUTBOX_DIR = DATA_DIR / "outbox"

RENOLOGY_STATUS_URL = "http://localhost:8080/api/status"
WEATHER_STATUS_URL = "http://localhost:8088/api/weather/current"


def check_process_running(pattern):
    """Checks if a process matching pattern is currently alive."""
    try:
        res = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True)
        pids = [int(p) for p in res.stdout.strip().split() if p.isdigit()]
        return len(pids) > 0, pids
    except Exception:
        return False, []


def check_systemd_unit(unit_name, user=True):
    """Checks systemd unit active state."""
    try:
        cmd = ["systemctl"]
        if user:
            cmd.append("--user")
        cmd.extend(["is-active", unit_name])
        res = subprocess.run(cmd, capture_output=True, text=True)
        return res.stdout.strip() == "active"
    except Exception:
        return False


def check_renology_pillar():
    """Audits Renology BLE daemon, HTTP 8080 API, and SQLite database freshness."""
    pillar = {
        "status": "PASS",
        "running": False,
        "pids": [],
        "api_healthy": False,
        "api_response_ms": 0,
        "db_healthy": False,
        "total_records": 0,
        "latest_telemetry_time": None,
        "age_seconds": None,
        "battery_soc": None,
        "pv_watts": None,
        "charging_status": None,
        "issues": []
    }

    # 1. Process Check
    running, pids = check_process_running("renology.*-http")
    if not running:
        # Check fallback process name
        running, pids = check_process_running("./renology")
    pillar["running"] = running
    pillar["pids"] = pids
    if not running:
        pillar["status"] = "FAIL"
        pillar["issues"].append("Renology daemon process is not running")

    # 2. HTTP API Check
    start_t = datetime.datetime.now()
    try:
        req = urllib.request.Request(RENOLOGY_STATUS_URL, headers={"User-Agent": "RenologyHealthCheck/1.0"})
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            elapsed = (datetime.datetime.now() - start_t).total_seconds() * 1000
            pillar["api_response_ms"] = round(elapsed, 1)
            if resp.status == 200:
                pillar["api_healthy"] = True
                data = json.loads(resp.read().decode("utf-8"))
                pillar["battery_soc"] = data.get("battery_soc_percent")
                pillar["pv_watts"] = data.get("pv_power_w")
                pillar["charging_status"] = data.get("charging_status")
            else:
                pillar["status"] = "FAIL"
                pillar["issues"].append(f"Renology API returned HTTP {resp.status}")
    except Exception as e:
        pillar["status"] = "FAIL"
        pillar["issues"].append(f"Renology API unreachable at {RENOLOGY_STATUS_URL}: {e}")

    # 3. SQLite Database Check & Age Calculation
    if DB_PATH.exists():
        try:
            conn = sqlite3.connect(str(DB_PATH), timeout=3.0)
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM telemetry")
            count = cur.fetchone()[0]
            pillar["total_records"] = count

            cur.execute("SELECT timestamp FROM telemetry ORDER BY id DESC LIMIT 1")
            row = cur.fetchone()
            if row:
                ts_str = row[0]
                pillar["latest_telemetry_time"] = ts_str
                # Parse timestamp
                try:
                    dt = datetime.datetime.fromisoformat(ts_str)
                    now = datetime.datetime.now(dt.tzinfo)
                    age = (now - dt).total_seconds()
                    pillar["age_seconds"] = round(age, 1)
                    if age > 75.0:
                        pillar["status"] = "FAIL"
                        pillar["issues"].append(f"Renology telemetry stalled: last record was {int(age)}s ago (>75s threshold)")
                    elif age > 30.0:
                        if pillar["status"] != "FAIL":
                            pillar["status"] = "WARN"
                        pillar["issues"].append(f"Renology telemetry delayed: last record was {int(age)}s ago")
                except Exception as ex:
                    pillar["issues"].append(f"Timestamp parse error: {ex}")

            pillar["db_healthy"] = True
            conn.close()
        except Exception as e:
            pillar["status"] = "FAIL"
            pillar["issues"].append(f"SQLite error querying {DB_PATH}: {e}")
    else:
        pillar["status"] = "FAIL"
        pillar["issues"].append(f"SQLite database missing: {DB_PATH}")

    return pillar


def check_weather_pillar():
    """Audits local EasyWeather station ingestion server and observation freshness."""
    pillar = {
        "status": "PASS",
        "service_active": False,
        "running": False,
        "api_healthy": False,
        "api_response_ms": 0,
        "station_status": None,
        "updated_at": None,
        "age_seconds": None,
        "outdoor_temp_c": None,
        "solar_radiation": None,
        "issues": []
    }

    # 1. Systemd / Process Check
    pillar["service_active"] = check_systemd_unit("weather-server.service")
    running, pids = check_process_running("weather_server.py")
    pillar["running"] = running

    if not pillar["service_active"] and not running:
        pillar["status"] = "FAIL"
        pillar["issues"].append("Weather ingestion service is not running")

    # 2. HTTP API & Telemetry Check
    start_t = datetime.datetime.now()
    try:
        req = urllib.request.Request(WEATHER_STATUS_URL, headers={"User-Agent": "RenologyHealthCheck/1.0"})
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            elapsed = (datetime.datetime.now() - start_t).total_seconds() * 1000
            pillar["api_response_ms"] = round(elapsed, 1)
            if resp.status == 200:
                pillar["api_healthy"] = True
                data = json.loads(resp.read().decode("utf-8"))
                pillar["station_status"] = data.get("status")
                updated_at_str = data.get("updated_at")
                pillar["updated_at"] = updated_at_str
                meas = data.get("measurements", {})
                pillar["outdoor_temp_c"] = meas.get("outdoor_temperature_c")
                pillar["solar_radiation"] = meas.get("solar_radiation_wm2")

                if data.get("status") != "online":
                    pillar["status"] = "WARN"
                    pillar["issues"].append(f"Weather station reports status: '{data.get('status')}'")

                # Check age if updated_at is present
                if updated_at_str:
                    try:
                        # Format is typically "YYYY-MM-DD HH:MM:SS"
                        dt = datetime.datetime.strptime(updated_at_str, "%Y-%m-%d %H:%M:%S")
                        now = datetime.datetime.now()
                        age = (now - dt).total_seconds()
                        pillar["age_seconds"] = round(age, 1)
                        if age > 7200.0:  # > 2 hours
                            pillar["status"] = "WARN"
                            pillar["issues"].append(f"Weather observations are stale: last update was {int(age/60)} minutes ago")
                    except Exception:
                        pass
            else:
                pillar["status"] = "FAIL"
                pillar["issues"].append(f"Weather API returned HTTP {resp.status}")
    except Exception as e:
        pillar["status"] = "FAIL"
        pillar["issues"].append(f"Weather API unreachable at {WEATHER_STATUS_URL}: {e}")

    return pillar


def check_kiosk_pillar():
    """Audits Firefox full-screen kiosk process and X11 display session."""
    pillar = {
        "status": "PASS",
        "running": False,
        "pids": [],
        "display_present": False,
        "issues": []
    }

    running, pids = check_process_running("firefox.*--kiosk")
    if not running:
        running, pids = check_process_running("firefox.*localhost:8080")
    pillar["running"] = running
    pillar["pids"] = pids

    display = os.environ.get("DISPLAY", ":0")
    pillar["display_present"] = os.path.exists(f"/tmp/.X11-unix/X{display.replace(':', '')}") or os.path.exists("/tmp/.X11-unix/X0")

    if not running:
        pillar["status"] = "WARN"
        pillar["issues"].append("Firefox kiosk dashboard process is not active")

    return pillar


def check_hardware_pillar():
    """Audits Surface Go 2 CPU temperatures, disk space, and email queue size."""
    pillar = {
        "status": "PASS",
        "cpu_temp_c": None,
        "disk_free_gb": None,
        "disk_used_pct": None,
        "outbox_queue_count": 0,
        "issues": []
    }

    # 1. Thermal Probe (Surface Go 2 Invariants: Normal <75C, Warm 75-89C, Critical >=90C)
    try:
        thermal_files = list(Path("/sys/class/thermal").glob("thermal_zone*/temp"))
        max_temp = 0
        for tf in thermal_files:
            try:
                t_val = int(tf.read_text().strip()) / 1000.0
                if t_val > max_temp:
                    max_temp = t_val
            except Exception:
                pass
        if max_temp > 0:
            pillar["cpu_temp_c"] = round(max_temp, 1)
            if max_temp >= 90.0:
                pillar["status"] = "FAIL"
                pillar["issues"].append(f"Surface Go 2 thermal critical: {max_temp}°C (Throttling limit: 90°C)")
            elif max_temp >= 75.0:
                if pillar["status"] != "FAIL":
                    pillar["status"] = "WARN"
                pillar["issues"].append(f"Surface Go 2 thermal warm: {max_temp}°C (Normal < 75°C)")
    except Exception:
        pass

    # 2. Disk Space
    try:
        usage = shutil.disk_usage(str(BASE_DIR))
        pillar["disk_free_gb"] = round(usage.free / (1024**3), 2)
        pillar["disk_used_pct"] = round((usage.used / usage.total) * 100, 1)
        if usage.free < 2 * (1024**3):  # Less than 2GB free
            pillar["status"] = "FAIL"
            pillar["issues"].append(f"Low disk space: {pillar['disk_free_gb']} GB remaining")
    except Exception:
        pass

    # 3. Outbox Queue
    if OUTBOX_DIR.exists():
        q_count = len(list(OUTBOX_DIR.glob("*.json")))
        pillar["outbox_queue_count"] = q_count
        if q_count > 10:
            pillar["issues"].append(f"{q_count} unsent emails waiting in outbox queue")

    return pillar


def run_comprehensive_audit():
    """Executes all pillars and synthesizes global health verdict."""
    timestamp = datetime.datetime.now().isoformat()
    renology = check_renology_pillar()
    weather = check_weather_pillar()
    kiosk = check_kiosk_pillar()
    hardware = check_hardware_pillar()

    # Determine global verdict
    statuses = [renology["status"], weather["status"], kiosk["status"], hardware["status"]]
    if "FAIL" in statuses:
        overall_status = "CRITICAL"
    elif "WARN" in statuses:
        overall_status = "DEGRADED"
    else:
        overall_status = "HEALTHY"

    all_issues = []
    all_issues.extend(renology["issues"])
    all_issues.extend(weather["issues"])
    all_issues.extend(kiosk["issues"])
    all_issues.extend(hardware["issues"])

    return {
        "timestamp": timestamp,
        "overall_status": overall_status,
        "issues_count": len(all_issues),
        "issues": all_issues,
        "pillars": {
            "renology": renology,
            "weather": weather,
            "kiosk": kiosk,
            "hardware": hardware
        }
    }


def print_triage(audit):
    """Outputs high-contrast formatted triage report."""
    status = audit["overall_status"]
    color_map = {"HEALTHY": "\033[92m", "DEGRADED": "\033[93m", "CRITICAL": "\033[91m"}
    reset = "\033[0m"

    print("=====================================================")
    print(f"  RENOLOGY & WEATHER SYSTEM HEALTH AUDIT")
    print(f"  Overall Verdict: {color_map.get(status, '')}{status}{reset}")
    print(f"  Timestamp:       {audit['timestamp']}")
    print("=====================================================")

    p_ren = audit["pillars"]["renology"]
    print(f"\n[1] RENOLOGY SOLAR ENGINE: [{p_ren['status']}]")
    print(f"  • Process Alive:     {p_ren['running']} (PIDs: {p_ren['pids']})")
    print(f"  • Web API (8080):    {p_ren['api_healthy']} ({p_ren['api_response_ms']} ms)")
    print(f"  • SQLite Telemetry:  {p_ren['total_records']} rows, last record {p_ren['age_seconds']}s ago")
    print(f"  • Live Status:       {p_ren['battery_soc']}% SOC, {p_ren['pv_watts']}W PV ({p_ren['charging_status']})")

    p_wea = audit["pillars"]["weather"]
    print(f"\n[2] WEATHER STATION ENGINE: [{p_wea['status']}]")
    print(f"  • Ingestion Service: {p_wea['service_active']} (Running: {p_wea['running']})")
    print(f"  • Web API (8088):    {p_wea['api_healthy']} ({p_wea['api_response_ms']} ms)")
    print(f"  • Observations:      {p_wea['outdoor_temp_c']}°C, {p_wea['solar_radiation']} W/m² (Updated: {p_wea['updated_at']})")

    p_kio = audit["pillars"]["kiosk"]
    print(f"\n[3] SURFACE KIOSK DISPLAY: [{p_kio['status']}]")
    print(f"  • Firefox Running:   {p_kio['running']} (PIDs: {p_kio['pids']})")
    print(f"  • X11 Display :0:    {p_kio['display_present']}")

    p_hw = audit["pillars"]["hardware"]
    print(f"\n[4] HARDWARE & RESOURCES: [{p_hw['status']}]")
    print(f"  • Surface CPU Temp:  {p_hw['cpu_temp_c']} °C")
    print(f"  • Disk Space:        {p_hw['disk_free_gb']} GB free ({p_hw['disk_used_pct']}% used)")
    print(f"  • Outbox Queue:      {p_hw['outbox_queue_count']} messages pending")

    if audit["issues"]:
        print("\n-----------------------------------------------------")
        print("IDENTIFIED ANOMALIES & ISSUES:")
        for idx, issue in enumerate(audit["issues"], 1):
            print(f"  {idx}. {issue}")
    else:
        print("\nAll systems operational. No anomalies detected.")
    print("=====================================================")


def main():
    parser = argparse.ArgumentParser(description="Renology & Weather Multi-Pillar Health Inspector")
    parser.add_argument("--json", action="store_true", help="Output machine-readable JSON")
    args = parser.parse_args()

    audit = run_comprehensive_audit()
    if args.json:
        print(json.dumps(audit, indent=2))
    else:
        print_triage(audit)

    if audit["overall_status"] == "CRITICAL":
        sys.exit(2)
    elif audit["overall_status"] == "DEGRADED":
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
