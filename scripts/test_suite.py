#!/usr/bin/env python3
"""
scripts/test_suite.py - Verification Test Suite for Mailer, Sunset Reporter, and Troubleshooter
Runs comprehensive automated unit tests covering all operational invariants.
"""

import datetime
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

import mailer
import sunset_reporter
import health_check
import troubleshooter


class TestMailer(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.orig_outbox = mailer.OUTBOX_DIR
        self.orig_log = mailer.LOG_FILE
        mailer.OUTBOX_DIR = Path(self.test_dir) / "outbox"
        mailer.LOG_FILE = Path(self.test_dir) / "email_log.txt"
        mailer.DATA_DIR = Path(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)
        mailer.OUTBOX_DIR = self.orig_outbox
        mailer.LOG_FILE = self.orig_log

    def test_default_config_recipient(self):
        conf = mailer.load_config()
        self.assertEqual(conf.get("recipient"), "frank@sfle.ca")

    def test_queue_message_creates_valid_json(self):
        res = mailer.queue_message(
            recipient="frank@sfle.ca",
            subject="Test Subject",
            text_body="Test plain body",
            html_body="<p>Test HTML body</p>",
            reason="Unconfigured SMTP"
        )
        self.assertEqual(res["status"], "queued")
        outbox_file = Path(res["file"])
        self.assertTrue(outbox_file.exists())

        with open(outbox_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["recipient"], "frank@sfle.ca")
        self.assertEqual(data["subject"], "Test Subject")
        self.assertEqual(data["text_body"], "Test plain body")
        self.assertIn("Test HTML body", data["html_body"])
        self.assertEqual(data["reason_queued"], "Unconfigured SMTP")

    def test_status_output(self):
        st = mailer.get_status()
        self.assertIn("recipient", st)
        self.assertIn("queued_messages", st)


class TestSunsetReporter(unittest.TestCase):
    def test_sunset_calculation(self):
        dt = sunset_reporter.get_sunset_time_today()
        self.assertIsInstance(dt, datetime.datetime)
        self.assertEqual(dt.date(), datetime.date.today())
        # Sunset in Ontario is generally between 17:00 and 21:00 depending on season
        self.assertTrue(16 <= dt.hour <= 22)

    def test_solar_stats_query(self):
        stats = sunset_reporter.get_solar_stats_today()
        self.assertIn("energy_generated_wh", stats)
        self.assertIn("ending_battery_soc", stats)
        self.assertIn("max_pv_voltage_v", stats)
        self.assertGreaterEqual(stats["ending_battery_soc"], 0)

    def test_report_generation_formats(self):
        solar = {
            "record_count": 500,
            "energy_generated_wh": 484,
            "energy_generated_kwh": 0.484,
            "peak_power_w": 286,
            "peak_power_time": "09:21 AM",
            "max_pv_voltage_v": 41.9,
            "min_battery_v": 13.2,
            "max_battery_v": 14.3,
            "ending_battery_v": 13.7,
            "ending_battery_soc": 100,
            "avg_battery_soc": 100.0,
            "charging_ah_today": 6,
            "load_power_used_wh": 0,
            "max_controller_temp_c": 34,
            "max_battery_temp_c": 26,
            "controller_model": "RNG-CTRL-RVR40",
            "battery_type": "Lithium (LFP)"
        }
        weather = {
            "status": "online",
            "outdoor_temp_c": 14.0,
            "outdoor_temp_f": 57.2,
            "humidity_pct": 62,
            "wind_kmh": 7.2,
            "wind_gust_kmh": 11.6,
            "wind_direction_deg": 180,
            "pressure_hpa": 1013.2,
            "solar_radiation_wm2": 245.5,
            "uv_index": 2,
            "daily_rain_mm": 0.0,
            "station_model": "EasyWeather DD85"
        }
        sunset_dt = datetime.datetime.now()
        text_body, html_body = sunset_reporter.generate_report(solar, weather, sunset_dt)

        # Assertions on text body
        self.assertIn("484 Wh", text_body)
        self.assertIn("286 W", text_body)
        self.assertIn("100%", text_body)
        self.assertIn("14.0 °C", text_body)
        self.assertIn("EasyWeather", text_body)

        # Assertions on HTML body
        self.assertIn("<!DOCTYPE html>", html_body)
        self.assertIn("484", html_body)
        self.assertIn("frank@sfle.ca", html_body)


class TestHealthCheck(unittest.TestCase):
    def test_process_check(self):
        # Current python process is always running
        running, pids = health_check.check_process_running("python3")
        self.assertTrue(running)
        self.assertGreater(len(pids), 0)

    def test_renology_pillar(self):
        pillar = health_check.check_renology_pillar()
        self.assertIn("status", pillar)
        self.assertIn("api_healthy", pillar)
        self.assertIn("total_records", pillar)

    def test_weather_pillar(self):
        pillar = health_check.check_weather_pillar()
        self.assertIn("status", pillar)
        self.assertIn("running", pillar)

    def test_kiosk_pillar(self):
        pillar = health_check.check_kiosk_pillar()
        self.assertIn("status", pillar)
        self.assertIn("display_present", pillar)

    def test_audit_synthesis(self):
        audit = health_check.run_comprehensive_audit()
        self.assertIn("overall_status", audit)
        self.assertIn(audit["overall_status"], ["HEALTHY", "DEGRADED", "CRITICAL"])
        self.assertIn("pillars", audit)


class TestTroubleshooter(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.orig_hb = troubleshooter.HEARTBEAT_FILE
        troubleshooter.HEARTBEAT_FILE = Path(self.test_dir) / "hb.json"
        troubleshooter.DATA_DIR = Path(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)
        troubleshooter.HEARTBEAT_FILE = self.orig_hb

    def test_heartbeat_recording(self):
        troubleshooter.record_heartbeat("HEALTHY", [])
        self.assertTrue(troubleshooter.HEARTBEAT_FILE.exists())
        with open(troubleshooter.HEARTBEAT_FILE, "r") as f:
            data = json.load(f)
        self.assertEqual(data["status"], "HEALTHY")
        self.assertEqual(data["issues_count"], 0)


if __name__ == "__main__":
    unittest.main()
