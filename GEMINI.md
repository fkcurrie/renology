# GEMINI.md - Renology Operational Guide & Technical Runbook

> **Context for AI Agents & Developers**: This document contains operational guidelines, diagnostic runbooks, protocol specifications, and developer workflows for **Renology**, an enterprise-grade Go implementation for monitoring Renogy solar energy hardware via Bluetooth Low Energy (BLE).

---

## 1. Project Overview & Quick Reference

- **Repository**: `github.com/fkcurrie/renology`
- **Primary Language**: 100% Go (Golang) — *Strict directive: Do NOT use Python.*
- **Maintainer**: `fcurrie` (`fkcurrie`)
- **Default Target Device**: `BT-TH-66F984D6` (MAC: `60:98:66:F9:84:D6`, OUI: Texas Instruments)
- **Target Hardware**: Renogy Rover / Wanderer / Adventurer Solar Charge Controllers via BT-1 / BT-2 BLE dongles.

### Directory Structure
```
/home/fcurrie/Projects/renology/
├── go.mod                     # Go module definition
├── go.sum                     # Cryptographic dependency checksums
├── main.go                    # CLI entrypoint, argument parsing, OS signal handling
├── models/
│   └── types.go               # Telemetry struct, charging states, battery profiles
├── modbus/
│   ├── crc.go                 # Modbus RTU CRC-16 calculation & validation
│   └── crc_test.go            # Unit tests with verified Renogy byte sequences
├── renogy/
│   ├── client.go              # BLE GATT connection, chunk reassembly, 5s polling loop
│   ├── parser.go              # Telemetry & register decoder
│   └── parser_test.go         # Comprehensive parser unit test suite
├── storage/
│   ├── storage.go             # Triple-mode storage (JSONL time-series, latest.json, CSV)
│   └── storage_test.go        # Storage engine unit tests
├── data/                      # Local telemetry outputs (git-ignored)
│   ├── renology_telemetry.jsonl
│   ├── latest_status.json
│   └── renology_history.csv
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

### 2.2 Execution
```bash
# Run with default settings (5s poll, target MAC 60:98:66:F9:84:D6)
./renology

# Run with custom parameters
./renology -mac 60:98:66:F9:84:D6 -interval 5 -out ./data -verbose

# Inspect live data feeds
tail -f ./data/renology_telemetry.jsonl
cat ./data/latest_status.json | jq .
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

## 5. Coding & Contribution Standards

1. **Pure Go Implementation**: External tools and dependencies must be standard Go libraries. No Python wrappers or sidecar scripts.
2. **Defensive Programming**:
   - Always validate frame lengths before indexing raw slices.
   - Always verify CRC checksums before passing frames to decoders.
   - Gracefully handle device disconnections and auto-reconnect without crashing.
3. **Testing Coverage**: Any modification to register decoding or Modbus frame construction must include corresponding unit tests under `modbus/` or `renogy/`.
