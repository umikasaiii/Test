#!/usr/bin/env bash
# Local coturn for the Internet tests (loopback only, test secret): `turn_local.sh start|stop|pid`.
# It speaks the SAME credential scheme the Worker uses (coturn use-auth-secret: username <expiry>[:tag], credential base64(HMAC-SHA1(secret, username))).
SECRET="${TURN_TEST_SECRET:-dslink-local-turn-test-secret}"; PORT="${TURN_TEST_PORT:-3478}"; PIDF=/tmp/dslink_turn.pid
case "${1:-start}" in
  start)
    "$0" stop >/dev/null 2>&1
    nohup turnserver --no-cli --no-tls --no-dtls --log-file=/tmp/dslink_turn.log --simple-log -n --listening-ip=127.0.0.1 --relay-ip=127.0.0.1 --listening-port="$PORT" --min-port=49200 --max-port=49400 \
      --use-auth-secret --static-auth-secret="$SECRET" --realm=dslink.test --allow-loopback-peers --no-multicast-peers --fingerprint --pidfile="$PIDF" >/tmp/dslink_turn.out 2>&1 &
    for i in $(seq 1 30); do sleep 0.2; [ -s "$PIDF" ] && break; done; cat "$PIDF" 2>/dev/null ;;
  stop) [ -s "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null; rm -f "$PIDF"; sleep 0.3 ;;
  pid) cat "$PIDF" 2>/dev/null ;;
esac
