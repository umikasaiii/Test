# Multiplayer

## Flow

**Host** – "Crea partita": identity → LAN IPv4 (Wi-Fi/hotspot/ethernet, never VPN/cellular/link-local) → free port (TCP *and*
UDP) → start the DSLink control server (UDP, same port number) → publish the room (mDNS `_dslink._tcp` + UDP beacon on
Android) → waiting room (1/4, players, IP/port on demand). "Avvia gioco" starts RetroArch as Netplay host
(`-H --port N --nick …`).

**Client** – "Unisciti": discover rooms (mDNS + beacon, merged) or enter IP/port manually → DSLink handshake (`HELLO`:
protocol, core version, console mode, mode, ROM hash if any, MAC conflict, capacity) → link test (20 probes: RTT, jitter, loss) →
wait until the host's Netplay TCP port is open → start RetroArch with **no content** as Netplay client
(`-C ip --port N`) → DS boots to the firmware menu → user taps *DS Download Play*.

State machine: `Idle → Preparing → Discovering → Hosting → Joining → Connected → BootingDS → WaitingForDownloadPlay →
Downloading → InGame → Disconnected / Error`; every transition is logged (see `dslink/include/dslink/session_machine.hpp`).

## Wire formats

* Advert (mDNS TXT / beacon): `proto, app, core, room, ip, port, game, session, host, mode, console, rom_sha?, players, max`.
  Strict parser (IPv4, port ≥ 1024, length limits).
* Control channel: `"DSLK" | version | type | seq | len | payload` (UDP): Hello / HelloAck / HelloReject / Ping / Pong / Bye.
* Compatibility is checked by the **host**; rejections are mapped to plain-Italian messages (the technical code stays in the log).

## Latency

The DS wireless protocol is extremely timing sensitive. DSLink measures RTT, jitter (RFC 3550 style) and loss and shows
*Ottima / Buona / Insufficiente*. **The thresholds (10/25 ms RTT, 4/10 ms jitter, 2 % loss) are provisional engineering guesses.**
They have not been calibrated on real devices and must be tuned during the device tests in [TEST_PLAN.md](TEST_PLAN.md).
"Insufficiente" warns but never blocks.

## Discovery per platform

| | Android | iOS |
|---|---|---|
| mDNS / DNS-SD | `NsdManager` (+ `MulticastLock` only while discovering/advertising) | `NWBrowser` / `NetService` (Local Network permission) |
| UDP beacon (fallback) | yes (broadcast) | no – needs the `com.apple.developer.networking.multicast` entitlement |
| Manual IP/port | yes | yes |

Android 16+/17 "local network" permission: `ACCESS_LOCAL_NETWORK` is declared; the app targets API 29 so it is not enforced yet.

## Limits (stated, not hidden)

* Netplay is TCP and relays unreliable DS wireless packets; behaviour on Wi-Fi with client isolation, guest networks, or high
  jitter is poor by nature. Use the same Wi-Fi or one phone's hotspot.
* VPN/tunnels are detected (warning) but not blocked.
* Automatic selection of the host in the DS Download Play list is **not implemented** (v1 fallback: the user taps it).
