#!/usr/bin/env bash
# Reproducible build of the PlaySphere PS1 Runtime for WebAssembly: the PCSX-ReARMed libretro core (pinned upstream, one small patch) + the libretro host shared with the Nintendo DS
# runtime, compiled with Emscripten. Output (git-ignored): cloud/web/play/core/ps1/playsphere_ps1.{js,wasm} and build-info.json (versions, sizes, sha256).
#   EMSDK_DIR      where the Emscripten SDK lives (default build/emsdk; cloned and installed at the pinned version when missing)
#   PCSX_SRC       use this already fetched PCSX-ReARMed tree instead of fetching the pinned commit (it must be that commit)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/upstream/versions.env"
EMSDK_DIR=${EMSDK_DIR:-$ROOT/build/emsdk}
W="$ROOT/build/ps1"
mkdir -p "$W"

if ! command -v emcc >/dev/null 2>&1 || ! emcc --version | head -n1 | grep -q "$EMSCRIPTEN_TAG"; then
  if [ ! -d "$EMSDK_DIR/.git" ]; then
    git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
    git -C "$EMSDK_DIR" checkout "$EMSDK_COMMIT"
  fi
  "$EMSDK_DIR/emsdk" install "$EMSCRIPTEN_TAG"
  "$EMSDK_DIR/emsdk" activate "$EMSCRIPTEN_TAG"
  # shellcheck disable=SC1091
  . "$EMSDK_DIR/emsdk_env.sh" >/dev/null
fi
emcc --version | head -n1

echo "== PCSX-ReARMed ($PCSX_REARMED_COMMIT)"
rm -rf "$W/src" && mkdir -p "$W/src"
if [ -n "${PCSX_SRC:-}" ]; then
  (cd "$PCSX_SRC" && tar --exclude=.git -cf - .) | tar -xf - -C "$W/src"
else
  git init -q "$W/fetch" 2>/dev/null || true
  git -C "$W/fetch" fetch -q --depth 1 "$PCSX_REARMED_REPO" "$PCSX_REARMED_COMMIT"
  git -C "$W/fetch" archive FETCH_HEAD | tar -xf - -C "$W/src"
fi
for p in "$ROOT"/wasm/ps1/patches/*.patch; do patch -p1 -d "$W/src" < "$p"; done
# platform=emscripten is the upstream target for WebAssembly: interpreter CPU core (no dynarec, WebAssembly cannot JIT), the NEON-derived GPU through WebAssembly SIMD,
# no threads, no sockets, no physical CD drive. GIT_VERSION is set explicitly: this tree is not a git checkout.
(cd "$W/src" && emmake make -f Makefile.libretro platform=emscripten -j"$(nproc)" GIT_VERSION=" ${PCSX_REARMED_COMMIT:0:7}")

echo "== PlaySphere PS1 Runtime (libretro host) for WebAssembly"
cp "$W/src/pcsx_rearmed_libretro_emscripten.bc" "$W/libpcsx_rearmed.a"      # the upstream target names its static archive .bc: the linker needs to see an archive
emcmake cmake -S "$ROOT/wasm/ps1" -B "$W/runtime" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCORE_ARCHIVE="$W/libpcsx_rearmed.a" -DCORE_SRC="$W/src" -DLIBRETRO_INCLUDE="$W/src/deps/libretro-common/include"
cmake --build "$W/runtime" --parallel

OUT="$ROOT/cloud/web/play/core/ps1"
mkdir -p "$OUT"
cp "$W/runtime/playsphere_ps1.js" "$W/runtime/playsphere_ps1.wasm" "$OUT/"
WASM_SHA=$(sha256sum "$OUT/playsphere_ps1.wasm" | cut -d' ' -f1); JS_SHA=$(sha256sum "$OUT/playsphere_ps1.js" | cut -d' ' -f1)
cat > "$OUT/build-info.json" <<JSON
{
  "id": "pcsx-rearmed",
  "runtime": "LOCAL_PS1_WASM",
  "coreVersion": "${PCSX_REARMED_COMMIT:0:12}",
  "upstream": "$PCSX_REARMED_REPO",
  "upstreamCommit": "$PCSX_REARMED_COMMIT",
  "license": "GPL-2.0-or-later",
  "emscripten": "$EMSCRIPTEN_TAG",
  "stateFormat": 1,
  "requires": ["wasm", "wasm-simd", "worker-module"],
  "files": { "playsphere_ps1.wasm": { "bytes": $(stat -c %s "$OUT/playsphere_ps1.wasm"), "sha256": "$WASM_SHA" }, "playsphere_ps1.js": { "bytes": $(stat -c %s "$OUT/playsphere_ps1.js"), "sha256": "$JS_SHA" } }
}
JSON
cat "$OUT/build-info.json"
