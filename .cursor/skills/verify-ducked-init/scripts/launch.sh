#!/usr/bin/env bash
# Start an isolated CRM 数据分析平台 dev server from an empty database and lake directory.
# Prints a READY line only after /login is usable and the seeded admin tenant is in PostgreSQL.
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
source "$DIR/lib.sh"
ROOT=$(verify_repo_root)

fail() {
  echo "LAUNCH FAIL: $*" >&2
  if [[ -n ${RUN_ID:-} ]]; then
    echo "Run: $DIR/cleanup.sh $RUN_ID" >&2
  fi
  exit 1
}

if [[ ! -d $ROOT/node_modules ]]; then
  fail "missing $ROOT/node_modules. From the repo root run: pnpm install --frozen-lockfile"
fi
command -v pnpm >/dev/null || fail "pnpm is not on PATH"
command -v psql >/dev/null || fail "psql is not on PATH"
command -v node >/dev/null || fail "node is not on PATH"
command -v curl >/dev/null || fail "curl is not on PATH"

PG_ADMIN_URL=${VERIFY_PG_ADMIN_URL:-postgres://crm:crm@127.0.0.1:5432/postgres}
if ! psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -tA -c 'SELECT 1' >/dev/null; then
  fail "cannot connect to VERIFY_PG_ADMIN_URL ($PG_ADMIN_URL). Start PostgreSQL 15+ and a role with CREATEDB and CREATEROLE. The repo default is: docker compose --profile pg up -d postgres (db_script/docker-compose.yml, user crm, password crm)."
fi

RUN_ID=${VERIFY_RUN_ID:-v$(date +%s)}
if [[ ! $RUN_ID =~ ^[a-z][a-z0-9]{0,30}$ ]]; then
  fail "VERIFY_RUN_ID must match ^[a-z][a-z0-9]{0,30}\$ (got $RUN_ID)"
fi

STATE_ROOT=$(verify_state_root)
STATE_DIR=$STATE_ROOT/$RUN_ID
if [[ -e $STATE_DIR ]]; then
  fail "state directory already exists: $STATE_DIR"
fi
mkdir -p "$STATE_DIR/lake"
EVIDENCE_DIR=${VERIFY_EVIDENCE_DIR:-/opt/cursor/artifacts/verify-ducked-init/$RUN_ID}
mkdir -p "$EVIDENCE_DIR"

if [[ -n ${VERIFY_PORT:-} ]]; then
  PORT=$VERIFY_PORT
  if [[ ! $PORT =~ ^[0-9]+$ ]]; then
    fail "VERIFY_PORT is not a number: $PORT"
  fi
else
  PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
fi

DB_NAME=crm_platform_verify_$RUN_ID
DATABASE_URL=${PG_ADMIN_URL%/*}/$DB_NAME
LAKE_DIR=$STATE_DIR/lake
LOG_FILE=$STATE_DIR/server.log
PID_FILE=$STATE_DIR/server.pid
BASE_URL=http://127.0.0.1:$PORT
TENANT_SLUG=verify
TENANT_NAME=验收租户
ADMIN_EMAIL=admin@verify.test
MASTER_KEY=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")

write_env_files() {
  local llm_name
  {
    echo "PLATFORM_DATABASE_URL=$(verify_sq "$DATABASE_URL")"
    echo "PLATFORM_LAKE_URI=$(verify_sq "$LAKE_DIR")"
    echo "PLATFORM_MASTER_KEY=$(verify_sq "$MASTER_KEY")"
    echo "MAILER=$(verify_sq console)"
    echo "MAGIC_LINK_RATE_LIMIT=$(verify_sq 50)"
    echo "MAGIC_LINK_RATE_WINDOW_MINUTES=$(verify_sq 15)"
    echo "NODE_ENV=$(verify_sq development)"
    echo "APP_ORIGIN=$(verify_sq "$BASE_URL")"
    # Copy every LLM_* variable that is set in this shell, including an empty value.
    # The dev server sources app.env, so a stub endpoint survives without the parent shell's exports.
    # An unset name is omitted on purpose: Vite loadEnv would otherwise refill it from a repo .env.
    while IFS= read -r llm_name; do
      [[ $llm_name == LLM_* ]] || continue
      echo "$llm_name=$(verify_sq "${!llm_name}")"
    done < <(compgen -v LLM_ || true)
  } >"$STATE_DIR/app.env"
  {
    echo "RUN_ID=$(verify_sq "$RUN_ID")"
    echo "STATE_DIR=$(verify_sq "$STATE_DIR")"
    echo "EVIDENCE_DIR=$(verify_sq "$EVIDENCE_DIR")"
    echo "LOG_FILE=$(verify_sq "$LOG_FILE")"
    echo "PID_FILE=$(verify_sq "$PID_FILE")"
    echo "PORT=$(verify_sq "$PORT")"
    echo "BASE_URL=$(verify_sq "$BASE_URL")"
    echo "PG_ADMIN_URL=$(verify_sq "$PG_ADMIN_URL")"
    echo "DATABASE_URL=$(verify_sq "$DATABASE_URL")"
    echo "DB_NAME=$(verify_sq "$DB_NAME")"
    echo "LAKE_DIR=$(verify_sq "$LAKE_DIR")"
    echo "TENANT_SLUG=$(verify_sq "$TENANT_SLUG")"
    echo "TENANT_NAME=$(verify_sq "$TENANT_NAME")"
    echo "ADMIN_EMAIL=$(verify_sq "$ADMIN_EMAIL")"
    echo "TENANT_ID=$(verify_sq "${TENANT_ID:-}")"
    echo "LAKE_ROLE=$(verify_sq "${LAKE_ROLE:-}")"
    echo "LAKE_ROLE_RO=$(verify_sq "${LAKE_ROLE_RO:-}")"
    echo "SERVER_PID=$(verify_sq "${SERVER_PID:-}")"
  } >"$STATE_DIR/state.env"
}

psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB_NAME\"" >/dev/null
write_env_files
ln -sfn "$STATE_DIR" "$STATE_ROOT/current"

set -a
# shellcheck disable=SC1090
source "$STATE_DIR/app.env"
set +a
# APP_ORIGIN is exported (from app.env), not unset: React Router dev merges vite.loadEnv(mode, root, "")
# into process.env, and loadEnv lets an already-set variable win over .env. An unset one is refilled
# from .env, so unsetting would let a repo .env redirect magic links to another host.
export APP_ORIGIN="$BASE_URL"
unset MAIL_HOST MAIL_USER MAIL_PASS

echo "migrating $DB_NAME"
if ! (cd "$ROOT" && pnpm db:migrate) >"$STATE_DIR/migrate.log" 2>&1; then
  tail -n 40 "$STATE_DIR/migrate.log" >&2 || true
  fail "pnpm db:migrate failed (see $STATE_DIR/migrate.log)"
fi

echo "creating tenant $TENANT_SLUG"
if ! (cd "$ROOT" && pnpm tenant:create --slug "$TENANT_SLUG" --name "$TENANT_NAME" --admin-email "$ADMIN_EMAIL") >"$STATE_DIR/tenant-create.log" 2>&1; then
  tail -n 60 "$STATE_DIR/tenant-create.log" >&2 || true
  fail "pnpm tenant:create failed (see $STATE_DIR/tenant-create.log)"
fi
if grep -q '初始化失败' "$STATE_DIR/tenant-create.log"; then
  cat "$STATE_DIR/tenant-create.log" >&2
  fail "tenant lake initialization failed"
fi

IFS='|' read -r TENANT_ID LAKE_ROLE LAKE_ROLE_RO LAKE_READY < <(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tA -F'|' -c \
  "SELECT t.id, tl.db_role, tl.ro_db_role, (tl.catalog_initialized_at IS NOT NULL)::text
   FROM platform.tenants t
   JOIN platform.tenant_lakes tl ON tl.tenant_id = t.id
   WHERE t.slug = 'verify'")
if [[ $LAKE_READY != true || -z $TENANT_ID || -z $LAKE_ROLE ]]; then
  fail "seeded tenant is missing or its lake is not initialized (id=$TENANT_ID ready=$LAKE_READY)"
fi
write_env_files

echo "starting dev server on $BASE_URL"
# Record this pid and kill only its descendant tree in cleanup.sh. nohup keeps it alive if the caller exits.
nohup bash -c "set -a; source $(verify_sq "$STATE_DIR/app.env"); set +a; unset MAIL_HOST MAIL_USER MAIL_PASS; cd $(verify_sq "$ROOT"); exec pnpm dev --host 127.0.0.1 --port $(verify_sq "$PORT") --strictPort" \
  >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" >"$PID_FILE"
write_env_files

ready=0
for _ in $(seq 1 300); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    tail -n 80 "$LOG_FILE" >&2 || true
    fail "dev server exited before /login was usable"
  fi
  code=$(curl -sS -o "$STATE_DIR/login.html" -w '%{http_code}' "$BASE_URL/login" 2>/dev/null || echo 000)
  if [[ $code == 200 ]] && grep -q '登录 CRM 数据分析平台' "$STATE_DIR/login.html"; then
    ready=1
    break
  fi
  sleep 1
done
if [[ $ready != 1 ]]; then
  tail -n 80 "$LOG_FILE" >&2 || true
  fail "timed out waiting for HTTP 200 from $BASE_URL/login containing 登录 CRM 数据分析平台"
fi

{
  echo "base_url=$BASE_URL"
  echo "http_status=$code"
  echo "login_marker=登录 CRM 数据分析平台"
  echo "tenant_id=$TENANT_ID"
  echo "lake_role=$LAKE_ROLE"
  echo "admin=$ADMIN_EMAIL"
  echo "database=$DB_NAME"
} >"$EVIDENCE_DIR/launch-ready.txt"

echo "READY base_url=$BASE_URL state=$STATE_DIR evidence=$EVIDENCE_DIR pid=$SERVER_PID database=$DB_NAME"
