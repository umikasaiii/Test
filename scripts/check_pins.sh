#!/usr/bin/env bash
# Fails when a submodule is not at the commit pinned in upstream/versions.env.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/upstream/versions.env"
ra=$(git -C "$ROOT/upstream/retroarch" rev-parse HEAD)
md=$(git -C "$ROOT/upstream/melonds-ds" rev-parse HEAD)
[ "$ra" = "$RETROARCH_COMMIT" ] || { echo "RetroArch is at $ra, pinned $RETROARCH_COMMIT" >&2; exit 1; }
[ "$md" = "$MELONDS_DS_COMMIT" ] || { echo "melonDS DS is at $md, pinned $MELONDS_DS_COMMIT" >&2; exit 1; }
echo "pins OK: RetroArch $RETROARCH_TAG ($ra), melonDS DS $MELONDS_DS_TAG ($md), melonDS $MELONDS_COMMIT"
