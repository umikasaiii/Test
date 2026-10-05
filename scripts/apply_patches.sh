#!/usr/bin/env bash
# Applies DSLink's patches to the pinned RetroArch checkout (idempotent). Usage: apply_patches.sh [retroarch_dir]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RA=${1:-$ROOT/upstream/retroarch}
cd "$RA"
for p in "$ROOT"/patches/retroarch/*.patch; do
  if git apply --check "$p" 2>/dev/null; then
    git apply "$p"; echo "applied  $(basename "$p")"
  elif git apply --reverse --check "$p" 2>/dev/null; then
    echo "already  $(basename "$p")"
  else
    echo "ERROR: $(basename "$p") neither applies nor is already applied" >&2; exit 1
  fi
done
