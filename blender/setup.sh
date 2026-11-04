#!/usr/bin/env bash
# Create (or verify) the pinned headless-Blender Python env for the asset pipeline (ADR-0003 §Pipeline).
#
# Idempotent and re-runnable: a container can restart and lose $HOME/.cache, so every art build calls
# this first (via blender/run.mjs). When the venv already holds the pinned bpy it only verifies and
# exits in < 1 s; otherwise it (re)creates it from blender/requirements.txt.
#
#   bash blender/setup.sh            # create or verify
#   bash blender/setup.sh --print    # print the venv python path (no install)
#
# Inputs (run.mjs sets them from the consumer's blender.config.mjs; all optional):
#   ASSET_PIPELINE_VENV         venv folder, default ~/.cache/game-engine/bpy-<version>-py3.13 (outside any repo)
#   ASSET_PIPELINE_PYTHON       CPython 3.13 to create the venv with, default python3.13 on PATH
#   ASSET_PIPELINE_BPY_VERSION  expected bpy version, default the bpy== pin in requirements.txt
#   ASSET_PIPELINE_ROOT         the consumer's repo root; a venv inside it (or inside this package) is refused
# Needs pypi.org on first run (~384 MB wheel, ~1 GB installed).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REQ="$HERE/requirements.txt"
BPY_VERSION="${ASSET_PIPELINE_BPY_VERSION:-$(sed -n 's/^bpy==\([0-9][0-9A-Za-z.]*\).*/\1/p' "$REQ" | head -n 1)}"
if [[ -z "$BPY_VERSION" ]]; then
  echo "setup.sh: no bpy== pin in $REQ" >&2
  exit 2
fi
VENV="${ASSET_PIPELINE_VENV:-$HOME/.cache/game-engine/bpy-${BPY_VERSION}-py3.13}"
VENV="${VENV/#\~/$HOME}"
PY_BIN="$VENV/bin/python"

if [[ "${1:-}" == "--print" ]]; then
  echo "$PY_BIN"
  exit 0
fi

# Absolute path without requiring GNU realpath: resolve the deepest existing parent.
abs_path() {
  local p="$1" tail=""
  while [[ ! -d "$p" && "$p" != "/" && -n "$p" ]]; do
    tail="/$(basename "$p")$tail"
    p="$(dirname "$p")"
  done
  echo "$(cd "$p" && pwd -P)$tail"
}

# Refuse a venv inside a repo: 1 GB of Blender must never be staged or shipped.
VENV_ABS="$(abs_path "$VENV")"
for guard in "${ASSET_PIPELINE_ROOT:-}" "$(cd "$HERE/.." && pwd -P)"; do
  [[ -n "$guard" ]] || continue
  case "$VENV_ABS/" in
    "$(abs_path "$guard")"/*) echo "setup.sh: refusing venv inside a repo ($VENV); set ASSET_PIPELINE_VENV (config \`venv\`) elsewhere" >&2; exit 2 ;;
  esac
done

verify() {
  [[ -x "$PY_BIN" ]] || return 1
  "$PY_BIN" -I -c "import bpy, sys; v=bpy.app.version_string.split()[0]; sys.exit(0 if v=='${BPY_VERSION}' else 1)" >/dev/null 2>&1
}

if verify; then
  echo "setup.sh: bpy ${BPY_VERSION} ready at $PY_BIN"
  exit 0
fi

BASE_PY="${ASSET_PIPELINE_PYTHON:-$(command -v python3.13 || true)}"
if [[ -z "$BASE_PY" ]]; then
  echo "setup.sh: CPython 3.13 not found (bpy ${BPY_VERSION} ships cp313 wheels only); set ASSET_PIPELINE_PYTHON (config \`python\`)" >&2
  exit 3
fi

echo "setup.sh: creating $VENV with $BASE_PY"
mkdir -p "$(dirname "$VENV")"
# --clear makes a half-finished venv from an interrupted run safe to rebuild.
"$BASE_PY" -m venv --clear "$VENV"
"$PY_BIN" -m pip install --quiet --disable-pip-version-check --no-input -r "$REQ"

if ! verify; then
  echo "setup.sh: bpy import failed after install" >&2
  exit 4
fi
echo "setup.sh: bpy ${BPY_VERSION} installed at $PY_BIN"
