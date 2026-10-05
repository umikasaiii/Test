# Mario Party DS

Mario Party DS uses **Single-Card Download Play**: the host runs the game, other DS consoles boot *without a cartridge*,
open *DS Download Play*, receive the game over the DS's local wireless and join. DSLink reproduces this; it does **not** load the
ROM on every device.

No ROM, BIOS or firmware is part of this repository or of any test.

## What you need

* Host: your own `Mario Party DS.nds` (a dump you made).
* **Every client**: your own DS `bios7.bin`, `bios9.bin`, `firmware.bin` (Impostazioni → File di sistema Nintendo DS → Importa;
  select all three at once, DSLink recognises them by size). The built-in replacement firmware cannot boot the DS menu, so
  without these files a Download Play client cannot work (the core reports this; verified by the integration test).
* Same Wi-Fi (or one phone's hotspot).

## Manual acceptance checklist (the only test that proves the goal)

1. Host: install DSLink, *Apri gioco* → pick the ROM → *Crea partita*. See "In attesa di giocatori… 1/4".
2. Client(s): *Impostazioni* → import the 3 system files → *Unisciti* → the room "Stanza di <host>" appears → *ENTRA*.
   Expect "Ping LAN: X ms – Qualità: …" and "In attesa che l'host avvii il gioco…".
3. Host: *Avvia gioco*. In Mario Party DS choose **Multiplayer** and wait on the search screen.
4. Client: when the DS menu appears, tap **DS Download Play**; Mario Party DS should be listed → select → download → start.
5. Both reach character / mode selection.
6. Record in the diagnostics screen: RTT, jitter, and any error. Repeat Android↔iPhone both ways.

Expected-to-be-fragile points (unverified): timing of the Download Play handshake over Netplay; whether the firmware
version matters; first-boot DS menu language/date prompts on the client.

---

# Mario Party DS on the DSLink Runtime — REAL Download Play, verified locally

**Status: MARIO PARTY LOCAL VERIFIED** (Europe, Rev 1, A8TP). Real ROM + the user's DS Lite firmware/BIOS, two DSLink Runtimes + melonDS DS 1.4.0, **no RetroArch**,
the second console **has no cartridge**. The private files live outside the repository (`/home/user/private`; `private/`, `*.nds`, `bios*.bin`, `firmware*.bin`, `*.srm`,
`*.ppm` are git-ignored, `scripts/check_no_private.py` guards every commit and CI). Nothing private is printed, committed, put in an artifact or an image.

## What happened, step by step (screenshots reviewed by eye, radio states from the Runtime)

| Step | Evidence |
|---|---|
| Files | ROM header/CRCs/logo valid; BIOS7 16 KiB, BIOS9 4 KiB; firmware 256 KiB DS Lite, Wi-Fi CRC and both user-settings CRCs valid; `--boot-test`: the core accepts it and shows the real DS health & safety screen |
| MARIO_HOST_BOOT | title screen ("Touch to Start"), 60 fps, music; first boot "Data has been created" → a save file; **the save survives a restart** (SRAM persistence proven with a real game) |
| CLIENT_FIRMWARE_BOOT / CLIENT_DS_MENU | no cartridge: health & safety → the real DS menu ("There is no DS Card inserted", PictoChat, **DS Download Play**) |
| CLIENT_DOWNLOAD_PLAY_OPEN | "Looking for software available for download…" |
| MARIO_MULTIPLAYER_MENU / HOST_ADVERTISING | host: Multiplayer → "Find Players – Searching for DS players"; the Runtime sees Nintendo vendor-IE beacons (~48/s) |
| GAME_DISCOVERED | client list: **"Mario Party DS · 01/04"** with the host's name |
| DOWNLOAD_HANDSHAKE → TRANSFER → VERIFY | "Would you like to download this software?" → authentication/association → ~2,600 distinct 292-byte command frames (~690 KB) in ~13 s → "Downloading…"; the host lists the client as a player |
| CLIENT_GAME_BOOT | host taps OK ("Transmitting data…"): the client reboots (Nintendo logo) into the downloaded software, answering with blank 28-byte replies for ~10 s |
| GAME_HANDSHAKE | host **"You are P1."**, client **"You are P2."** |
| LOBBY | same session on both: host Select Mode, client "P1 is making selections." |
| IN_GAME | Puzzle Collection: P1 vs P2 listing both names; P1=Mario chosen with the host's stylus, P2=Peach with the client's stylus, mirrored on both; Block Star match running; D-pad moves only the pressing player's hand (own screen) and the mirror on the other console's top screen |

Not Dual-ROM at any point. The only ROM is on the host; the client receives the game over the emulated DS wireless link (the payload never touches the filesystem).

## Radio signatures captured from the real session (used by `runtime/src/dlplay_diag.cpp`)
beacons with Nintendo vendor IE (host) · auth + assoc (client→host) · bulk **292-byte** MP command frames = the download · 32/42-byte commands with ~38-byte replies = keep-alive polling
while "Downloading…" waits for the host · **28-byte replies** while the downloaded game boots · then ~202-byte commands / ~34–70-byte replies at ~60 Hz (lobby and game look the same on the
wire, so the final LOBBY/IN_GAME call is made from the screen: `DIAG_MARK`). A typical timeline: discovered 0 s, handshake +6.9 s, transfer 7.2–20.1 s, verify, game boot +1–2 s…+12 s, lobby +34 s.

## Reproducing
`tests/runtime/mario_dlplay.py <rt> <core> <cfgtool> /home/user/private [--sigterm]` — fully automated through the lobby: **23/23** (three consecutive runs; one earlier run had a flaky screen
check on my side, none had a product failure). `--game` continues into a match but its navigation is experimental. `cloud/tests/browser_mario.mjs` does the same **from two real Chromium
browsers over WebRTC** (touch/D-pad from the browsers, video/audio back): **22/22**, repeated four times, then into a Block Star match; input independence reviewed visually
(B presses RIGHT: only Peach's hand moves — on B's bottom screen and mirrored on A's top screen).

## Findings that mattered
* "Downloading…" lasting forever is **normal until the host taps OK** (the host's Find Players screen then says "Transmitting data…").
* A fresh save has minigame modes locked (grey); Puzzle Mode is available for a two-player test.
* **Real bug found and fixed:** if the other console vanished while melonDS was inside its blocking reply wait (`NextPacketBlock`), the bridge called the core's `stop()` from within `poll_receive`;
  the core nulled its send/poll pointers and then called them: segfault in the survivor. Lifecycle callbacks (`stop`, `disconnected`) are now deferred to `pump()` between frames.
  Regression: `tests/runtime/test_peer_loss.py` (NPT_BLOCK mode in the test core reproduces it: 10/10 crashes before, 0/20 after).
* The gateway did not reap its runtime children when they were stopped from outside (zombies): fixed.
* Not exercised: DSi mode, other games, Wi-Fi under network latency (everything is a Unix socket on one host), packet loss, a third console.
