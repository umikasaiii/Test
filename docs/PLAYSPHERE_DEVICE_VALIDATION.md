# PlaySphere V1 — real device validation (HONOR 200, iPhone)

Nothing in this file has been run yet: every row is **NOT TESTED** until someone does it on the physical device and writes the result in `PLAYSPHERE_V1_TEST_MATRIX.md`. Automated tests run in desktop Chrome (Chromium, no GPU); they say nothing about phone performance.

Prepare: the deployed (or staged) PlaySphere address, two accounts, a DS homebrew or your own legally owned DS game, and for PlayStation your own disc image (+ BIOS if you have one). Never put a game, BIOS or save in a bug report or screenshot you share.

Developer overlay (FPS, audio underruns, memory): Impostazioni › Informazioni, tap the version seven times, start a game, read the overlay. Record `EMU fps`, `RENDER fps`, `AUDIO underruns`, `WASM MB`, `main stalls`.

## A. Both devices (HONOR 200 with Chrome, iPhone with Safari)

1. **Install**: Android — menu › Installa app (or the INSTALLA PLAYSPHERE card). iPhone — Condividi › Aggiungi alla schermata Home. Open the installed icon: standalone (no browser bar), the PlaySphere icon, the splash colour.
2. **First launch**: welcome flow (5 slides, SALTA works), lands on Home. Rotate: layout follows, no clipped content under the notch / Dynamic Island / gesture bar.
3. **Library**: add a DS file, add a PlayStation disc (.cue+.bin or .chd). Cards show cover, platform, no technical text. Search, Recenti, Preferiti, filters. Tap a card: Game detail.
4. **NDS**: GIOCA. Picture, sound, touch (stylus), buttons, MENU › leave. The touch layout is the approved one. Portrait and landscape. Note fps.
5. **PS1**: GIOCA (BIOS choice dialog if no BIOS). Picture, sound, digital buttons, DualShock mode (menu › Stick analogici), disc swap if multi-disc, memory card, save state slot 1. Note fps; PAL discs run at 50 Hz.
6. **Audio**: no crackle, no silence after a phone call / notification / lock screen; sound returns after background → resume.
7. **Background / resume**: lock the screen, switch app, come back: game paused and resumed, no crash; the save is intact.
8. **Offline**: airplane mode. App opens, local games play, the Offline badge shows, Cloud features say they need a connection.
9. **Cloud**: create an account (passkey or password), enable "Salva nel mio Cloud", upload, restart on the other device, download, play, save conflict dialog (play the same game on two devices without syncing).
10. **Multiplayer**: Crea stanza / Unisciti with code and QR (camera), two devices on the same Wi-Fi, then on different networks (mobile data + Wi-Fi). Mario Party DS Download Play only with your own copy.
11. **Party Voice**: create a party with two phones, speak, mute, volume, owner kick; start a game while in the party; leave the game; leave the party. Microphone denied → clear message.
12. **Service worker update**: deploy a new build, reopen: "Aggiornamento disponibile" appears only from the menus (never during a game), AGGIORNA ORA applies it.
13. **Gamepad** (optional): a Bluetooth pad: buttons and sticks, two pads on PlayStation.
14. **Performance feel**: input latency, scrolling smoothness of Home / Libreria with ~30 games, battery and temperature after 15 minutes of play.

## B. Android-specific (HONOR 200)
Back gesture from a sub-screen goes back one step and never exits the app unexpectedly; back during a game asks "Uscire dal gioco?"; keyboard resizing on the account form; file picker accepts .nds, .cue/.bin together, .chd; wake lock keeps the screen on while playing; installed app fullscreen.

## C. iPhone-specific
`100dvh` and the Safari toolbar collapsing; keyboard covering inputs (account form); audio only after a tap (the "RIPRENDI" hint); safe areas in portrait and landscape; no horizontal rubber-banding in the player; standalone mode; storage persistence after a week unused (Safari may evict site data — export saves via Cloud).

## Reporting
For each row: PASS / FAIL / NOT TESTED, device, OS and browser version, build (Impostazioni › Informazioni), what happened. Failures that lose a save, crash a game or block multiplayer are release blockers.
