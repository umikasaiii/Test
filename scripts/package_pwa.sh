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
cat > "$OUT/index.html" <<'HTML'
<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=play/"><title>DSLink</title><a href="play/">DSLink</a>
HTML
touch "$OUT/.nojekyll"
echo "PWA ready in $OUT ($(du -sh "$OUT" | cut -f1)); serve it over HTTPS (e.g. GitHub Pages) and open /play/"
