# Internet multiplayer + Party Voice (FASE 7)

Status: implemented and tested **on loopback / local coturn only**. Nothing here has been verified on a real Internet path, on a Honor device or on an iPhone.

## Principle: reachability is not latency

A TURN relay makes two players *reachable*; it does not make the link fast enough for the Nintendo DS radio. Observed so far: ~0–8 ms one-way works, ~10 ms is borderline, more fails. So:

1. ICE finds a path (direct host/srflx, or relay).
2. A **preflight** measures that path on the very DataChannel the game will use (RTT, jitter, loss, spikes, reordering, bufferedAmount, stability, a few seconds).
3. The result is classed **OTTIMA / BUONA / LIMITATA / NON ADATTA**, scaled by the game's **network profile**.
4. The mode is chosen (DIRECT DISTRIBUTED or TURN DISTRIBUTED). A session that is likely to fail is never started silently.

The normal UI shows words only ("Connessione: OTTIMA", "Diretta" / "Tramite relay"). Numbers live in the dev overlay (`?dev=1`: GAME NETWORK and VOICE blocks).

## ICE configuration (server side, short lived)

`GET /api/realtime/ice` (authenticated, rate limited 40 / 10 min) returns `iceServers`, `expiresAt`, and `policy` (`relayAvailable`, `stunOnly`, `providers`). The PWA never holds a TURN user, password or secret; it re-requests when the credentials expire. Anonymous / signed-out use gets public STUN only and the UI says that a relay is not available.

| Worker var | Meaning |
|---|---|
| `DSLINK_STUN_URLS` | comma separated `stun:` URLs (default: public STUN) |
| `DSLINK_TURN_URLS` | comma separated `turn:` / `turns:` URLs of your TURN server |
| `DSLINK_TURN_SECRET` | **secret** shared with coturn `static-auth-secret` (`use-auth-secret`) |
| `DSLINK_TURN_USERNAME_MODE` | `timestamp-user` (default, `<expiry>:<opaque tag>`) or `timestamp` |
| `DSLINK_TURN_TTL_SECONDS` | credential lifetime (default 3600, 300 … 86400) |
| `DSLINK_TURN_PROVIDER` | label only |

Credential = `base64(HMAC-SHA1(secret, username))`, username `<expiry>[:tag]` (coturn REST scheme). Cloudflare Realtime TURN keys (`TURN_KEY_ID` + `TURN_KEY_API_TOKEN`) are also understood by `turn.ts`.

coturn minimal config: `use-auth-secret`, `static-auth-secret=<DSLINK_TURN_SECRET>`, `realm=<your domain>`, `fingerprint`, `no-multicast-peers`, deny private ranges (`denied-peer-ip`), TLS for `turns:` on 443/5349.

## Game network profile

Part of the catalog metadata (`game_metadata.network_profile`, table `cloud/web/play/netprofiles.json`, resolved by `profileOf`): `LOW_LATENCY_REQUIRED` (Mario Party DS, product codes `AMP*`, and DS Download Play), `NORMAL`, `UNKNOWN` (default). Thresholds are scaled ×1 / ×2.5 / ×1.6 respectively; nothing is hardcoded on a title in the lobby logic. The profile also sets the longest tolerated outage (6 s / 14 s / 9 s).

## Choices shown to the user

"Questa connessione potrebbe non essere abbastanza veloce per il multiplayer Nintendo DS." with **RIPROVA** (repeat the measurement), **CONTINUA COMUNQUE**, and **USA MODALITÀ HOSTED** — shown only when `window.DSLINK_HOSTED.available` (a native Hosted host exists on the device). The pure PWA shows the limit and nothing else: there is no cloud emulator.

## Reconnect

* Short loss: grace window, then ICE restart (the host offers, the guest asks through signaling). No radio backlog is kept while the link is down.
* Wi-Fi ↔ mobile / NAT rebinding / resume from sleep: `networkChanged` pauses the liveness watch, restarts ICE, re-measures.
* On an Internet session (ICE servers present) a silent path is healed by ICE restart instead of ending the game at once; `netGraceMs` (14 s) and the profile's outage limit end it cleanly with a clear message when the gap makes the DS session impossible.

## Party Voice

Independent of the emulator: a party survives starting and leaving a game. Backend: `parties`, `party_members`, `party_invites` in D1 (migration 0004) and the `PartyRoom` Durable Object, which relays *signaling only* (roster, mute flag, SDP/ICE); the Cloud never carries, records, stores or transcribes audio.

* Roles: owner (CREA PARTY, KICK; leaving hands ownership to the longest-standing member), members (ACCETTA / RIFIUTA / ESCI).
* 2–8 logical members. Transport `P2PMesh` behind the `VoiceTransport` seam (an SFU can replace it later). **The mesh is verified at 2, 3 and 4 peers only; 5–8 is NOT verified** and no paid SFU is required.
* Opus speech tuning (mono, ~24 kbit/s, 20 ms, FEC, DTX), echoCancellation / noiseSuppression / autoGainControl with fallback.
* The microphone is requested **only** when entering / activating the party, never at app start; denied / unavailable → listen-only with RIPROVA MICROFONO.
* MUTE, DISATTIVA AUDIO PARTY, individual volume, speaking indicator, optional ducking "RIDUCI AUDIO GIOCO DURANTE VOCE" (never changes the game volume permanently).
* The voice-quality gate is separate from the DS gate: a slow DS link does not stop the voice.
* Mobile background: persistence is not promised; on return the app detects dead connections and rebuilds them.
* Presence shows "NEL PARTY" / "IN GAME · title" only. Blocked users cannot invite or join; invites, ICE requests and joins are rate limited.

## Tests

| Test | What |
|---|---|
| `cloud/worker/test/internet.test.ts` | ICE endpoint (no secret leaked, ephemeral credentials, STUN-only fallback), profiles, party REST/authz/blocks/rate limits |
| `cloud/tests/netquality_unit.mjs` | classification + mode selection |
| `cloud/tests/play_internet_e2e.mjs` | ICE direct, STUN binding, TURN relay, DS radio direct / relay, network change, ICE restart (coturn killed and restarted), matrix 0/5/8/10/20/40 ms, RIPROVA / CONTINUA / HOSTED |
| `cloud/tests/play_party_e2e.mjs [--relay]` | party 2/3/4, mute, volume, speaking, owner/kick, reconnect, party during and after a game, mic denied, voice over TURN |
| `cloud/tests/turn_local.sh` | local coturn on loopback (needs `coturn`) |

Not verified: real NAT traversal across networks, real-world latency of any TURN provider, Mario Party DS over the Internet, Honor, iPhone / Safari party voice.

## Deploy

`deploy.yml` reads repository **variables** `TURN_PROVIDER`, `TURN_URL`, `DSLINK_STUN_URLS` (optional) and the repository **secret** `TURN_SECRET`; the secret is stored as the Worker secret `DSLINK_TURN_SECRET` and never appears in the repository, the PWA or the logs. Without them the deployment works, STUN only, and the UI says the relay is unavailable.
