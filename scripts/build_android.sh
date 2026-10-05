#!/usr/bin/env bash
# Builds the DSLink Android APKs (arm64-v8a). Needs: JDK 11, Android SDK, NDK (ANDROID_NDK), cmake, ninja, python3.
# Output: upstream/retroarch/pkg/android/phoenix/build/outputs/apk/dslink/{debug,release}/*.apk
#
#   scripts/build_android.sh            # debug + release, unit tests, lint
#   TASKS="assembleDslinkDebug" scripts/build_android.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/upstream/versions.env"
: "${ANDROID_NDK:?set ANDROID_NDK to the NDK used for the melonDS DS core (r25+)}"
TASKS=${TASKS:-"testDslinkDebugUnitTest lintDslinkDebug assembleDslinkDebug assembleDslinkRelease"}

"$ROOT/scripts/check_pins.sh"

echo "== melonDS DS core (arm64-v8a, software renderer: OpenGL is disabled on Android upstream, see issue #23)"
cmake -S "$ROOT/upstream/melonds-ds" -B "$ROOT/build/core-android" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$ANDROID_NDK/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=24 \
  -DENABLE_OGLRENDERER=OFF -DMELONDS_REPOSITORY_TAG="$MELONDS_COMMIT" \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5
cmake --build "$ROOT/build/core-android" --parallel
CORE=$(find "$ROOT/build/core-android" -name 'melondsds_libretro_android.so' -o -name 'melondsds_libretro.so' | head -n1)
[ -n "$CORE" ] || { echo "core library not found" >&2; exit 1; }
mkdir -p "$ROOT/android/jniLibs/arm64-v8a" "$ROOT/android/assets/info"
cp "$CORE" "$ROOT/android/jniLibs/arm64-v8a/libmelondsds_libretro_android.so"
cp "$ROOT/build/core-android/melondsds_libretro.info" "$ROOT/android/assets/info/melondsds_libretro.info"

echo "== assets (touch overlay, icons)"
python3 "$ROOT/scripts/gen_assets.py"

echo "== RetroArch patches"
"$ROOT/scripts/apply_patches.sh"

echo "== Gradle: $TASKS"
cd "$ROOT/upstream/retroarch/pkg/android/phoenix"
./gradlew --no-daemon $TASKS
find build/outputs/apk -name '*.apk' -exec ls -l {} \;
