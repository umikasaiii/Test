#!/usr/bin/env bash
# Assembles the static PWA (what a web host serves) into build/pwa: /play/ (app + WebAssembly core), /controls/ (the frozen touch controls), /mp/mp.css (shared look), and a root redirect.
# Needs the WASM build (scripts/build_wasm.sh). Contains no ROM, BIOS or firmware: those are imported by the user in the browser and never leave it.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/build/pwa"
[ -f "$ROOT/cloud/web/play/core/dslink_wasm.wasm" ] || { echo "run scripts/build_wasm.sh first" >&2; exit 1; }
rm -rf "$OUT" && mkdir -p "$OUT/mp"
cp -r "$ROOT/cloud/web/play" "$OUT/play"
cp -r "$ROOT/cloud/worker/public/controls" "$OUT/controls"
cp "$ROOT/cloud/web/mp/mp.css" "$OUT/mp/mp.css"
mkdir -p "$OUT/mp/vendor" && cp "$ROOT/cloud/web/mp/vendor/qrcode.js" "$ROOT/cloud/web/mp/vendor/jsQR.js" "$OUT/mp/vendor/"
cat > "$OUT/index.html" <<'HTML'
<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=play/"><title>DSLink</title><a href="play/">DSLink</a>
HTML
# --- where the DSLink Cloud lives (read by the PWA at start; nothing for the user to type). No DSLINK_CLOUD_URL = this page's own origin (the Worker serves the PWA itself).
#   DSLINK_CLOUD_URL=https://dslink-cloud.<account>.workers.dev  DSLINK_API_MODE=proxy|direct
#   proxy  (default for a static host such as Netlify): /api/* is proxied by the host (_redirects) so the session cookie is first-party (Safari blocks third-party cookies);
#          signaling and the presence socket go straight to the cloud (SSE/WebSocket do not survive a plain proxy).
#   direct: everything goes straight to the cloud (needs the page's origin in the Worker's ORIGINS and a browser that allows cross-site cookies).
CLOUD="${DSLINK_CLOUD_URL:-}"; CLOUD="${CLOUD%/}"
if [ -z "$CLOUD" ]; then printf '{ "api": "", "signal": "", "ws": "" }\n' > "$OUT/play/cloud-config.json"
elif [ "${DSLINK_API_MODE:-proxy}" = "direct" ]; then printf '{ "api": "%s", "signal": "%s", "ws": "%s" }\n' "$CLOUD" "$CLOUD" "$CLOUD" > "$OUT/play/cloud-config.json"
else
  printf '{ "api": "", "signal": "%s", "ws": "%s" }\n' "$CLOUD" "$CLOUD" > "$OUT/play/cloud-config.json"
  printf '/api/*  %s/api/:splat  200\n' "$CLOUD" > "$OUT/_redirects"
fi
# cross-origin isolation (SharedArrayBuffer radio ring) straight from the host's headers: Netlify and Workers static assets both read _headers
cat > "$OUT/_headers" <<'HDR'
/play/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
/controls/*
  Cross-Origin-Resource-Policy: same-origin
/mp/*
  Cross-Origin-Resource-Policy: same-origin
HDR
touch "$OUT/.nojekyll"
echo "PWA ready in $OUT ($(du -sh "$OUT" | cut -f1)); serve it over HTTPS (e.g. GitHub Pages) and open /play/"
