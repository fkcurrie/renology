#!/usr/bin/env python3
"""
scripts/mailer.py - Robust Email Delivery Engine for Renology & Weather Station
Delivers HTML & plain-text alert/report emails to frank@sfle.ca via SMTP TLS.
If credentials are not yet configured or network is offline, safely queues messages
to data/outbox/ with zero data loss.
"""

import argparse
import datetime
import email.utils
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
import json
import os
import smtplib
import ssl
import sys
import uuid
from pathlib import Path

DEFAULT_CONFIG_PATH = Path("/home/fcurrie/.config/renology/email.json")
DATA_DIR = Path("/home/fcurrie/Projects/renology/data")
OUTBOX_DIR = DATA_DIR / "outbox"
LOG_FILE = DATA_DIR / "email_log.txt"

DEFAULT_RECIPIENT = "frank@sfle.ca"
DEFAULT_CONFIG = {
    "recipient": DEFAULT_RECIPIENT,
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 587,
    "smtp_user": "",
    "smtp_password": "",
    "from_name": "Renology Solar & Weather Sentinel",
    "from_email": "renology-surface@sfle.ca",
    "use_tls": True
}


def load_config():
    """Load configuration from ~/.config/renology/email.json or env vars."""
    config = dict(DEFAULT_CONFIG)
    if DEFAULT_CONFIG_PATH.exists():
        try:
            with open(DEFAULT_CONFIG_PATH, "r", encoding="utf-8") as f:
                user_conf = json.load(f)
                config.update(user_conf)
        except Exception as e:
            print(f"[Mailer] Warning: Failed to read {DEFAULT_CONFIG_PATH}: {e}", file=sys.stderr)
    else:
        # Create default config file for user
        DEFAULT_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(DEFAULT_CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(config, f, indent=2)
            os.chmod(DEFAULT_CONFIG_PATH, 0o600)
        except Exception as e:
            pass

    # Environment variables override
    if os.environ.get("SMTP_HOST"):
        config["smtp_host"] = os.environ["SMTP_HOST"]
    if os.environ.get("SMTP_PORT"):
        config["smtp_port"] = int(os.environ["SMTP_PORT"])
    if os.environ.get("SMTP_USER"):
        config["smtp_user"] = os.environ["SMTP_USER"]
    if os.environ.get("SMTP_PASSWORD"):
        config["smtp_password"] = os.environ["SMTP_PASSWORD"]
    if os.environ.get("SMTP_RECIPIENT"):
        config["recipient"] = os.environ["SMTP_RECIPIENT"]
    if os.environ.get("SMTP_FROM"):
        config["from_email"] = os.environ["SMTP_FROM"]

    return config


def queue_message(recipient, subject, text_body, html_body=None, reason="Unconfigured SMTP credentials"):
    """Saves email message to outbox queue for future delivery."""
    OUTBOX_DIR.mkdir(parents=True, exist_ok=True)
    msg_id = f"{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:8]}"
    outbox_file = OUTBOX_DIR / f"{msg_id}.json"

    payload = {
        "id": msg_id,
        "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "recipient": recipient,
        "subject": subject,
        "text_body": text_body,
        "html_body": html_body,
        "reason_queued": reason
    }

    with open(outbox_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    log_entry(f"QUEUED [{msg_id}] Subject: '{subject}' -> {recipient} (Reason: {reason})")
    return {"status": "queued", "id": msg_id, "file": str(outbox_file), "reason": reason}


def log_entry(msg):
    """Appends an event to the email log file."""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"[{timestamp}] {msg}\n")
    except Exception:
        pass


def send_email(recipient=None, subject="Renology Alert", text_body="", html_body=None):
    """
    Delivers email via SMTP or queues locally.
    Returns dict with delivery or queue status.
    """
    config = load_config()
    target_recipient = recipient or config.get("recipient") or DEFAULT_RECIPIENT

    smtp_host = config.get("smtp_host", "smtp.gmail.com")
    smtp_port = int(config.get("smtp_port", 587))
    smtp_user = config.get("smtp_user", "").strip()
    smtp_pass = config.get("smtp_password", "").strip()
    from_email = config.get("from_email", "solar-kiosk@sfle.ca")
    from_name = config.get("from_name", "Renology Solar Sentinel")
    use_tls = config.get("use_tls", True)

    # Check if SMTP credentials exist
    if not smtp_user or not smtp_pass:
        reason = "SMTP user or password not set in ~/.config/renology/email.json"
        res = queue_message(target_recipient, subject, text_body, html_body, reason)
        print(f"[Mailer] {reason}. Message safely saved to outbox queue: {res['file']}")
        return res

    # Construct MIME message
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{from_email}>"
    msg["To"] = target_recipient
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain="sfle.ca")

    msg.attach(MIMEText(text_body, "plain", "utf-8"))
    if html_body:
        msg.attach(MIMEText(html_body, "html", "utf-8"))

    # Attempt SMTP transmission
    try:
        if smtp_port == 465:
            # SSL directly
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(smtp_host, smtp_port, context=context, timeout=15) as server:
                server.login(smtp_user, smtp_pass)
                server.sendmail(from_email, [target_recipient], msg.as_string())
        else:
            # STARTTLS (port 587 or 25)
            with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as server:
                server.ehlo()
                if use_tls:
                    context = ssl.create_default_context()
                    server.starttls(context=context)
                    server.ehlo()
                server.login(smtp_user, smtp_pass)
                server.sendmail(from_email, [target_recipient], msg.as_string())

        log_entry(f"SENT Subject: '{subject}' -> {target_recipient}")
        print(f"[Mailer] Successfully sent email to {target_recipient}: '{subject}'")
        return {"status": "delivered", "recipient": target_recipient, "subject": subject}

    except Exception as e:
        err_msg = f"SMTP Transmission Failed: {e}"
        print(f"[Mailer] Error: {err_msg}", file=sys.stderr)
        res = queue_message(target_recipient, subject, text_body, html_body, err_msg)
        return res


