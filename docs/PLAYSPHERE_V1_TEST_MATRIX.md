# PlaySphere V1 — test matrix

Legend: **PASS** = verified, **FAIL** = failed, **NOT TESTED** = not verified. AUTOMATED = Playwright/Chromium (desktop, software rendering) and vitest in this repository, homebrew ROMs and generated test discs only. HONOR (HONOR 200) and IPHONE columns are real-device columns: nothing has been run on a physical device yet, so they are NOT TESTED. SOFTWARE READY is not DEVICE VERIFIED.

| Area | AUTOMATED | HONOR 200 | IPHONE |
|---|---|---|---|
| UI (shell, nav, Home, Library, Detail, Profile, Friends, onboarding, states, light/dark, responsive, a11y) — `play_ui_e2e` 77/77 | PASS | NOT TESTED | NOT TESTED |
| NDS (homebrew boot, input, save, touch geometry vs 75c6b3e) | PASS | NOT TESTED | NOT TESTED |
| PS1 (generated test disc, HLE BIOS, memory card) | PASS | NOT TESTED | NOT TESTED |
| Cloud (account, library, files, saves, R2, conflict) | PASS | NOT TESTED | NOT TESTED |
| Save (local/cloud, corrupt, quota, retry, no silent loss) | PASS | NOT TESTED | NOT TESTED |
| Offline (shell, NDS, PS1 offline) | PASS | NOT TESTED | NOT TESTED |
| Multiplayer (LAN/direct/relay, QR + isolation, internet) | PASS | NOT TESTED | NOT TESTED |
| Party (2/3/4 peers, relay, mute, volume, owner, reconnect) | PASS | NOT TESTED | NOT TESTED |
| Update (SW update never interrupts a game, AGGIORNA ORA) | PASS | NOT TESTED | NOT TESTED |
| Install (manifest, icons, maskable) | PASS (static checks) | NOT TESTED | NOT TESTED |
| Orientation (portrait/landscape/tablet geometry) | PASS | NOT TESTED | NOT TESTED |
| Controller (real gamepad) | NOT TESTED (emulated events only) | NOT TESTED | NOT TESTED |
| Audio (worklet, no underruns at 60 fps) | PASS | NOT TESTED | NOT TESTED |
| Performance (FCP 264 ms, LCP 264 ms, CLS 0, 0 long tasks at start; NDS 59.8 / PS1 60.6 emu fps, 0 stalls in 8 s) | PASS | NOT TESTED | NOT TESTED |

Known automated deviation: 4x CPU throttle render fps (44 vs 45 required; baseline 42) — see KNOWN_ISSUES.

Not verified at all: HONOR VERIFIED NO, IPHONE VERIFIED NO, REAL GAMEPAD NO, REAL PS1 GAME NO, REAL BIOS PS1 NO, REAL INTERNET MULTIPLAYER NO, REAL PARTY VOICE NO.
