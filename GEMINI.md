# GEMINI.md - Renology Operational Guide & Technical Runbook

> **Context for AI Agents & Developers**: This document contains operational guidelines, diagnostic runbooks, protocol specifications, and developer workflows for **Renology**, an enterprise-grade Go implementation for monitoring Renogy solar energy hardware via Bluetooth Low Energy (BLE).

---

## 1. Project Overview & Quick Reference

- **Repository**: `github.com/fkcurrie/renology`
- **Primary Language**: 100% Go (Golang) — *Strict directive: Do NOT use Python.*
- **Maintainer**: `fcurrie` (`fkcurrie`)
- **Default Target Device**: `BT-TH-66F984D6` (MAC: `60:98:66:F9:84:D6`, OUI: Texas Instruments)
- **Target Hardware**: Renogy Rover / Wanderer / Adventurer Solar Charge Controllers via BT-1 / BT-2 BLE dongles.
- **Physical Edge Host**: Microsoft Surface Go 2 (fanless Intel Core m3-8100Y, 8GB RAM, Linux Mint 22, X11 `2400x1600` display).
- **Public Cloud Hub**: Google Cloud Run (`solaria-solar` / `https://renology-952659886764.us-central1.run.app`, custom domain `solar.sfle.ca`).
- **Power & Inverter Setup**:
  - 100Ah LiFePO4 battery (~1,280 Wh storage capacity, 12V nominal).
  - Dual 160W monocrystalline solar panels in series (~320W nominal, up to 100V string).
  - Voltworks 1000W Pure Sine Wave Inverter 12V DC to 110V/120V AC (CETL/CSA listed, compatible with LiFePO4 battery and Starlink).
  - HP3500Pro EasyWeather station at `192.168.0.163:8088`.

### Directory Structure
```
/home/fcurrie/Projects/renology/
├── go.mod                     # Go module definition
├── go.sum                     # Cryptographic dependency checksums
├── main.go                    # CLI entrypoint, argument parsing, cloud pusher & OS signal handling
├── Dockerfile                 # Multi-stage production container for Cloud Run relay
├── .dockerignore              # Clean container build exclusions
├── models/
│   ├── types.go               # Telemetry struct, charging states, battery profiles
│   └── history.go             # 24h & 7d historical series and daily summary types
├── modbus/
│   ├── crc.go                 # Modbus RTU CRC-16 calculation & validation
│   └── crc_test.go            # Unit tests with verified Renogy byte sequences
├── renogy/
│   ├── client.go              # BLE GATT connection, chunk reassembly, 5s polling loop
│   ├── parser.go              # Telemetry & register decoder (35-word / 75-byte frames)
│   └── parser_test.go         # Comprehensive parser unit test suite
├── storage/
│   ├── db.go                  # SQLite storage engine (WAL mode, indexes, schema migrations)
│   ├── storage.go             # Storage coordinator (SQLite, latest.json, JSONL backup, CSV)
│   ├── storage_test.go        # Storage engine unit tests (SQLite & CSV migration)
│   ├── history.go             # 24h & 7d downsampling & diurnal aggregation
│   └── history_test.go        # History engine unit tests
├── web/
│   ├── server.go              # HTTP server, REST API (/api/status, /api/history, /api/weather, /api/telemetry/push)
│   ├── server_test.go         # Web server unit test suite
│   └── static/
│       ├── index.html         # High-contrast solar kiosk UI & Voltworks inverter card
│       ├── style.css          # Anti-glare dark automotive theme
│       └── app.js             # Automotive fuel dial canvas, solar speedometer, & 24h/7d charts
├── scripts/
│   ├── deploy_cloud_run.sh    # Automated build & push pipeline to Google Cloud Run
│   ├── mailer.py              # Pure Python 3 email engine (SMTP TLS 587/465 + Outbox queue)
│   ├── sunset_reporter.py     # Sunset daily solar harvest & weather reporter to frank@sfle.ca
│   ├── health_check.py        # Multi-pillar SRE health inspector (JSON & CLI triage)
│   ├── troubleshooter.py      # Hourly autonomous watcher: self-healing + agy escalation
│   └── test_suite.py          # Automated verification test suite
├── systemd/
│   ├── renology.service       # Systemd user service for Renology poller, SQLite & HTTP API
│   ├── renology-kiosk.service # Systemd user service for Firefox fullscreen kiosk on Surface Go 2
│   ├── renology-sunset.service/timer # Daily sunset report dispatch timer
│   └── renology-troubleshooter.service/timer # Hourly autonomous self-healing timer
├── start-kiosk.sh             # 1-click launcher for Linux Mint / Surface Go 2
├── data/                      # Local telemetry outputs (git-ignored)
│   ├── renology.db            # Embedded SQLite database (WAL mode, indexed time-series)
│   ├── renology.db-wal        # SQLite Write-Ahead Log
│   ├── latest_status.json     # Live telemetry snapshot
│   ├── renology_telemetry.jsonl # Append-only raw backup
│   ├── renology_history.csv   # CSV export format
│   ├── rf_survey.csv          # RF signal link survey log
│   └── outbox/                # Safe spool for queued alert & report emails
├── SOUL.md                    # Project mission, architectural manifesto & roadmap
├── GEMINI.md                  # This operational runbook & technical reference
└── README.md                  # Public documentation & getting started guide
```

