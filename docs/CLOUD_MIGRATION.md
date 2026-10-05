# Migration: native V1 -> DSLink Cloud V1

Frozen: `android/` and `ios/` (kept in the repo, not extended; no RetroArch-on-iOS work). Baseline: commit
`2e5ed1d730e786968154bd2a19428994f2cc95f7`.

## Reused as-is (nothing rewritten)

| Native V1 part | Role in Cloud V1 |
|---|---|
| `dslink/` C++ layer | Identity + **distinct MAC per emulator slot** (`DeviceIdentity`, `macFromNickname`), ROM header/SHA check on upload (`inspectRomFile`), firmware validation, session `state machine` per room (Idle→…→InGame), diagnostics + privacy-scrubbed log, compat checks |
| `buildRetroArchConfig/CoreOptions/CommandLine` + `dslink_cfgtool` | generates each slot's `retroarch.cfg`, core options and `-H`/`-C` args (host = slot 1, client = slot 2 with **no content**) |
| `patches/retroarch/0001` | content-less client start / Netplay args (Android part unused on Linux; the CLI path is native RetroArch) |
| `tests/integration/linux_netplay_smoke.sh` | kept as the regression gate; the container smoke test builds on it |
| verified fact: 2 RetroArch+melonDS DS Netplay on Linux, client boots with no cartridge, MACs match | the whole multiplayer link of Cloud V1 |
| upstream pins (`upstream/versions.env`), CI native job | unchanged |

## New

`cloud/` (controller, gateway, web, Dockerfile), capture/inject glue, WebRTC. The difference in the multiplayer model: the
Download Play client is no longer a phone but emulator slot #2 in the container, so Wi-Fi/mDNS/hotspot problems disappear and
latency between the two DS instances is loopback.

## Not reused / dropped for Cloud

mDNS/NSD/Bonjour discovery, beacon, manual IP, local-network permission flows, native UIs, touch overlay (the browser provides
its own pad), per-device firmware import UX (firmware is a **server-side** private asset for slot #2 – see below).

## Open issue that applies to Cloud

Slot #2 (Download Play client) needs *bootable DS firmware* (user's own `bios7/bios9/firmware`). The built-in replacement firmware
cannot reach the DS menu (verified). Until the user supplies them, slot #2 can only be tested without Download Play. They stay
private (mounted volume / secret), never in the image or repo.

## Legal/operational note

Running emulation for users in a cloud adds hosting/legal questions (ROM uploads, redistribution). V1 only accepts a ROM from
the room host for that room's lifetime, stores nothing after the room closes, and ships only a self-generated homebrew test ROM.
