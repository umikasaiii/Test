# Test plan and status

Legend: **IMPLEMENTED** (code exists) · **BUILD VERIFIED** (CI builds it) · **EMULATOR TESTED** (real RetroArch+core, no device) ·
**NETWORK TESTED** (real sockets, loopback) · **DEVICE VERIFIED** (on physical phones) · **NEEDS DEVICE TEST**.

## Automated (run in CI)

| Area | Status |
|---|---|
| dslink C++ library: 56 tests – identity creation/persistence, MAC derivation (vs independent MT19937 reference), distinct MACs (2000 devices), SHA-256 vectors, advert serialize/parse/reject, session validation & version mismatch, IPv4 parse/selection, ports, ROM header/CRC, firmware validation, host & client state machines, disconnect/retry, latency, launch config, log sanitiser, diagnostics | NETWORK TESTED (Linux, macOS; ASan/UBSan/TSan clean locally) |
| Control channel over loopback: hello accept/reject (protocol, core, MAC conflict, room full), bye/timeouts, probes, beacon | NETWORK TESTED |
| Linux integration (`tests/integration/linux_netplay_smoke.sh`): real RetroArch 1.22.2 (patched) + real melonDS DS 1.4.0, host↔client Netplay, core multiplayer started, core MAC == DSLink MAC, no-cartridge client joins and hits the expected "needs firmware" error | EMULATOR TESTED |
| Pure-Java helpers (JUnit) | BUILD/TEST VERIFIED in CI |
| Android APK (core + RetroArch + DSLink) | see README status table |
| iOS app build + XCTest on simulator | see README status table |

## Device tests (cannot be run by the author's environment)

* TEST 1 Android: import .nds, start, audio, controls, touch. — NEEDS DEVICE TEST
* TEST 2 Android↔Android same Wi-Fi: host appears, client joins, Netplay connects. — NEEDS DEVICE TEST
* TEST 3 iPhone↔iPhone. — blocked: iOS emulator not integrated (docs/IOS.md)
* TEST 4 Android↔iPhone both directions. — blocked (same)
* TEST 5 Mario Party DS Download Play: [MARIO_PARTY_DS.md](MARIO_PARTY_DS.md). — NEEDS DEVICE TEST

Also to calibrate on devices: latency thresholds, 60 fps on mid-range arm64 with the software renderer, mic, suspend/resume
save integrity (autosave every 10 s; unverified on device).
