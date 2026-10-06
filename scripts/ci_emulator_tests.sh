#!/usr/bin/env bash
# Runs the instrumented tests and ALWAYS prints what the app/gateway/Runtime logged (the test APK and the app are uninstalled afterwards).
cd "$(dirname "$0")/../android-app"
adb logcat -c
gradle --no-daemon -Pdslink.abis=x86_64 connectedDebugAndroidTest
rc=$?
echo "=================== logcat (dslink tags) ==================="
adb logcat -d -s dslink-test:V dslink-stack:V dslink-render:V dslink-audio:V dslink-jni:V dslink-nsd:V AndroidRuntime:E | tail -150
exit $rc
