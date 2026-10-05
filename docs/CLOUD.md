# DSLink Cloud — status, how it deploys, how to run it

Status scale: **CODED · BUILD VERIFIED · LOCAL TESTED · CLOUD DEPLOYED · BROWSER VERIFIED · DEVICE VERIFIED · MARIO PARTY VERIFIED**.
"LOCAL TESTED" = automated tests on a Linux machine. Automated browser tests (headless Chromium) are **BROWSER VERIFIED**, never DEVICE VERIFIED.

## Status

| Area | Status | Evidence |
|---|---|---|
| **DSLink Runtime** (libretro host, A/V, input/touch, 4 ports, core options, dirs, SRAM, no-content boot, logs, metrics, clean stop) | CODED · BUILD VERIFIED · LOCAL TESTED | `test_single.py` 15/15 |
| melonDS DS directly under the Runtime | **PASS** | same + A/B 13/13 |
| RetroArch parity | **13/13 + 10/10 + 19/19** | [RETROARCH_PARITY.md](RETROARCH_PARITY.md) |
| Two simultaneous DS instances (different identities/MACs, independent video, audio, input, touch) | **PASS** (LOCAL TESTED) | `test_two_ds.py` 14/14; `browser_e2e.mjs` 19/19 |
| DS multiplayer **without RetroArch** (bridge; real DS Wi-Fi frames between two cores) | **PASS** for transport and radio frames; Download Play / Mario Party protocol UNVERIFIED | `test_wifi_bridge.py` 9/9, `test_bridge_parity.py` 10/10 |
| WebRTC from Runtime framebuffer/audio (no screen capture), 2 media tracks per browser, reliable + unreliable data channels | **PASS**: VP8 in headless Chromium locally; **H.264 with real Chrome in CI** (job `container-e2e`, run 14) — BROWSER VERIFIED | `browser_e2e.mjs`, `pwa_e2e.mjs` |
| Cloudflare Realtime **SFU** (per Cloud Gaming example) | **NOT IMPLEMENTED — API unverified** (developers.cloudflare.com unreachable from the build environment). Container → browser media must go through TURN/SFU because Containers do not accept inbound UDP: the gateway accepts ICE/TURN servers (`DSLINK_ICE`, Worker `ICE_SERVERS`) so a TURN-relayed peer is the CODED fallback; **untested on Cloudflare** | — |
| Accounts (passkeys + password) | **PASS** (LOCAL TESTED, BROWSER VERIFIED with a virtual authenticator) | `auth.test.ts` 13 + `pwa_e2e` |
| Friends / requests / invites | **PASS** (LOCAL TESTED, BROWSER VERIFIED) | `friends.test.ts` 9, `session.test.ts` 14, `pwa_e2e` |
| Presence (ONLINE / IN_GAME / OFFLINE, multi-device, timeouts) | **PASS** (LOCAL TESTED, BROWSER VERIFIED) | `friends.test.ts`, `pwa_e2e` |
| Game library (header detection, validation, delete, account purge) | **PASS** (LOCAL TESTED) | `library.test.ts` 12 |
| R2 private storage (per-user prefixes, never public, presigned direct upload) | Worker-proxied path **PASS** against miniflare R2; presigned URL generation CODED, **not tested against real R2** | `library.test.ts` |
| Session DO + Container (`DSLinkContainer`, ticketed content, cleanup) | DO logic LOCAL TESTED; Container API integration CODED, **cannot run outside Cloudflare**; a local gateway stands in for it | `session.test.ts`, `internal_session.py` 14/14, `pwa_e2e` |
| PWA (manifest, service worker, installable, mobile-first, passkey UI, library, friends, invites, game screen) | **BROWSER VERIFIED** (Chromium, mobile emulation, offline shell, no horizontal scroll) · **DEVICE PENDING** (Safari iPhone, Chrome Android, desktop not run) | `pwa_e2e.mjs` 33/33 |
| Production image without RetroArch (`cloud/Dockerfile.runtime`) | **BUILD VERIFIED in CI** (GitHub Actions `cloud` run 14, all 6 jobs green: image build + both browser suites in real Chrome, runtime-tests, RetroArch parity, worker, PWA e2e); not built in this sandbox (no Docker daemon) | `.github/workflows/cloud.yml` |
| **Cloudflare deployment** | **NOT DEPLOYED** | needs account, D1/R2 ids, `wrangler deploy` |
| PS1 | library accepts/validates `.chd`, `.cue+.bin`; **no core in the Runtime, no two-port mapping** | [LIBRARY.md](LIBRARY.md) |
| DEVICE VERIFIED | **NO** | |
| **Mario Party DS** | **NOT TESTED** — requires the user's private ROM and bootable DS firmware | |

