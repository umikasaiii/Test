# Upstream versions (pinned)

DSLink never builds against a floating "latest". Every revision lives in [`upstream/versions.env`](../upstream/versions.env)
and is enforced by `scripts/check_pins.sh` (run by CI).

| Component | Version | Commit | Role |
|---|---|---|---|
| RetroArch | v1.22.2 | `69a4f0ea1e8aaf442ae4858f2e7f2b31a1776576` | frontend, libretro host, Netplay (git submodule `upstream/retroarch`) |
| melonDS DS (libretro core) | v1.4.0 | `f394adbacb5722ee97c1b37c8064da9a25818310` | Nintendo DS emulation, local-wireless over the libretro *netpacket* API (submodule `upstream/melonds-ds`) |
| melonDS (standalone, fetched by the core) | branch `jtg/fix-uninitialized-opengl` | `16f127dbb587a73371827ce79689c5d237c4b59b` | emulation library; the core's CMake references a *branch*, DSLink pins the commit |

Other core dependencies (libretro-common `fa8a1b5`, glm `6f14f47`, libslirp-mirror `e61dbd4`, fmt `12.2.0`, zlib `v1.3.2`, …)
are pinned by the core's own `cmake/FetchDependencies.cmake` at v1.4.0.

## What was verified before choosing this stack

* RetroArch ships Android and iOS projects and has a mature Netplay stack.
* melonDS DS 1.4.0 targets Android arm64 and iOS arm64, supports `SET_SUPPORT_NO_GAME` (boot to the DS menu without a
  cartridge – required for Download Play clients), derives the emulated MAC from the libretro username
  (`melonds_mac_address_mode = from-username`) and carries DS local wireless over `RETRO_ENVIRONMENT_SET_NETPACKET_INTERFACE`
  (`src/libretro/net/mp.cpp`). Netplay carries those packets between devices.
* The old melonDS 2021 core is **not** used.
* OpenGL is disabled for Android/iOS builds upstream (melonds-ds issue #23): the software renderer is used.

## DSLink's patches to upstream

`patches/retroarch/` (applied by `scripts/apply_patches.sh`, idempotent):

1. `0001-dslink-netplay-launch.patch` – lets the Android front-end start LAN Netplay from an intent extra
   (`DSLINK_NETPLAY=host;PORT;NICK` / `client;IP;PORT;NICK`) and start a core **without content** instead of the menu.
   RetroArch's Android launcher had no way to pass `-H/-C/--port/--nick`.
2. `0002-dslink-android-app.patch` – Gradle flavor `dslink` (applicationId `com.dslink.emulator`, arm64-v8a, min SDK 29),
   DSLink activities/permissions in the manifest, emulator activity in its own process, JUnit + lint wiring.

The melonDS DS core is **not** modified.

Licenses: RetroArch GPLv3, melonDS DS GPLv3, melonDS GPLv3. DSLink as a whole is distributed under GPLv3 (see `LICENSE`).
