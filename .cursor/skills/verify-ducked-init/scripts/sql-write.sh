#!/usr/bin/env bash
# Writable SQL against this run's verify database only.
# Usage:
#   scripts/sql-write.sh "UPDATE ..."
#   scripts/sql-write.sh <run-id-or-state-dir> "UPDATE ..."
# Refuses before connecting when the database name is not crm_platform_verify_<run-id>.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
if [[ $# -ge 2 ]]; then
  verify_load_state "$1"
  shift
else
  verify_load_state
fi
if [[ $# -ne 1 || -z $1 ]]; then
  echo "usage: scripts/sql-write.sh [run-id] \"SQL\"" >&2
  exit 2
fi

refuse() {
  echo "sql-write.sh: refusing database '$1' (writable SQL is limited to crm_platform_verify_<run-id> for this run)" >&2
  exit 1
}

if [[ ! ${RUN_ID:-} =~ ^[a-z][a-z0-9]{0,30}$ ]]; then
  refuse "${RUN_ID:-}"
fi
expect=crm_platform_verify_$RUN_ID
[[ ${DB_NAME:-} == "$expect" ]] || refuse "${DB_NAME:-}"

url_name=$(python3 -c 'import sys; from urllib.parse import urlparse; print(urlparse(sys.argv[1]).path.lstrip("/").split("/")[0])' "${DATABASE_URL:-}")
[[ $url_name == "$expect" ]] || refuse "$url_name"

# Clear PGOPTIONS so a parent read-only setting cannot redirect this helper.
actual=$(PGOPTIONS= psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -tA -c 'SELECT current_database()')
[[ $actual == "$expect" ]] || refuse "$actual"

# -q keeps the command tag (UPDATE 1) off stdout so callers see returned rows, same as sql.sh.
PGOPTIONS= exec psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -tA -F'|' -c "$1"
