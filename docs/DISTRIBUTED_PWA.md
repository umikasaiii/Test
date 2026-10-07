# Distributed PWA ↔ PWA over a WebRTC DataChannel (Phase 3)

Two players, **two PWAs**, no streaming: each device runs its own melonDS WebAssembly (video, audio, input, touch and save stay local) and **only the DS radio frames** cross a
WebRTC DataChannel. No video/audio stream, no second emulator on the host, no encoder.

```
 device A (HOST)                                                             device B (PLAYER 2)
 melonDS WASM ─ DSLink Radio Bridge ─ WebRtcLink ─ page: RadioPeer ═ DataChannel ═ RadioPeer ─ ring/queue ─ WebRtcLink ─ Bridge ─ melonDS WASM
                                          (worker)      (main thread)  "radio" binary        (main thread)    (worker)
                                                                        "ctl" lobby JSON
 signaling (offer/answer/ICE only) :  /signal/*  (Worker Durable Object or the Node dev server)
```

## DSRadioTransport

`runtime/src/radio_link.hpp` defines the abstract `RadioLink` the Multiplayer Bridge (`MpBridge`) talks to. Backends:

| backend | where | notes |
|---|---|---|
| `LanLink` (DRP/UDP) | native Runtime, Android | existing Distributed Native mode, unchanged (`lan_test` 26/26, CI regressions) |
| `WebRtcLink` | WASM (`wasm/webrtc_link.cpp`) | frames cross to the page through `self.__dslRadio` |

The logical frame `(dest, src, payload)` is the one the native bridge already uses: there is **no second incompatible protocol**; `MpBridge::attachHost/attachGuest` take any `RadioLink`.
`RECV_TIMEOUT_MS = 25` is untouched.

## The receive path and why there are two

melonDS waits for the other console's answers by **spinning inside the emulation call** (up to 25 ms, calling the bridge's `poll()`), and a worker cannot receive a message while it spins.
Therefore frames from the network must already be readable synchronously:

* **SharedArrayBuffer ring** (`radio-ring.js`): the page writes, the worker reads without an event loop. This is the path real multiplayer games need. It requires a cross-origin isolated page
  (COOP/COEP): the Worker/host can send the headers, or on static hosting the service worker adds them (`sw.js`, off by default; the first use of *Gioca con amici* turns it on and reloads once).
* **message queue** (no SAB): frames are queued when the worker's event loop runs, i.e. *between* frames. Fine for plain radio traffic (the homebrew test passes) but **measured NOT sufficient for
  Mario Party DS Download Play** (Phase 4: the DS handshake ends in `ERROR`; see `docs/MARIO_PARTY_PWA.md`). `?radioring=msg` forces it (A/B test). Games like that need the **high-performance
  multiplayer mode** (the SharedArrayBuffer ring), which the lobby requires for Download Play and enables by itself (see below).

`RTCPeerConnection` lives on the main thread (Safari has no `RTCPeerConnection` in workers); the core's frames reach it by `postMessage`.

## DataChannel

* `radio`: **binary**, `ordered:false, maxRetransmits:0` (UDP-like: no head-of-line blocking, no late retransmissions). Verified on the live channel objects in the test.
  `?radiomode=ordered` switches to ordered+reliable for A/B comparison.
* `ctl`: reliable JSON for the lobby only (hello, ready, start, quality, vis, bye). Never radio, ROM, save, BIOS or firmware.
* Radio message = 1 byte `[version<<4 | type]` + payload. DATA: `seq u16, dest u16, src u16, frame…` (7 bytes of header). PING/PONG: `seq u16`. DTLS already authenticates and encrypts.
* Receive re-sequencer: a gap is waited for ≤ 8 ms (`reorderMs`), then counted as lost; late frames are dropped, never replayed.
* **Backpressure** (never blocks the emulator): `bufferedAmount` ≥ 8 KiB → frames wait in a 4-deep queue where the **newest wins** (obsolete frames dropped); ≥ 32 KiB → dropped and the queue cleared.
  The SAB ring drops the new frame when the core is far behind.

## Metrics (dev overlay `?dev=1`, `RADIO` lines; `dslinkPlay.stats().radio`)

RTT last/avg/max and one-way **estimate** (RTT/2, not a measurement), smoothed jitter, frames sent/received/lost/reordered/late, drops by cause (soft/hard/closed/impairment/ring), queue depth/max,
`bufferedAmount` and its max, max re-sequencer hold, ring lag (page→core, absolute epoch clock), core in/out counters, channel mode (`ordered`, `maxRetransmits`).

## Signaling

Minimal and ephemeral: `cloud/signal/room.mjs` (one module) is used by the Node dev/LAN server (`cloud/signal/dev_server.mjs`) and by the Worker's Durable Object (`cloud/worker/src/signal.ts`, route `/signal/*`).
`POST create` → 6-digit code + host token; `POST join` → guest token; `GET events` (SSE); `POST send`; `POST leave`. Only `offer|answer|ice|bye|hello` JSON ≤ 16 KB is relayed; nothing is stored (no ROM, save,
BIOS, firmware, account, traffic log). One guest only (a second gets 409), 10-minute idle TTL, host leaves → room closed, vanished pages are detected (stream close + grace, or 25 s of silence; pages
heartbeat every 8 s), brute-force joins are rate limited (429). Contract: `cloud/tests/signal_contract.mjs` (Node server 20/20, real Worker 17/17).

