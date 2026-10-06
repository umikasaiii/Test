# DSLink on Android — native Runtime + melonDS (arm64-v8a)

Status: **built in CI, tested on a desktop and on an Android *emulator* (x86_64 build of the same code) with homebrew content.
DEVICE VERIFIED: NO** — nothing here has run on a physical phone yet; speed (55–60 fps), thermals, battery and real Wi-Fi behaviour are **unmeasured**.

## 1. Architecture

```
 Android app (Kotlin, single activity)
 ├─ SurfaceView (back)  ◄── native GL renderer ◄── raw frames ──┐
 ├─ WebView (front, transparent while a game runs)               │  shared memory file
 │    the approved Multiplayer UX + the FROZEN touch controls    │  (filesDir/av.shm)
 │    └─ DSLinkAndroid bridge: buttons, stylus, picture rects ───┼─► JNI ─► buttons / touch / pause
 ├─ JNI lib (libdslink_jni.so): EGL/GLES2 renderer, AAudio output, input, metrics, private-file validation
 └─ spawns (from nativeLibraryDir, all inside the APK):
      libdslink_gateway.so   the existing DSLink gateway (Go): lobby, session state machine, LAN discovery, netcheck, Download Play assistant
        └─ libdslink_runtime.so  the existing DSLink Runtime (C++), ONE per game, built without FFmpeg
             └─ dlopen libmelondsds_libretro.so  melonDS DS libretro core (open source, pinned upstream commits). No RetroArch.
```

* **No second runtime.** The C++ Runtime, the Go gateway, the web UI and the touch-controls module are the same sources as on the desktop; the Android build only adds a thin front end.
* **SessionMode / RadioTransport / GameStreamTransport** are unchanged: the app runs **Distributed** (`RadioTransport LAN`, `GameStreamTransport NONE`). Hosted needs an encoder the app does not carry yet (see §9).
* The Runtime gained one option, `--shm FILE`: it writes the raw XRGB frame (triple buffer, seqlock), the audio (lock-free ring) and a status block into a memory-mapped file and reads buttons / touch / pause / quit from it. No encoder, no socket, no copy through JavaScript. The same file layout (`runtime/src/shm_layout.hpp`) is used by the Runtime and the JNI library; on the desktop `shm_probe` plays the front end (`tests/runtime/test_shm_frontend.py`).
* The page does not draw the picture. The unchanged touch-controls engine lays the picture out exactly as before and the page hands the two rectangles (visible clip, picture) to the app; the native renderer draws the frame there (GL scissor + quad). The true 2:3 DS proportions, FOCUS views, portrait/landscape and safe areas therefore come from the approved layout engine, not from a copy of it.

## 2. NDK / JNI

* `scripts/build_android_native.sh <abi>` builds everything native with one NDK toolchain call and puts it in `android-app/app/src/main/jniLibs/<abi>/`: core, Runtime, `dslink_cfgtool`, `dslink_romcheck` (executables shipped as `lib*.so`), the JNI library, and the gateway (`GOOS=android GOARCH=arm64 CGO_ENABLED=0`, `-checklinkname=0` for pion's `anet`).
* The executables run from `nativeLibraryDir` (`extractNativeLibs=true`, `useLegacyPackaging`): the only place an app may `exec` from on Android 10+.
* JNI (`com.dslink.app.Native`): `nativeInit/Shutdown`, `nativeSetSurface`, `nativeSetLayout`, `nativeSetVisible`, `nativeButton/Touch/ReleaseAll`, `nativeSetPaused`, `nativeRequestQuit`, `nativeMetrics`, `nativeGrabFrame` (tests), `nativeCheckSysFile` / `nativeInspectRom` (the existing DSLink C++ validation).

## 3. Core loading

The gateway starts `libdslink_runtime.so --core libmelondsds_libretro.so --shm … --link …`; the Runtime `dlopen`s the core, runs `retro_init`, `retro_load_game`, then `retro_run` at the core's frame rate with the same options file, save/system directories and identity as on the desktop. The software renderer is used (OpenGL is disabled upstream on Android).

## 4. Rendering

`renderer.cpp`: EGL + GLES2 on the `SurfaceView`; one texture (256×384 XRGB, uploaded only when a new frame arrives; R/B swap in the shader), linear filter, scissor to the clip rectangle, quad to the picture rectangle, vsync via `eglSwapBuffers`. The renderer is idle while no game is visible.

## 5. Audio

`audio_out.cpp`: AAudio, shared low-latency stream, 16-bit stereo at the core's native rate (~32.7 kHz; AAudio resamples if the device needs it), buffer = 2 bursts. The callback only copies from the shared-memory ring (`ShmReader::pullAudio`): it primes before playing, counts underruns, and jumps ahead if it ever falls more than ~0.27 s behind (no runaway latency). A disconnected route (headset unplugged) re-opens the stream. Audio focus is requested while a game runs; loss pauses emulation, gain resumes it.

## 6. Private files

* ROMs (`.nds`) are added with the page's own file input → system document picker (SAF) → uploaded over loopback to the gateway library in the app's private storage.
* `bios7.bin`, `bios9.bin`, `firmware.bin`: **FILE DI SISTEMA** screen (SAF picker) → copied into the app's private `filesDir/system`, validated by the DSLink C++ code (size, structure, not blank, not swapped) and deleted if invalid.
* Never in the APK, the repository, the CI artifacts or any log (CI fails the build if the APK contains a ROM/BIOS/firmware-like file, and `scripts/check_no_private.py` runs on every push).

## 7. LAN networking and permissions

* Game transport: the verified DS-radio-over-UDP `RadioTransport LAN` (only DS radio frames cross the network).
* Discovery: the gateway's UDP discovery (broadcast to the subnet's directed broadcast address + unicast hints) **plus Android NSD**: a host advertises `_dslink._tcp` (TXT: room id only, never the code/secret), guests browse it and give the resolved IPs to the gateway as hints. A `MulticastLock` is held while the app is in the foreground. The room code alone never authenticates (HMAC under the session secret), as on the desktop.
* The app reads its own Wi-Fi address and broadcast from `ConnectivityManager` (a process cannot enumerate interfaces on modern Android) and hands them to the gateway (`/api/mp/net`), refreshed on every network change. No IP is hard-coded; manual IP is developer-menu only.
* The UI API answers **loopback only** (`DSLINK_UI_LOOPBACK_ONLY`); other phones can reach just the authenticated peer-lobby protocol.
* Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`, `CAMERA` (only when the user taps SCANSIONA QR; the WebView page uses `getUserMedia` on the secure origin `http://127.0.0.1`).

