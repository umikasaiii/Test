# DSLink

Nintendo DS emulator for **Android and iOS** focused on **simple local multiplayer** (same Wi-Fi / hotspot), first target:
**Mario Party DS** through the real *DS Download Play* flow. It is built on RetroArch 1.22.2 and the melonDS DS 1.4.0 libretro
core; DSLink adds a layer that hides cores, Netplay, IPs, ports and MACs.

> **Honest status (V1, first working version)** — see the table. No device test has been run by the author.

| Item | Status |
|---|---|
| Portable DSLink layer (identity/MAC, discovery, handshake, state machines, diagnostics…) | IMPLEMENTED, 56 native tests (NETWORK TESTED) |
| RetroArch + melonDS DS driven only by DSLink config: host↔client Netplay, MACs, no-cartridge client | EMULATOR TESTED on Linux (integration test) |
| Android app (APK) | IMPLEMENTED; build status: see "CI" below |
| Android on a phone: emulation, touch, multiplayer | NEEDS DEVICE TEST |
| iOS app: UI, Bonjour, local-network permission, handshake | IMPLEMENTED; build status: see "CI" |
| iOS emulator engine linked in | **NOT DONE** (docs/IOS.md) |
| Android ↔ iPhone, iPhone ↔ iPhone, Mario Party DS Download Play | NEEDS DEVICE TEST / blocked on iOS engine |
| Automatic pick of the host in the DS Download Play list | NOT IMPLEMENTED (user taps it) |

CI: <https://github.com/umikasaiii/Test/actions> (workflows `native`, `android`, `ios`).

## Quick start

**Android** — download `DSLink-debug.apk` from the `android` workflow artifacts (or build: [docs/ANDROID.md](docs/ANDROID.md)),
install it.
**iOS** — `cd ios && xcodegen generate`, open `DSLink.xcodeproj`, choose your Team, run ([docs/IOS.md](docs/IOS.md)).

**ROM**: *Apri gioco* → pick your `.nds` (it is copied into app-private storage and header-checked).
**System files** (needed by Download Play *clients*): *Impostazioni → File di sistema Nintendo DS → Importa*, select `bios7.bin`,
`bios9.bin`, `firmware.bin` from **your own** console. They never leave the device.

**Host**: *Crea partita* → wait for players → *Avvia gioco* → in Mario Party DS choose *Multiplayer*.
**Client**: *Unisciti* → *ENTRA* → when the DS menu appears tap *DS Download Play* → pick the game.
If the room is not found: *Inserisci IP manualmente* (host: *Mostra dati connessione*).

Guide for Mario Party DS: [docs/MARIO_PARTY_DS.md](docs/MARIO_PARTY_DS.md) · problems: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Develop

```
git submodule update --init --recursive
cmake -S dslink -B build/dslink && cmake --build build/dslink && build/dslink/dslink_tests     # 56 native tests
tests/integration/linux_netplay_smoke.sh <retroarch> <melondsds_libretro.so> build/dslink/dslink_cfgtool
```
Docs: [architecture](docs/ARCHITECTURE.md) · [multiplayer](docs/MULTIPLAYER.md) · [upstream pins & patches](docs/UPSTREAM_VERSIONS.md) ·
[test plan](docs/TEST_PLAN.md).

## Legal / privacy

* DSLink contains **no** ROM, BIOS, firmware, NAND, keys or other Nintendo files. Bring your own.
* LAN only; no accounts, ads, analytics, telemetry or servers.
* Licensed **GPLv3** (see `LICENSE`). Components: RetroArch (GPLv3), melonDS DS (GPLv3), melonDS (GPLv3); full notices live in
  the upstream submodules and in each distributed binary's source offer.
