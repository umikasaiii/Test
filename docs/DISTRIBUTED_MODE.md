# Distributed Mode and Hosted Mode (local / LAN multiplayer, no cloud)

Status of this milestone: see the results section at the end. Cloudflare is **not used**; its code stays in the repository as a future/fallback path
(`docs/CLOUDFLARE_DEPLOY.md`, `docs/COST_ESTIMATE.md`).

## The three independent choices

| Concept | Values | Meaning |
|---|---|---|
| **SessionMode** | `DISTRIBUTED` / `HOSTED` | who emulates what |
| **RadioTransport** | `LOCAL` / `LAN` | how the emulated DS radio frames travel between two melonDS instances |
| **GameStreamTransport** | `NONE` / `WEBRTC` | whether encoded video/audio/input travel between devices |

| | RadioTransport | GameStreamTransport | Emulators |
|---|---|---|---|
| **Distributed** (preferred) | `LAN` (DSLink Radio Protocol over UDP) | `NONE` | one per device, each with its own screen, audio, input, MAC |
| **Hosted** (already proven) | `LOCAL` (Unix socket, same machine) | `WEBRTC` (direct on the LAN, no TURN) | both on the host; the guest only receives video/audio of P2 and sends input |

Code: `runtime/src/session_mode.hpp` (the enums and `--session-mode auto|distributed|hosted`), `runtime/src/mp_bridge.*` (one bridge, two transports,
the DS routing logic is shared and untouched), `runtime/src/radio_lan.*` (the LAN transport), `cloud/gateway/lan.go` (per-device session wiring) and the
developer menu in `cloud/web` (**MULTIPLAYER MODE: Automatico / Distribuito / Hosted**). `auto` = distributed first; hosted stays a manual fallback
(no automatic probing: collect data first).

In Distributed Mode the *only* thing that crosses between devices is what the emulated DS Wi-Fi radio sends. No video, no game audio, no input.
(In the PWA the device's own screen is fed by a loopback WebRTC stream from its own runtime; a native app would draw directly. That loopback stream never
leaves the device. See the cost measurements below.) The voice channel of the future DSLink Party is deliberately **not** part of the radio protocol:
it will be a separate channel (own socket/codec/volume) so it never mixes with emulator audio or the DS radio.

## DSLink Radio Protocol (DRP v1) — `radio_lan.hpp`

One UDP datagram = 36-byte header + payload (little endian):

| off | field | notes |
|---|---|---|
| 0 | magic `DSLR` | format check |
| 4 | version | 1 |
| 5 | type | JOIN, WELCOME, DATA, PING, PONG, BYE, REJECT, DISCOVER, ANNOUNCE |
| 6 | peer id | sender's id (host = 0, guests 1, 2, …) |
| 8 | session id | random per host start |
| 12 | sequence | per sender and per peer for DATA |
| 16 | timestamp ms | sender's clock (only differences are used: jitter, RTT) |
| 20 | payload length | validated against the datagram size |
| 24 / 26 | dest / src | the libretro netpacket routing fields, unchanged (`0xFFFF` = broadcast) |
| 28 | tag (8 bytes) | SipHash-2-4 over header+payload, keyed with the per-peer session key |

* **The DS frames are carried byte for byte.** The DS emulated protocol is never modified; the bridge routes exactly like RetroArch's Netplay
  (a client sends to the host, the host relays broadcasts/unicasts) — the same code path as the Unix-socket transport.
* **No retransmission.** A radio medium is lossy; retransmitting would add exactly the latency the DS timing windows cannot afford.
  A small **re-sequencer** (default 8 ms, `--lan-reorder-ms`) restores order when a late datagram shows up inside the window; after that the gap
  is declared lost and anything older that arrives is dropped. Delivery is therefore always in order, possibly lossy — like a radio.
* **Statistics** (1 Hz in the runtime status, `lan`): tx/rx packets and bytes, lost, re-sequenced, late-dropped, duplicates, bad auth/format,
  interarrival jitter (RFC 3550), RTT (PING/PONG every 500 ms, min/max/EWMA), queue depth (datagrams waiting per poll + re-sequencer + impairment queue).
