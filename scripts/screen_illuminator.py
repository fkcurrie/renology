#!/usr/bin/env python3
"""
Surface Go 2 Screen Illuminator (Camera Fill-Light / Softbox)
-------------------------------------------------------------
When on-demand camera streaming activates in a dark room:
1. Checks the ambient light sensor (ALS) or ephemeris to confirm darkness.
2. Records prior display sleep state and brightness percentage.
3. Wakes display via DPMS, sets brightness to 100%, and launches a borderless
   pure-white (#FFFFFF) GTK window to illuminate the room for the camera.
4. When streaming stops, closes the window, restores original brightness,
   and puts the display back to sleep if it was originally asleep.
"""

import os
import sys
import time
import json
import signal
import math
import argparse
import subprocess
from datetime import datetime

STATE_FILE = "/run/user/1000/screen_illumination.json"
PID_FILE = "/run/user/1000/screen_illumination.pid"
ALS_PATH = "/sys/bus/iio/devices/iio:device0/in_illuminance_raw"
DPMS_PATH = "/sys/class/drm/card1-eDP-1/dpms"
BACKLIGHT_PATH = "/sys/class/backlight/intel_backlight/actual_brightness"
SCREEN_ASLEEP_FLAG = "/run/user/1000/screen_asleep"

# Dorset, ON coordinates for astronomical solar ephemeris fallback
LATITUDE = 45.244
LONGITUDE = -78.895

# Ensure X11 display and authority are populated in environment BEFORE importing Gtk
if "DISPLAY" not in os.environ:
    os.environ["DISPLAY"] = ":0"
if "XAUTHORITY" not in os.environ:
    os.environ["XAUTHORITY"] = os.path.expanduser("~/.Xauthority")

def get_als_illuminance():
    try:
        if os.path.exists(ALS_PATH):
            with open(ALS_PATH, "r") as f:
                return float(f.read().strip())
    except Exception:
        pass
    return None

def is_dorset_nighttime():
    """Approximates solar elevation for Dorset, ON to check if sun has set."""
    now = datetime.utcnow()
    day_of_year = now.timetuple().tm_yday
    # Solar declination
    dec = 23.45 * math.sin(math.radians(360.0 / 365.0 * (day_of_year - 81)))
    # Equation of time (minutes)
    b = math.radians(360.0 / 365.0 * (day_of_year - 81))
    eot = 9.87 * math.sin(2.0 * b) - 7.53 * math.cos(b) - 1.5 * math.sin(b)
    time_offset = 4.0 * LONGITUDE + eot
    solar_time = now.hour * 60.0 + now.minute + now.second / 60.0 + time_offset
    hour_angle = (solar_time / 4.0) - 180.0
    # Solar elevation angle
    lat_rad = math.radians(LATITUDE)
    dec_rad = math.radians(dec)
    ha_rad = math.radians(hour_angle)
    sin_elev = math.sin(lat_rad) * math.sin(dec_rad) + math.cos(lat_rad) * math.cos(dec_rad) * math.cos(ha_rad)
    elevation = math.degrees(math.asin(max(-1.0, min(1.0, sin_elev))))
    return elevation < -0.833  # Sun below horizon

def check_darkness():
    """Returns (is_dark: bool, als_lux: float or None, reason: str)"""
    als = get_als_illuminance()
    if als is not None:
        if als < 15.0:
            return True, als, f"ALS raw reading {als:.1f} < 15.0 (dark)"
        else:
            return False, als, f"ALS raw reading {als:.1f} >= 15.0 (ambient light present)"

    # Fallback to local weather station solar radiation
    try:
        import urllib.request
        with urllib.request.urlopen("http://localhost:8088/api/weather/current", timeout=2.0) as resp:
            data = json.loads(resp.read().decode())
            rad = data.get("measurements", {}).get("solar_radiation_wm2")
            if rad is not None:
                if float(rad) < 10.0:
                    return True, None, f"Ecowitt solar radiation {rad:.1f} W/m² (night/dark)"
                else:
                    return False, None, f"Ecowitt solar radiation {rad:.1f} W/m² (daylight)"
    except Exception:
        pass

    # Astronomical ephemeris fallback
    night = is_dorset_nighttime()
    return night, None, "Dorset astronomical ephemeris (sun below horizon)" if night else "Dorset astronomical ephemeris (sun above horizon)"

def is_screen_asleep():
    if os.path.exists(SCREEN_ASLEEP_FLAG):
        return True
    try:
        if os.path.exists(DPMS_PATH):
            with open(DPMS_PATH, "r") as f:
                if f.read().strip().lower() == "off":
                    return True
    except Exception:
        pass
    try:
        if os.path.exists(BACKLIGHT_PATH):
            with open(BACKLIGHT_PATH, "r") as f:
                if int(f.read().strip()) == 0:
                    return True
    except Exception:
        pass
    return False

def get_brightness():
    try:
        res = subprocess.run([
            "busctl", "--user", "call",
            "org.cinnamon.SettingsDaemon.Power",
            "/org/cinnamon/SettingsDaemon/Power",
            "org.cinnamon.SettingsDaemon.Power.Screen",
            "GetPercentage"
        ], capture_output=True, text=True, timeout=2.0)
        if res.returncode == 0:
            return int(res.stdout.strip().split()[-1])
    except Exception:
        pass
    return 100

def set_brightness(pct):
    try:
        res = subprocess.run([
            "busctl", "--user", "call",
            "org.cinnamon.SettingsDaemon.Power",
            "/org/cinnamon/SettingsDaemon/Power",
            "org.cinnamon.SettingsDaemon.Power.Screen",
            "SetPercentage", "u", str(pct)
        ], capture_output=True, text=True, timeout=2.0)
        return res.returncode == 0
    except Exception:
        return False

