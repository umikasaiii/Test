# Mario Party DS — Download Play PWA ↔ PWA (Phase 4)

Real DS Download Play between two PWAs, over the Phase 3 WebRTC DataChannel. **HOST**: Mario Party DS ROM + BIOS + firmware (+ `refs.json` for the menu assistant). **GUEST**: BIOS + firmware only, **no cartridge**.
The game reaches the guest the way it does on real DS hardware: the host's emulated console transmits it over the emulated Wi-Fi (Download Play) and the guest's firmware receives it. The DataChannel carries
**only the wireless frames the core produces**; the ROM never goes through signaling, the DataChannel as a file, HTTP or any server. Nothing private is in the repository, the PWA package, the APK, CI artifacts or logs.

```
HOST PWA  melonDS WASM (Mario, direct boot) ─ bridge ─ WebRtcLink ─ page ═ DataChannel "radio" ═ page ─ ring ─ WebRtcLink ─ bridge ─ melonDS WASM (NO cartridge, firmware boot) GUEST PWA
          └ DlAssist (host): Multiplayer > Single-Card Play > OK                                                        DlAssist (guest): DS menu > Download Play > pick game ┘
```

## What was built

* **No-cartridge guest** (`wasm/dslink_wasm.cpp`, `emulator.worker.js`): `dsl_start` with an empty ROM boots the firmware menu (`melonds_boot_mode = native`); the DS Wi-Fi identity differs per role (the MAC derives from the user name).
* **Download Play diagnostics in WASM**: the same passive state machine the native Runtime uses (`runtime/src/dlplay_diag.cpp`, frame classification only): `dl_state` (HOST_ADVERTISING, GAME_DISCOVERED, DOWNLOAD_HANDSHAKE/TRANSFER/VERIFY, CLIENT_GAME_BOOT, GAME_HANDSHAKE, LOBBY, IN_GAME), counters, timings. Dev overlay `DL` line.
* **Assistant** (`cloud/web/play/dlassist.js`): the JavaScript port of the native product's driver (`cloud/gateway/mpdriver.go`). It compares the page's own picture with the user's reference screens (a 16x16 average-hash,
  **bit-identical** to the native one, unit-tested) and touches the console through the same input path as the touch controls. Waits are scaled by the console's real speed (the DS menus advance per emulated frame).
  *Host* uses `refs.json`; the *guest needs no references at all*: it is driven by the DS state machine (the radio starting to scan, the game being discovered, the transfer states) plus the fixed touch points of the firmware menu.
* **refs.json** (host only, validated, never sent anywhere, never logged — error messages name screens, not content). Missing → the lobby shows "Manca refs.json" **before START**, keeps the room (peer connected) and offers the import **inside the lobby**.
* **Lobby**: the guest's lobby decides: same game in the library → regular Distributed (Phase 3); no copy of the game but BIOS+firmware present → **Download Play** (host and guest both told); neither → clear message. The host's START additionally checks system files, `refs.json` and the high-performance mode.
* **Metrics/timeline** (`assist.timeline`, result files): DISCOVERY_START, HOST_ADVERTISING, GUEST_DISCOVERED, DOWNLOAD_BEGIN, DOWNLOAD_BYTES/PROGRESS, DOWNLOAD_COMPLETE, GUEST_BOOT, GAME_HANDSHAKE, MARIO_LOBBY, GAMEPLAY (names, times, byte counters only).
* **Radio frame trace** (`player.radioTrace()`, no payload): time, direction, DS packet type, length, 802.11 frame-control, DataChannel→core wait; `tools/mp_trace_summary.py` summarises it **and the native Runtime's `DSLINK_MP_TRACE`** with the same fields for the comparison below.

## The radio receive path: the message queue is NOT enough (measured)

Phase 3 left this open. Mario Party DS answered it. Same two PWAs, same ROM, same firmware, same menu automation; only the receive path differs:

| receive path | result |
|---|---|
| **SharedArrayBuffer ring** (page cross-origin isolated) | discovery ✓, transfer ✓ (~20 s), guest boot ✓, game handshake ✓, **lobby ✓ on both screens**, minigame ✓ |
| **message queue** (`?radioring=msg`) | discovery ✓, handshake started, then the DS state machine goes to **ERROR** (≈15 s after the handshake); the transfer never completes |