* Datagrams up to 60 000 bytes are accepted (IP fragmentation on a LAN; real DS frames are well below the Ethernet MTU: the Mario Party download uses 292-byte frames).
* Liveness: BYE on exit, and a 4 s silence timeout for crashes (the host reports `disconnected(id)` to the core; a guest's core gets `stop()`).

## Room code, discovery and join (no accounts, no backend)

```
HOST  [CREA PARTITA]  ->  code 482731  (+ join URI / QR payload  dslink://join?c=482731&s=<128-bit secret>&h=192.168.1.20:41233)
GUEST [UNISCITI] 482731 -> DISCOVER (UDP broadcast, port 47531; carries only a keyed hash of the code)
HOST  ANNOUNCE (unicast: data port, session id, name; authenticated with a key derived from the code)
GUEST JOIN  (nonce, proof)  ->  HOST verifies, assigns the lowest free id, answers WELCOME (host nonce)  ->  per-peer session key
```
* **The code is not the only secret.** The session key is derived from a random per-session **secret** and both join nonces. With the QR/URI
  (`dslink://join?...&s=`) the secret travels out of band and the join is strong. With the typed code only, the host wraps the secret with a keystream
  derived from the code: that stops other devices on the LAN and random packets, but a passive eavesdropper who captured the join and brute-forces the
  1 000 000 codes offline could recover the key. The QR path is the recommended one; typed code is the convenience path (documented limit, not hidden).
* Wrong proof → silently ignored and counted; **8 bad joins in 10 s lock joins for 30 s** (throttles online guessing of the code). A full room (3 guests)
  answers REJECT. Every DATA/PING/PONG/BYE datagram is authenticated; unknown peers and forged datagrams are dropped (unit-tested).
* Discovery is a UDP broadcast (255.255.255.255:47531). mDNS was considered: it needs a platform stack on Android/iOS; the broadcast works with plain sockets
  everywhere and is what the runtime already needs. A multicast/mDNS front end can be added later without touching the protocol.
* Fallbacks: QR / URI (`--lan-uri`), and **manual host address** (`--lan-host ip:port`, debug only). The end user normally never sees IP, ports, MAC, core or bridge.

## Network impairment harness

`--lan-impair delay=<ms>,jitter=<ms>,loss=<%>` (runtime flag; test only) applies, to every outgoing DATA/PING/PONG datagram of that runtime, a fixed
delay, a uniform jitter of ±J (reordering happens naturally) and random loss. Both consoles run with the same setting, so the **round-trip added is
2 × delay**. Handshake packets are not impaired (the experiment targets the game). `tests/runtime/lan_matrix.py` runs the real Mario Party DS flow for a list of
cases and records, per case, which phase was reached.

## Tests

| Test | What it proves |
|---|---|
| `runtime/tests/lan_test.cpp` (26 checks) | discovery, join by code and by QR secret, 3 guests with distinct ids/keys, room full, wrong code/secret, brute-force lockout, forged datagrams, ordering/byte-exactness, loss counters, jitter re-sequencing, BYE, timeout |
| `tests/runtime/test_lan_bridge.py` (15 checks) — **TEST A, E** | two Runtime processes + two melonDS exchange real DS wireless frames only over the LAN transport; no bridge socket; RTT; graceful exit/crash/reconnect of the guest; host crash |
| `tests/runtime/mario_dlplay.py [--lan] [--impair …] [--blind-game]` — **TEST B** | real Mario Party DS Download Play: host boot → client firmware → DS menu → Download Play → discovery → handshake → transfer → verify → client boot → game handshake → lobby → in game |
| `tests/runtime/lan_matrix.py` — **TEST C, D** | repeated runs and impairment matrix; per-phase results |

## Platform notes (Android / iOS) — constraints, not workarounds

* **A web page / PWA cannot be a Distributed peer.** Browsers have no raw UDP sockets and no broadcast. Distributed Mode needs the DSLink Runtime as a *native*
  component on every device (Android app, iOS app, desktop). The PWA stays the Hosted-mode client (receives WebRTC video, sends input). This is the biggest consequence of
  choosing Distributed as the preferred mode and it changes the roadmap: the first Distributed devices are native builds, not the web app.
* **Portability of the Runtime.** The runtime is C++17 + POSIX sockets + `dlopen` of a libretro core + FFmpeg for the optional encoder; the LAN transport uses only
  `socket/bind/sendto/recvfrom/poll` and has no Linux-specific API. In a native app the encoder (`--av`) is not needed: the app draws the core's frames directly
  (the PWA-style loopback WebRTC stream is only a desktop/dev convenience). A native build must replace `dlopen` of a `.so` by linking or loading the platform's core binary.
* **Android.** Plain UDP on Wi-Fi/hotspot needs no special permission. Receiving a *broadcast* (the host listening for DISCOVER) needs a `WifiManager.MulticastLock` on many devices;
  unicast (ANNOUNCE, JOIN, data) does not. Hotspot: the phone creating it is usually `192.168.43.1`/`172.20.10.1`-like and broadcast works inside it. The melonDS core supports an ARM64 JIT on Android.
* **iOS.** Local-network access triggers the **Local Network privacy prompt** (`NSLocalNetworkUsageDescription`). Raw UDP *broadcast/multicast* additionally needs the
  `com.apple.developer.networking.multicast` entitlement (granted by Apple on request); the supported discovery mechanism is **Bonjour/mDNS** (`NWBrowser`/`NWListener`,
  services declared in `NSBonjourServices`). So the iOS discovery front end should be Bonjour carrying the same ANNOUNCE data; the DRP datagrams themselves are unicast UDP and need only the prompt.
  Third-party iOS apps cannot use a JIT, so the core must run as an **interpreter**: whether a given iPhone sustains full-speed DS emulation with the interpreter is **not measured here** and is the
  first thing to measure on a real device. Nothing in this design bypasses platform policy.
* **iPhone ↔ iPhone / Android ↔ iPhone.** The protocol is OS-independent; what differs is discovery (Bonjour vs broadcast, bridged by the host answering both) and CPU budget.
  Android HOST ↔ iPhone GUEST puts the heavier role (the host also routes) on the stronger device.
* **Hotspot / client isolation.** Many public/guest Wi-Fi networks isolate clients from each other (no device-to-device UDP): Distributed (and Hosted-LAN) do not work there; a phone hotspot does.

## Results (real Mario Party DS Download Play, two Runtime processes, LAN RadioTransport, melonDS DS 1.4.0 core, no RetroArch, no Cloudflare)

Private files (ROM, BIOS, firmware) stayed outside the repository, image, artifacts and logs; `scripts/check_no_private.py` ran at every step.
Raw per-case counters (no private content): `docs/data/lan_matrix{1..4}.json`; table generator: `tests/runtime/lan_report.py`.

### Success rate (TEST C): 10 / 10
Ten consecutive runs of the whole flow **HOST BOOT → CLIENT FIRMWARE → DS MENU → DOWNLOAD PLAY → DISCOVERY → HANDSHAKE → TRANSFER → VERIFY → CLIENT BOOT → GAME HANDSHAKE → LOBBY → IN GAME**
(Puzzle Mode → Block Star match running on both consoles), 188–217 s each, 0 packets lost, 0 late, 0 bad auth, mean guest RTT 3.6 ms, both consoles ≥ 59 fps.
The in-match "independent D-pad" frame-difference heuristic is not reliable while the playfield animates (it fails identically on the Unix-socket path), so it is not counted;
screenshots of the running match on both consoles were reviewed by eye. In Distributed Mode input isolation is architectural (each device feeds only its own console).
The Unix-socket path (`mario_dlplay.py` without `--lan`) was re-run as the regression oracle: 23/23.

### Impairment matrix (TEST D) — impairment is applied to **each direction**, so the added round trip is 2 × delay

Phase times with delay (client, from the Runtime's Download Play state machine): transfer of the ~690 KB payload takes **12 s at 0 ms, 19 s at 2 ms, 36 s at 5 ms, 65 s at 10 ms, 78 s at 15 ms**
(≈ 2 400 command/reply exchanges × (≈ 5 ms + RTT)); at ≥ 20 ms the transfer does not start.

| Impairment (each way) | Verdict | What happens |
|---|---|---|
| latency 0 – 8 ms (RTT ≤ ~16 ms) | **STABLE** | every phase passes (0 ms: 10/10 through the match; 2, 5 ms: 1/1; 8 ms: 3/3) |
| latency 10 ms (RTT ~20 ms) | **BORDERLINE** | 3 of 4 runs reach the lobby; 1 failed at the game handshake; transfer takes 65 s |
| latency 12 ms | **BORDERLINE / unreliable** | lobby reached in the single run, slow (354 s) |
| latency 15 ms (RTT ~30 ms) | **FAILS** at CLIENT BOOT | discovery, handshake, transfer, verify OK; the downloaded game never boots |
| latency 20 / 30 / 50 / 80 ms | **FAILS** at TRANSFER | discovery and handshake OK, the bulk transfer never starts |
| jitter ±2/±5/±10 ms around 5 ms | **STABLE** (1/1 each) | the 8 ms re-sequencer absorbs it (thousands of datagrams re-sequenced per run) |
| jitter ±10 ms around 0 | **STABLE** (1/1) | |
| jitter ±2 ms around 10 ms | FAILS at game handshake; ±5/±10: at client boot | the *mean* delay (10 ms) is already borderline; jitter on a stable mean is tolerated |
| loss 0.1 / 0.5 / 1 / 2 % | **STABLE** (1/1 each, up to 790 lost frames in a run) | the DS protocol's own retries cover it |
| loss 3 % | **STABLE** (3/3) | |
| loss 5 % | **BORDERLINE** (1 of 3 runs completes) | fails at transfer start or at the game handshake |
| loss 10 % | **FAILS** at game handshake | transfer completes, the game start does not |
| mobile-like: 5 ms ± 3 ms + 1 % loss | **STABLE** (1/1) | |

**Why the latency limit exists (verified in the core source).** `upstream/melonds-ds/src/libretro/net/mp.cpp` blocks, for every command, up to `RECV_TIMEOUT_MS = 25` ms in a busy loop of
`poll_receive` waiting for the peer's reply. A reply that takes longer than 25 ms (RTT + the guest's own polling granularity) is a timeout. That is why the limit is a *round-trip* of roughly 20–25 ms,
independent of bandwidth, and why jitter hurts only when the mean is already near it. The bridge cannot change this; a change would have to be made in the core (a configurable receive timeout) —
**not done**, because it alters the emulated timing and you asked not to modify the emulated protocol arbitrarily. It is the first thing to try if Distributed Mode must work over hotspots with RTT > 20 ms.

Full table (one row per case; "lost / re-seq / late" are the receiver counters of both sides, RTT is measured by the protocol's PING/PONG at bridge-poll granularity):

| case | impair (per direction) | result | discovery | handshake | transfer | verify | client_boot | game_handshake | lobby | in_game | RTT ms (guest, avg/min/max) | lost / re-seq / late | jitter ms | queue max | time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| d2 | delay=2 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 4.5/4/51 | 0 / 0 / 0 | 0.6 | 5 | 135 s |
| d5 | delay=5 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 10.4/10/84 | 0 / 0 / 0 | 0.4 | 5 | 154 s |
| d10 | delay=10 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 20.3/20/197 | 0 / 0 / 0 | 0.5 | 6 | 231 s |
| d20 | delay=20 | FAIL (11/12) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | – | 58.9/40/85 | 0 / 0 / 0 | 6.9 | 6 | 237 s |
| d15 | delay=15 | FAIL (15/16) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | – | 45.4/30/238 | 0 / 0 / 0 | 1.9 | 5 | 384 s |
| d30 | delay=30 | FAIL (11/12) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | – | 60.2/60/85 | 0 / 0 / 0 | 0.5 | 7 | 237 s |
| d50 | delay=50 | FAIL (11/12) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | – | 116.7/100/134 | 0 / 0 / 0 | 2.9 | 7 | 237 s |
| d80 | delay=80 | FAIL (11/12) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | – | 183.6/160/185 | 0 / 0 / 0 | 3.1 | 21 | 237 s |
| j2 | delay=10,jitter=2 | FAIL (16/17) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | – | 50.1/16/176 | 0 / 1362 / 0 | 1.7 | 6 | 397 s |
| j5 | delay=10,jitter=5 | FAIL (15/16) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | – | 50.1/12/66 | 9 / 563 / 9 | 1.7 | 5 | 274 s |
| j10 | delay=10,jitter=10 | FAIL (15/16) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | – | 43.9/4/84 | 259 / 771 / 259 | 7.0 | 5 | 279 s |
| l0.1 | loss=0.1 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 5.0/0/17 | 60 / 84 / 0 | 0.4 | 4 | 122 s |
| l0.5 | loss=0.5 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 0.7/0/43 | 251 / 324 / 0 | 0.5 | 4 | 110 s |
| l1 | loss=1 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 2.6/0/17 | 442 / 596 / 0 | 0.5 | 4 | 106 s |
| l2 | loss=2 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 0.8/0/33 | 790 / 1034 / 0 | 0.4 | 6 | 104 s |
| base#1 | none | **PASS** (24/26, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 2.9/0/35 | 0 / 0 / 0 | 0.9 | 3 | 204 s |
| base#2 | none | **PASS** (24/26, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 3.3/0/17 | 0 / 0 / 0 | 0.4 | 3 | 188 s |
| base#3 | none | **PASS** (24/26, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 3.6/0/17 | 0 / 0 / 0 | 0.4 | 3 | 217 s |
| base#4 | none | **PASS** (24/26, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 4.4/0/17 | 0 / 0 / 0 | 0.4 | 4 | 198 s |
| base#5 | none | **PASS** (24/26, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 4.2/0/17 | 0 / 0 / 0 | 0.3 | 4 | 204 s |
| base#6 | none | **PASS** (24/26, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 4.4/0/43 | 0 / 0 / 0 | 0.4 | 3 | 201 s |
| base#7 | none | **PASS** (24/26, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 2.8/0/66 | 0 / 0 / 0 | 0.4 | 3 | 197 s |
| base#8 | none | **PASS** (24/26, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 2.4/0/18 | 0 / 0 / 0 | 0.4 | 4 | 202 s |
| base#9 | none | **PASS** (24/26, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 3.5/0/18 | 0 / 0 / 0 | 0.4 | 5 | 202 s |
| base#10 | none | **PASS** (24/26, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 4.1/0/17 | 0 / 0 / 0 | 0.4 | 5 | 213 s |
| d10#1 | delay=10 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 20.4/19/51 | 0 / 0 / 0 | 0.5 | 5 | 233 s |
| d10#2 | delay=10 | FAIL (16/17) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | – | 50.3/19/132 | 0 / 0 / 0 | 1.5 | 6 | 304 s |
| d10#3 | delay=10 | **PASS** (22/23, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 20.2/20/67 | 0 / 0 / 0 | 0.5 | 5 | 255 s |
| d12 | delay=12 | **PASS** (21/23, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 42.8/24/51 | 0 / 0 / 0 | 1.9 | 17 | 354 s |
| jb2 | delay=5,jitter=2 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 10.0/7/51 | 0 / 2566 / 0 | 1.4 | 5 | 157 s |
| jb5 | delay=5,jitter=5 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 9.4/1/51 | 51 / 3336 / 51 | 3.0 | 5 | 164 s |
| jb10 | delay=5,jitter=10 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 9.2/0/51 | 1033 / 3659 / 1033 | 6.8 | 5 | 187 s |
| l5 | loss=5 | FAIL (11/12) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | – | 4.3/0/19 | 187 / 315 / 0 | 3.0 | 18 | 148 s |
| l10 | loss=10 | FAIL (16/17) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | – | 16.7/0/20 | 1849 / 2211 / 0 | 1.9 | 4 | 371 s |
| l3#1 | loss=3 | **PASS** (22/23, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 0.5/0/17 | 1487 / 0 / 0 | 0.4 | 4 | 125 s |
| l3#2 | loss=3 | **PASS** (22/23, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 0.9/0/17 | 1453 / 0 / 0 | 0.5 | 4 | 122 s |
| l3#3 | loss=3 | **PASS** (22/23, a screen-hash heuristic check failed) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 0.0/0/17 | 1447 / 0 / 0 | 0.4 | 4 | 122 s |
| l5#1 | loss=5 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 0.5/0/17 | 1831 / 0 / 0 | 0.4 | 4 | 123 s |
| l5#2 | loss=5 | FAIL (16/17) | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | – | 16.7/0/24 | 896 / 0 / 0 | 1.0 | 5 | 352 s |
| d8#1 | delay=8 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 16.1/15/51 | 0 / 0 / 0 | 0.4 | 5 | 198 s |
| d8#2 | delay=8 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 16.0/15/51 | 0 / 0 / 0 | 0.5 | 19 | 199 s |
| d8#3 | delay=8 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 16.1/16/165 | 0 / 0 / 0 | 0.4 | 6 | 200 s |
| jz10 | delay=0,jitter=10 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 6.9/0/51 | 318 / 2921 / 318 | 3.6 | 7 | 138 s |
| m | delay=5,jitter=3,loss=1 | **PASS** (23/23) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | 10.2/5/53 | 277 / 3019 / 0 | 2.0 | 8 | 169 s |


### Disconnect / reconnect (TEST E)
* Bridge level (`test_lan_bridge.py`, 15/15): graceful guest exit (BYE) → host drops it at once; guest SIGKILL → host drops it by timeout (4 s); a fresh guest process discovers, joins and frames flow again, both after BYE and after a crash; host SIGKILL → the guest's core is told the session ended and the guest process stays alive.
* Mario level (`mario_dlplay.py --disconnect-test`): the guest process is killed in the lobby: the host process survives and sees the peer leave; a new guest process re-joins and its radio is live.
* **Known limit:** with the guest gone the melonDS core keeps blocking up to 25 ms per command waiting for replies, so the host console runs at ~7 fps until the session ends (the same core behaviour as on the Unix-socket bridge). Candidate mitigation (not implemented): when the last peer is lost, the bridge ends the multiplayer session (`stop()`) and the app shows "player disconnected".

### Cost: Distributed vs Hosted (real Mario Party DS lobby, this x86 machine, VP8 for the loopback display)

| | Emulation CPU (% of one core) | RSS | Network between devices |
|---|---|---|---|
| **Distributed, per device** (one runtime), PWA-like (encoder for the local screen) | **53 %** avg (max 101 %) | 266 MB | **radio only: ~0.7 Mbps average for the whole session** (host 12.4 MB tx + 4.9 MB rx over ~200 s, incl. the 690 KB download) |
| **Distributed, per device, native-like** (no encoder: the app draws the frames itself) | **38 %** avg | 253 MB | same |
| **Hosted, host device** (two runtimes + two encoders + gateway/WebRTC) | **130 %** + gateway 4 % | 273 MB each | **~4.3 Mbps upstream** (2.3 + 2.0 Mbps video, 2 × 0.1 Mbps audio) |
| **Hosted, guest device** | decode only (no emulation) | – | ~2.1 Mbps downstream, input upstream |

So Distributed moves the cost from one device (130 % of a core + 4.3 Mbps up) to two devices (38–53 % each) and cuts inter-device traffic by ~6×, at the price of a hard **RTT ≲ 16–20 ms** requirement and of native apps (see platform notes).

### Hosted Mode over the LAN (kept, re-verified)
`browser_mario.mjs` (two real browsers, real Mario Party DS, direct WebRTC, no TURN, no Cloudflare): **23/23**, selected ICE pair `host<->host` for both players, 59–60 fps, 0 packets lost, jitter 3–5 ms,
RTT 0–2 ms. `browser_distributed.mjs` (two gateways = two devices + two browsers, Distributed through the gateway, discovery by code): **10/10**. `browser_e2e.mjs` / `pwa_e2e.mjs` regressions: see the milestone report.

### Recommendation
* **Default: Hosted** until the native Runtime exists on the devices; it is the only mode that works from the PWA and it tolerates any RTT (latency only delays input → picture).
* **Distributed** is the preferred mode for **native apps on the same Wi-Fi/phone hotspot when the measured RTT is ≲ 16 ms** (probe with the protocol's PING before starting). Above ~20 ms it must fall back to Hosted.
* `Auto` therefore, once the data justifies it, = *probe RTT → Distributed if ≤ 16 ms, else Hosted*; today it is Distributed-first with a manual Hosted fallback, as requested.