def flush_queue():
    """Attempts to deliver any queued messages in outbox."""
    if not OUTBOX_DIR.exists():
        print("[Mailer] Outbox directory is empty.")
        return 0

    queued_files = sorted(list(OUTBOX_DIR.glob("*.json")))
    if not queued_files:
        print("[Mailer] No queued messages found in outbox.")
        return 0

    config = load_config()
    if not config.get("smtp_user") or not config.get("smtp_password"):
        print(f"[Mailer] Cannot flush queue: SMTP credentials not set in {DEFAULT_CONFIG_PATH}.")
        print(f"[Mailer] Total queued messages: {len(queued_files)}")
        return 0

    print(f"[Mailer] Attempting to deliver {len(queued_files)} queued message(s)...")
    success_count = 0
    for qf in queued_files:
        try:
            with open(qf, "r", encoding="utf-8") as f:
                data = json.load(f)
            res = send_email(
                recipient=data.get("recipient"),
                subject=data.get("subject"),
                text_body=data.get("text_body"),
                html_body=data.get("html_body")
            )
            if res.get("status") == "delivered":
                qf.unlink()
                success_count += 1
        except Exception as e:
            print(f"[Mailer] Failed to flush {qf.name}: {e}", file=sys.stderr)

    print(f"[Mailer] Flushed {success_count}/{len(queued_files)} messages successfully.")
    return success_count


def get_status():
    """Returns status summary of mailer config and outbox queue."""
    config = load_config()
    queue_count = 0
    if OUTBOX_DIR.exists():
        queue_count = len(list(OUTBOX_DIR.glob("*.json")))

    return {
        "config_file": str(DEFAULT_CONFIG_PATH),
        "recipient": config.get("recipient", DEFAULT_RECIPIENT),
        "smtp_host": config.get("smtp_host"),
        "smtp_port": config.get("smtp_port"),
        "smtp_user_configured": bool(config.get("smtp_user")),
        "queued_messages": queue_count,
        "outbox_dir": str(OUTBOX_DIR),
        "log_file": str(LOG_FILE)
    }


def main():
    parser = argparse.ArgumentParser(description="Renology & Weather Email Delivery Engine")
    parser.add_argument("--to", help="Target email recipient (default: frank@sfle.ca)", default=DEFAULT_RECIPIENT)
    parser.add_argument("--subject", help="Email subject line", default="Renology Notification")
    parser.add_argument("--body", help="Plain text message body", default="")
    parser.add_argument("--html", help="Optional HTML message body", default=None)
    parser.add_argument("--test", action="store_true", help="Send a test verification email")
    parser.add_argument("--flush-queue", action="store_true", help="Attempt delivery of queued outbox messages")
    parser.add_argument("--status", action="store_true", help="Print configuration and queue status")
    args = parser.parse_args()

    if args.status:
        st = get_status()
        print(json.dumps(st, indent=2))
        return

    if args.flush_queue:
        flush_queue()
        return

    if args.test:
        subject = f"[TEST] Renology Solar & Weather Kiosk Status Test ({datetime.datetime.now().strftime('%Y-%m-%d %H:%M')})"
        body = (
            "This is a test notification from the Renology Solar Sentinel & Weather Station monitor.\n"
            f"Host: Linux Mint / Microsoft Surface Go 2\n"
            f"Timestamp: {datetime.datetime.now().isoformat()}\n"
            "If you are receiving this, email transmission is operating correctly."
        )
        html = f"""
        <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0b111e; color: #f1f5f9; padding: 24px;">
            <div style="max-width: 600px; margin: 0 auto; background: #131d31; border: 1px solid #1e293b; border-radius: 12px; padding: 24px;">
                <h2 style="color: #38bdf8; margin-top: 0;">☀️ Renology Solar Sentinel Test</h2>
                <p>This is a verification test from your <strong>Linux Mint Surface Go 2 Solar Kiosk</strong>.</p>
                <div style="background: #0f172a; padding: 16px; border-radius: 8px; border-left: 4px solid #10b981; font-family: monospace;">
                    <p style="margin: 0;">Status: <strong>OPERATIONAL</strong></p>
                    <p style="margin: 4px 0 0 0;">Recipient: <strong>{args.to}</strong></p>
                    <p style="margin: 4px 0 0 0;">Time: <strong>{datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S EDT')}</strong></p>
                </div>
            </div>
        </body>
        </html>
        """
        res = send_email(args.to, subject, body, html)
        print(json.dumps(res, indent=2))
        return

    if not args.body:
        print("[Mailer] Error: Please provide --body or use --test / --status.", file=sys.stderr)
        sys.exit(1)

    res = send_email(args.to, args.subject, args.body, args.html)
    print(json.dumps(res, indent=2))


if __name__ == "__main__":
    main()
