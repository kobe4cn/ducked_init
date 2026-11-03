#!/usr/bin/env bash
# Read-only SQL against the verification instance's platform database.
# Usage:
#   scripts/sql.sh "SELECT email, role::text FROM platform.members"
#   scripts/sql.sh <run-id-or-state-dir> "SELECT 1"
set -euo pipefail
source "$(dirname "$0")/lib.sh"
if [[ $# -ge 2 ]]; then
  verify_load_state "$1"
  shift
else
  verify_load_state
fi
if [[ $# -ne 1 ]]; then
  echo "usage: scripts/sql.sh [run-id] \"SQL\"" >&2
  exit 2
fi
exec psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -F'|' -c "$1"
