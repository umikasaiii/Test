# Android

* Package `com.dslink.emulator`, flavor `dslink`, **arm64-v8a**, minSdk 29 (Android 10), targetSdk 29.
  targetSdk 29 keeps RetroArch's legacy file code working; DSLink itself only uses app-private storage and the system file picker.
* Build (needs JDK 11, Android SDK, NDK for the core, cmake, ninja, python3):
  ```
  git submodule update --init --recursive
  ANDROID_NDK=/path/to/ndk scripts/build_android.sh
  ```
  Output: `upstream/retroarch/pkg/android/phoenix/build/outputs/apk/dslink/{debug,release}/`. The release APK is signed with
  the debug key unless `RELEASE_STORE_FILE/PASSWORD/KEY_ALIAS/KEY_PASSWORD` Gradle properties are set.
  CI (`.github/workflows/android.yml`) does exactly this and uploads the APKs.
* Install: `adb install -r DSLink-debug.apk` (or open the file on the phone, allowing "install unknown apps").
* Permissions: INTERNET, ACCESS_NETWORK_STATE, ACCESS_WIFI_STATE, CHANGE_WIFI_MULTICAST_STATE (mDNS; lock held only while
  discovering/advertising), RECORD_AUDIO (asked on first game, optional), ACCESS_LOCAL_NETWORK (forward-compat).
* Rendering is software (OpenGL is disabled upstream on Android). Performance on real phones is **not measured yet**.
* Touch controls: generated overlay (`scripts/gen_assets.py`): D-pad, A/B/X/Y, L/R, Start/Select, **Mic** (core L3),
  **DS** (core R3: cycle screen layout), **EXIT**. Portrait and landscape variants switch automatically.