---

## 2. Developer Commands & Workflows

### 2.1 Building & Testing
```bash
# Run all unit tests
go test -v ./...

# Run tests with race detection
go test -v -race ./...

# Compile the standalone binary
go build -o renology main.go
```

### 2.2 Execution (Local Edge)
```bash
# Run daemon with poller and embedded kiosk web server (http://localhost:8080)
./renology -mac 60:98:66:F9:84:D6 -interval 5 -out ./data -http :8080

# Launch directly into full-screen kiosk mode on the Surface screen
./renology -kiosk

# 1-click bash launcher
./start-kiosk.sh

# Run in web-only mode (inspect data without polling BLE)
./renology -web-only -http :8080

# Run with custom parameters and verbose BLE logging
./renology -mac 60:98:66:F9:84:D6 -interval 5 -out ./data -verbose

# Inspect live data feeds
tail -f ./data/renology_telemetry.jsonl
cat ./data/latest_status.json | python3 -m json.tool
```

### 2.3 Cloud Run Deployment & Verification
```bash
# 1-step automated Cloud Run deployment script
./scripts/deploy_cloud_run.sh

# Or manual deployment using Google Cloud Build and Cloud Run
gcloud builds submit --tag us-central1-docker.pkg.dev/solaria-solar/cloud-run-source-deploy/renology:latest . --project solaria-solar
gcloud run deploy renology --image us-central1-docker.pkg.dev/solaria-solar/cloud-run-source-deploy/renology:latest --project solaria-solar --region us-central1 --allow-unauthenticated

# Verify live deployment endpoints
curl -s https://renology-952659886764.us-central1.run.app/api/status | python3 -m json.tool
curl -s https://renology-952659886764.us-central1.run.app/api/weather | python3 -m json.tool
```

### 2.4 Surface Go 2 Kiosk Operations
```bash
# Inspect and manage local systemd user services
systemctl --user status renology.service
systemctl --user restart renology.service

systemctl --user status renology-kiosk.service
systemctl --user restart renology-kiosk.service

# Capture remote screenshot of physical Surface screen (DISPLAY=:0)
DISPLAY=:0 gnome-screenshot -f /tmp/surface_kiosk.png

# Prevent screen sleeping & power blanking on Surface Go 2
DISPLAY=:0 xset s off -dpms s noblank
```

---

## 3. Bluetooth & BlueZ Troubleshooting Runbook

