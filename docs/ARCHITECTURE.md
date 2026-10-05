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
