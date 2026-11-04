#!/usr/bin/env bash
# Stop the verification server this run started, drop its database and lake roles, delete its state dir.
# Evidence under EVIDENCE_DIR is left in place.
# Usage: scripts/cleanup.sh [run-id-or-state-dir]
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
source "$DIR/lib.sh"
verify_load_state "${1:-}"

if [[ -n ${STATE_DIR:-} && -f ${STATE_DIR}/browser.pid ]]; then
  verify_kill_tree "$(cat "${STATE_DIR}/browser.pid")"
fi

if [[ -n ${SERVER_PID:-} ]]; then
  verify_kill_tree "$SERVER_PID"
  for _ in $(seq 1 20); do
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    # Second pass: SIGKILL the same tree only.
    children=$(ps -o pid= --ppid "$SERVER_PID" 2>/dev/null || true)
    for child in $children; do
      kill -9 "$child" 2>/dev/null || true
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
fi

if [[ -n ${STATE_DIR:-} && -d ${STATE_DIR}/chrome-profile ]]; then
  # Match the profile path we passed to Chrome, not the process name. STATE_DIR is the real path
  # (verify_load_state) and browser.mjs realpaths it too, so the `current` symlink never appears here.
  pids=$(ps -eo pid=,args= | awk -v dir="${STATE_DIR}/chrome-profile" 'index($0, dir) && $2 !~ /awk/ { print $1 }')
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
fi

if [[ -n ${DB_NAME:-} && -n ${PG_ADMIN_URL:-} ]]; then
  psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB_NAME' AND pid <> pg_backend_pid()" \
    >/dev/null || true
  psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB_NAME\"" >/dev/null
fi

drop_role() {
  local role=$1
  [[ -n $role ]] || return 0
  psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS \"$role\"" >/dev/null || \
    echo "CLEANUP WARN: could not drop role $role" >&2
}
drop_role "${LAKE_ROLE_RO:-}"
drop_role "${LAKE_ROLE:-}"

root=$(verify_state_root)
if [[ -L $root/current ]]; then
  current=$(readlink -f "$root/current" || true)
  if [[ $current == "$STATE_DIR" ]]; then
    rm -f "$root/current"
  fi
fi

kept=$EVIDENCE_DIR
rm -rf "$STATE_DIR"
echo "CLEANUP DONE state removed"
if [[ -n ${kept:-} && -d $kept ]]; then
  echo "EVIDENCE KEPT $kept"
  find "$kept" -type f | sort
else
  echo "EVIDENCE KEPT (directory was not created: ${kept:-unset})"
fi
