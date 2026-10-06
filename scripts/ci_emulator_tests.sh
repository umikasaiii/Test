#!/usr/bin/env bash
# Runs the instrumented tests and ALWAYS prints what the app/gateway/Runtime logged (the test APK and the app are uninstalled afterwards).
cd "$(dirname "$0")/../android-app"
adb logcat -c
# A freshly booted emulator can be busy with Google-app first-run work and ANR the very first activity ("keyDispatchingTimedOut" kills the instrumentation before any test
# body ran): that is the emulator, not the app, so such a run is repeated once. A real test failure (no ANR) is never retried.
for attempt in 1 2; do
  adb shell am force-stop com.google.android.googlequicksearchbox >/dev/null 2>&1
  adb shell input keyevent KEYCODE_HOME >/dev/null 2>&1
  gradle --no-daemon -Pdslink.abis=x86_64 connectedDebugAndroidTest 2>&1 | tee /tmp/gradle_android.log
  rc=${PIPESTATUS[0]}
  if [ "$rc" = 0 ] || ! grep -q "keyDispatchingTimedOut" /tmp/gradle_android.log || [ "$attempt" = 2 ]; then break; fi
  echo "=== attempt $attempt died of an emulator ANR before/while starting the first test; repeating once ==="
  sleep 20
done
adb logcat -d -s dslink-test:V dslink-stack:V dslink-render:V dslink-audio:V dslink-jni:V dslink-nsd:V AndroidRuntime:E > /tmp/logcat_android.txt
echo "=================== logcat (dslink tags, last 120) ==================="
tail -120 /tmp/logcat_android.txt
if [ "$rc" != 0 ]; then   # an ANR kills the instrumentation (keyDispatchingTimedOut): show who was blocked and where
  echo "=================== ANR / input dispatching diagnostics ==================="
  adb logcat -d -b all 2>/dev/null | grep -iE "ANR in|Input dispatching timed out|am_anr|not responding|keyDispatching|Reason:|CPU usage|load:" | cut -c1-400 | tail -40
  adb root >/dev/null 2>&1; sleep 2
  for f in $(adb shell ls /data/anr 2>/dev/null | tr -d '\r' | head -3); do echo "--- /data/anr/$f (main thread) ---"; adb shell "grep -m1 -B2 -A25 '\"main\" prio' /data/anr/$f" 2>/dev/null | cut -c1-300; done
fi
echo "=================== SUMMARY ==================="
grep -E "FAILED|PASSED|Starting [0-9]+ tests|Tests on .* (failed|passed)" /tmp/gradle_android.log | sed 's/\x1b\[[0-9;]*m//g'
grep -E "dslink-test: java.lang.AssertionError" /tmp/logcat_android.txt | cut -c1-3000
echo "--- failures from the test result XML ---"
find app/build/outputs -name "*.xml" -path "*androidTest*" -print0 2>/dev/null | xargs -0 -r grep -h -A6 "<failure" | cut -c1-3000 | head -40
exit $rc
