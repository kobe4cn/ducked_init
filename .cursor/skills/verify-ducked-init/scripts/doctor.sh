#!/usr/bin/env bash
# Read-only check: is the verification instance worth driving?
# Usage: scripts/doctor.sh [run-id-or-state-dir]
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
source "$DIR/lib.sh"
verify_load_state "${1:-}"
mkdir -p "$EVIDENCE_DIR"
REPORT=$EVIDENCE_DIR/doctor.txt
: >"$REPORT"

fail() {
  echo "DOCTOR FAIL: $*" | tee -a "$REPORT" >&2
  exit 1
}
ok() {
  echo "DOCTOR OK: $*" | tee -a "$REPORT"
}

[[ -n ${SERVER_PID:-} && -f ${PID_FILE:-} ]] || fail "no server pid recorded"
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  fail "server pid $SERVER_PID is not running"
fi
ok "server pid $SERVER_PID is running"

listener_pid=$(verify_listener_pids "$PORT" | head -1)
if [[ -z $listener_pid ]]; then
  fail "nothing is listening on TCP port $PORT"
fi
if ! verify_pid_is_descendant "$listener_pid" "$SERVER_PID"; then
  fail "port $PORT is held by pid $listener_pid, which is not the server we started ($SERVER_PID)"
fi
ok "port $PORT is held by pid $listener_pid (descendant of $SERVER_PID)"

body=$STATE_DIR/doctor-login.html
code=$(curl -sS -o "$body" -w '%{http_code}' "$BASE_URL/login" || echo 000)
if [[ $code != 200 ]] || ! grep -q '登录 CRM 数据分析平台' "$body"; then
  fail "GET $BASE_URL/login returned $code and did not contain 登录 CRM 数据分析平台"
fi
ok "GET /login returned 200 with 登录 CRM 数据分析平台"

admin=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -F'|' -c \
  "SELECT t.slug, t.name, s.name, m.email, m.role::text
   FROM platform.tenants t
   JOIN platform.spaces s ON s.tenant_id = t.id AND s.is_default
   JOIN platform.members m ON m.tenant_id = t.id
   WHERE t.slug = 'verify' AND m.email = 'admin@verify.test'")
if [[ $admin != 'verify|验收租户|默认空间|admin@verify.test|admin' ]]; then
  fail "admin seed row mismatch: [$admin]"
fi
ok "tenant verify / 验收租户 / 默认空间 / admin@verify.test / admin"

lake=$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -F'|' -c \
  "SELECT (tl.catalog_initialized_at IS NOT NULL)::text, tl.data_path, tl.db_role
   FROM platform.tenant_lakes tl
   JOIN platform.tenants t ON t.id = tl.tenant_id
   WHERE t.slug = 'verify'")
IFS='|' read -r ready data_path role <<<"$lake"
if [[ $ready != true ]]; then
  fail "tenant lake is not initialized: [$lake]"
fi
case $data_path in
  "$LAKE_DIR"/*) ;;
  *) fail "lake data_path $data_path is not under $LAKE_DIR" ;;
esac
if [[ $role != "$LAKE_ROLE" ]]; then
  fail "lake role $role does not match recorded $LAKE_ROLE"
fi
ok "lake initialized at $data_path role $role"

if [[ -f $LOG_FILE ]] && grep -q '\[后台任务失败\]' "$LOG_FILE"; then
  fail "server log contains [后台任务失败]"
fi
ok "server log has no [后台任务失败]"
ok "base_url=$BASE_URL evidence=$EVIDENCE_DIR"
echo "DOCTOR PASS"
echo "DOCTOR PASS" >>"$REPORT"
