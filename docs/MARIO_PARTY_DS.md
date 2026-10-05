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

# Mario Party DS on the DSLink Runtime (current procedure, local, private files)

Status: **NOT TESTED** — waiting for the user's private ROM + firmware. Everything below is prepared and self-tested with homebrew.

Private files live OUTSIDE the repository (suggested: `/home/user/private/` — `private/`, `*.nds`, `bios*.bin`, `firmware*.bin`, `*.ppm`, `mario_out/` are git-ignored,
`scripts/check_no_private.py` runs in CI and as a local pre-commit hook, and no CI job ever receives them).

1. **Validate** (never modifies, never prints contents): `python3 scripts/validate_private.py /home/user/private --boot-test build/rt/dslink-runtime <core.so> /home/user/private/out`
   checks ROM header/CRCs/SHA-256, BIOS sizes, firmware header/Wi-Fi/user-settings CRCs and console type, then boots the firmware on a *copy* and checks the core accepts it and shows a real UI.
2. **Drive** both consoles interactively (screenshots as PNG, buttons, touch, wireless diagnostics):
   `python3 tools/dsdriver.py serve --rt … --core … --cfgtool … --rom "/home/user/private/<rom>.nds" --fw /home/user/private --out /home/user/private/out`
   then `python3 tools/dsdriver.py cmd shot host NAME | press client A | touch client 0.5 0.75 | status | grep client DLPLAY`. The client has **no cartridge** (`--dual-rom` exists for comparison debugging only).
3. **Diagnostics**: each Runtime classifies the 802.11 frames at the bridge and logs `DLPLAY <from> -> <to> t=… prev_state_lasted=… (reason)`, exposed in the status JSON as `dl_state`,
   `dl_counters`, `dl_hist`. States: `HOST_ADVERTISING` (Nintendo vendor-IE beacons), `CLIENT_SCANNING`, `GAME_DISCOVERED`, `DOWNLOAD_HANDSHAKE`, `DOWNLOAD_TRANSFER`, `DOWNLOAD_VERIFY`,
   `CLIENT_GAME_BOOT`, `GAME_HANDSHAKE`, `LOBBY`, `IN_GAME`, `ERROR`. The *screen-level* states (MARIO_HOST_BOOT, MARIO_MULTIPLAYER_MENU, CLIENT_FIRMWARE_BOOT, CLIENT_DS_MENU,
   CLIENT_DOWNLOAD_PLAY_OPEN) are established by looking at the screenshots and recorded in the session notes. The wireless thresholds are heuristics validated only on synthetic frames
   (`runtime/tests/dlplay_test.cpp`) and must be re-tuned against the first real capture.
4. **If a state fails**: capture the first failing state, then A/B against RetroArch (reference only) with identical firmware/ROM/MAC/options (`DSLINK_BACKEND=retroarch`).

Known risk spotted in the core (melonDS DS `libretro/net/mp.cpp`): reply waits use `NextPacketBlock()`, a 25 ms **CPU-time** busy loop that calls the bridge's `poll_receive`. The bridge reads its sockets
non-blockingly inside that call (so replies are seen), but the peer only answers when its own emulation runs, so frame pacing/encoder load on both consoles matters. Same architecture under RetroArch.
