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

- **Query Device Info (Reg 12, 8 words)**:
  `FF 03 00 0C 00 08 90 14`
- **Query Live Real-Time Telemetry (Reg 256, 34 words)**:
  `FF 03 01 00 00 22 D1 F1`
- **Query Battery Chemistry Profile (Reg 57348, 1 word)**:
  `FF 03 E0 04 00 01 C8 08`

### 4.3 Notification Chunk Reassembly
Because BLE default MTU is ~23 bytes (20 payload bytes), a 73-byte Modbus response arrives across 4 chunks:
```
Chunk 1: 20 bytes -> [FF 03 44 [data 0..16]]
Chunk 2: 20 bytes -> [[data 17..36]]
Chunk 3: 20 bytes -> [[data 37..56]]
Chunk 4: 13 bytes -> [[data 57..67] [CRC_Lo] [CRC_Hi]]
```
The client buffers incoming bytes until `len(buffer) == byte_count + 5`, then validates CRC-16 before parsing.

---

## 5. Coding & Contribution Standards

1. **Pure Go Implementation**: External tools and dependencies must be standard Go libraries. No Python wrappers or sidecar scripts.
2. **Defensive Programming**:
   - Always validate frame lengths before indexing raw slices.
   - Always verify CRC checksums before passing frames to decoders.
   - Gracefully handle device disconnections and auto-reconnect without crashing.
3. **Testing Coverage**: Any modification to register decoding or Modbus frame construction must include corresponding unit tests under `modbus/` or `renogy/`.
