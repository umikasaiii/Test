#!/usr/bin/env bash
# Reproducible build of the DSLink WebAssembly Runtime: the melonDS DS libretro core (pinned upstream, one small patch) + the DSLink libretro host, compiled with Emscripten.
# Output: cloud/web/play/core/dslink_wasm.{js,wasm} (git-ignored) and build/wasm/BUILDINFO.txt.
#   EMSDK_DIR   where the Emscripten SDK lives (default build/emsdk; cloned and installed at the pinned version when missing)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/upstream/versions.env"
EMSDK_DIR=${EMSDK_DIR:-$ROOT/build/emsdk}
W="$ROOT/build/wasm"
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

echo "== melonDS DS core ($MELONDS_DS_TAG, melonDS $MELONDS_COMMIT) for WebAssembly"
rm -rf "$W/melonds-ds" && mkdir -p "$W/melonds-ds"
(cd "$ROOT/upstream/melonds-ds" && tar --exclude=.git -cf - .) | tar -xf - -C "$W/melonds-ds"
for p in "$ROOT"/wasm/patches/*.patch; do patch -p1 -d "$W/melonds-ds" < "$p"; done
# Notes on the flags: software renderer only, no threads (the page runs the core in one worker), no JIT (not possible in WebAssembly), networking is compiled but never used
# (Wi-Fi emulation is a later milestone), C++ exceptions through the WebAssembly exception-handling proposal (Safari 15.2+, Chrome 95+), no dlopen.
emcmake cmake -S "$W/melonds-ds" -B "$W/core" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS="-fwasm-exceptions" \
  -DENABLE_OPENGL=OFF -DENABLE_OGLRENDERER=OFF -DENABLE_NETWORKING=ON -DENABLE_THREADED_RENDERER=OFF -DENABLE_JIT=OFF -DENABLE_DYNAMIC=OFF -DHAVE_DYNAMIC=ON -DHAVE_MMAP=0 \
  -DENABLE_LTO_RELEASE=OFF -DMELONDS_REPOSITORY_TAG="$MELONDS_COMMIT" -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DFETCHCONTENT_BASE_DIR="$W/deps" -DDSLINK_WASM_PCAP_STUB="$ROOT/wasm/net_pcap_stub.cpp"
cmake --build "$W/core" --parallel

echo "== DSLink Runtime (libretro host) for WebAssembly"
emcmake cmake -S "$ROOT/wasm" -B "$W/runtime" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCORE_BUILD="$W/core" -DDEPS_BUILD="$W/deps" \
  -DLIBRETRO_INCLUDE="$W/deps/libretro-common-src/include"
cmake --build "$W/runtime" --parallel

OUT="$ROOT/cloud/web/play/core"
mkdir -p "$OUT"
cp "$W/runtime/dslink_wasm.js" "$W/runtime/dslink_wasm.wasm" "$OUT/"
{
  echo "emscripten $EMSCRIPTEN_TAG (emsdk $EMSDK_COMMIT)"
  echo "melonDS DS $MELONDS_DS_TAG ($MELONDS_DS_COMMIT), melonDS $MELONDS_COMMIT"
  echo "dslink_wasm.wasm $(stat -c %s "$OUT/dslink_wasm.wasm") bytes sha256 $(sha256sum "$OUT/dslink_wasm.wasm" | cut -d' ' -f1)"
} | tee "$W/BUILDINFO.txt"
