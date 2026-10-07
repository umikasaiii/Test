# DSLink PWA + WebAssembly — Foundation 1

The Nintendo DS runs **inside the page**: the same melonDS DS libretro core and the same minimal DSLink libretro host that the Android app uses, compiled to WebAssembly.
No cloud emulation, no Container, no streaming, no network: every device emulates locally.

```
Browser (Chrome Android / Safari iOS / desktop)
  └─ Web Worker  ── dslink_wasm.wasm = DSLink libretro host + melonDS DS core (single thread)
        ├─ frames  → RGBA buffers → main thread → WebGL2 canvas (the picture the frozen touch UI lays out)
        ├─ audio   → MessagePort straight to the AudioWorklet (32768 Hz → device rate, adaptive buffer)
        └─ input   ← frozen UI Touch V1 (D-pad, A/B/X/Y, L/R, Start/Select, stylus, multi-touch) / keyboard on desktop
  Storage: OPFS (if a real write works) → IndexedDB fallback.  Saves: library/<rom-id>/save
```

## Layout

| Path | What |
|---|---|
| `wasm/` | `dslink_wasm.cpp` (C API for JS), `CMakeLists.txt`, `net_pcap_stub.cpp`, `patches/0001-melonds-ds-emscripten.patch` (static library instead of a loadable module) |
| `runtime/src/libretro_host.*` | the shared host; WebAssembly adds `#ifdef DSLINK_WASM` (core linked in, no `dlopen`) and in-memory ROM / option text — desktop and Android behaviour is unchanged |
| `scripts/build_wasm.sh` | reproducible build (pinned Emscripten 3.1.74 / emsdk commit and pinned upstream in `upstream/versions.env`) → `cloud/web/play/core/` (git-ignored) |
| `scripts/package_pwa.sh` | static site in `build/pwa` (`/play/`, `/controls/`, `/mp/mp.css`) — no ROM/BIOS/firmware inside |
| `cloud/web/play/` | the player: `play.js` (library, system files, game screen), `player.js` (worker, audio, input, lifecycle), `emulator.worker.js`, `audio-worklet.js`, `video.js`, `storage.js`, `sha256.js`, `sw.js`, manifest |
| `cloud/tests/play_wasm_e2e.mjs` | browser end-to-end test (homebrew ROMs only) |
| `.github/workflows/wasm.yml` | CI: guard → WASM build → e2e in real Chrome → package guard → artifact `DSLink-PWA-WASM` |
| `.github/workflows/pwa-pages.yml` | manual: publish the PWA to GitHub Pages (HTTPS) for phone testing |

## What the core build does and does not include

Software renderer only (no OpenGL), no threaded renderer, no JIT (impossible in WebAssembly), no dynamic loading. Networking code is compiled (the core needs its types) but nothing uses it:
the page never opens a socket (the e2e test asserts zero WebSocket/WebRTC/fetch/XHR while a game runs). C++ exceptions use the WebAssembly exception-handling proposal (`-fwasm-exceptions`:
Chrome 95+, Safari 15.2+). **No SharedArrayBuffer / WASM threads are needed** (cross-origin isolation is not required, so Safari/iOS and any static host work); a threaded build can come later as an option.

## Files and privacy

