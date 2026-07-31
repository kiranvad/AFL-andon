#!/usr/bin/env bash
set -euo pipefail

# Activate the environment that provides `tiled`. Override this name when
# your installation uses a different environment.
TILED_CONDA_ENV="${TILED_CONDA_ENV:-afl_agent}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if command -v conda >/dev/null 2>&1; then
  eval "$(conda shell.bash hook)"
  conda activate "$TILED_CONDA_ENV"
fi

exec tiled serve config "$SCRIPT_DIR/tiled_config.yml"
