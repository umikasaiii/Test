#!/usr/bin/env bash
# Runs the instrumented tests and ALWAYS prints what the app/gateway/Runtime logged (the test APK and the app are uninstalled afterwards).
cd "$(dirname "$0")/../android-app"
adb logcat -c
gradle --no-daemon -Pdslink.abis=x86_64 connectedDebugAndroidTest 2>&1 | tee /tmp/gradle_android.log
rc=${PIPESTATUS[0]}
adb logcat -d -s dslink-test:V dslink-stack:V dslink-render:V dslink-audio:V dslink-jni:V dslink-nsd:V AndroidRuntime:E > /tmp/logcat_android.txt
echo "=================== logcat (dslink tags, last 120) ==================="
tail -120 /tmp/logcat_android.txt
echo "=================== SUMMARY ==================="
grep -E "FAILED|PASSED|Starting [0-9]+ tests|Tests on .* (failed|passed)" /tmp/gradle_android.log | sed 's/\x1b\[[0-9;]*m//g'
grep -E "dslink-test: java.lang.AssertionError" /tmp/logcat_android.txt | cut -c1-600
echo "--- failures from the test result XML ---"
find app/build/outputs -name "*.xml" -path "*androidTest*" -print0 2>/dev/null | xargs -0 -r grep -h -A6 "<failure" | cut -c1-700 | head -40
exit $rc