* ROM (`.nds`), `bios7.bin` (16 KB), `bios9.bin` (4 KB), `firmware.bin` (128/256/512 KB) are picked with the browser's file picker and copied into the browser storage of **this device**. They are never uploaded, never put in the repository, the artifacts or any log
  (the page logs nothing about file contents; the service worker only ever caches the player's own static files).
* BIOS/firmware are optional for homebrew (the core falls back to its built-in FreeBIOS); commercial games should have them. `refs.json` is not used here (it is a Download Play automation file).
* CI uses only the homebrew test ROMs built from this repository (`tests/rom`).

## Storage

`openStore()` tries OPFS and **proves** it with a write + read-back probe (Safari exposes the directory API but not writable streams on the main thread in many versions); otherwise IndexedDB.
`?store=opfs|idb` forces one (tests). Logical paths: `system/<file>`, `library/<rom-id>/rom.nds`, `library/<rom-id>/meta.json`, `library/<rom-id>/save`.
The rom-id is the first 24 hex digits of SHA-256(size ‖ first 4 MB ‖ last 4 MB): stable, fast, and identical with or without WebCrypto (plain-http pages have no `crypto.subtle`).
The core writes SRAM into its in-memory file system; the worker hands it to the page when it changes (every 5 s while playing, on pause/background, on exit) and the page stores it.
The next start gives the stored save back to the core before boot. The browser may evict storage of a non-installed site (Safari: after 7 days without use) — the page asks for persistent storage (`navigator.storage.persist()`); an installed PWA is exempt on iOS.

## Lifecycle, audio, orientation

* The AudioContext is created **inside the tap on GIOCA** (iOS only allows that). If the browser still blocks audio after a background/resume, a "RIPRENDI" card appears.
* Hidden page → emulation pauses, save is flushed, the AudioContext is suspended; visible again → resumes. Rotation is handled by the frozen layout engine (the canvas is the element it positions).
* Exit goes through the frozen controls menu → "Esci" → confirmation; the save is written before the library is shown again. Browser Back inside a game asks first.

## Development overlay and diagnostics

`/play/?dev=1` (or `localStorage["dslink.dev"]="1"`): emulator fps, render fps (+renderer), frame time avg/max, dropped frames, audio mode/underruns/buffer, WASM memory, main-thread stalls, storage backend.
Everything stays on the device. The library page also has a collapsible "Compatibilità di questo dispositivo" panel (WebAssembly, module worker, WebGL2, AudioWorklet, storage backend, secure context, standalone).

## Verified so far

Desktop Chrome (headless, software WebGL) in CI: see the report of the commit. **Not verified on any phone**: HONOR VERIFIED = NO, IPHONE VERIFIED = NO until tested physically.
Known risks to look at on the devices: iOS silent switch muting Web Audio, memory limits for big ROMs on iOS, AudioWorklet/OPFS needing HTTPS (plain-http LAN pages fall back to ScriptProcessor + IndexedDB),
frame time on mid-range phones (single thread: emulation + core share one worker).

## Not in this milestone

Multiplayer in WASM (Distributed WebRTC, Download Play PWA↔PWA), accounts, cloud library/saves (R2), friends, presence, voice, PS1, TURN/SFU.

---

# Phase 2 — mobile performance and hardening

Real Honor 200 run of Foundation 1 (Mario Party DS): emulator 59.9 fps (full speed), **render 51.6 fps**, frame 13.5/21.0 ms, **795 audio underruns**, buffer 172 ms, 5 main-thread stalls, OPFS.
The emulation is fast enough; the page around it was not. What was found and changed:

## Audio — what the 795 was and what replaced it

* **The old counter counted samples, not dropouts**: one starved 128-sample quantum added up to 128, so 795 means "at least 7 dropouts", each followed by a forced re-prime of the whole 70 ms target in silence. Every dropout was therefore a long gap, and the number was not comparable to anything.
* **The old buffer controller was too weak** (+-0.4 % at full error): the emulator's wall clock (59.9 fps) is 0.12 % faster than the DS (59.83 Hz) and the audio clock is a third clock; the buffer drifted to 172 ms instead of staying near its target.
* New `AudioRing` (`cloud/web/play/audio-worklet.js`, shared by the AudioWorklet, the ScriptProcessor fallback and a deterministic unit test, `cloud/tests/audio_ring_unit.mjs`):
  PI controller on the buffer level (+-0.6 % rate, linear resampling 32768 Hz → device rate); starvation is **one event** (fade out, silence, refill to 60 % of target, fade in) with its silent samples counted separately;
  **adaptive target**: starts at 100 ms, x1.35 after a dropout (max 250 ms), shrinks 5 ms every 8 s of stability (floor 70 ms); overrun guard (counted, bounded); flush on resume (silence while refilling is *not* an underrun).
  No allocation per quantum or per message (metrics object reused; message buffers are recycled by the worklet → worker; SharedArrayBuffer ring needs none).
* **Transport**: default = worker → AudioWorklet over a MessagePort **without SharedArrayBuffer** (works on Safari/iOS and any static host). When the page *happens to be* cross-origin isolated (COOP/COEP headers), a lock-free SharedArrayBuffer ring is used instead. `?audio=msg|sp` (or the test panel) forces a path for A/B.
* iOS: `navigator.audioSession.type = "playback"` (17+) so the silent switch does not mute the game; the AudioContext is created inside the tap.

## Video — copies, allocations, pacing

* WASM no longer converts XRGB→RGBA per pixel on the emulation thread: one `memcpy`, the fragment shader swaps the channels (`texture2D(...).bgra`). 
* The worker owns a **pool of 4 picture buffers** that the page hands back after upload; if none is free the picture is skipped at the source (the emulation never waits for the page). Nothing large is allocated per frame.
* The page keeps a **3-picture FIFO** drained one per `requestAnimationFrame` (the old "latest wins" slot lost a picture whenever two arrived between vsyncs); the oldest is dropped only when the page is >3 behind. `fit()`'s per-frame layout read was removed (ResizeObserver only). The core's clock never depends on `requestAnimationFrame`.
* **Optional render worker** (`render-worker.js`): the game canvas is transferred to an OffscreenCanvas owned by a second worker that receives the pictures straight from the emulator worker, so the main thread is off the video path. Chosen with the test panel / `?render=worker`; before the canvas is transferred (irreversible) the worker must pass a real probe (WebGL + shaders + one draw on a throwaway canvas), otherwise the main-thread renderer is used. Default stays the main-thread renderer until the target phones confirm the worker path.

Headless Chromium, homebrew ROM, main thread slowed with CDP CPU throttling (the emulator worker is not slowed, like on a phone whose UI thread is the weak link):

| scenario | before | after (main-thread renderer) | after (render worker) |
|---|---|---|---|
| no throttle, render fps | 59.0 | 60.0 | 56–59 |
| 4x throttle, render fps | 45.2 | 56–58 | 54–56 |
| 8x throttle, render fps | 31.5 | 30–33 | **46–51** |
| 4 x 400 ms main-thread blocks | — | emulator 59.8 fps, **0 underruns** | same |
| audio underruns (all scenarios) | 0 (per-sample count) | 0 events | 0 events |

(The desktop never reproduced the Honor's underruns, so the audio fix is verified by the deterministic ring test and by robustness scenarios, not by "795 → 0" on the device. The device overlay below is what will show the real before/after.)

## Development overlay (`/play/?dev=1`, or "Impostazioni di test" → overlay)

```
EMU    emulator fps  frame avg/max ms  late avg/max ms (worker timer lateness)
VIDEO  submit (worker) recv (page) drawn  drop(src / render)  q (FIFO depth)
RENDER fps (renderer / worker)  upload avg/max ms  draw avg/max ms  main-thread cost per frame avg/max ms
AUDIO  backend  buf current/target ms  queue frames  srcRate>deviceRate  base+output latency ms
       underruns events / silent samples   last10s   overrun   health (state/ctx)   late quanta   max message gap ms
WASM   memory MB   main stalls (rAF gaps > 50 ms, long tasks)   running | PAUSED <reason>   storage
```
Underruns are now comparable before/after: events, silent samples, and the last 10 seconds.

## Background, lock screen, interruptions

`visibilitychange` (pause, flush save, suspend audio; resume = resume audio → flush stale audio → resume emulation), `pagehide` (save + pause), `pageshow` with `persisted` (verifies the worker is alive, otherwise reports the interrupted session with the save safe),
AudioContext `statechange` ("interrupted" on iOS calls/alarms, "suspended"): game pauses cleanly, the RIPRENDI card appears, a tap resumes audio and game together. Rotation: the layout engine + ResizeObserver; verified to cause no underrun.
Screen Wake Lock is requested while playing (feature-detected). All of it is covered by `cloud/tests/play_wasm_hardening.mjs`.

## Test panel (on the device, no URL editing)

Library → "Impostazioni di test": render path (auto/main/worker), audio path (auto / worklet+messages / ScriptProcessor), hardware latency hint (interactive / balanced / playback — a larger hardware buffer is the first thing to try if a device still crackles), overlay on/off. Saved on the device only.

## Still open

Not verified on iPhone/Safari or on a phone after this change (HONOR/IPHONE VERIFIED = NO until tested physically). Possible next steps if the Honor still shows frame time ≈13 ms for heavy 3D games: a SIMD build (Safari 16.4+, would need a non-SIMD fallback), LTO, or a threaded build for hosts that can send COOP/COEP.
