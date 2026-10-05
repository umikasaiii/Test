# DSLink Multiplayer Bridge — DS multiplayer without RetroArch

`runtime/src/mp_bridge.*` implements the only part of RetroArch's Netplay that the melonDS DS core uses: the libretro
**NETPACKET interface** (`RETRO_ENVIRONMENT_SET_NETPACKET_INTERFACE`). It runs inside one container, over a Unix-domain socket;
the DS wireless packets never touch the network.

## Minimum set of RetroArch services the core relies on (determined from the core and from RetroArch's `netplay_frontend.c`)

| Service | What the core expects | Bridge implementation |
|---|---|---|
| Environment | `SET_NETPACKET_INTERFACE`, `GET_USERNAME` (MAC), core options, `GET_VARIABLE_UPDATE` | LibretroHost ([LIBRETRO_HOST.md](LIBRETRO_HOST.md)) |
| `start(client_id, poll_receive)` | called once the session is established; host is client id 0, joiners get 1, 2, … | host: immediately; client: when the host's HELLO assigns the id |
| `send(flags, buf, len, client_id)` | `client_id` = destination or `0xFFFF` broadcast; flags (reliable/unreliable/flush) accepted and ignored on a reliable stream | routed as below |
| `receive(buf, len, client_id)` | invoked from `poll_receive` (and the frontend) for every inbound frame | called from `pump()` |
| `poll()` | frontend polls the core once per frame **before** `retro_run` | `pump()` before each `retro_run` |
| `connected / disconnected(id)` | peer lifecycle | called on accept / close |
| `stop()` | session end | on peer loss or shutdown |

## Routing (identical to RetroArch)
* A client sends everything to the host. The host delivers to itself if `dest == 0` or broadcast; for broadcast it also relays to every
  client except the sender; for a unicast to another client it relays to that client.
* Frame on the wire: `u16 dest, u16 src, u32 len, payload`; control frames use `dest = 0xFFFE` (HELLO assigns the client id).

## Lifecycle and failure behaviour
Host listens at `--mp-path`; the client connects (retrying up to `--mp-timeout`). If the peer closes, the host reports `disconnected`
and keeps running; a client whose host disappears receives `stop()`. Counters (`mp_in`, `mp_out`, `mp_peers`, `mp_active`) are in the
1 Hz status.

## Evidence
* `test_bridge_parity.py` (**10/10**): the same NETPACKET-only test core under RetroArch Netplay and under the bridge produces the same
  sequence of `START / CONNECTED / RECV / DISCONNECTED / STOP` events, including ordering, host-as-id-0, broadcast relay and leave.
* `test_wifi_bridge.py` (**9/9**): **real DS wireless frames.** Two melonDS instances run homebrew that powers the DS Wi-Fi block from
  ARM7, selects channel 1 and broadcasts 802.11 data frames; melonDS's radio emulation hands each to the netpacket `send`, the bridge
  carries it, the other melonDS receiver delivers it to the other ARM7, which counts it. Checks: both transmit, both receive the
  *other's* frames (sender id), counters keep growing, a lone console never receives (no echo), the receiver stops when the sender
  leaves.
* Browser path: the same observations through WebRTC video (`browser_e2e.mjs`, 19/19) with RetroArch and with the Runtime.
* Regression against `tests/integration/linux_netplay_smoke.sh` semantics: the two-DS test (`test_two_ds.py`, 14/14) asserts the same
  facts as the smoke (both cores start the multiplayer layer, MACs differ and equal DSLink's derivation, host sees 1 peer, no-cartridge client
  joins) plus independence of audio/video/input/touch.

## Not verified
DS Download Play, Mario Party's MP host/client protocol (CMD/REPLY/ACK frames with their timing windows) — these need a ROM using them
and, for the no-cartridge console, the user's bootable DS firmware. They use the same `send`/`receive` path exercised above, but that
is an inference, not a test. Latency/jitter of the bridge under load on Cloudflare hardware is unmeasured.
