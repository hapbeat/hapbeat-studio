#!/usr/bin/env bash
# Pre-commit: strip non-audio chunks from staged WAV files so author/copyright
# metadata never reaches the public git history. Re-stages files after rewriting.
#
# Install: run `bash scripts/install-git-hooks.sh` once per clone.

set -e

# Collect staged WAV files (Added/Copied/Modified/Renamed)
mapfile -t WAVS < <(git diff --cached --name-only --diff-filter=ACMR | grep -iE '\.wav$' || true)
[ "${#WAVS[@]}" -eq 0 ] && exit 0

# Find repo root for absolute paths
REPO_ROOT="$(git rev-parse --show-toplevel)"
SCRIPT="$REPO_ROOT/scripts/strip-wav-metadata.mjs"

if [ ! -f "$SCRIPT" ]; then
  # If running in a sub-repo without the script, fall back to workspace copy
  WS_SCRIPT="$REPO_ROOT/../hapbeat-studio/scripts/strip-wav-metadata.mjs"
  if [ -f "$WS_SCRIPT" ]; then
    SCRIPT="$WS_SCRIPT"
  else
    echo "[pre-commit] strip-wav-metadata.mjs not found; skipping WAV strip" >&2
    exit 0
  fi
fi

CHANGED=0
ABS_PATHS=()
for f in "${WAVS[@]}"; do
  ABS="$REPO_ROOT/$f"
  [ -f "$ABS" ] && ABS_PATHS+=("$ABS")
done

if [ "${#ABS_PATHS[@]}" -gt 0 ]; then
  # Capture sizes before/after to report what changed
  declare -A SIZE_BEFORE
  for p in "${ABS_PATHS[@]}"; do SIZE_BEFORE["$p"]=$(wc -c < "$p"); done

  node "$SCRIPT" "${ABS_PATHS[@]}" >/dev/null 2>&1 || true

  for p in "${ABS_PATHS[@]}"; do
    after=$(wc -c < "$p")
    before=${SIZE_BEFORE["$p"]}
    if [ "$before" -ne "$after" ]; then
      rel="${p#$REPO_ROOT/}"
      git add "$rel"
      echo "[pre-commit] stripped WAV metadata: $rel ($before -> $after bytes)"
      CHANGED=$((CHANGED + 1))
    fi
  done
fi

if [ "$CHANGED" -gt 0 ]; then
  echo "[pre-commit] re-staged $CHANGED file(s) after metadata strip"
fi
exit 0
