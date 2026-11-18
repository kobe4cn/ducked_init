#!/usr/bin/env bash
# HTTP acceptance for API key usage on the two consumer lookup routes.
# Requires a fresh launch.sh instance (doctor.sh already passed). No browser.
# Usage: scripts/api-key-usage.sh [run-id]
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
source "$DIR/lib.sh"
verify_load_state "${1:-}"
ROOT=$(verify_repo_root)
if [[ ! -f $STATE_DIR/app.env ]]; then
  echo "api-key-usage.sh: missing $STATE_DIR/app.env. Run launch.sh first." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$STATE_DIR/app.env"
set +a
export BASE_URL LOG_FILE EVIDENCE_DIR RUN_ID STATE_DIR
export NODE_PATH=$ROOT/node_modules
cd "$ROOT"
exec node --import tsx "$DIR/api-key-usage.mts"