`?signal=URL` points the PWA to another signaling server (tests, LAN); by default it uses its own origin.

## UX

*GIOCA CON AMICI* → **CREA PARTITA** (choose the game → code + QR) / **UNISCITI** (code, QR scan, or `?join=CODE` from the camera app). Lobby: **HOST / PLAYER 2**, *Connessione… / Connesso / Pronto*,
quality **OTTIMA / BUONA / NON ADATTA** (no numbers). The host measures the link for ~2.5 s on the same channel/settings before START (RTT, jitter, loss on the radio channel); thresholds come from the
native evidence (≈0–8 ms one way good, ≈10 borderline, ≥15 probably a problem) and **recommend, never block**. START needs PLAYER 2 *Pronto*. Never shown: SDP, IP, ports, ICE.
Both devices need the same game (same ROM, or the same cartridge code); **nothing is transferred**, each keeps its own save.

Connection loss, a closed page, Wi-Fi loss or a closed channel → the local game is closed (save kept, no zombie worker/core) and **Connessione persa** is shown. A peer in the background tells the other
side (`vis`) so a silent peer is not mistaken for a lost one (30 s tolerance instead of 4 s); on resume the radio backlog is flushed. A 1.5 s outage is survived (test).

LAN first: STUN only (`?stun=0` disables it), no TURN; if no direct path exists the error is "ICE failed (nessun percorso diretto)".

## Tests

* `cloud/tests/play_wasm_distributed.mjs` — two Chrome contexts through the real UI: WebRTC offer/answer/ICE, DataChannel open, binary/unordered/no-retransmit, quality gate, START, one melonDS per device,
  A→B and B→A radio (homebrew bars: yellow = sent, cyan = received from the other console, square colour = sender), no tracks/senders/transceivers/getUserMedia, local video/audio/input/touch, SAB and
  message-queue paths, short outage, background/resume, disconnect both ways, wrong code, 2 players only, room cleanup. 37/37.
* `cloud/tests/play_wasm_distributed_matrix.mjs` — network fault matrix: 0, 5, 8, 10 ms, 5 ms + jitter, 5 ms + 1 % / 3 % loss, plus a run with the channel ordered+reliable (this only proves the mode switch: the loss is injected above the channel, so retransmission delay is **not** simulated — a real ordered-vs-unordered comparison needs `tc netem`/a real lossy Wi-Fi, not available in CI); connection time, radio
  handshake, duration, drops, `bufferedAmount`. RTT/jitter/round-trip loss come from a 250-ping probe on the idle link (clean: before the emulators load the CPU); in-game RTT on the same machine is dominated by main-thread scheduling and is reported separately. The impairment is **test-only** (JS level, each page delays/drops what it sends, like the native `LanImpair`); report in `/tmp/playdist/matrix.json`.
* `cloud/tests/signal_contract.mjs` — signaling contract (Node and Worker).
* The two homebrew ROMs are two builds of the same program with different console ids (different Wi-Fi MAC); the DS Wi-Fi MAC derives from the user name, so the WASM host sets `DSLinkP1` / `DSLinkP2`
  by role.

Numbers measured in headless Chrome on one machine (loopback, software WebGL, two emulators competing for the CPU) are **not** phone numbers: RTT includes main-thread scheduling. They show the
mechanism works and the impairment is real; they say nothing about Honor or iPhone.

## Not verified (needs two physical devices)

HONOR DISTRIBUTED VERIFIED: **NO** · IPHONE DISTRIBUTED VERIFIED: **NO**. Build for the test: `scripts/package_pwa.sh`, serve `build/pwa` over **HTTPS** (e.g. GitHub Pages; or the Worker which also serves `/signal`),
open `/play/` on both phones on the same Wi-Fi, add the same game, CREA PARTITA on one and UNISCITI on the other. For the SharedArrayBuffer path serve COOP/COEP or let the service worker do it
(first use reloads once). Safari/iOS: `RTCDataChannel` unordered/maxRetransmits support and the background behaviour must be checked on the device.

## HTTPS-testable build (two phones)

1. CI artifact `DSLink-PWA-WASM` (or `scripts/build_wasm.sh && scripts/package_pwa.sh`) → `build/pwa`; serve it over HTTPS (GitHub Pages works). Service workers, `RTCPeerConnection` on phones
   and the camera (QR) need a secure context.
2. Signaling: the Worker serves `/signal/*` (`cloud/worker`, Durable Object `SignalRoom`, same code as `cloud/signal/dev_server.mjs`). A PWA on another origin uses
   `https://HOST/play/?signal=https://WORKER-HOST` (CORS is open on `/signal/*`; nothing but the code, tokens and offer/answer/ICE passes through it).
   LAN alternative with no cloud: `node cloud/signal/dev_server.mjs --static build/pwa --coi` behind an HTTPS tunnel or a local certificate.
3. On both phones (same Wi-Fi): open `/play/`, import the same game, **GIOCA CON AMICI** → CREA PARTITA / UNISCITI. The first use turns on cross-origin isolation (one reload) so the radio uses the SharedArrayBuffer path.
4. Dev overlay: `?dev=1` shows the `RADIO` lines (RTT, jitter, loss, `bufferedAmount`, ring lag).