### 3.1 The "Single Connection" Limitation
> [!IMPORTANT]
> Renogy BT-1 and BT-2 dongles use Texas Instruments CC2541/CC2640 chips with BLE stack firmware that **supports exactly ONE active connection**.
> If the Renogy DC Home app (or any mobile phone) is connected or running in the background, the BT module **will either reject connection requests or stop advertising completely**.

**Resolution**:
1. Disable Bluetooth on nearby smartphones or force-close the Renogy DC Home app.
2. If the module state is latched, unplug the RJ12 cable from the solar charge controller for 5 seconds and reconnect it to power-cycle the BLE radio.

### 3.2 Error: `le-connection-abort-by-local` / HCI `0x3E`
In Linux BlueZ (`bluetoothd`), `Connection Failed to be Established (0x3E)` occurs when:
1. **Marginal RF Signal (-100 dBm to -102 dBm)**: At high distance or through RV/cabin walls, the Link Layer radio misses the initial 6 connection events, prompting the controller to abort.
2. **Aggressive Connection Intervals**: BlueZ defaults can be too fast for high-latency peripheral radios.

**Tuning Linux Connection Parameters**:
Edit `/etc/bluetooth/main.conf`:
```ini
[LE]
MinConnectionInterval=60
MaxConnectionInterval=120
ConnectionSupervisionTimeout=600
ScanIntervalConnect=100
ScanWindowConnect=100
```
Or apply dynamically via debugfs:
```bash
echo 60 | sudo tee /sys/kernel/debug/bluetooth/hci0/conn_min_interval
echo 120 | sudo tee /sys/kernel/debug/bluetooth/hci0/conn_max_interval
echo 600 | sudo tee /sys/kernel/debug/bluetooth/hci0/supervision_timeout
```

**Intel AX200 Wireless Driver Reset**:
If the internal Intel combo card state becomes desynchronized:
```bash
sudo modprobe -r btusb && sudo modprobe btusb
sudo systemctl restart bluetooth
sudo hciconfig hci0 up
bluetoothctl power on
```

### 3.3 BlueZ vs. Direct HCI in Go (Architecture Analysis)
When implementing BLE in Go on Linux, developers face a choice between two foundational architectures:

| Parameter | BlueZ via D-Bus (`tinygo.org/x/bluetooth`) | Direct Raw HCI Sockets (`github.com/go-ble/ble`) |
| :--- | :--- | :--- |
| **Linux Layer** | User-space `bluetoothd` daemon over D-Bus IPC | Direct `AF_BLUETOOTH` kernel raw socket (`HCI_CHANNEL_RAW`) |
| **Permissions** | **Unprivileged (Non-Root)** | **Requires Root** or `CAP_NET_RAW` / `CAP_NET_ADMIN` |
| **System Coexistence** | Seamless (works alongside BT mouse, keyboard, audio) | Exclusive: Resets adapter (`HCI Reset`), disrupts desktop BT |
| **Connection Behavior** | Sends `LE Extended Create Connection` + `LL_FEATURE_REQ` | Sends standard `LE_Create_Connection` (avoids feature abort) |
| **Fringe Signal Link** | Aborts in 270ms if remote feature response missed | Link layer succeeds; application ATT then drops if RSSI < -94 dBm |
| **Best Used For** | Laptops, desktop Linux, general distribution | Dedicated headless SBCs (Raspberry Pi), embedded appliances |

**Conclusion & Strategy**:
1. Neither BlueZ nor direct HCI can circumvent the laws of RF physics: at -101 dBm, the CC2541 chip's receiver (-94 dBm floor) cannot decode incoming packets reliably.
2. `tinygo.org/x/bluetooth` remains the recommended primary engine for Renology because it runs without root privileges, integrates cleanly with system services, and works across Linux, macOS, and Windows.
3. Direct raw HCI is documented as a viable alternative for dedicated embedded appliances where `bluetoothd` is disabled.

---

## 4. Modbus RTU Over BLE Protocol Reference

