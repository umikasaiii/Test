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
