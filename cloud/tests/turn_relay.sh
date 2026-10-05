#!/usr/bin/env bash
# Local proof of the media path Cloudflare Containers force on us (no inbound UDP): browser <-> TURN relay <-> gateway (TURN client).
# Starts the dev TURN server + the gateway in relay-only mode and runs the two-browser end-to-end test over relay<->relay.
# usage: turn_relay.sh <runtime> <core.so> <cfgtool> <romcheck> <rom1.nds> <rom2.nds>      (CHROME=... for a local Chromium)
set -euo pipefail
RT=$1; CORE=$2; CFG=$3; RC=$4; R1=$5; R2=$6
here=$(cd "$(dirname "$0")" && pwd)
( cd "$here/../gateway" && go build -o /tmp/dslink-gateway . && go build -o /tmp/devturn ./cmd/devturn )
/tmp/devturn >/tmp/devturn.log 2>&1 & T=$!
rm -rf /tmp/dslink-cloud
DSLINK_ICE='[{"urls":["turn:127.0.0.1:3478?transport=udp"],"username":"dslink","credential":"dslink-dev"}]' DSLINK_RELAY_ONLY=1 DSLINK_BACKEND=runtime \
  DSLINK_VIDEO_CODEC=${DSLINK_VIDEO_CODEC:-h264} DSLINK_RUNTIME=$RT DSLINK_CORE=$CORE DSLINK_CFGTOOL=$CFG DSLINK_ROMCHECK=$RC DSLINK_WORKDIR=/tmp/dslink-cloud \
  /tmp/dslink-gateway -addr :8080 -web "$here/../web" >/tmp/gw-turn.log 2>&1 & G=$!
trap 'kill $G $T 2>/dev/null || true' EXIT
for i in $(seq 1 30); do curl -sf localhost:8080/api/status >/dev/null && break; sleep 1; done
curl -s localhost:8080/api/config | grep -q '"iceTransportPolicy":"relay"'
cd "$here" && node browser_e2e.mjs http://localhost:8080 "$R1" "$R2" | tee /tmp/turn_e2e.log
out=$(node perf_probe.mjs http://localhost:8080 "$R1" "$R2" 10)
echo "$out" | grep -E 'icePath|fps|firstFrameMs|rttMs'
echo "$out" | grep -q 'relay<->relay' || { echo "FAIL: media did not use relay<->relay"; exit 1; }
echo "OK: relay-only media path verified"
