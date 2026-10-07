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
