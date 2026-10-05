# Architecture

> **Direction (current):** DSLink is its own minimal Libretro frontend, the **DSLink Runtime**, built for the cloud.
> RetroArch is **REFERENCE ONLY**: it stays in the repository (patches, submodule, `cloud/Dockerfile`, the `DSLINK_BACKEND=retroarch`
> gateway backend, the native-app work from commit `c7393f0`) as a diagnostic and parity baseline, and is **not** in the production
> path or in the production image (`cloud/Dockerfile.runtime`).

```
 PWA (browser, installable)
   │  HTTPS / WebSocket                         accounts · friends · presence · library · invites
 Cloudflare Worker ───────────────────────────── D1 (metadata) · R2 (private bytes)
   │                                              Durable Objects: Presence (per user) · GameSession (per session)
   │  session boot: Container API + one-time content ticket
 Cloudflare Container  (cloud/Dockerfile.runtime)
   ├─ gateway (Go, pion WebRTC): signalling, per-slot media tracks, input
   ├─ DSLink Runtime  ─ libretro ─ melonDS DS     (slot 1: Player 1, has the cartridge)
   └─ DSLink Runtime  ─ libretro ─ melonDS DS     (slot 2: Player 2, no cartridge)
        └── DSLink Multiplayer Bridge (Unix socket, inside the container): DS wireless packets never leave it
 WebRTC media: Runtime framebuffer/audio → libx264 / libopus (in-process) → RTP → browser. Inputs back on two DataChannels.
```

| Document | Topic |
|---|---|
| [DSLINK_RUNTIME.md](DSLINK_RUNTIME.md) | the Runtime: process model, CLI, control link, A/V pipeline, metrics |
| [LIBRETRO_HOST.md](LIBRETRO_HOST.md) | which libretro environment calls / callbacks the host implements and how |
| [RETROARCH_PARITY.md](RETROARCH_PARITY.md) | A/B evidence against RetroArch, what RetroArch may not be removed for |
| [MULTIPLAYER_BRIDGE.md](MULTIPLAYER_BRIDGE.md) | DS multiplayer without RetroArch |
| [CLOUD.md](CLOUD.md) | deployment, status table, how to run everything |
| [AUTH.md](AUTH.md) · [FRIENDS.md](FRIENDS.md) · [PRESENCE.md](PRESENCE.md) | accounts, friends/invites, presence |
| [LIBRARY.md](LIBRARY.md) · [STORAGE.md](STORAGE.md) | private game library, R2/D1 layout, saves |
| [SECURITY.md](SECURITY.md) | threat model and privacy rules |

Status vocabulary used everywhere: **CODED · BUILD VERIFIED · LOCAL TESTED · CLOUD DEPLOYED · BROWSER VERIFIED · DEVICE VERIFIED · MARIO PARTY VERIFIED**.
Automated browser tests are never reported as device tests.

## Why a Runtime instead of RetroArch in the cloud

RetroArch is a desktop/mobile frontend: window system, GL/audio drivers, menus, input drivers, playlists. In a container we had to
fake a display, an audio sink and a screen capture per emulator (Xvfb + PulseAudio + ffmpeg x11grab) and inject keys/mouse with
xdotool-style tooling. The Runtime removes the whole detour: the core's framebuffer and audio go straight into an encoder, inputs
are written straight into the core's input state, and the DS wireless packets are forwarded by a ~300-line bridge.
Measured differences: no X server, no audio server, one process per console, ~60 fps pacing with a single thread plus the encoder.

## Layers in the repository

| Path | Role |
|---|---|
| `runtime/` | DSLink Runtime (C++17): libretro host, bridge, A/V pipeline, control link |
| `cloud/gateway/` | Go gateway: WebRTC, rooms, `/api/internal/*` session provisioning; backends `runtime` (production) and `retroarch` (reference) |
| `cloud/worker/` | Cloudflare Worker (TypeScript): API, D1 schema, Durable Objects, R2, PWA assets (`public/`) |
| `cloud/web/` | the original minimal UI (CREA PARTITA / ENTRA) talking directly to a gateway; kept for development |
| `dslink/` | portable C++ library: identity/MAC derivation, ROM check, config generation (also used by the gateway) |
| `patches/`, `upstream/` | RetroArch patches + pinned submodules (reference path) |
| `android/`, `ios/` | native apps — **frozen** |
| `tests/` | runtime tests, A/B parity, homebrew test ROMs (own code, GPLv3) |

## Identity and MAC (unchanged)

`deviceId` → nickname (set of distinct letters from `SHA-256(deviceId+salt)`) → the core derives the DS MAC from the libretro
username (`melonds_mac_address_mode=from-username`). The Runtime passes the same username; tests assert the MAC reported by the core
equals DSLink's derivation under both frontends.

---

# Appendix: the original architecture (native apps + RetroArch, frozen)


Decision: **fork-style integration of RetroArch (option A)**, not a new frontend (option B). RetroArch already provides the
mature pieces that are risky to rewrite: libretro host, Netplay (TCP, handshake, packet relay for the core's *netpacket*
interface), audio/video, touch overlay, saves. DSLink adds a thin layer on top and a minimal, documented patch set.

