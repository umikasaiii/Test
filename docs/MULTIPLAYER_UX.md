# Multiplayer UX (LAN / local, no cloud)

**Cloudflare used: NO.** Everything in this document is LAN/local: no Worker, D1, R2, TURN, Container, account or cloud friends.
The earlier Cloudflare code stays in the repository as a future/fallback path; nothing here depends on it.

The user sees a game flow, never IPs, ports, MACs, sockets, cores, Runtime, WebRTC or radio-bridge terms:

```
HOST   DSLink → Multiplayer → CREA PARTITA → game from the local library → lobby with CODE + QR
GUEST  DSLink → Multiplayer → UNISCITI → code / QR / PARTITE VICINE → lobby → PRONTO
HOST   AVVIA PARTITA → "Preparazione… Avvio Nintendo DS… Ricerca partita… Download Play… Avvio partita…" → game
```

Screens: `docs/img/multiplayer-flow.png` (full flow) and the individual `docs/img/mp-*.png` shots.

## Where it lives

| Piece | File |
|---|---|
| UI (mobile-first, same visual language as the touch controls; the in-game screen *is* the frozen touch-controls module) | `cloud/web/mp/{index.html,mp.css,mp.js}` served by the gateway at `/mp/` |
| Session state machine, lobby, start flow, supervision | `cloud/gateway/mpstate.go`, `mpsession.go`, `mpops.go`, `mpflow.go` |
| LAN discovery + network pre-check | `cloud/gateway/mpnet.go` |
| Download Play assistant (the DS-level setup a person would do with the stylus) | `cloud/gateway/mpdriver.go` |
| Local game library | `cloud/gateway/mplib.go` |
| HTTP surface | `cloud/gateway/mpapi.go` (`/api/mp/*` UI↔gateway, `/api/lobby/*` gateway↔gateway) |
| Peer-loss policy in the emulator process | `runtime/src/main.cpp` (`--mp-peer-grace-ms`, `L_MP_STOP`) |

Each device runs its own gateway (+ Runtime). The browser/app on a device talks only to *its own* gateway; the two gateways talk to each other on the LAN.

## Create / join

**Create** (host): choose a game from this device's library (games are added with *Aggiungi un gioco*; the files stay on the device under `DSLINK_LIBRARY`, never in the repository)
→ the gateway creates the room: a 6-digit **room code**, a random 128-bit **session secret**, an internal room id and a temporary host name.
The lobby shows the code and a **QR code** (real, generated with the vendored MIT `qrcode-generator`; decoded in the tests with `jsQR`).

**Join** (guest), in priority order:
1. **PARTITE VICINE** — rooms found by LAN discovery are listed automatically (game title + host name, nothing else). Joining one needs the **host's approval** (ACCETTA / RIFIUTA on the host).
2. **Code** — 6 digits; discovery finds the host by a hash of the code (the code is never broadcast).
3. **QR** — camera scan (`BarcodeDetector`, or `jsQR` where it does not exist); the payload `dslink://join?c=CODE&s=SECRET&h=HOST:PORT&r=ROOM&u=PORT` carries everything needed to join securely **without ever showing an address**. It carries no ROM, BIOS or firmware, nothing private (tested).
4. Manual host address — **developer menu only**.

*Camera limit (documented, not hidden):* browsers allow `getUserMedia` only on secure origins (HTTPS or localhost). On plain `http://<lan-ip>` the scan button explains that the camera is unavailable and asks for the code. The QR generation, the parser and the join flow are complete and tested (`__mp.joinPayload`); a native app or an HTTPS origin makes the scan work.

## Discovery, session auth, game transport — three separate concerns

| | Mechanism |
|---|---|
| **Discovery** | UDP broadcast on port 47532 → `ANNOUNCE` {room id, title, host label, HTTP port}. Nothing secret. The same port answers echo probes for the network check. |
| **Session auth** | HTTP join with an **HMAC-SHA256 proof**: under the QR secret (QR join), or under a key derived from the code (code join). The code alone never completes a join *and* never authenticates the game: the room code, the secret and a per-guest token are handed to the guest's console only at START, wrapped (AES-GCM) under the guest's private token. 8 bad proofs in 10 s lock the room for 30 s. A full room answers "already full"; the same device joining twice gets the same answer. |
| **Game transport** | Distributed: DSLink Radio Protocol over UDP (`docs/DISTRIBUTED_MODE.md`), authenticated with the same secret. Hosted: WebRTC straight to the host on the LAN (no TURN). |