### 4.1 Service & Characteristic UUIDs
| Name | UUID | Description |
| :--- | :--- | :--- |
| **Write Service** | `0000ffd0-0000-1000-8000-00805f9b34fb` | Service containing Modbus write characteristic |
| **Write Characteristic** | `0000ffd1-0000-1000-8000-00805f9b34fb` | Sends raw Modbus RTU frames (Write Without Response) |
| **Notify Service** | `0000fff0-0000-1000-8000-00805f9b34fb` | Service containing Modbus response characteristic |
| **Notify Characteristic** | `0000fff1-0000-1000-8000-00805f9b34fb` | Emits GATT notifications containing response chunks |

### 4.2 Standard Request Frames
Function code `0x03` (Read Holding Registers). Checksum is Modbus CRC-16 (Low Byte First).

```
[DeviceID] [Function] [Start Register High] [Start Register Low] [Num Registers High] [Num Registers Low] [CRC Low] [CRC High]
```

- **Query System Ratings (Reg 10, 1 word)**:
  `FF 03 00 0A 00 01 A1 D7`
- **Query Device Info (Reg 12, 8 words)**:
  `FF 03 00 0C 00 08 90 14`
- **Query Live Real-Time Telemetry (Reg 256, 35 words)**:
  `FF 03 01 00 00 23 10 31`
- **Query Battery Chemistry Profile (Reg 57348, 1 word)**:
  `FF 03 E0 04 00 01 C8 08`

### 4.3 Notification Chunk Reassembly
Because BLE default MTU is ~23 bytes (20 payload bytes), a 75-byte Modbus response arrives across 4 chunks:
```
Chunk 1: 20 bytes -> [FF 03 46 [data 0..16]]
Chunk 2: 20 bytes -> [[data 17..36]]
Chunk 3: 20 bytes -> [[data 37..56]]
Chunk 4: 15 bytes -> [[data 57..69] [CRC_Lo] [CRC_Hi]]
```
The client buffers incoming bytes until `len(buffer) == byte_count + 5`, then validates CRC-16 before parsing. Exception responses (`func_code & 0x80 != 0`) are handled at a fixed 5-byte length.

### 4.4 Hardware Timing & Pacing (Renogy SWE Runbook)
- **UART Baud & Physical Layer**: Internal MCU UART operates at 9600-8N1 (~1.04 ms/byte). A 75-byte response requires ~78ms of physical UART wire transmission time plus 20-50ms MCU ADC conversion latency.
- **Inter-Frame Silence ($t_{3.5}$ Rule)**: Modbus RTU requires at least 3.5 character times of bus silence between frames. To prevent controller MCU UART RX overrun, Renology enforces a mandatory 100ms hardware pacing delay between consecutive Modbus frames.
- **One-Time Startup Ingestion**: Static hardware parameters (rated system voltage/current, model name, battery profile) are queried once upon link establishment and cached, eliminating serial bus contention during the 5s telemetry loop.

---

## 5. Surface Go 2 Kiosk Operations & Systemd Runbook

### 5.1 Hardware Profile & Environmental Constraints
- **Hardware**: Microsoft Surface Go 2 (fanless Intel Core m3-8100Y, 8GB RAM, 128GB eMMC flash).
- **Thermal & Fanless Operation**: Because the Surface Go 2 is completely fanless and operates 24/7 in a remote cabin environment, passive cooling is critical. The Renology Go poller and the Firefox kiosk browser are optimized to consume <2% CPU aggregate idle load. Heavy canvas redraws, unthrottled `requestAnimationFrame` loops, or high disk I/O must be avoided.
- **eMMC Storage Wear Leveling**: SQLite operates in WAL (`renology.db-wal`) mode with `PRAGMA synchronous = NORMAL`. Data commits are batched and memory-cached to prevent premature flash memory wear.
- **Display Resolution & Coordinates**: The physical 10.5" screen runs at 1920x1280, with Linux Mint Cinnamon X11 scaling resulting in an effective `2400x1600` canvas (`DISPLAY=:0`).

