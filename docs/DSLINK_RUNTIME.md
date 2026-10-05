# DSLink Runtime

`runtime/` — a minimal Libretro frontend for Linux x86_64, one process per emulated console. **No** menus, playlists, shaders,
achievements, themes, rewind, netplay lobby, window system or audio server. It does exactly what a cloud console needs.

Status: **BUILD VERIFIED · LOCAL TESTED** (see [RETROARCH_PARITY.md](RETROARCH_PARITY.md) for the evidence). Not yet run on real cloud hardware.

## Process model

```
 dslink-runtime  (one per console)
   ├─ libretro host   dlopen(core) → retro_set_* → retro_load_game / no content → retro_run() at the core's own frame rate
   ├─ AvPipeline      XRGB8888 frame → swscale → libx264 (or libvpx) ;  s16 stereo → swresample → libopus   (all in-process)
   ├─ Link            Unix-domain socket to the gateway: media out, input/commands in, logs, 1 Hz status JSON
   └─ MpBridge        Unix-domain socket to the other console of the same container (DS wireless packets)
```

The main thread paces `retro_run()` against a monotonic clock (60 fps for DS); encoding happens inline on the same thread with
`preset ultrafast, tune zerolatency, baseline` (libx264) so a slow encoder shows up as a measured late frame instead of unbounded
latency. Metrics: frames, fps, slowest frame (ms), video frames, audio packets, bridge counters.

## Command line

| Flag | Meaning |
|---|---|
| `--core PATH` | libretro core (`.so`) |
| `--content PATH` | ROM; omit to boot without content (core must declare `support_no_game`) |
| `--system DIR`, `--save DIR` | system (BIOS/firmware) and save directories handed to the core |
| `--options FILE` | core options (`key = "value"` lines, RetroArch `.opt` format) |
| `--username NAME` | libretro `GET_USERNAME` (the DS core derives the console's MAC from it) |
| `--link PATH` | listen on this Unix socket for the gateway |
| `--av on` / `--codec h264\|vp8` / `--out-w --out-h` | enable in-process encoding (default 512×768, 2× the DS) |
| `--mp-path PATH --mp-role host\|client [--mp-timeout MS]` | Multiplayer Bridge ([MULTIPLAYER_BRIDGE.md](MULTIPLAYER_BRIDGE.md)) |
| `--name`, `--log FILE`, `--frames N` | label, log file, stop after N frames (tests) |

Environment: `DSLINK_VIDEO_CODEC=vp8` selects VP8 where the browser has no H.264 in WebRTC (headless Playwright Chromium).

## Control link (little endian: `u8 type, u8 flags, u16 0, u32 length, payload`)

| Dir | Type | Payload |
|---|---|---|
| runtime→gw | 1 VIDEO | flags bit0 = keyframe; `u64 pts_us` + Annex-B access unit (or VP8 frame) |
| runtime→gw | 2 AUDIO | `u64 pts_us` + Opus packet (20 ms, 48 kHz stereo) |
| runtime→gw | 3 LOG, 4 STATUS | text / JSON (the last 400 log lines are replayed when the gateway attaches) |
| gw→runtime | 10 BUTTON | `u8 port, u8 retropad id, u8 down` |
| gw→runtime | 11 TOUCH | `f32 x, f32 y, u8 down` — normalised over the **whole** frame; the host maps to libretro pointer ±32767 |
| gw→runtime | 13 QUIT · 14 KEYFRAME · 16 SAVE · 12/15 test helpers (snapshot, audio dump) |

A PLI/FIR from a browser becomes `KEYFRAME`; the encoder emits an IDR immediately.

## Saves, firmware, boot without content

* SRAM: `retro_get_memory_data(SAVE_RAM)` is flushed to `<save>/<library_name>/<content base>.srm` on a clean stop and on `SAVE`
  (same path RetroArch uses; checked equal in the A/B test). A restored file is loaded by the core at start.
* BIOS/firmware: read by the core from `<system>/<library_name>/` (`bios7.bin`, `bios9.bin`, `firmware.bin`). The Runtime never
  ships any. Without them melonDS runs ROMs with its built-in replacement BIOS; booting to the DS **menu** (needed for Download Play on
  the cartridge-less console) requires the user's bootable firmware — both under RetroArch and under the Runtime.
* Boot without content: `retro_run` runs with no `retro_load_game` content; verified identical outcome to RetroArch (the core reports
  the missing firmware, starts its multiplayer layer, joins the bridge).

## Clean stop

SIGINT/SIGTERM or `QUIT`: stop the loop, flush SRAM, `retro_unload_game`, `retro_deinit`, close the bridge peer so the other console
sees the leave, flush the encoder, exit 0. Exit code 0 and the "stopped cleanly" log line are asserted by the tests.

## Build and test

```
cmake -S runtime -B build/rt -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build/rt     # needs libavcodec/libswscale/libswresample dev packages
python3 tests/runtime/test_single.py        build/rt/dslink-runtime <core.so> <rom.nds> <cfgtool>          # 15 checks
python3 tests/runtime/test_two_ds.py        build/rt/dslink-runtime <core.so> <rom1> <rom2> <cfgtool>      # 14 checks
python3 tests/runtime/test_wifi_bridge.py   build/rt/dslink-runtime <core.so> <rom1> <rom2> <cfgtool>      #  9 checks
```
Not supported (by design, phase 1): macOS/Windows/ARM hosts, OpenGL/Vulkan hardware-rendered cores (the DS core runs its software
renderer), save states, rewind, cheats, netplay with other frontends, cores needing the VFS interface (it is deliberately not offered;
melonDS falls back to plain files).
