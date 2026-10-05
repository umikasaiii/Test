# Architecture

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

# DSLink Cloud V1 (current direction)

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