### 5.2 Systemd User Services
Renology runs as an unprivileged user daemon under systemd:

1. **Poller & REST API Engine (`systemd/renology.service`)**:
   ```ini
   [Unit]
   Description=Renology Solar BLE Poller, SQLite Engine & HTTP API
   After=network.target bluetooth.target
   Wants=bluetooth.target

   [Service]
   Type=simple
   WorkingDirectory=%h/Projects/renology
   EnvironmentFile=-%h/.config/renology/renology.env
   ExecStart=%h/Projects/renology/renology -mac 60:98:66:F9:84:D6 -interval 5 -out ./data -http :8080
   Restart=always
   RestartSec=5
   Nice=10

   [Install]
   WantedBy=default.target
   ```

2. **Firefox Fullscreen Kiosk (`systemd/renology-kiosk.service`)**:
   ```ini
   [Unit]
   Description=Renology Surface Go 2 Fullscreen Kiosk Display
   After=renology.service graphical-session.target
   Wants=renology.service

   [Service]
   Type=simple
   Environment=DISPLAY=:0
   ExecStart=/usr/bin/firefox --kiosk http://localhost:8080
   Restart=on-failure
   RestartSec=8

   [Install]
   WantedBy=default.target
   ```

### 5.3 Screen Sleep, Blanking, and DPMS Suppression
To keep the solar kiosk dashboard permanently visible on the Surface screen:
```bash
# Disable X11 screen saver and DPMS power-off
DISPLAY=:0 xset s off
DISPLAY=:0 xset -dpms
DISPLAY=:0 xset s noblank
```
Under Cinnamon desktop settings, ensure AC power display sleep is set to **"Never"**.

### 5.4 Remote Display Inspection & Testing
For headless or remote maintenance over SSH:
```bash
# Capture full 2400x1600 Surface display
DISPLAY=:0 gnome-screenshot -f /tmp/surface_kiosk.png

# Synthetic touch/click coordinates for timespan tabs:
# Today: (874, 1038) | Week: (1010, 1038) | Month: (1110, 1038) | Quarter: (1220, 1038)
```

---

## 6. Google Cloud Run Dashboard & Relay Runbook

### 6.1 Serverless Edge-to-Cloud Relay Pattern
Off-grid solar installations are frequently situated behind mobile cellular hotspots (CGNAT) or Starlink terminals with no inbound port forwarding or static IPs. Renology overcomes this via an egress-only push architecture:
- **Edge Pusher (`startCloudPusher()`)**: The Surface Go 2 poller spawns a background worker that pushes live JSON telemetry snapshots to Google Cloud Run every 5 seconds.
- **Cloud Relay Engine (`-cloud-relay`)**: Cloud Run executes the Renology binary in relay mode, accepting inbound authenticated telemetry pushes on `/api/telemetry/push`, maintaining an embedded SQLite database, and serving the public kiosk UI globally.

### 6.2 Cloud Infrastructure & Deployment
- **Project ID**: `solaria-solar` (Project Number: `952659886764`)
- **Region**: `us-central1`
- **Service Name**: `renology`
- **Live URL**: `https://renology-952659886764.us-central1.run.app` (Custom domain: `solar.sfle.ca`)
- **Container Build Pipeline**:
  ```bash
  # Submit Dockerfile build to Cloud Build and push to Artifact Registry
  gcloud builds submit --tag us-central1-docker.pkg.dev/solaria-solar/cloud-run-source-deploy/renology:latest . --project solaria-solar

  # Deploy to Cloud Run with unauthenticated public read access
  gcloud run deploy renology \
    --image us-central1-docker.pkg.dev/solaria-solar/cloud-run-source-deploy/renology:latest \
    --project solaria-solar \
    --region us-central1 \
    --allow-unauthenticated
  ```
  *(Or execute `./scripts/deploy_cloud_run.sh`)*.

