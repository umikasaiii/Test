# RetroArch parity (RetroArch = reference, not production)

RetroArch (pinned, with the DSLink patches) is kept as the **reference and diagnostic baseline**: the same core, ROM, options, identity
and inputs are run under both frontends and the observable behaviour is compared. RetroArch is **not** removed from the repository until
every row below is green *and* the Mario Party test passes on the Runtime; it is already absent from the production image.

## Evidence (all LOCAL TESTED, Linux x86_64, melonDS DS 1.4.0, test homebrew ROMs)

| # | Suite | Result |
|---|---|---|
| 1 | `tests/parity/ab_parity.py` — one console, RetroArch vs Runtime | **13/13** |
| 2 | `tests/runtime/test_bridge_parity.py` — same NETPACKET test core under RetroArch Netplay vs the Multiplayer Bridge | **10/10** |
| 3 | `cloud/tests/browser_e2e.mjs` — two browsers, `DSLINK_BACKEND=retroarch` (reference) | **19/19** |
| 4 | `cloud/tests/browser_e2e.mjs` — the same suite, `DSLINK_BACKEND=runtime` | **19/19** |
| 5 | `tests/integration/linux_netplay_smoke.sh` (original RetroArch↔RetroArch DS netplay smoke) | unchanged, still the regression baseline |

**Parity X/Y = 13/13 (single console) + 10/10 (packet interface) + 19/19 (two-console product path, identical on both backends).**

### What `ab_parity.py` compares (13 checks)
core initialisation log lines (every INFO/WARN/ERROR line the core printed under RetroArch also appears under the Runtime and the
Runtime adds none) · ROM loading lines · top-screen framebuffer (mean absolute difference < 1 level) · bottom screen · audio tone
frequency (443 vs 440 Hz) · A / Up input → identical pixels · touch → same stylus position seen by the ARM7 (centroid within 3 px)
· system-directory resolution (`melonDS DS` sub-directory) · save files written (same names/sizes, 8 KiB `.srm`) · boot without
content (same outcome: needs bootable firmware) · derived MAC equal under both and equal to DSLink's derivation · clean shutdown.

### What the DS wireless A/B shows (checks 3 vs 4)
The homebrew ROMs drive the DS Wi-Fi hardware from ARM7 (power-up, channel 1, 802.11 data frames). In both backends each console's
top screen shows (yellow) frames it sent, (cyan) frames received from the *other* console and (square colour) the sender id; the two
backends produce the same observations in the real browser video.

## Known, accepted differences
* Timing: RetroArch paces on its video driver, the Runtime on a monotonic clock → identical frame content, not identical frame timing.
* The Runtime offers no VFS/microphone/rumble: the core logs its fallback; RetroArch offers VFS but the results are file-equivalent.
* Browser video codecs: VP8 locally (headless Chromium has no H.264 in WebRTC); H.264 is verified only in CI with real Chrome.

## Not covered by parity (and therefore **UNVERIFIED**)
Real commercial games (no ROM was available), DS Download Play and the DS MP command/reply/ack protocol, DSi mode, save states,
cores other than melonDS DS, multiple Runtime instances on cloud hardware under load.
