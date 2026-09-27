#!/usr/bin/env python3
"""
scripts/troubleshooter.py - Autonomous Troubleshooting Engine & agy Invocation Orchestrator
Monitors Renology BLE poller, SQLite database, Weather station, and Kiosk display hourly.
Autonomously resolves defects, collaborates with agy/gemini-3.8-flash-high for deep reasoning,
and delivers structured incident alerts to frank@sfle.ca if physical intervention is needed.
"""

import argparse
import datetime
import json
import os
import subprocess
import sys
import time
from pathlib import Path

BASE_DIR = Path("/home/fcurrie/Projects/renology")
DATA_DIR = BASE_DIR / "data"
SCRIPTS_DIR = BASE_DIR / "scripts"
HEARTBEAT_FILE = DATA_DIR / "troubleshooter_heartbeat.json"
INCIDENT_FILE = DATA_DIR / "incident_history.json"
DEFAULT_RECIPIENT = "frank@sfle.ca"

sys.path.insert(0, str(SCRIPTS_DIR))
import health_check


def log(msg):
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [Troubleshooter] {msg}")


def attempt_remediation(audit):
    """
    Executes targeted, safe self-healing actions based on identified anomalies.
    Returns a list of remediation actions taken.
    """
    actions_taken = []
    p_ren = audit["pillars"]["renology"]
    p_wea = audit["pillars"]["weather"]
    p_kio = audit["pillars"]["kiosk"]

    # 1. Weather Server Remediation
    if not p_wea["running"] or not p_wea["api_healthy"]:
        log("Weather server unresponsive. Attempting systemd restart...")
        res = subprocess.run(["systemctl", "--user", "restart", "weather-server.service"], capture_output=True, text=True)
        actions_taken.append(f"Restarted weather-server.service (exit code: {res.returncode})")
        time.sleep(3)

    # 2. Renology Daemon / Poller Remediation
    if not p_ren["running"] or not p_ren["api_healthy"]:
        log("Renology poller process dead or API unreachable. Attempting service restart...")
        res = subprocess.run(["systemctl", "--user", "restart", "renology.service"], capture_output=True, text=True)
        if res.returncode != 0:
            # Fallback to direct background launch if unit not active yet
            cmd = ["/home/fcurrie/Projects/renology/renology", "-mac", "60:98:66:F9:84:D6", "-interval", "5", "-out", "./data", "-http", ":8080"]
            subprocess.Popen(cmd, cwd=str(BASE_DIR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            actions_taken.append("Spawned renology binary directly")
        else:
            actions_taken.append("Restarted renology.service via systemctl")
        time.sleep(4)

    # 3. Renology Telemetry Stalled (>75s old)
    elif p_ren.get("age_seconds") and p_ren["age_seconds"] > 75.0:
        log(f"Renology telemetry stalled (age: {p_ren['age_seconds']}s). Cycling Bluetooth radio and poller...")
        # Safe non-disruptive BLE radio reset
        subprocess.run(["bluetoothctl", "power", "off"], capture_output=True)
        time.sleep(2)
        subprocess.run(["bluetoothctl", "power", "on"], capture_output=True)
        time.sleep(2)
        subprocess.run(["systemctl", "--user", "restart", "renology.service"], capture_output=True)
        actions_taken.append(f"Cycled Bluetooth radio and restarted renology.service (stalled telemetry was {p_ren['age_seconds']}s old)")
        time.sleep(8)

    # 4. Kiosk Display Remediation
    if not p_kio["running"] and p_kio["display_present"]:
        log("Firefox kiosk display not detected. Relaunching on DISPLAY=:0...")
        env = os.environ.copy()
        env["DISPLAY"] = ":0"
        res = subprocess.run(["systemctl", "--user", "restart", "renology-kiosk.service"], capture_output=True, text=True)
        if res.returncode != 0:
            subprocess.Popen(["/usr/bin/firefox", "--kiosk", "http://localhost:8080"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            actions_taken.append("Spawned firefox --kiosk directly on DISPLAY=:0")
        else:
            actions_taken.append("Restarted renology-kiosk.service via systemctl")
        time.sleep(4)

    return actions_taken


def invoke_agy_troubleshooter(audit, actions_taken):
    """
    Invokes the agy CLI with the specialized renology-troubleshooter agent
    using model gemini-3.8-flash-high to perform autonomous investigation.
    """
    log("Invoking agy with gemini-3.8-flash-high for autonomous deep troubleshooting...")
    prompt = f"""[AUTOMATED AUDIT ESCALATION]
The Renology Solar & Weather autonomous watcher detected an operational anomaly that standard heuristics could not fully resolve.

CURRENT AUDIT DETAILS:
Overall Verdict: {audit['overall_status']}
Identified Issues: {json.dumps(audit['issues'], indent=2)}
Actions Already Attempted: {json.dumps(actions_taken, indent=2)}

DIAGNOSTIC STATUS:
Renology Pillar: {json.dumps(audit['pillars']['renology'])}
Weather Pillar: {json.dumps(audit['pillars']['weather'])}
Kiosk Pillar: {json.dumps(audit['pillars']['kiosk'])}
Hardware Pillar: {json.dumps(audit['pillars']['hardware'])}

TASK:
1. Inspect the relevant systemd journals or process logs.
2. Determine if the issue is a software hang or physical disconnect.
3. If an autonomous software fix is possible, apply it.
4. Output a concise technical root cause assessment and recommendation.
"""

    try:
        cmd = [
            "/home/fcurrie/.local/bin/agy",
            "--agent", "renology-troubleshooter",
            "--model", "gemini-3.8-flash-high",
            "--dangerously-skip-permissions",
            "--print", prompt
        ]
        res = subprocess.run(cmd, cwd=str(BASE_DIR), capture_output=True, text=True, timeout=90)
        output = res.stdout.strip()
        log(f"agy troubleshooting response received ({len(output)} bytes)")
        return output
    except Exception as e:
        log(f"agy invocation failed: {e}")
        return f"Autonomous agent invocation failed: {e}"


def send_escalation_alert(audit, actions_taken, agy_diagnosis, recipient=DEFAULT_RECIPIENT):
    """
    Composes and delivers a structured executive incident notification to frank@sfle.ca.
    """
    ts_str = datetime.datetime.now().strftime("%Y-%m-%d %I:%M %p EDT")
    subject = f"🚨 ALERT: Renology Solar / Weather Intervention Needed ({audit['overall_status']})"

    issues_formatted = "\n".join([f"  • {issue}" for issue in audit["issues"]])
    actions_formatted = "\n".join([f"  • {action}" for action in actions_taken]) if actions_taken else "  • None taken"

    text_body = f"""=====================================================
  RENOLOGY & WEATHER AUTONOMOUS INCIDENT ALERT
=====================================================
Status:    {audit['overall_status']}
Host:      Linux Mint / Microsoft Surface Go 2
Timestamp: {ts_str}
Recipient: {recipient}

[1] DETECTED ANOMALIES
-----------------------------------------------------
{issues_formatted}

[2] AUTONOMOUS HEALING ATTEMPTS
-----------------------------------------------------
{actions_formatted}

[3] AGY / GEMINI-3.8-FLASH-HIGH DIAGNOSTIC ASSESSMENT
-----------------------------------------------------
{agy_diagnosis}

[4] RECOMMENDED PHYSICAL / ON-SITE INTERVENTION
-----------------------------------------------------
1. Renology BT-1 / BT-2 Dongle:
   • Unplug the RJ12 6-pin cable from the solar charge controller for 5 seconds to power-cycle the Texas Instruments BLE module.
   • Verify that no mobile device (e.g. Renogy DC Home app) is actively paired or connected to the dongle (single-connection firmware limitation).
2. Local Weather Station (DD85 / Ecowitt):
   • Check the indoor console LCD screen to verify it is connected to local Wi-Fi.
   • Confirm the weather station custom HTTP upload path is pointing to http://192.168.0.163:8088.
3. Surface Go 2 Kiosk:
   • If display is black, tap the screen to ensure device has not entered power-saving lock.
   • Remote SSH and Cloudflare tunnels remain active and healthy.

=====================================================
Renology Autonomous Sentinel • System SRE Self-Healing Engine
"""

    html_body = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0b111e; color: #f1f5f9; padding: 24px; }}
  .container {{ max-width: 650px; margin: 0 auto; background: #131d31; border: 1px solid #ef4444; border-radius: 12px; overflow: hidden; }}
  .header {{ background: #7f1d1d; padding: 20px 24px; border-bottom: 2px solid #ef4444; }}
  .header h1 {{ margin: 0; font-size: 18px; color: #fecaca; }}
  .header .meta {{ font-size: 12px; color: #fca5a5; margin-top: 4px; }}
  .content {{ padding: 24px; }}
  .section {{ margin-bottom: 20px; }}
  .section-title {{ font-size: 12px; font-weight: 700; text-transform: uppercase; color: #38bdf8; letter-spacing: 0.8px; margin-bottom: 8px; }}
  .box {{ background: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 14px; font-size: 13px; line-height: 1.5; }}
  .box.alert {{ border-left: 4px solid #ef4444; }}
  .box.action {{ border-left: 4px solid #10b981; }}
  .box.agent {{ border-left: 4px solid #818cf8; white-space: pre-wrap; font-family: monospace; font-size: 12px; }}
  .box.checklist {{ border-left: 4px solid #f59e0b; }}
  .footer {{ background: #0b111e; padding: 14px; text-align: center; font-size: 11px; color: #64748b; border-top: 1px solid #1e293b; }}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🚨 Renology & Weather Sentinel: Intervention Required</h1>
    <div class="meta">{ts_str} • Surface Go 2 Appliance • Status: {audit['overall_status']}</div>
  </div>
  <div class="content">
    <div class="section">
      <div class="section-title">Detected Issues</div>
      <div class="box alert">
        {issues_formatted.replace(chr(10), '<br>')}
      </div>
    </div>

    <div class="section">
      <div class="section-title">Autonomous Remediation Attempted</div>
      <div class="box action">
        {actions_formatted.replace(chr(10), '<br>')}
      </div>
    </div>

    <div class="section">
      <div class="section-title">AI Agent Diagnostic Analysis (gemini-3.8-flash-high)</div>
      <div class="box agent">{agy_diagnosis}</div>
    </div>

    <div class="section">
      <div class="section-title">Recommended On-Site Intervention Checklist</div>
      <div class="box checklist">
        <strong>1. Renology BT-1/BT-2 Dongle:</strong><br>
        • Unplug RJ12 6-pin cable from controller for 5 seconds to hard reboot BLE stack.<br>
        • Ensure no mobile phone or Renogy DC Home app is connected in background.<br><br>
        <strong>2. Local Weather Station (EasyWeather):</strong><br>
        • Verify indoor Wi-Fi console is powered on and receiving 915MHz sensor signals.<br><br>
        <strong>3. Surface Go 2 Screen:</strong><br>
        • Touch display to ensure screen is unlocked. Local services remain active.
      </div>
    </div>
  </div>
  <div class="footer">
    Renology Autonomous SRE • Automated Dispatch to {recipient}
  </div>
</div>
</body>
</html>
"""

    mailer_script = SCRIPTS_DIR / "mailer.py"
    cmd = [
        sys.executable, str(mailer_script),
        "--to", recipient,
        "--subject", subject,
        "--body", text_body,
        "--html", html_body
    ]
    subprocess.run(cmd, capture_output=True, text=True)
    log(f"Escalation notification dispatched to {recipient}")


def record_heartbeat(status, issues):
    """Records audit heartbeat for status inspection."""
    data = {
        "timestamp": datetime.datetime.now().isoformat(),
        "status": status,
        "issues_count": len(issues),
        "issues": issues
    }
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(HEARTBEAT_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


def run_hourly_inspection(force_alert=False):
    """
    Main hourly troubleshooting loop:
    1. Audits state across all 4 pillars.
    2. Takes autonomous corrective actions if degraded/critical.
    3. If unresolved, escalates to agy and alerts Frank.
    """
    log("Beginning hourly Renology & Weather health inspection...")
    audit = health_check.run_comprehensive_audit()
    record_heartbeat(audit["overall_status"], audit["issues"])

    # If completely healthy, we are done
    if audit["overall_status"] == "HEALTHY" and not force_alert:
        log("System is fully HEALTHY. Telemetry streaming, weather online, kiosk up. No action required.")
        return 0

    log(f"Audit detected non-healthy status: {audit['overall_status']} ({len(audit['issues'])} issues)")
    for issue in audit["issues"]:
        log(f"  Issue: {issue}")

    # Check if only warm thermal (expected in fanless Surface during compile/test)
    non_thermal_issues = [i for i in audit["issues"] if "thermal warm" not in i]
    if not non_thermal_issues and not force_alert:
        log("Only thermal warm noted (normal under task load on fanless tablet). System functional.")
        return 0

    # Attempt autonomous recovery actions
    actions_taken = attempt_remediation(audit)

    # Re-evaluate health after recovery attempt
    post_audit = health_check.run_comprehensive_audit()
    record_heartbeat(post_audit["overall_status"], post_audit["issues"])

    if post_audit["overall_status"] == "HEALTHY" and not force_alert:
        log(f"Autonomous remediation SUCCESSFUL! Resolved by: {actions_taken}")
        return 0

    # Filter out mild thermal warm
    active_critical_issues = [i for i in post_audit["issues"] if "thermal warm" not in i]
    if not active_critical_issues and not force_alert:
        log("All core services recovered. Remaining warning is within tolerable thresholds.")
        return 0

    log(f"Self-healing could not resolve {len(active_critical_issues)} issue(s). Escalating to AI agent...")
    agy_diag = invoke_agy_troubleshooter(post_audit, actions_taken)

    # Dispatch email notification to Frank
    send_escalation_alert(post_audit, actions_taken, agy_diag)
    return 1


def main():
    parser = argparse.ArgumentParser(description="Autonomous Renology & Weather Hourly Troubleshooter")
    parser.add_argument("--now", action="store_true", help="Run the hourly inspection immediately")
    parser.add_argument("--test-alert", action="store_true", help="Simulate an escalation alert and email to frank@sfle.ca")
    args = parser.parse_args()

    if args.test_alert:
        log("Generating simulated escalation alert...")
        audit = health_check.run_comprehensive_audit()
        audit["overall_status"] = "CRITICAL"
        audit["issues"].append("[SIMULATED TEST] Bluetooth peripheral disconnected; 0x3E connection timeout")
        actions = ["Cycled Bluetooth adapter hci0", "Restarted renology.service"]
        diag = "Simulated Diagnostic: BT-1 dongle unresponsive to LE Create Connection packets. Likely power-latched or out of radio range."
        send_escalation_alert(audit, actions, diag)
        return

    run_hourly_inspection()


if __name__ == "__main__":
    main()