def run_window(was_asleep, orig_brightness, als_lux, reason):
    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('Gdk', '3.0')
    from gi.repository import Gtk, Gdk, GLib

    if not Gtk.init_check()[0]:
        print("[ScreenIlluminator] ERROR: Gtk.init_check failed to connect to X11 display", file=sys.stderr)
        return

    # 1. Wake display via DPMS and dismiss screensaver
    subprocess.run(["xset", "-display", ":0", "dpms", "force", "on"], check=False)
    subprocess.run(["cinnamon-screensaver-command", "-d"], check=False)

    # 2. Maximize backlight to 100%
    set_brightness(100)

    # 3. Create fullscreen white window
    window = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
    window.set_title("CameraIllumination")
    window.set_decorated(False)
    window.fullscreen()
    window.set_keep_above(True)

    css = Gtk.CssProvider()
    css.load_from_data(b"window { background-color: #ffffff; }")
    window.get_style_context().add_provider(css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    # Hide cursor
    window.realize()
    window.get_window().set_cursor(Gdk.Cursor.new_from_name(window.get_display(), "none"))

    # Dismiss on physical touch or keypress
    window.connect("key-press-event", lambda w, e: Gtk.main_quit())
    window.connect("button-press-event", lambda w, e: Gtk.main_quit())

    # Write state
    state = {
        "pid": os.getpid(),
        "was_asleep": was_asleep,
        "original_brightness": orig_brightness,
        "als_lux": als_lux,
        "reason": reason,
        "started_at": time.time(),
        "active": True
    }
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)
    with open(PID_FILE, "w") as f:
        f.write(f"{os.getpid()}\n")

    def on_sig(signum, frame):
        GLib.idle_add(Gtk.main_quit)

    signal.signal(signal.SIGTERM, on_sig)
    signal.signal(signal.SIGINT, on_sig)

    window.show_all()
    print(f"[ScreenIlluminator] Active on PID {os.getpid()} (was_asleep={was_asleep}, orig_brightness={orig_brightness}%)", flush=True)

    try:
        Gtk.main()
    finally:
        print("[ScreenIlluminator] Cleaning up and restoring display state...", flush=True)
        # Restore prior brightness
        set_brightness(orig_brightness)

        # Restore sleep state if display was asleep
        if was_asleep:
            subprocess.run(["xset", "-display", ":0", "dpms", "force", "off"], check=False)
            print("[ScreenIlluminator] Display was asleep before stream; forced DPMS off to resume sleep.", flush=True)

        if os.path.exists(STATE_FILE):
            try:
                os.unlink(STATE_FILE)
            except Exception:
                pass
        if os.path.exists(PID_FILE):
            try:
                os.unlink(PID_FILE)
            except Exception:
                pass

def stop_illumination():
    if not os.path.exists(PID_FILE):
        return False, "Not running"
    try:
        with open(PID_FILE, "r") as f:
            pid = int(f.read().strip())
        os.kill(pid, signal.SIGTERM)
        # Wait up to 2 seconds for clean exit
        for _ in range(20):
            time.sleep(0.1)
            try:
                os.kill(pid, 0)
            except OSError:
                return True, "Stopped cleanly"
        os.kill(pid, signal.SIGKILL)
        return True, "Force killed"
    except Exception as e:
        return False, str(e)

def main():
    parser = argparse.ArgumentParser(description="Surface Go 2 Screen Illuminator")
    parser.add_argument("action", choices=["start", "stop", "status", "check-dark", "auto"])
    parser.add_argument("--force", action="store_true", help="Force illumination even if room is not dark")
    args = parser.parse_args()

    if args.action == "check-dark":
        dark, lux, reason = check_darkness()
        print(json.dumps({"is_dark": dark, "als_lux": lux, "reason": reason}, indent=2))
        sys.exit(0 if dark else 1)

    elif args.action == "status":
        active = False
        pid = None
        state_data = {}
        if os.path.exists(PID_FILE):
            try:
                with open(PID_FILE, "r") as f:
                    pid = int(f.read().strip())
                os.kill(pid, 0)
                active = True
                if os.path.exists(STATE_FILE):
                    with open(STATE_FILE, "r") as sf:
                        state_data = json.load(sf)
            except Exception:
                active = False

        dark, lux, reason = check_darkness()
        status_info = {
            "active": active,
            "pid": pid,
            "is_dark": dark,
            "als_lux": lux,
            "darkness_reason": reason,
            "screen_asleep": is_screen_asleep(),
            "state": state_data
        }
        print(json.dumps(status_info, indent=2))
        sys.exit(0)

    elif args.action == "stop":
        ok, msg = stop_illumination()
        print(f"Stop: ok={ok}, {msg}")
        sys.exit(0 if ok else 1)

    elif args.action in ("start", "auto"):
        # Check if already running
        if os.path.exists(PID_FILE):
            try:
                with open(PID_FILE, "r") as f:
                    pid = int(f.read().strip())
                os.kill(pid, 0)
                print(f"[ScreenIlluminator] Already active on PID {pid}")
                sys.exit(0)
            except Exception:
                pass

        dark, lux, reason = check_darkness()
        if not dark and not args.force:
            print(f"[ScreenIlluminator] Skipping: Room is not dark ({reason})")
            sys.exit(2)

        was_asleep = is_screen_asleep()
        orig_b = get_brightness() or 100
        run_window(was_asleep, orig_b, lux, reason)

if __name__ == "__main__":
    main()
