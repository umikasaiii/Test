# PlaySphere V1 — architecture (what exists today)

This document describes only what is implemented and running in the repository at the FASE 9 commit. Nothing planned is listed here as if it existed. Earlier documents (`ARCHITECTURE.md`, `PLAYSPHERE_MULTICORE_ARCHITECTURE.md`, `PLAYSPHERE_PS1.md`, `CLOUD.md`, `DISTRIBUTED_PWA.md`, `INTERNET_VOICE.md`) go deeper on each part.

```
                       ┌──────────────────────────── the PWA (cloud/web/play, static, offline capable) ───────────────────────────┐
 browser storage  ◄──► │ shell.js (Home, Libreria, detail, theme, nav)  play.js (library, saves, Cloud sync)  cloudui / friends /   │
 (OPFS / IndexedDB)    │ partyui (screens)       GameProfile → RuntimeResolver → CoreRegistry → GameSession                            │
                       │                          ├─ NDS adapter  (Player) ─► emulator.worker.js ─► melonDS DS  (WebAssembly)         │
                       │                          └─ PS1 adapter  (PS1GameSession) ─► ps1.worker.js ─► PCSX-ReARMed (WebAssembly)      │
                       │ controls (frozen touch UI, layouts "nds" and "ps1")   audio worklet + shared audio ring   video / render worker│
                       │ net.js + session.js + radio-peer.js (WebRTC DataChannel, DS radio only)    voice.js (Party mesh, WebRTC audio)│
                       └────────────────────────────────┬───────────────────────────────────────────────────┬────────────────────────┘
                                                        │ HTTPS (cookie session) / WebSocket (ticket)        │ WebRTC (direct, STUN, TURN)
                                          ┌─────────────▼───────────────── Cloudflare Worker (cloud/worker) ───────┐   other player's PWA
                                          │ auth · friends · social · presence (DO) · invites · party (DO) · library │
                                          │ files + saves (R2) · realtime/ICE (TURN credentials) · signal (DO rooms) │
                                          └──────────────┬───────────────────────────┬──────────────────────────────┘
                                                         │ D1 (SQLite)               │ R2 bucket (private)       coturn (TURN, deployed separately)
```

## Client (cloud/web/play)

| Part | Files | Role |
|---|---|---|
| App shell | `index.html`, `playsphere.css`, `shell.js`, `theme-init.js` | Five destinations (Home, Libreria, Multiplayer, Amici, Profilo) + Impostazioni; bottom bar / side rail / sidebar; themes; first run; install, offline and update hints; Game detail sheet; friendly errors and loading states; routing by hash (`#/home`, `#/games`, …) with back-button behaviour and last-tab restore. It sits on top of the screens below: every older screen id still exists. |
| Library | `play.js`, `storage.js`, `gameprofile.js`, `ps1import.js`, `ps1bios.js` | Import (DS file; PlayStation `.cue`+`.bin`, `.chd`, `.iso`, `.m3u`), one library for both systems, per-game folder `library/<id>/` (rom, meta, save, states). OPFS with IndexedDB fallback; streaming import of large discs; partial imports are rolled back. |
| Multi-core | `coreregistry.js`, `runtimeresolver.js`, `gamesession.js`, `inputprofile.js` | The platform of a game decides the core; the user never chooses one. A new system = one registry entry + one adapter + one WebAssembly build. |
| Players | `player.js` (DS), `ps1session.js` (PS1), `emulator.worker.js`, `ps1.worker.js`, `video.js`, `render-worker.js`, `audio-worklet.js`, `avpipe.js`, `gamepad.js`, `ps1ui.js` | Cores run in module workers; audio through an AudioWorklet ring; video through WebGL2 (main thread or OffscreenCanvas worker); physical gamepads through the Gamepad API; PlayStation extras (analog sticks, states, disc swap) injected into the frozen in-game menu. A watchdog closes a session whose worker stopped producing frames. |
| Cloud client | `cloud.js`, `cloudui.js`, `cloudfiles.js`, `friends.js` | Account, profile, friends, presence, invites, library metadata; files and saves with hash-verified resumable uploads, revisions and conflict handling. |
| Multiplayer | `session.js`, `net.js`, `netquality.js`, `radio-peer.js`, `radio-ring.js`, `dlassist.js` | Room by code / QR / invite; WebRTC DataChannel carrying only DS radio frames; ICE with STUN/TURN; quality gate; Download Play assistant. |
| Party Voice | `voice.js`, `partyui.js` | Peer-to-peer audio mesh, owner / kick / mute / volume, survives game start and stop. |
| Service worker | `sw.js` | One build = one cache (shell, JS, CSS, both cores together), update waits for the next open or the user's AGGIORNA ORA, never replaces code under a running game; the PlayStation core is cached lazily and atomically. |

## Cloud (cloud/worker)

Cloudflare Worker + Durable Objects (presence, signalling rooms, party rooms) + D1 (accounts, sessions, friends, library metadata, invites, file index) + R2 (private files and saves). Routes by file: `auth.ts`, `friends.ts`, `social.ts`, `presence.ts`, `playinvites.ts`, `party.ts`/`partyroom.ts`, `library.ts`, `files.ts`, `realtime.ts`/`turn.ts`, `signal.ts`. Serves the PWA as static assets with the security headers of `scripts/package_pwa.sh`.

## Runtime and legacy modes (kept, not extended in this phase)

`runtime/` is the libretro host shared by the WebAssembly cores, the Android app and the desktop runtime. `cloud/gateway` (Go) and `android*/` carry the earlier Hosted / Native Distributed modes and their tests; they still pass their CI jobs. PlaySphere's own multiplayer is the PWA↔PWA path above.

## Data and where it lives

| Data | Where | Leaves the device? |
|---|---|---|
| Game files, BIOS, firmware | browser storage | Only to the user's own private R2 space if Cloud sync is on (PlayStation disc images never) |
| Saves, memory cards | browser storage | Revisioned in the user's Cloud if enabled; save states stay local |
| Favourites, recents, theme, preferences | `localStorage` (`ps.*`) | Favourites are mirrored to the Cloud library entry when logged in |
| Account, friends, library metadata | D1 | yes (it is the account) |
| Party / game audio | WebRTC, peer to peer | never stored |

## Legacy identifiers kept on purpose (`LEGACY_DSLINK_IDENTIFIER`)

Repository, npm package and Worker names, D1 / R2 / Durable Object names, `dsl_session` cookie, `dslink.*` storage keys, `dslink-play-*` cache names, `DSLINK_*` environment variables, `dslinkPlay` test object. Renaming them needs a migration (cookies, caches, data) and is not part of V1.

## What is NOT in V1

PlaySphere PC Remote (no Windows host, no remote game session, no streaming), other systems (GB/GBC/GBA/NES/SNES/N64/PSP appear only in the registry's `FUTURE_PLATFORMS` and are never shown), PlayStation disc upload to the Cloud, save-state sync, a real Sony BIOS test, mobile performance claims.
