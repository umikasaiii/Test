# PlaySphere V1 — release checklist

Mark an item only when it is true *now*. `SOFTWARE READY` means the software side is done; `DEVICE VERIFIED` additionally needs the real-device rows. A release is **certified V1 only when every box is ticked**.

## Software

- [ ] **CI green** on the release commit: workflows `wasm`, `cloud`, `native`, `android`, `android-native`, `ios`.
- [ ] `scripts/check_no_private.py` clean; the package guard in `wasm.yml` clean (no ROM, BIOS, firmware, disc, `refs.json`).
- [ ] **Security**: `PLAYSPHERE_V1_SECURITY_AUDIT.md` read; no open High finding; rate-limit rules configured on the production zone (K6); CSP headers present on `/play/*` (`play_csp_worker.mjs`).
- [ ] **Privacy**: ROM / BIOS / saves private, Party Voice not recorded, no analytics or third-party script.
- [ ] **Licences**: `THIRD_PARTY_NOTICES.md` current; the PWA package contains `play/third-party-notices.txt`; About lists the cores.
- [ ] **PWA**: `manifest.webmanifest` name / short name PlaySphere, icons 192 / 512 / maskable / apple-touch / favicon, installable.
- [ ] **Service worker**: update safety (`play_sw_update.mjs`), offline start (`play_ps1_offline.mjs`), both cores cached together.
- [ ] **Cloud**: migrations applied (`wrangler d1 migrations apply`), R2 bucket private, TURN secret set, `ORIGINS` correct.
- [ ] **NDS**: single player, saves, offline, distributed, Mario Party DS Download Play (private test), Internet multiplayer.
- [ ] **PS1**: boot, video NTSC / PAL, audio, input, memory card, Cloud save, offline, bin/cue, chd, multi-disc.
- [ ] **Touch**: `controls_geometry_probe.mjs --check` unchanged; `git diff 75c6b3e -- cloud/worker/public/controls` empty.
- [ ] **Multicore**: `play_multicore_e2e.mjs`, `play_multicore_stress.mjs`.
- [ ] **Hardening**: `play_hardening_e2e.mjs`.
- [ ] **UI**: `play_ui_e2e.mjs` (design system, themes, accessibility, responsive).
- [ ] Production build: `scripts/package_pwa.sh` (set `DSLINK_CLOUD_URL` only for a separate static host) and the `deploy` workflow with Cloudflare credentials.
- [ ] `VERSION` updated; Impostazioni › Informazioni shows the new version and commit.
- [ ] **Known issues** reviewed (`PLAYSPHERE_V1_KNOWN_ISSUES.md`): no blocker open.

## Real devices (not yet done)

- [ ] HONOR 200 — all rows of `PLAYSPHERE_DEVICE_VALIDATION.md` PASS
- [ ] iPhone — all rows PASS
- [ ] Real two-network multiplayer, real Party Voice, real gamepad, a real PlayStation game (and BIOS if available)

## After release

Next phase: **real-device validation and stabilisation**. PlaySphere PC Remote stays frozen until it is complete.
