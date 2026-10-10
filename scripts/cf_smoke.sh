#!/usr/bin/env bash
# Smoke test of a deployed PlaySphere Cloud (used by .github/workflows/deploy.yml and the deploy-playsphere.yml bridge).
#   usage: scripts/cf_smoke.sh <https://worker-url> <true|false>      (second argument = R2_ENABLED)
# Every request states WHAT it checked and, when it fails, the exact method, path, HTTP status and (short, token-free) response body, so a red run is never a mystery.
# With R2 enabled: save round trip through the private bucket + anonymous refused. With R2 disabled: NO upload / download, the storage routes must answer 503 STORAGE_NOT_CONFIGURED.
# Everything else (health, PWA, signaling, account, friends, Party, ICE, account deletion) runs in both modes.
set -u
url="${1:?usage: cf_smoke.sh <url> <true|false>}"; url="${url%/}"; R2="${2:-false}"
out=$(mktemp); tok=""; u=""
H=(-H "origin: $url")

fail() { echo "::error::SMOKE FAILED - $*"; exit 1; }
# call <name> <expected-status-regex> <method> <path> [curl args...]   (sets CODE; the body is in $out)
call() {
  local name="$1" want="$2" m="$3" p="$4"; shift 4
  CODE=$(curl -s -m 60 -o "$out" -w '%{http_code}' -X "$m" "$url$p" "${H[@]}" "$@") || CODE="curl-error-$?"
  if ! [[ "$CODE" =~ $want ]]; then fail "$name: $m $p -> HTTP $CODE (expected $want): $(head -c 300 "$out" 2>/dev/null | tr -d '\r' | tr '\n' ' ')"; fi
  echo "ok   $name ($m $p -> $CODE)"
}
auth=(); body() { cat "$out"; }
cleanup() {                                   # the throw-away account never stays behind, even when a check failed
  if [ -n "$tok" ]; then curl -s -m 30 -o /dev/null -X DELETE "$url/api/account" "${H[@]}" -H "authorization: Bearer $tok" -H 'content-type: application/json' -d "{\"confirm\":\"$u\"}" || true; fi
  rm -f "$out" /tmp/s1.bin /tmp/s2.bin
}
trap cleanup EXIT

echo "Testing $url (R2_ENABLED=$R2)"
for i in $(seq 1 30); do [ "$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$url/api/health")" = 200 ] && break; sleep 4; done
call "Worker health" '^200$' GET /api/health
call "PWA served" '^200$' GET /play/
call "WebRTC signaling creates a room" '^200$' POST /signal/create -H 'content-type: application/json' -d '{}'

u="smoke$RANDOM$RANDOM"
call "smoke account registration" '^(200|201)$' POST /api/auth/register -H 'content-type: application/json' -d "{\"username\":\"$u\",\"password\":\"correct horse battery staple\"}"
tok=$(python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' < "$out") || fail "register answered $CODE without a token"
auth=(-H "authorization: Bearer $tok")

if [ "$R2" = "true" ]; then
  head -c 4096 /dev/urandom > /tmp/s1.bin
  call "R2: save upload" '^2' PUT "/api/saves/nds-smok?base=0&device=smoke-device-1&name=CI" "${auth[@]}" --data-binary @/tmp/s1.bin
  call "R2: save download" '^200$' GET /api/saves/nds-smok/data "${auth[@]}"
  cp "$out" /tmp/s2.bin; cmp -s /tmp/s1.bin /tmp/s2.bin || fail "R2 round trip: the downloaded save differs from the uploaded one"
  echo "ok   R2 round trip identical"
  CODE=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$url/api/saves/nds-smok/data"); [ "$CODE" = 401 ] || fail "anonymous save download -> HTTP $CODE (expected 401)"
  echo "ok   anonymous refused (401)"
else
  echo "R2 disabled — local storage mode"
  call "config reports storage=none" '^200$' GET /api/config
  [ "$(python3 -c 'import sys,json;print(json.load(sys.stdin).get("storage"))' < "$out")" = none ] || fail "/api/config should report storage=none: $(head -c 200 "$out")"
  for p in /api/saves/nds-smok /api/storage /api/files; do
    call "storage route $p answers 503" '^503$' GET "$p" "${auth[@]}"
    grep -q STORAGE_NOT_CONFIGURED "$out" || fail "GET $p answered 503 but not STORAGE_NOT_CONFIGURED: $(head -c 200 "$out")"
  done
  echo "ok   storage routes answer 503 STORAGE_NOT_CONFIGURED (no upload / download tried)"
fi

call "account: friends list" '^200$' GET /api/friends "${auth[@]}"
call "Party Voice: create" '^201$' POST /api/party "${auth[@]}"
call "Party Voice: leave" '^200$' POST /api/party/leave "${auth[@]}"
call "ICE servers (Internet multiplayer)" '^200$' GET /api/realtime/ice "${auth[@]}"
python3 -c 'import sys,json;d=json.load(sys.stdin);p=d["policy"];print("ICE:", "TURN relay available" if p["relayAvailable"] else "STUN only (relay NOT available)", "- ttl", d["ttlSeconds"], "s")' < "$out" || fail "ICE answer is not the expected JSON: $(head -c 200 "$out")"
CODE=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$url/api/realtime/ice"); [ "$CODE" = 401 ] || fail "anonymous GET /api/realtime/ice -> HTTP $CODE (expected 401)"
echo "ok   ICE endpoint refuses anonymous callers (401)"
call "smoke account deleted" '^200$' DELETE /api/account "${auth[@]}" -H 'content-type: application/json' -d "{\"confirm\":\"$u\"}"
tok=""

{ echo "CLOUD API URL: $url"; echo "SIGNALING URL: $url/signal"; echo "PWA URL: $url/play/"; [ "$R2" = "true" ] || echo "R2 disabled — local storage mode"; } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
echo "SMOKE OK"