Why: melonDS waits for each reply by spinning inside the emulation call (up to `RECV_TIMEOUT_MS = 25` ms, **unchanged**), and a worker cannot run its `onmessage` while it spins. With the queue every reply is
consumed only *between* frames → the command times out. In the failing run the host transmitted 3098 commands and its guest received all of them, but the replies reached the host's core only after the waits had expired
(first command→reply pair measured at 112 s). With the ring the page writes the frame where the spinning core reads it:

| host: command→reply (TX cmd → next RX reply, ms) | p50 | p90 | p99 | max | share > 25 ms |
|---|---|---|---|---|---|
| Native Distributed (UDP/LAN, 0 ms) | 0.2 | 0.6 | 10.1 | 33 | 0 |
| **PWA ring** (DataChannel, same machine, emulators at ~30 fps) | 1.7 | 9.9 | 14.7 | 55 | 0.0002 |
| PWA message queue | the run fails in the handshake | | | | |

The ring needs no allocation per received frame (the core copies straight from the shared buffer), carries a per-record page timestamp (queue age: avg 0.03 ms, max ≈15–45 ms in a 70 s Mario transfer — these maxima are the page
being busy), drops with an explicit counter when the core is far behind, and is flushed on resume. The transmit side (core → page) uses `postMessage`; its worker→page latency is measured (`tx->page` in the overlay)
and was not the limiting factor, so no transmit ring was added.

**DSLink therefore requires the high-performance multiplayer mode for Download Play**: the lobby says "Modalità multiplayer ad alte prestazioni richiesta" and refuses START (host) / PRONTO (guest) if either device
is not cross-origin isolated. On static hosting the service worker turns it on and reloads **once**, at the last moment before the network is used, with the intent saved (see the next section). The no-SAB path remains for homebrew.
It is **not** presented as sufficient for Mario.

## QR + isolation flow

Isolation (COOP/COEP) comes from the host's headers or, on static hosting, from the service worker (`sw.js`, opt-in flag kept in a cache entry). The reload happens in `prepare()` (`friends.js`) right before the room is created or joined:

* **Create**: the chosen game is saved; after the reload the room is created with it — no questions asked again, the room did not exist before the reload.
* **Join by typed code**: the code is saved; after the reload it joins.
* **QR** (`…/play/?join=CODE`, opened by the camera app, even on a device that never saw DSLink): the page waits for its service worker, enables isolation, reloads (the intent holds the code) and lands in the right room without
  showing the code form; the code is removed from the URL after use. One reload only (no loop); if isolation is impossible the plain path is used and Download Play is refused with the message above.

Tested in `cloud/tests/play_wasm_qr_isolation.mjs` (plain static host without COOP/COEP): 11/11.

## Results (private run, headless Chrome, one machine)

Table below (generated by `tools/mario_pwa_report.py` from the private result files; times are wall-clock in this sandbox, see the limits). Honest limits of these numbers:

* two melonDS instances with software WebGL share one sandbox CPU: they run at **~30 fps** (10 fps with a distant peer, because every command waits for its reply inside the frame), so durations (download ≈ 20 s vs 12 s native) are
  longer than a phone would show; `RTT` is the DataChannel probe, dominated by main-thread scheduling;
* the impairment is the JS-level one of Phase 3 (each page delays/jitters/drops what it **sends**, per direction), the same semantics as the native `LanImpair`; its jitter is `0…J` ms, not `±J`;
* the *gameplay* run (Puzzle Mode → Block Star) proves a real match runs on both consoles and that each console's own input moves its own hand and the mirror on the other; the soak (330 s) kept the multiplayer session alive
  with the DS state never `ERROR`, no deauthentication and no emulation stall. The match itself may reach its "Continue" screen inside that window, so this is **not** a measurement of 5 uninterrupted minutes of active play.

## Not verified

HONOR MARIO VERIFIED: **NO** · IPHONE MARIO VERIFIED: **NO**. The HTTPS-testable build is the same as Phase 3 (`docs/DISTRIBUTED_PWA.md`, "HTTPS-testable build"); the private files are imported on the phones by hand
(BIOS/firmware on both, ROM + `refs.json` on the host only). Safari/iOS needs `SharedArrayBuffer`, i.e. cross-origin isolation through the service worker, and a device test of the whole flow.

## Private test

`cloud/tests/play_mario_private.mjs <private-dir> [--game --soak=330] [--msg] [--delay=ms --jitter=ms --loss=pct] [--late-refs]` — never run in CI (needs the user's files; reads them from `<private-dir>`, results go to
`<private-dir>/out/pwa_<name>/`, no payload). CI runs only the homebrew tests (`dlassist_unit`, `play_wasm_qr_isolation`, Phase 3 suites).