```
 DSLink UI (Java / SwiftUI)        <- the only thing the user sees
   │  JNI / C bridge
 dslink/  (portable C++17, no deps)  identity & MAC · advert · compatibility · state machine · UDP control channel
   │                                  · beacon · firmware/ROM validation · latency · launch config · diagnostics
   │  generates retroarch.cfg + core options + netplay launch extra
 RetroArch 1.22.2 (patched)  ── libretro ──  melonDS DS 1.4.0
   └── Netplay (TCP, port N)  carries the core's DS local-wireless packets between devices
```

## Layers

* **dslink/** – everything testable without a phone. 56 native tests incl. loopback networking; also compiled into the
  Android (NDK) and iOS apps. See [MULTIPLAYER.md](MULTIPLAYER.md).
* **android/** – Java UI (no XML), NSD/mDNS + multicast lock, JNI bridge, generated touch overlay. Built *inside* RetroArch's
  Android Gradle project through the `dslink` flavor (source sets point at `/android`).
* **ios/** – SwiftUI app, Bonjour (`NWBrowser` + `NetService`), Local-Network permission handling, XcodeGen project.
  Emulator integration: see [IOS.md](IOS.md).
* **patches/** – the only changes to upstream.
* **tests/integration/** – real RetroArch + real core, headless, two processes.

## Process model on Android

The emulator (`RetroActivityFuture`) runs in the `:ra` process; the DSLink session (control server, beacon, mDNS) stays in
the main process. Each game therefore starts from a clean RetroArch state while the host keeps advertising.

## Identity

`deviceId` (128 random bits) is persisted. The nickname handed to RetroArch is a *set of distinct letters* derived from
`SHA-256(deviceId + salt)`, because the core's MAC hash is an order-independent XOR in which repeated characters cancel
("aaaa" collides with "bbbb" – found by the DSLink tests). The derived MAC is verified equal to what the real core reports
(integration test). A residual collision is detected by the host during the handshake (`MAC_CONFLICT`) and the client re-rolls
its salt automatically.

## Privacy / security

LAN only, no accounts, no telemetry, no server. ROMs / BIOS / firmware stay in app-private storage. Logs are scrubbed of paths
and opaque blobs. The control channel is unauthenticated UDP on the local network (same trust model as RetroArch Netplay).


---

# Appendix: DSLink Cloud V1 as first built (RetroArch capture path — now the reference backend)

**The native Android/iOS apps are frozen** (baseline commit `2e5ed1d`). The goal is now a cloud-hosted DS "room":
both players use only a browser; the emulators and the DS wireless link live **inside one Linux container**.

```
 Browser P1 ──WebRTC──┐                                   ┌── RetroArch + melonDS DS #1 (ROM)  ──┐
   input (data channel) ─►                                │     Xvfb :101 · audio sink · input   │ DS wireless
   video/audio ◄── RTP ──┤   gateway (Go, pion WebRTC)    │                                      ├─ packets stay
 Browser P2 ──WebRTC──┤   signalling + rooms + upload  ───┤                                      │ INSIDE the
   input ─►             │                                 └── RetroArch + melonDS DS #2 (no card)┘ container
   video/audio ◄──      └─ controller: spawns/monitors the two emulator slots (DSLink C++ layer, config, patches)
                              Netplay (TCP, 127.0.0.1) between #1 and #2 ← never leaves the container
```

Rules: **no DS multiplayer packet ever travels between browsers**; browsers only send input and receive audio/video.
Each slot is an independent process group: own framebuffer, own audio stream, own input injection (keys + absolute pointer for the
touch screen), own identity (distinct DS MAC via DSLink's `DeviceIdentity`).

Components
* `cloud/controller` – slot supervisor (Python): per slot config from the existing C++ layer (`dslink_cfgtool`), starts
  Xvfb/RetroArch/capture, restarts on failure, exposes status.
* `cloud/gateway` – Go, WebRTC (pion): rooms, join codes, ROM upload, per-peer tracks, input data channel → slot input.
* `cloud/web` – minimal UI: CREA PARTITA / ENTRA, room code/link, `<video>` + on-screen pad + touch.
* TURN/SFU: **Cloudflare Realtime (SFU + TURN) is the intended production relay but could NOT be verified**: the build environment's
  egress policy blocks developers.cloudflare.com, so the current API (sessions/tracks, WebSocket adapter, TURN credentials,
  Containers UDP support) was not read. V1 therefore terminates WebRTC directly in the gateway (works on loopback / public IP /
  any standard TURN) behind an interface that a Cloudflare adapter can implement later. See [CLOUD_MIGRATION.md](CLOUD_MIGRATION.md).

Status vocabulary: CODED / BUILD VERIFIED / LOCAL TESTED / CLOUD DEPLOYED / BROWSER VERIFIED / DEVICE VERIFIED / MARIO PARTY VERIFIED.