## Request path of a game

```
 invite accepted ─► Worker creates GameSession DO ─► alarm: container start ─► Worker→container POST /api/internal/session
   { manifest, one-time ticket, per-slot gateway tokens, contentBase }
 gateway: GET contentBase/files/<id>            (ticket)  → Player 1's ROM, only in the container's private work dir
          GET contentBase/slot/N/system/<name>  (ticket)  → each slot's OWN firmware
          GET contentBase/save/sram             (ticket)  → restore host save
          starts Runtime #1 (host) and Runtime #2 (no cartridge), joined by the bridge
 browsers: wss /api/sessions/:id/signal  ── Worker (membership) ──► container /ws?player=N&token=…  → WebRTC
 end:      Worker → POST /api/internal/end → gateway uploads SRAM, wipes the room → container destroyed; leases and tickets removed
```

## Deploying (not done)
```
cd cloud/worker && npm ci --legacy-peer-deps
wrangler d1 create dslink && wrangler r2 bucket create dslink-private            # put the ids in wrangler.jsonc
wrangler secret put INTERNAL_TOKEN      # and R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME for presigned uploads
wrangler d1 migrations apply dslink --remote
wrangler deploy                          # builds cloud/Dockerfile.runtime as the Container image
```
Set `ORIGINS`/`RP_ID` to the real hostname (WebAuthn is bound to it) and `ICE_SERVERS` to a TURN configuration.

## Run everything locally (what the tests do)
```
tests/rom/build.sh /tmp                                              # homebrew ROMs (gcc-arm-none-eabi)
cmake -S runtime -B build/rt -G Ninja && cmake --build build/rt      # Runtime
(cd cloud/gateway && go build -o /tmp/dslink-gateway .)
# gateway (stands in for the Container; DSLINK_BACKEND=retroarch selects the reference backend)
DSLINK_INTERNAL_TOKEN=internal-secret DSLINK_BACKEND=runtime DSLINK_RUNTIME=build/rt/dslink-runtime DSLINK_CORE=<melondsds_libretro.so> \
  DSLINK_CFGTOOL=<dslink_cfgtool> DSLINK_ROMCHECK=<dslink_romcheck> DSLINK_LOOPBACK=1 /tmp/dslink-gateway -addr :8080 -web cloud/web
# Worker + PWA (workerd, local D1/R2/Durable Objects)
cd cloud/worker && npx wrangler d1 migrations apply dslink --local -c wrangler.dev.jsonc && npx wrangler dev -c wrangler.dev.jsonc --port 8787 --local
cd cloud/tests && npm install && node pwa_e2e.mjs http://localhost:8787 /tmp/dslink_test_1.nds        # 33 checks
cd cloud/worker && npx vitest run                                    # 48 tests
```
`DSLINK_VIDEO_CODEC=vp8` for headless Chromium; the default (H.264) needs a browser with H.264 in WebRTC (real Chrome).

## Reference path (RetroArch) — kept, not production
`cloud/Dockerfile` (RetroArch + Xvfb + PulseAudio + ffmpeg capture), `DSLINK_BACKEND=retroarch`; used by CI for A/B and by `browser_e2e.mjs`.

## Findings worth knowing

* The core decrypts the ROM's first 0x800 ARM9 bytes in place: an ARM7 binary at ROM offset 0x4600 is corrupted. Real ROMs and
  `tests/rom/pack_nds.py` put ARM7 at ≥ 0x8000.
* RetroArch's X11 input driver gives an *absolute* pointer only when the mouse is not grabbed and the window is 1:1 at (0,0):
  the container runs it windowed at 512×768 with `input_auto_mouse_grab=false`. Browser touch → X pointer is therefore exact.
* XTEST key events must be sent with root=0 (pointer events with the root window).
* `x11grab` only emits frames on change and libvpx's default threading stalls under CPU contention: capture uses
  `-fps_mode cfr`, `-threads 1` and a keyframe every second so a late-joining browser decodes immediately.
* Software GL (llvmpipe) is enough for RetroArch's X11 output; the melonDS core renders in software.
* Per-room CPU: 2× (RetroArch + Xvfb + VP8 + Opus) — roughly 1.5–2 cores on the build machine; sizing for real hosting is **unmeasured**.