## Run table (one run per row; delays are per direction, so the added round trip is twice the value)

| run | impairment | radio rx | checks | lobby | discovery->download ms | download ms | download->boot ms | boot->lobby ms | RTT avg ms | jitter ms | lost h/g | host cmd->reply p50/p99/max ms | >25 ms | guest turnaround p50/p99 ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| m0 | - | SAB | 10/10 | PASS | 14169 | 20334 | 31757 | 103570 | 2.2 | 2.0 | 0/0 | 1.67/14.88/25.44 | 0.0001 | 0.23/4.65 |
| m10 | delay=10 | SAB | 6/10 | FAIL | 8590 | 33822 | None | None | 26.4 | 6.3 | 0/0 | 22.28/26.14/30.61 | 0.044 | 0.63/5.39 |
| m2 | delay=2 | SAB | 10/10 | PASS | 14157 | 32450 | 53468 | 188194 | 8.2 | 2.0 | 0/0 | 6.05/19/73.03 | 0.0005 | 0.21/4.73 |
| m5 | delay=5 | SAB | 10/10 | PASS | 8607 | 49380 | 74747 | 276257 | 12.9 | 2.9 | 0/0 | 12.08/23.51/45.44 | 0.0026 | 0.22/4.76 |
| m8 | delay=8 | SAB | 10/10 | PASS | 14149 | 76450 | 77895 | 316824 | 18.4 | 2.2 | 0/0 | 18.16/25.14/34.06 | 0.0127 | 0.33/5.06 |
| mj | delay=5,jitter=3 | SAB | 10/10 | PASS | 8601 | 56242 | 77586 | 290179 | 14.3 | 2.2 | 0/0 | 14.74/24.25/30.04 | 0.0035 | 0.24/4.74 |
| ml1 | delay=5,loss=1 | SAB | 10/10 | PASS | 8604 | 58069 | 77046 | 284660 | 12.4 | 1.6 | 0/0 | 12.2/24.49/29.01 | 0.0051 | 0.26/4.96 |
| r3msg | - | msg | 5/10 | FAIL | None | None | None | None | 1.9 | 1.1 | 0/0 | 112801.44/112801.44/112801.44 | 1 | 0.39/1.38 |
| r4sab | - | SAB | 10/10 | PASS | 8607 | 20817 | 15030 | 45071 | 4.9 | 4.5 | 0/0 | 1.75/14.74/54.76 | 0.0002 | 0.26/4.83 |

Reading it (PWA over the DataChannel vs the native Distributed numbers of `docs/DISTRIBUTED_MODE.md`, which are *stable* up to 8 ms, *borderline* at 10 ms and *fail* from 15 ms):

| delay each way | native Distributed | PWA ↔ PWA (this phase, 1 run each) |
|---|---|---|
| 0 ms | PASS (10/10) | **PASS** — lobby confirmed on both screens; Download Play transfer ≈ 20 s (native 12 s) |
| 2 ms | PASS | **PASS** (transfer ≈ 32 s, native 19 s) |
| 5 ms | PASS | **PASS** (transfer ≈ 49 s, native 36 s) |
| 8 ms | PASS (3/3) | **PASS** (transfer ≈ 76 s) |
| 10 ms | BORDERLINE (3 of 4 reach the lobby) | **FAIL in this run**: discovery, handshake and transfer complete (≈ 34 s of transfer), the downloaded game does not start; same shape as the native borderline failures |
| 5 ms ± jitter (0…3 ms) | PASS | **PASS** |
| 5 ms + 1 % loss | PASS (up to 3 %) | **PASS** |

The PWA's margin is therefore about the same as native (8 ms each way ≈ 16–20 ms RTT), measured here with a single run per row — not enough to claim a statistically sound margin. Under delay the
emulators slow down (≈ 8–10 fps at 8–10 ms each way, because every command waits for its reply inside the frame), which is why the assistant scales its waits by the console's real speed.

Unexplained session ends: in three earlier runs (5, 8 and 10 ms each way, before the assistant's waits were scaled by the console speed) a session ended by itself some minutes after the lobby (a console
left the game; the host/guest page went back to the library). They did not recur in the final runs of the table (the 5 and 8 ms runs passed), but the cause was **not** established: it may be the core requesting a
shutdown after a wireless error under slow/laggy conditions. The worker now reports the core's own log tail and the DS state with every shutdown (`player.shutdownInfo`), so the next occurrence will carry its reason.
