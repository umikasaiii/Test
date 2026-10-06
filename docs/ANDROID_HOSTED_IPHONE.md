# Hosted V0 — Honor 200 (Android host) + iPhone (Safari guest)

Status: built and tested on the desktop and on an Android *emulator* (software codecs), homebrew test ROMs in CI; Mario Party DS tested on the desktop with the private files.
**DEVICE VERIFIED: NO. HONOR 200 VERIFIED: NO. IPHONE SAFARI VERIFIED: NO.** Nothing in this document says how fast it is on the Honor 200: speed, thermals, battery, the
hardware encoder's behaviour and Safari's behaviour are unmeasured until you run the procedure in §10.

## 1. What it is

```
HONOR 200 (DSLink APK)                                                       iPHONE (Safari / Home-Screen web app)
 ├─ DSLink gateway (Go, in the APK)      ◄── http://<honor>:8765/guest/ ──── guest page: join by code or QR, lobby, game screen,
 │    web guest session ("/g/<id>/")      ◄── WebRTC signalling (/ws) ─────   the FROZEN touch controls (UI Touch V1)
 ├─ DSLink Runtime #1 + melonDS #1 (Mario Party DS cartridge)                     ◄── video P2 (H.264) + audio P2 (Opus), direct on the LAN
 │     └─ P1: shared memory → native GL + AAudio on the phone               ──► buttons + touch P2 (WebRTC data channel)
 └─ DSLink Runtime #2 + melonDS #2 (NO cartridge: DS menu → Download Play)
       ├─ the DS wireless link between #1 and #2 is LOCAL (Unix socket bridge inside the phone) — real Nintendo DS Download Play
       └─ video: MediaCodec H.264 (hardware when the SoC has it)  + audio: libopus  → gateway → WebRTC → iPhone
```

* The iPhone does **not** emulate anything and never receives the ROM: it gets video and audio and sends buttons and touch. The Download Play transfer happens between the two consoles inside the Honor.
* Reused unchanged: the Runtime, the melonDS core, the bridge, the Download Play driver (including the automatic retry), the multiplayer session state machine, room codes, QR, lobby, reconnect, the WebRTC stack (pion), UI Touch V1 (the `cloud/worker/public/controls` directory is byte-identical to the approved commit), private-file validation.
* New: the Android stream encoder, browser guest sessions, the guest page, the LAN exposure rules.

## 2. The stream encoder (Runtime, Android build)

| piece | what | where |
|---|---|---|
| video | NDK `AMediaCodec` H.264 (`video/avc`, the system's default encoder: the SoC's hardware block on a phone), Baseline profile, CBR, 2.5 Mbit/s, keyframe every 2 s, no B-frames, low-latency/real-time hints (ignored where unsupported), BT.601 limited range | `runtime/src/mediacodec_codec.cpp`, `mc_encoder.cpp` |
| input to the codec | `ByteBuffer` in the layout the codec reports (NV12 or I420, its own **stride** and **slice height**, read from the input format) — no vendor-specific assumption; the RGB→YUV conversion is a small C++ loop (≈1 ms for a DS frame) | `enc_common.cpp` |
| picture size | **256×384** = the DS picture as it is (no upscale: nothing to convert or encode twice); the gateway/Runtime accept `--out-w/--out-h` (e.g. 512×768) if the guest's screen needs it | `main.cpp` |
| decoupling | a one-slot mailbox: the emulation thread copies the frame and returns; if the encoder is behind, the newer picture replaces the older one and `dropped` counts it. The encoder runs on its own thread | `mc_encoder.cpp` |
| keyframes | the first picture, every 2 s, and whenever the browser asks (PLI/FIR → gateway → `L_KEYFRAME` → `request-sync`). **SPS+PPS are prepended to every keyframe**, so a guest that joins late or reconnects can start decoding | `mc_encoder.cpp` |
| audio | the core's audio (≈32 728 Hz stereo) → cubic resampler → 48 kHz → **libopus** (pinned submodule `upstream/opus`, v1.5.2), 20 ms packets, 96 kbit/s, low-delay | `opus_stream.cpp`, `enc_common.cpp` |
| numbers | encoder fps, encode latency (avg/max), bitrate, conversion time, dropped frames, keyframes, codec name and whether it is hardware — in the Runtime's status (`enc`) and in the developer overlay | `av_pipeline.cpp` |
| self-test | `libdslink_runtime.so --encoder-selftest`: 150 synthetic frames → the same encoder → the access units are **decoded again with the device's decoder** and the four quadrants are compared (colours, plane order, stride). One JSON line. Developer menu → *Test encoder Hosted (MediaCodec H.264)* | `mediacodec_selftest.cpp` |

Software fallback: if the device has only a software H.264 encoder (the emulator does), the same code runs on it; the codec name in the self-test and in the overlay says so (`hardware:false`). There is **no** FFmpeg/x264 in the Android build.

## 3. Browser guests (how the iPhone joins without a second gateway)

