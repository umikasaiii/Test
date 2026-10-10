# PlaySphere — third-party notices

PlaySphere is distributed under **GPL-3.0** (see `LICENSE`). It contains or builds on the components below. Source for every component that ships in the PWA is available: the exact upstream commits are pinned in `upstream/versions.env`, the changes PlaySphere makes are in `wasm/`, `runtime/` and `patches/`, and `scripts/build_wasm.sh` / `scripts/build_ps1_wasm.sh` rebuild the shipped binaries.

PlaySphere contains **no game, no BIOS and no firmware**. Nintendo DS and PlayStation are trademarks of their owners; PlaySphere is not affiliated with them.

## Emulation cores (shipped as WebAssembly)

| Component | Use | License | Where verified |
|---|---|---|---|
| melonDS DS (libretro core, melonDS) | Nintendo DS | GPL-3.0 | `upstream/melonds-ds/LICENSE` |
| PCSX-ReARMed (libretro) | PlayStation 1 | GPL-2.0-or-later (every GPL-licensed source file of the build says "or later") | `docs/PLAYSPHERE_PS1_CORE_DECISION.md` |
| libretro-common | headers / helpers of the cores | MIT | pinned source tree |
| libchdr | CHD disc images (PlayStation) | BSD-3-Clause | `libchdr/LICENSE.txt` |
| LZMA SDK (inside libchdr) | CHD decompression | public domain | `lzma-26.02/LICENSE` |
| zstd decoder (inside libchdr) | CHD decompression | BSD-3-Clause or GPL-2.0, at the user's option (BSD chosen) | header of `zstddeclib.c` |
| miniz | zlib for CHD (replaces Emscripten's downloaded zlib port, see `wasm/ps1/patches/`) | MIT | `miniz.c` |
| FLAC wrapper (libchdr) | CHD audio | BSD-3-Clause | `libchdr_flac.c` |
| Emscripten runtime | glue code of the generated `.js` | MIT / University of Illinois-NCSA | Emscripten 3.1.74 (`upstream/versions.env`) |

The PCSX-ReARMed build is the **interpreter** (no dynarec) with the NEON GPU compiled to WebAssembly SIMD; its built-in HLE BIOS is project code, not a Sony file.

## Libraries in the PWA

| Component | License |
|---|---|
| QR Code Generator for JavaScript (Kazuhiko Arase) — `cloud/web/mp/vendor/qrcode.js` | MIT |
| jsQR — `cloud/web/mp/vendor/jsQR.js` | Apache-2.0 |

## Cloud (Cloudflare Worker) and gateway

| Component | License |
|---|---|
| `@simplewebauthn/server` | MIT |
| `aws4fetch` | MIT |
| `@cloudflare/containers` | MIT |
| pion/webrtc and the pion family, gorilla/websocket (gateway, Go) | MIT / BSD (see each module's `LICENSE` in `go.sum`-pinned versions) |
| Opus (libopus, `upstream/opus`) | BSD-3-Clause (royalty-free patent licences apply, see its `COPYING`) |
| coturn (deployment of a TURN server, not part of the package) | BSD-3-Clause |

## Reproducing the list

`cloud/worker/package.json` and `cloud/gateway/go.mod` list the Cloud dependencies; `upstream/versions.env` the pinned sources. If you ship a modified PlaySphere you must keep these notices and offer the corresponding source under the same licenses.
