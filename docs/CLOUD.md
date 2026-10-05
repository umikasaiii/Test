# DSLink Cloud V1 — status and how to run

Status scale: **CODED · BUILD VERIFIED · LOCAL TESTED · CLOUD DEPLOYED · BROWSER VERIFIED · DEVICE VERIFIED · MARIO PARTY VERIFIED**

| Item | Status |
|---|---|
| Two RetroArch+melonDS DS instances in one environment, each with its own X framebuffer, PulseAudio sink, input injector, DS MAC | LOCAL TESTED |
| Emulator 1 with ROM (Netplay host) / emulator 2 with **no cartridge** (Netplay client), connected over loopback inside the environment | LOCAL TESTED (joins and starts the core's multiplayer layer; DS menu itself needs the user's firmware → not yet) |
| Per-slot video (VP8) + audio (Opus) → WebRTC, per-browser input → its own emulator only (buttons + touch screen) | LOCAL TESTED / BROWSER VERIFIED (two headless Chromium, localhost) |
| Web UI: CREA PARTITA (upload .nds → room code/link), ENTRA (code) | BROWSER VERIFIED (headless Chromium driving the real UI) |
| Container image (`cloud/Dockerfile`: pinned RetroArch+core, gateway, Xvfb, Pulse, ffmpeg) | BUILD VERIFIED (GitHub Actions `cloud` run 37298639235, ~3.5 min) |
| Both browser suites against the **container** (Playwright Chromium on the runner) | BROWSER VERIFIED in CI (13/13 UI flow + 16/16 independence), same run |
| Cloudflare Realtime SFU/TURN/Containers integration | **NOT DONE — API unverified** (developers.cloudflare.com blocked in the build environment) |
| CLOUD DEPLOYED | NO |
| DEVICE VERIFIED (real phones) | NO |
| MARIO PARTY VERIFIED | NO — blocked on the user's ROM **and** firmware |

## What the browser tests prove (`cloud/tests/`)

`browser_e2e.mjs` (16 checks, "Multi-ROM compatibility mode": slot 2 also gets a test ROM so its output differs):
two browsers connected at once; video A is a blue screen and video B a red one (different framebuffers); audio A peaks at 440 Hz
and audio B at 660 Hz (different streams); a button pressed in A lights only emulator 1, in B only emulator 2; a touch in B
makes emulator 2's ARM7 read the touch panel (crosshair) and emulator 1 sees nothing; both emulators joined Netplay inside the
container; core multiplayer started on both; DS MACs differ and equal DSLink's derivation.

`browser_ui_nocart.mjs` (13 checks, the real product flow, **no test hooks**): host uploads a .nds in the UI and gets a code;
guest enters it; both connected; emulator 2 has no cartridge, joined as Netplay client, and its core reports it needs bootable
firmware (expected without the user's DS firmware).

## Run locally (Linux)

```
# test ROMs (own homebrew, redistributable)
tests/rom/build.sh /tmp                       # needs gcc-arm-none-eabi
# gateway + tools built as in cloud/Dockerfile; then:
DSLINK_RETROARCH=... DSLINK_CORE=... DSLINK_CFGTOOL=... DSLINK_ROMCHECK=... DSLINK_LOOPBACK=1 DSLINK_DEBUG=1 \
  cloud/gateway/dslink-gateway -addr :8080 -web cloud/web
cd cloud/tests && npm install && node browser_ui_nocart.mjs http://localhost:8080 /tmp/dslink_test_1.nds
```
Container: `docker build -f cloud/Dockerfile -t dslink-cloud . && docker run --rm -p 8080:8080 dslink-cloud`
(for remote browsers: publish `50000-50100/udp`, set `DSLINK_PUBLIC_IP`, or provide TURN through `DSLINK_ICE`).
Private firmware for emulator 2: mount a directory with `bios7.bin bios9.bin firmware.bin` and set `DSLINK_FIRMWARE_DIR`.

## Findings worth knowing

* The core decrypts the ROM's first 0x800 ARM9 bytes in place: an ARM7 binary at ROM offset 0x4600 is corrupted. Real ROMs and
  `tests/rom/pack_nds.py` put ARM7 at ≥ 0x8000.
* RetroArch's X11 input driver gives an *absolute* pointer only when the mouse is not grabbed and the window is 1:1 at (0,0):
  the container runs it windowed at 512×768 with `input_auto_mouse_grab=false`. Browser touch → X pointer is therefore exact.
* XTEST key events must be sent with root=0 (pointer events with the root window).
* `x11grab` only emits frames on change and libvpx's default threading stalls under CPU contention: capture uses
  `-fps_mode cfr`, `-threads 1` and a keyframe every second so a late-joining browser decodes immediately.
* Software GL (llvmpipe) is enough for RetroArch's X11 output; the melonDS core renders in software.
* Per-room CPU: 2× (RetroArch + Xvfb + VP8 + Opus) — roughly 1.5–2 cores on the build machine; sizing for real hosting is **unmeasured**.
