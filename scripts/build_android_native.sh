#!/usr/bin/env bash
# Builds every native piece of the DSLink Android app for one ABI and places it where Gradle packages it (android-app/app/src/main/jniLibs/<abi>/):
#   libmelondsds_libretro.so   melonDS DS libretro core (open source, built from the pinned upstream commits)
#   libdslink_runtime.so       the existing DSLink Runtime (C++), built without FFmpeg                (executable)
#   libdslink_cfgtool.so / libdslink_romcheck.so   the existing DSLink C++ tools                       (executables)
#   libdslink_gateway.so       the existing DSLink gateway (Go)                                         (executable)
#   libdslink_jni.so           JNI: GL renderer, AAudio, input, metrics, private-file validation
# Needs: Android NDK (ANDROID_NDK), cmake, ninja, Go. Usage:  ANDROID_NDK=/path/to/ndk scripts/build_android_native.sh [arm64-v8a|x86_64]
# (x86_64 exists only so CI can run the whole stack on an Android emulator; the product ABI is arm64-v8a.)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ABI=${1:-arm64-v8a}
: "${ANDROID_NDK:?set ANDROID_NDK to the NDK (r25+)}"
. "$ROOT/upstream/versions.env"
PLATFORM=26
TOOLCHAIN="$ANDROID_NDK/build/cmake/android.toolchain.cmake"
OUT="$ROOT/android-app/app/src/main/jniLibs/$ABI"
mkdir -p "$OUT"

echo "== melonDS DS core ($ABI, software renderer)"
cmake -S "$ROOT/upstream/melonds-ds" -B "$ROOT/build/android-core-$ABI" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" -DANDROID_ABI="$ABI" -DANDROID_PLATFORM=$PLATFORM \
  -DENABLE_OGLRENDERER=OFF -DMELONDS_REPOSITORY_TAG="$MELONDS_COMMIT" -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build "$ROOT/build/android-core-$ABI" --parallel
CORE=$(find "$ROOT/build/android-core-$ABI" \( -name 'melondsds_libretro_android.so' -o -name 'melondsds_libretro.so' \) | head -n1)
[ -n "$CORE" ] || { echo "core library not found" >&2; exit 1; }
cp "$CORE" "$OUT/libmelondsds_libretro.so"

echo "== Runtime, DSLink tools, JNI ($ABI)"
cmake -S "$ROOT/android-app/native" -B "$ROOT/build/android-native-$ABI" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" -DANDROID_ABI="$ABI" -DANDROID_PLATFORM=$PLATFORM -DANDROID_STL=c++_static \
  -DLIBRETRO_INCLUDE="$ROOT/upstream/retroarch/libretro-common/include" -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build "$ROOT/build/android-native-$ABI" --parallel --target dslink-runtime dslink_cfgtool dslink_romcheck dslink_jni
B="$ROOT/build/android-native-$ABI"
cp "$B/runtime_build/dslink-runtime" "$OUT/libdslink_runtime.so"
cp "$B/dslink_build/dslink_cfgtool"  "$OUT/libdslink_cfgtool.so"
cp "$B/dslink_build/dslink_romcheck" "$OUT/libdslink_romcheck.so"
cp "$B/libdslink_jni.so"             "$OUT/libdslink_jni.so"

echo "== gateway (Go)"
# GOOS=android matters: with GOOS=linux Go uses pidfd_send_signal, which Android's app seccomp filter kills with SIGSYS.
case "$ABI" in
  arm64-v8a)  GOARCH=arm64 ;  CGO=0 ; CCBIN="" ;;
  x86_64)     GOARCH=amd64 ;  CGO=1 ; CCBIN=$(ls "$ANDROID_NDK"/toolchains/llvm/prebuilt/*/bin/x86_64-linux-android${PLATFORM}-clang | head -n1) ;;   # android/amd64 needs external (cgo) linking; emulator only
  *) echo "unsupported ABI $ABI" >&2; exit 1 ;;
esac
# github.com/wlynxg/anet (pion's Android network-interface workaround) needs go:linkname access to net internals
(cd "$ROOT/cloud/gateway" && CGO_ENABLED=$CGO CC="$CCBIN" GOOS=android GOARCH=$GOARCH go build -trimpath -ldflags="-checklinkname=0 -s -w" -o "$OUT/libdslink_gateway.so" .)

# executables ship stripped
STRIP=$(ls "$ANDROID_NDK"/toolchains/llvm/prebuilt/*/bin/llvm-strip | head -n1)
for f in libdslink_runtime.so libdslink_cfgtool.so libdslink_romcheck.so libdslink_jni.so libmelondsds_libretro.so; do "$STRIP" --strip-unneeded "$OUT/$f" || true; done
ls -l "$OUT"
