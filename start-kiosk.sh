#!/usr/bin/env bash
# start-kiosk.sh — Launch Renology Solar Kiosk on Linux Mint / Surface Go 2
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$DIR"

echo "================================================="
echo "  Starting Renology Solar Kiosk on Surface...    "
echo "================================================="

# Check if renology web daemon is already running
if ! pgrep -f "renology.*-http" >/dev/null; then
  echo "Starting Renology engine (BLE Poller + Web Server)..."
  ./renology -mac 60:98:66:F9:84:D6 -interval 5 -out ./data -http :8080 > renology.log 2>&1 &
  sleep 2
fi

# Launch Firefox in kiosk mode
echo "Opening kiosk dashboard in Firefox fullscreen mode..."
firefox --kiosk http://localhost:8080 &

echo "Kiosk running. Access remotely at http://$(hostname -I | awk '{print $1}'):8080"