Threat-model limit (same as the radio protocol): a code-only join protects against other devices and random traffic; a passive eavesdropper who captured a code join and brute-forces the 10⁶ codes offline could learn the secret. The QR path keeps the secret out of band.

## Session states (one source of truth: `/api/mp/state`)

`IDLE → CREATING_ROOM → WAITING_FOR_PEER → NETWORK_CHECK → CONNECTED → READY → STARTING → DOWNLOAD_PLAY → IN_GAME`,
with `JOINING` (guest), `RECONNECTING`, `ENDED`, `ERROR`. The transition table lives in `mpstate.go`; **illegal transitions are refused and logged** (unit-tested: e.g. `IDLE→IN_GAME`, `READY→IN_GAME`, `ENDED→IN_GAME` are impossible). The UI contains no session logic: it renders the state document and posts user intents (`create`, `join`, `ready`, `start`, `cancel`, `lobby-return`, `reset`).

## Lobby

Game, mode (*Automatica / Distribuita / Hosted*), HOST and PLAYER 2 with their status (✓ Pronto / ✓ Connesso / In attesa… / Chiede di unirsi), network quality, notices. Host is ready by definition; the guest presses PRONTO; **AVVIA PARTITA** is enabled only when the guest is connected, the network was checked and the guest is ready. Milliseconds are never shown (they are in the developer menu).

## Network pre-check

When a guest connects, it sends **40 timestamped UDP probes at 20 ms** to the host and measures reachability, **median RTT, jitter (mean absolute successive difference) and loss** — several samples, never a single ping. Conservative V1 criteria (desktop; to be recalibrated on phones — the measured Distributed limit was ≈ 16 ms of bridge round trip):

| | Rule | UI | Mode (Automatic) |
|---|---|---|---|
| GREEN | reachable, median RTT ≤ 12 ms, jitter ≤ 4 ms, loss ≤ 2 % | **Ottima** | Distribuita |
| YELLOW | in between | **Buona** | Hosted — "Per maggiore stabilità verrà utilizzata la modalità Hosted." |
| RED | unreachable, RTT > 18 ms, jitter > 10 ms or loss > 5 % | **Non adatta** | Hosted — same message |

## Distributed vs Hosted

AUTOMATIC prepares Distributed only on a GREEN network, otherwise Hosted. **No complex fallback during a game.** The developer menu (`/mp/?dev=1`, or 5 taps on the logo) offers *Automatico / Distributed / Hosted* and shows metrics, the plan and the session log.
* **Distributed:** each device runs its own console; only the DS radio crosses the LAN; the host's console also advertises the radio room, the guest's console connects to it.
* **Hosted:** both consoles run on the host (local bridge); the guest's device runs none and receives video/audio of Player 2 over a direct WebRTC connection and sends its input.

## Start (what the assistant does)

Host: launch the console(s) → (Distributed) publish the radio port → **Download Play assistant**: game menu → Multiplayer → wait for the guest; guest: firmware → DS menu → DS Download Play → pick the game → transfer → both reach the game's lobby. The assistant "looks" at the console like the user (a 16×16 average-hash of the Runtime's frame vs per-game reference screens, `DSLINK_PROFILE_REFS`, **kept outside the repository**) and touches it through the same input path as the touch controls. The host's OK is **state-aware and repeated quickly**: the assistant waits a few seconds after the transfer for the other console to finish verifying, taps OK, and taps again every few seconds only while the host still shows the player list and the other console has not started booting (a tap that is ignored must never leave the other console waiting long enough to be dropped). Games without a profile (and the homebrew tests) skip it. If the Download Play setup does not complete (an emulated DS can occasionally stall at the hand-over), the host **redoes the whole setup once, quietly** — consoles restarted, same session and lobby, the guest device follows when it sees the attempt counter grow — and only a second failure is shown to the user. (A tests-only hook, `DSLINK_MP_TEST_FAIL_FIRST=1`, forces the first attempt to fail to prove this path in both modes.) Steps shown to the user: *Preparazione partita… / Connessione al secondo giocatore… / Avvio Nintendo DS… / Ricerca partita… / Download Play… / Avvio partita…* — no technical log.

## Disconnection / reconnection

