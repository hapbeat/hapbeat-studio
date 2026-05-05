#!/usr/bin/env bash
# Install repo-local git hooks (pre-commit WAV metadata stripper).
# Run once after clone. Idempotent.
set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"
mkdir -p "$HOOKS_DIR"

HOOK="$HOOKS_DIR/pre-commit"

# Locate hook source: prefer this repo, fall back to sibling hapbeat-studio.
SRC="$REPO_ROOT/scripts/pre-commit-strip-wav.sh"
if [ ! -f "$SRC" ]; then
  for cand in \
    "$REPO_ROOT/../hapbeat-studio/scripts/pre-commit-strip-wav.sh" \
    "$(dirname "$0")/pre-commit-strip-wav.sh"; do
    if [ -f "$cand" ]; then
      SRC="$(cd "$(dirname "$cand")" && pwd)/$(basename "$cand")"
      break
    fi
  done
fi

if [ ! -f "$SRC" ]; then
  echo "[install-git-hooks] pre-commit-strip-wav.sh not found in $REPO_ROOT/scripts or sibling hapbeat-studio/scripts" >&2
  exit 1
fi

# If a pre-commit already exists, append our invocation; otherwise create one.
if [ -f "$HOOK" ] && ! grep -q "pre-commit-strip-wav.sh" "$HOOK"; then
  echo "" >> "$HOOK"
  echo "bash \"$SRC\"" >> "$HOOK"
  echo "[install-git-hooks] appended to existing pre-commit hook"
elif [ ! -f "$HOOK" ]; then
  cat > "$HOOK" <<EOF
#!/usr/bin/env bash
bash "$SRC"
EOF
  chmod +x "$HOOK"
  echo "[install-git-hooks] installed pre-commit hook"
else
  echo "[install-git-hooks] already installed"
fi
