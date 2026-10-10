# PlaySphere V1 — known issues

Honest list. "Release blocker" means: do not call V1 released while it is open. Severity: **H**igh, **M**edium, **L**ow.

## Blockers for the V1 *certification* (not software defects)

| # | Issue | Sev | Scope | Workaround | Blocker |
|---|---|---|---|---|---|
| K1 | **No test on a real phone has been run** (HONOR 200, iPhone): install, touch, audio, orientation, background/resume, battery, thermals, real mobile performance of DS and PlayStation | H | all | follow `PLAYSPHERE_DEVICE_VALIDATION.md` | **yes** |
| K2 | Real multiplayer across two real networks, real Party Voice with real microphones, real Bluetooth gamepads: only simulated / loopback coverage (local coturn, fake media, scripted Gamepad API) | H | multiplayer, party, input | device validation | **yes** |
| K3 | **No commercial PlayStation game and no real Sony BIOS has been tested** (none exists in CI by design); compatibility with real games is unknown; the built-in HLE BIOS is used only after an explicit choice | H | PS1 | add your own BIOS; test your own discs | **yes** (for any PS1 compatibility claim) |
| K4 | An independent security review has not been done (this phase's audit was done by the code's author) | M | Cloud | `PLAYSPHERE_V1_SECURITY_AUDIT.md` | before a public launch |
| K5 | No public deployment was made (no Cloudflare credentials in this environment); the production headers and the deploy workflow were verified locally and in CI only | M | release | run the deploy workflow with credentials | before launch |

## Software issues

| # | Issue | Sev | Scope | Workaround | Blocker |
|---|---|---|---|---|---|
| K6 | Rate limits are counted in each Worker isolate's memory: they stop scripts and runaway clients, not a distributed attack | M | Cloud | add Cloudflare rate-limiting rules on `/api/auth/*`, `/api/users/search`, `/api/play/invites` | no |
| K7 | `style-src 'unsafe-inline'` remains in the CSP (the UI uses inline `style` attributes); scripts are strict | L | PWA | none needed | no |
| K8 | Removing a game / a Cloud file still uses the browser's native `confirm()` dialog (functional, not in the PlaySphere style) | L | UX | — | no |
| K9 | PlayStation disc images are not uploaded to the Cloud (only metadata, memory card and BIOS); save states are local only | M | PS1 / Cloud | copy the disc to the other device | no |
| K10 | The "Locale / Online" switch in Multiplayer groups what exists: Locale = rooms by code or QR (the connection may still go over the Internet when the devices are on different networks), Online = invite online friends. There is no setting that forces LAN-only | L | UX | — | no |
| K11 | Routes are hash routes (`#/games`), not path routes (`/library/`): the host is static and has no rewrite rules; refreshing `/play/#/games` works, `/play/library/` does not exist | L | routing | — | no |
| K12 | The legacy hosted / gateway web UI (`cloud/web/index.html`, `cloud/web/mp/`) and the native Android / iOS apps only had their visible name changed; they keep their older look (they are not the PlaySphere PWA) | L | legacy modes | use the PWA | no |
| K13 | Test hooks and the welcome flow depend on `navigator.webdriver`: automated browsers get `window.dslinkPlay` and skip the welcome flow unless `?welcome=1` | L | testing | — | no |
| K14 | Visual regression is checked by layout invariants (overflow, navigation placement, columns, contrast of tokens, no clipped content) plus screenshots kept as CI artifacts, **not** by pixel baselines (they would be flaky across machines) | L | testing | review the screenshots | no |
| K15 | PWA icons are not recompressed (about 300 KB in total, cached once) | L | assets | — | no |
| K16 | Italian only (no translation layer); system fonts only, so typography varies slightly by device | L | UX | — | no |
| K17 | Safe-area handling (`env(safe-area-inset-*)`) is verified by presence in the CSS and by layout tests, not on a real notch / Dynamic Island | M | iPhone / Android | device validation | with K1 |
| K18 | iOS Safari may evict site data of a PWA not opened for a long time (browser policy); local games and saves live in that storage | M | iPhone | enable Cloud save; keep the app installed | no |
| K19 | The party / camera paths were verified under the real CSP with a **locally tracked run** (CSP with `unsafe-eval` added only so Playwright's own helper works) and in the normal CI runs without CSP enforcement (Playwright needs `eval`); the exact production policy is exercised in CI by `play_csp_worker.mjs` (page, service worker, DS and PlayStation cores, workers) | L | testing | — | no |
| K20 | Performance numbers in the docs are from desktop Chromium with software rendering: they compare the UI before / after, they say nothing about phones | M | performance | device validation | with K1 |

## Not implemented on purpose

PlaySphere PC Remote; other systems (GB, GBC, GBA, NES, SNES, N64, PSP); disc image upload; save-state sync. They are not defects.

## Render fps under 4x CPU throttle (test environment)
`play_wasm_hardening.mjs` "THROTTLE 4x" requires render >= 45 fps. On the software-rendering CI/dev container it measures 42 fps on the FASE 8 baseline (e9d1311) and 44 fps on PlaySphere V1 (emulator stays 59.8 fps, audio underruns 0). The threshold was NOT lowered; the check is environment-limited, and V1 is not slower than the baseline. Real phones are covered by the device checklist.