* Lobby: a guest that stops answering for 5 s frees the slot ("L'altro giocatore si è disconnesso."); a host that closes the room tells the guest ("L'host ha chiuso la partita.").
* In game: the loss of the peer (heartbeat or radio link) → **RECONNECTING** ("Connessione persa. Riconnessione in corso…"). If the peer is back inside **12 s** the game resumes in the same session (tested with a frozen guest). Otherwise the session **ends in an orderly way**: the consoles are stopped, process groups killed, sockets and scratch files released, and the user sees **"Connessione con il giocatore persa."** with **TORNA ALLA LOBBY** (host: same room waiting again; guest: joins the same room again) and **CHIUDI PARTITA**.
* The emulator process also protects itself: with `--mp-peer-grace-ms 10000` the host ends the multiplayer session by itself 10 s after the last peer vanished (core `stop()`), so the console cannot stay at ~6 fps blocked on missing replies. `RECV_TIMEOUT_MS = 25` in the melonDS core is **not** modified.

## Errors (user language; technical detail stays in logs / developer menu)

| Cause | Message |
|---|---|
| no host found | Non riesco a trovare la partita. |
| UDP/HTTP blocked between devices | I dispositivi non riescono a comunicare sulla rete Wi-Fi. |
| wrong / expired code | Codice partita non valido o scaduto. |
| room full | La partita è già al completo. |
| too many bad tries | Troppi tentativi. Riprova tra qualche istante. |
| peer left / lost | L'altro giocatore si è disconnesso. / Connessione con il giocatore persa. |
| host closed | L'host ha chiuso la partita. |
| high latency for Distributed (forced) | La rete non è abbastanza veloce per la modalità Distribuita. |
| missing firmware on a device | Mancano i file di sistema Nintendo DS (firmware) su questo dispositivo. |

## Mobile, resume, rotation, Back

Touch targets ≥ 56 px (audited ≥ 44 px on 360×800, 390×844, 412×915, 430×932 and landscape), no horizontal scroll, text ≥ 12 px, safe-area paddings. Rotation re-lays out the lobby and the (frozen) touch controls. A reload re-reads the server state, so the session continues. **Back** inside a session asks for confirmation instead of leaving silently; short background/foreground changes keep the session (the *gateways* hold the heartbeat, not the page).

## Tests

`cloud/gateway/mp_test.go` (Go: state machine, classification, QR payload, wrap, netcheck against impaired echo, discovery by code tag, lobby create/join/ready/duplicate/QR/forged QR/nearby approval/cancel/leave/expiry/lockout) · `cloud/tests/mp_ux_e2e.mjs` (two browsers, two gateways, only through the UI: home, library, create, QR decode, nearby, invalid code, join, network check, ready, start, Distributed and Hosted flows, rotation, crash → clean end → back to lobby → play again, short outage → resume, host cancel, guest leave, Back/refresh/background, viewports) · `cloud/tests/mp_mario_ux.mjs` (PRIVATE: real Mario Party DS through the new flow only) · `tests/runtime/test_lan_bridge.py` (peer-grace policy).

## Results (this milestone, LAN only, Cloudflare not used)

| Check | Result |
|---|---|
| Go gateway tests (state machine, lobby, QR, discovery, pre-check, auth/lockout/expiry) | pass |
| UX end to end (two browsers, two gateways, only through the UI) | 37/37 |
| Mario Party DS through the new UX, Distributed (code / QR / nearby) | 3/3 |
| Mario Party DS through the new UX, Hosted (code / QR / nearby) | 3/3 |
| Peer-loss policy: host fps during the stall → after the grace window | ~7 fps → ~60 fps, session ended by itself |
| Old local bridge oracle, LAN bridge suite, controls, PWA, browser e2e | 23/23, 18/18, 118/118 + 195/195, 35/35, 19/19 |
| Touch controls diff against the approved baseline | empty |
| Private-file guard | clean |

Device verified: **NO** (no physical phone was used). The camera QR scan needs a secure origin (HTTPS or localhost) in the browser; on plain `http://` LAN pages the QR code is shown for scanning with the phone's camera app, and the code or *Partite vicine* is the fallback.

Test environment note: the sandbox Chromium has no H.264, so the legacy PWA/browser tests run the gateway with `DSLINK_VIDEO_CODEC=vp8` (the CI Chrome uses its H.264 default).