A browser cannot run the DSLink gateway, so each browser guest gets **its own guest session inside the host's gateway** (`cloud/gateway/mpweb.go`): a normal multiplayer session with `web=true` that talks the same lobby protocol to the host session over loopback. The browser only sees the same `/api/mp/state` document as every other screen; it never handles an address, a port, a token or any cryptography (WebCrypto does not exist on an `http://` page anyway).

* URL prefix `/g/<id>/…`: `<id>` is a random handle the browser keeps in `localStorage`. Only `state`, `join`, `ready`, `cancel`, `reset`, `lobby-return` exist there.
* Join proofs are unchanged: the 6-digit code or the QR's secret is verified by the host's session (HMAC), with the same lockout after repeated bad proofs. A wrong code shows "Codice partita non valido o scaduto." inline. A second browser finds the room full.
* **A browser guest always gets Hosted** (`decideMode`), whatever the network check says; its network row is hidden (there is no radio link to measure).
* If the browser stops talking to the gateway (Safari in the background, tab closed) for 5 s, its session stops the heartbeat the host watches; the host shows *Riconnessione…*; the browser has 12 more seconds to come back (same session, the stream is rebuilt), otherwise the host ends the game with **"Connessione con il giocatore persa."**, both consoles stop, the encoder and the WebRTC peers are released. Sessions of browsers that never come back are dropped after 90 s.

## 4. The guest page (iPhone)

`http://<honor>:8765/guest/` — the multiplayer page in *guest mode* (`cloud/web/mp/index.html` + `mp.js`; no second UI):

* only **Unisciti** (no create, no library, no system-files, no nearby list, no scanner, no IP anywhere); the join screen has the 6-digit field;
* **QR**: the host's lobby shows a QR whose content is a web address (`http://<ip>:8765/guest/?c=…&s=…&r=…&u=…`). The iPhone's **Camera app** reads it and opens Safari on the guest page, which joins by itself (the secret is removed from the address bar right after). DSLink on another phone reads the same QR. Join by code always works;
* lobby → PRONTO → host AVVIA → *Download Play* steps → game screen with the **frozen UI Touch V1** controls (portrait and landscape layouts, L/R, D-pad 8 directions, ABXY, Select/Start/Menu, stylus on the bottom screen, safe areas) and the leave menu;
* **Add to Home Screen**: `manifest.webmanifest` + `apple-mobile-web-app-capable` + `apple-touch-icon`; opened from the icon it runs standalone (no Safari bars). No service worker (it needs HTTPS and the page does not need to work offline);
* iOS autoplay: the video starts **muted** (the only autoplay iOS allows) and the first touch on the controls — a user gesture — switches the sound on;
* if the WebRTC link drops while the session is still IN_GAME the page rebuilds it (every 2 s, and when the page becomes visible again).

### Secure context (HTTPS) — decided, not ignored

The guest page is served over **plain HTTP on the LAN**. What iOS Safari needs a secure context for, and what this page does:

