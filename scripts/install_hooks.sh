#!/usr/bin/env bash
# Installs a local pre-commit hook that refuses to commit ROMs / BIOS / firmware (see scripts/check_no_private.py).
set -euo pipefail
root=$(git rev-parse --show-toplevel)
cat > "$root/.git/hooks/pre-commit" <<'H'
#!/usr/bin/env bash
exec python3 "$(git rev-parse --show-toplevel)/scripts/check_no_private.py" --staged
H
chmod +x "$root/.git/hooks/pre-commit"
echo "pre-commit guard installed"