### 6.3 Security & Token Authentication
- Telemetry push ingress (`/api/telemetry/push`) requires bearer token validation matching `RENOLOGY_CLOUD_TOKEN`.
- The secret token is stored on the Surface Go 2 in `~/.config/renology/renology.env` (file permissions `0600`):
  ```bash
  RENOLOGY_CLOUD_URL=https://renology-952659886764.us-central1.run.app
  RENOLOGY_CLOUD_TOKEN=<secret-token>
  ```
- Public read endpoints (`/`, `/api/status`, `/api/history`, `/api/weather`) remain open for low-latency family and operational monitoring on mobile phones and laptops.

---

## 7. Advanced Telemetry & Visual Features Reference

### 7.1 Voltworks 1000W Inverter Autonomy Card
- **Hardware**: Voltworks 1000W Continuous / 2000W Surge Pure Sine Wave Inverter 12V DC to 110V/120V AC (CETL/CSA listed, built-in UL fuses, compatible with LiFePO4 battery and Starlink).
- **Usable Energy Reserve**: Calculated against 100Ah LiFePO4 nominal capacity ($100\text{ Ah} \times 12.8\text{V} \approx 1,280\text{ Wh}$).
- **Dynamic Autonomy Projections**:
  - Starlink (RV/Cabin): 50W (~24.5 hrs on full reserve)
  - Laptop & Phones: 45W (~27.0 hrs)
  - 12V Cooler / Portable Fridge: 35W avg (~34.0 hrs)
  - Cabin LED Lighting: 15W (~75.0 hrs)
  - Inverter Tare Standby: 8W (~6.0 days)
- **Headroom Indicator**: Real-time progress bar tracking total inverter capacity headroom (1000W continuous rating).

### 7.2 Dorset, Ontario Solar Ephemeris
- **Coordinates**: `45.2444° N, 78.8956° W` (Dorset, Haliburton County, ON).
- **Calculation**: Standard NOAA solar calculation implemented in `app.js` determines astronomical sunrise and sunset times based on the current calendar day.
- **Visualization**: Vertical dashed datum lines (`#f59e0b` amber sunrise, `#f97316` orange sunset) with pinned timestamp badges on the 24H solar power canvas chart.

### 7.3 Peak Solar Generation Reference Line & HUD Badges
- **Reference Line**: Layer E.3 dotted red line (`#ef4444`, `[4, 4]` dash, 1.5px width, 5px blur glow) rendered horizontally at the exact peak generation level across:
  - Daily ("Today" / 24H)
  - Weekly ("Week" / 7D)
  - Monthly ("Month" / 30D), Quarter (90D), Half Year (180D), Whole Year (365D)
- **HUD Pill Badges**: Docked on the right canvas margin (`▲ 24H PEAK: <W>W`, `▲ 7D PEAK: <W>W`, `▲ 30D PEAK: <W>W`).
- **Zero-Suppression**: During nighttime or before sunrise (when peak solar generation is 0W), the line and HUD badge are automatically hidden to avoid cluttering the baseline.

### 7.4 EasyWeather HP3500Pro Station Ingestion
- **Local Weather Station**: HP3500Pro / EasyWeather V1.6.5 at `192.168.0.163:8088`.
- **Ingestion**: Reverse-proxied via `/api/weather` in `web/server.go`.
- **Metrics**: Outdoor/indoor temperature, humidity, solar radiation ($W/m^2$), barometric pressure, rainfall rate, and wind speed.

---

## 8. Coding & Contribution Standards

1. **Pure Go Implementation**: External tools and dependencies must be standard Go libraries. No Python wrappers or sidecar scripts.
2. **Defensive Programming**:
   - Always validate frame lengths before indexing raw slices.
   - Always verify CRC checksums before passing frames to decoders.
   - Gracefully handle device disconnections and auto-reconnect without crashing.
3. **Testing Coverage**: Any modification to register decoding or Modbus frame construction must include corresponding unit tests under `modbus/` or `renogy/`.