| feature | needs HTTPS on iOS? | here |
|---|---|---|
| `RTCPeerConnection`, WebSocket to the host | **no** (only `getUserMedia` needs it) | used; works over http |
| page camera for scanning a QR (`getUserMedia`) | **yes** | **not used** by the guest page: the iPhone's own Camera app scans the QR and opens the address. The in-page scanner stays hidden for guests. Join by code is the primary path |
| service worker | yes | not used |
| Add to Home Screen | no (works for http sites with the iOS meta tags) | used |
| `crypto.subtle` | yes | not used (the host's gateway does the proofs) |

A self-signed certificate would force the user through a Safari warning and a profile installation, which is worse than http on a private LAN. Real HTTPS (a trusted certificate per Honor) is not part of this V0.

## 5. LAN exposure (Android app)

The gateway listens on all interfaces, but with `DSLINK_UI_LOOPBACK_ONLY=1` another device can reach only: the peer lobby protocol (`/api/lobby/*`), the stream signalling (`/ws`, token), `/api/config`, a browser guest's own session (`/g/<id>/…`) and the static files a guest needs (`/guest/`, `/mp/mp.js`, `/mp/mp.css`, `/mp/vendor/`, `/controls/`). The host's own UI (`/mp/`, library, create, start, dev menu, snapshots) answers the app itself only. `mp_hosted_phone_e2e.mjs` checks this from a non-loopback address.

## 6. WebRTC on the LAN

Direct, no TURN, no Internet, no Cloudflare. The gateway's host candidates advertise the Wi-Fi/hotspot address the app reports from ConnectivityManager (`DSLINK_WEBRTC_ADVERTISE=1`), because native code on modern Android cannot enumerate network interfaces reliably. Safari hides its own address behind an mDNS name; the gateway still connects because the connectivity checks arrive from the iPhone's real address (peer-reflexive candidate).

## 7. Honor hotspot (iPhone joined to the Honor's own hotspot)

Supported by design, **not verified on a device**: with no Wi-Fi *network* (the phone is the access point) ConnectivityManager has nothing to report, so the app looks for the tethering interface's LAN address through Java's interface enumeration (mobile data, VPN and Wi-Fi Direct interfaces are skipped) and re-checks every 4 s. If the platform hides that interface there is no address to put in the QR: join by code still works once the iPhone opens `http://192.168.43.1:8765/guest/` (the usual Android hotspot gateway address; the Honor's may differ — Settings → hotspot shows it). Please report what you see in §10.

## 8. Developer overlay

Developer menu → *Overlay prestazioni* (never shown in the normal UI): console 1 fps, render fps, CPU (app and **all** Runtimes), RAM, audio underruns/xruns/skips, thermal state, battery delta, network RTT, and in Hosted: **console 2 fps**, guest connected + **WebRTC round trip**, **encoder codec (hardware/software), encoder fps, encode latency, bitrate, dropped frames**.

## 9. What was tested, and what that does and does not prove

| test | where | proves |
|---|---|---|
| `enc_test` (283 checks) | CI host job | colour conversion into NV12/I420 with arbitrary stride/slice height, the 48 kHz resampler, Annex-B helpers, mailbox/keyframe/SPS-PPS/drop logic against a fake codec, libopus encode → decode level |
| Go tests | CI | web guest join by code and QR address (wrong code/secret refused, room full, Hosted forced, browser-gone → lobby reopens), LAN guard rules, QR formats |
| `mp_hosted_phone_e2e.mjs` (31 checks) | CI + local | the whole phone-host + browser-guest flow on one machine with the gateway started as the app starts it and a non-loopback "iPhone" browser: LAN rules, join by code/QR, Hosted, two consoles, WebRTC connected, **video ≈60 fps, audio 50 pkt/s**, input/touch isolation (P2 only / P1 only), rotation, brief absence + reconnection, absence for good → "Connessione con il giocatore persa.", cleanup. **VP8** is used there because Playwright's Chromium cannot decode H.264 |
| instrumented tests on an Android **emulator** (x86_64, API 30) | CI | the real APK stack: MediaCodec encoder self-test (software codec), Hosted flow with the app's WebView as the browser: WebRTC connected, H.264 + Opus packets arrive, encoder numbers, browser buttons reach console 2 only, browser gone → session ends, both consoles stop |
| Mario Party DS Hosted V0 (private) | local only | create → join (guest page) → start → Download Play between the two consoles → client boot → Mario's lobby → match, 3 runs |

Not proven: anything about the Honor 200's hardware encoder (the emulator uses the software codec), Safari's H.264 decode and autoplay, iOS mDNS ICE, real Wi-Fi or hotspot, speed, heat, battery. Those are what §10 measures.

## 10. Real test, Honor 200 + iPhone (5 steps)

1. **Honor**: install `DSLink-Hosted-iPhone-V0-arm64-debug.apk` (CI artifact of the final commit). Open DSLink → *FILE DI SISTEMA*: import your `bios7.bin`, `bios9.bin`, `firmware.bin` (they stay in the app's private storage). Put the Honor and the iPhone on the **same Wi-Fi** (or turn on the Honor's hotspot and join it from the iPhone).
2. **Honor, encoder check** (30 s, optional but useful): tap the logo 5 times → Developer → *Test encoder Hosted (MediaCodec H.264)*. Expect `"pass":true`, a codec name that does **not** start with `c2.android.`/`OMX.google.`, `"hardware":true`, `encFps` ≈ 60, `decode` `ok` (or `skipped_vendor_format`). Send me that line.
3. **Honor**: *MULTIPLAYER → CREA PARTITA* → add Mario Party DS from your files → *CREA STANZA*. The lobby shows a 6-digit code and a QR.
4. **iPhone**: open the **Camera**, point it at the Honor's QR, tap the banner → Safari opens DSLink and joins by itself (or open `http://<honor address>:8765/guest/` and type the code). Optional: Share → *Add to Home Screen*, then open it from the icon. Tap **PRONTO**. On the Honor tap **AVVIA PARTITA**: both consoles start, Download Play runs by itself, Mario Party DS opens on both. Tap the iPhone screen once to switch the sound on.
5. **Play Mario Party** and watch the Honor's overlay (Developer → *Overlay prestazioni*): P1 emu fps, **P2 emu fps**, encoder fps / latency / bitrate / dropped, RTT, CPU, thermal. Note: the first minute vs. after 10 minutes (throttling), whether the iPhone's picture and sound keep up, input lag, and what happens if you lock the iPhone for 5 s (expect *Riconnessione…* then back) and for 30 s (expect "Connessione con il giocatore persa." on both).

## 11. Known limitations

* Nothing is device-verified (see the top). The 55–60 fps targets are targets, not results.
* The iPhone cannot play in the background; locking it or switching apps for more than ≈17 s ends the session.
* HTTP only (no certificate); the page's own QR scanner is disabled for guests (use the Camera app or the code).
* Safari-specific behaviour (H.264 profile negotiation, mDNS candidates, muted autoplay) follows the standards and Chromium's behaviour but is untested on iOS.
* Honor hotspot address detection is best-effort (§7).
* One browser guest per room; up to four idle guest sessions are kept in memory.
* Hosted needs both consoles + the encoder on one phone: the Honor 200 headroom is unknown until measured.
