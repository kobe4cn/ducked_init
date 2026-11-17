#!/bin/sh
# Isolated dispatcher run for the assertion-failure task error, console mail, and audit text.
# Not a browser recipe. Does not touch crm_platform or a crm_platform_verify_* database.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../../../.." && pwd)
cd "$ROOT"
TOKEN=${VERIFY_ASSERT_TOKEN:-$(date +%s | sha256sum | cut -c1-8)}
case "$TOKEN" in
  *[!a-z0-9]*|"" ) echo "VERIFY_ASSERT_TOKEN must match [a-z0-9]{1,12}" >&2; exit 2 ;;
esac
export VERIFY_ASSERT_TOKEN="$TOKEN"
export PLATFORM_DATABASE_URL="postgres://crm:crm@127.0.0.1:5432/crm_verify_aa${TOKEN}"
export TEST_SOURCE_DATABASE_URL="postgres://crm:crm@127.0.0.1:5432/crm_src_aa${TOKEN}"
export PLATFORM_LAKE_URI="${VERIFY_ASSERT_LAKE:-/tmp/verify-assert-${TOKEN}-lake}"
export PLATFORM_SOURCE_FILES_DIR="${VERIFY_ASSERT_SOURCES:-/tmp/verify-assert-${TOKEN}-sources}"
export PLATFORM_MASTER_KEY="${PLATFORM_MASTER_KEY:-$(node -e 'process.stdout.write(Buffer.alloc(32, 7).toString("base64"))')}"
export MAILER=console
export APP_URL="${APP_URL:-http://127.0.0.1:5173}"
export SOURCE_LARGE_TABLE_ROWS="${SOURCE_LARGE_TABLE_ROWS:-1000}"
export SOURCE_CONNECT_TIMEOUT_SECONDS="${SOURCE_CONNECT_TIMEOUT_SECONDS:-60}"
unset MAIL_HOST MAIL_USER MAIL_PASS TEST_TIMING
mkdir -p "$PLATFORM_LAKE_URI" "$PLATFORM_SOURCE_FILES_DIR"
exec node --import tsx "$ROOT/.cursor/skills/verify-ducked-init/scripts/assertion-alert.mts"