## 8. Lifecycle

| Event | Behaviour |
|---|---|
| rotation | no activity recreate (`configChanges`); the page re-lays out the controls, new rectangles go to the renderer |
| activity recreate | the gateway/Runtime are process-level singletons; the new activity re-attaches the surface and reloads the page, which re-reads the session state |
| pause / app switch / screen lock | all buttons released, emulation paused (`paused` flag in shared memory), audio silent; resume continues. The gateway's 12 s grace window decides whether a longer absence ends the session |
| audio focus loss | pause; regain → resume |
| Back | the page's own Back guard (history) asks before leaving a session; at the home screen the task moves to the background |
| close | leaving from the in-game menu ends the session; finishing the activity stops the gateway and its Runtime (and a parent-death watchdog covers a killed app) |

## 9. Hosted on Android — PARTIAL

* Not available as a **host**: streaming a console to another device needs H.264/Opus encoders (FFmpeg), which the app does not ship yet; `DSLINK_NO_ENCODER=1` makes the automatic choice always Distributed.
* The architecture is ready: the same Runtime can run two consoles and the gateway already serves WebRTC; what is missing is an encoder for the Android build and a device test.
* A guest phone viewing a Hosted game from a desktop host uses the WebView's WebRTC over the existing page code (not tested on a device).

## 10. Developer overlay (off by default)

Developer menu → *Overlay prestazioni*: emulator fps / render fps / frame time (avg, max), CPU of the app and of the Runtime, RAM, audio underruns / xruns / skips / latency, network RTT / jitter / loss (from the gateway's pre-check), battery level and delta, battery temperature and thermal status. Never shown in the normal UI.

## 11. Build / install

```
git submodule update --init --recursive
ANDROID_NDK=/path/to/ndk scripts/build_android_native.sh arm64-v8a
cd android-app && gradle assembleDebug          # JDK 17, Gradle 8.9, Android SDK 34
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
CI (`.github/workflows/android-native.yml`) does exactly this and uploads `DSLink-android-arm64-debug.apk`; a second job runs the instrumented tests on an x86_64 emulator.

## 12. Tests without a phone

| Test | Where |
|---|---|
| shared-memory front end (reader, audio ring policy, input, restart) | desktop, `android-app/native/tests/fe_test.cpp` |
| Runtime `--shm` against the real core (frames, audio, buttons, touch, pause, quit; no FFmpeg, no link) | desktop, `tests/runtime/test_shm_frontend.py` |
| real UI + gateway as the app starts it + fake bridge → shared memory → core (create/join, native display, layout rects, touch controls, stylus, rotation) | desktop, `cloud/tests/mp_native_e2e.mjs` |
| Android-only C++ sources syntax-checked against stub NDK headers | CI `host-tests` |
| pure Kotlin logic | JVM unit tests (`LogicTest`) |
| arm64 APK build, APK content check (no private/ROM files) | CI `apk-arm64` |
| the whole app on an Android emulator (x86_64): Runtime + core from the APK, GL surface, AAudio, JNI input/touch, rotation, pause/resume, recreate, Back, QR address | CI `emulator-x86_64` (instrumented) |

The emulator proves the pipeline, **not** arm64 performance. Mario Party DS (private files) was not run on Android.

## 13. Known limitations

* **Not verified on a phone**: fps, thermals, battery, audio latency and real Wi-Fi/NSD behaviour are unknown. Software rendering (no OpenGL renderer in the core on Android) may not reach 60 fps on every phone.
* Hosted host is not available (no encoder). Internet play, PS1, iOS are not part of this milestone.
* The camera QR scan depends on the WebView's camera support; the room code and PARTITE VICINE are the fallback.
* Background emulation is paused (no long screen-off gameplay).
* Touch UI is the web one inside a WebView: touch latency is the WebView's pointer-event latency plus one JNI call; to be measured on a phone.

## 14. Final device test (max 5 steps)

1. Install `DSLink-android-arm64-debug.apk` on **two** Android phones on the same Wi-Fi; on each, open DSLink → **FILE DI SISTEMA** → pick your `bios7.bin`, `bios9.bin`, `firmware.bin` (each must show ✓).
2. On each phone add your own game from **CREA PARTITA → + Aggiungi un gioco**.
3. Phone A: **CREA PARTITA** → pick the game → **CREA STANZA**. Phone B: **UNISCITI** → tap the room under **PARTITE VICINE** (or enter the code / scan the QR) → **PRONTO**; phone A: **AVVIA PARTITA**.
4. Wait for *Download Play* to finish and the game lobby to appear on both; play a few minutes; rotate, lock/unlock the screen once, switch app and come back.
5. Developer menu (tap the logo 5 times) → **Overlay prestazioni**: note emulator fps, frame time, CPU, audio underruns, RTT, battery delta and thermal state on both phones; report them.
