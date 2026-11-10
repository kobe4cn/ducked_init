#!/usr/bin/env bash
# Sign in as the seeded admin, save the tenant model provider and both tier cards against the local stub,
# accept the confirm dialogs for 恢复默认 and 恢复平台默认, send AI 助手 messages, and write one dirty tier row.
# Usage: VERIFY_LLM_LOG=<stub jsonl> scripts/drive-model.sh [run-id-or-state-dir]
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
source "$DIR/lib.sh"
verify_load_state "${1:-}"
# shellcheck disable=SC1090
source "$STATE_DIR/app.env"
EV=$EVIDENCE_DIR
mkdir -p "$EV"
: >"$EV/drive-model.log"

log() { printf '%s\n' "$*" | tee -a "$EV/drive-model.log" >&2; }
run() { log "+ $*"; "$@"; }
B() { node "$DIR/browser.mjs" "$@"; }
die() { log "drive-model: $*"; exit 1; }

expect_title() {
  local want=$1 got
  got=$(B title)
  log "title=$got"
  [[ $got == "$want" ]] || die "title mismatch: [$got] want [$want]"
}

for name in LLM_BASE_URL LLM_MODEL LLM_API_KEY LLM_REASONING_BASE_URL LLM_REASONING_MODEL LLM_REASONING_API_KEY; do
  [[ -n ${!name:-} ]] || die "app.env is missing a non-empty $name. Export LLM_* before launch.sh."
done
[[ $LLM_BASE_URL == http://127.0.0.1:*/platform/v1 ]] || die "LLM_BASE_URL must be http://127.0.0.1:<port>/platform/v1"
origin=${LLM_BASE_URL%/platform/v1}
[[ $LLM_REASONING_BASE_URL == "$origin/platform-reasoning/v1" ]] || die "LLM_REASONING_BASE_URL must be $origin/platform-reasoning/v1"
STUB_LOG=${VERIFY_LLM_LOG:-}
[[ -n $STUB_LOG ]] || die "set VERIFY_LLM_LOG to the stub jsonl path"
[[ -f $STUB_LOG ]] || die "VERIFY_LLM_LOG does not exist yet: $STUB_LOG"
curl -fsS "$origin/health" >/dev/null || die "stub is not serving $origin/health"

proc_url=$(tr '\0' '\n' <"/proc/$SERVER_PID/environ" | sed -n 's/^LLM_BASE_URL=//p' || true)
[[ $proc_url == "$LLM_BASE_URL" ]] || die "server environ LLM_BASE_URL does not match app.env"
python3 - "$STATE_DIR/app.env" "$EV/llm-env.txt" "$proc_url" <<'PY'
import sys
src, dst, proc_url = sys.argv[1], sys.argv[2], sys.argv[3]
lines = [f"process_LLM_BASE_URL={proc_url}"]
for line in open(src):
    if not line.startswith("LLM_"):
        continue
    name, _, raw = line.rstrip("\n").partition("=")
    val = raw[1:-1].replace("'\\''", "'") if raw.startswith("'") and raw.endswith("'") else raw
    if "KEY" in name:
        lines.append(f"{name}=set last4={val[-4:]}")
    else:
        lines.append(f"{name}={val}")
open(dst, "w").write("\n".join(lines) + "\n")
PY
log "app.env LLM_* matches the server process (keys recorded as last4 only)"

TENANT_URL=$origin/tenant/v1
TIER_URL=$origin/tier-reason/v1
DIRTY_URL=$origin/dirty/v1
TENANT_KEY=sk-tenant-AAAA
REASON_KEY=sk-reason-BBBB
WITHIN_TENANT='form:has(#model-base-url)'
WITHIN_FAST='form:has(#fast-model)'
WITHIN_REASON='form:has(#reasoning-model)'
WITHIN_RESET_FAST='form:has(input[name="intent"][value="tier_reset"]):has(input[name="tier"][value="fast"])'
WITHIN_RESET_REASON='form:has(input[name="intent"][value="tier_reset"]):has(input[name="tier"][value="reasoning"])'
WITHIN_RESET_PLATFORM='form:has(input[name="intent"][value="reset"])'

login_as() {
  local email=$1 offset url
  offset=$(wc -c <"$LOG_FILE" | tr -d ' ')
  run B goto /login
  run B screenshot --path "$EV/model-login-form.png"
  run B fill --label "工作邮箱" --value "$email"
  run B click --role button --name "发送登录链接"
  if ! B wait-text "请查收邮件"; then
    log "retry login after the first Vite reload"
    run B goto /login
    offset=$(wc -c <"$LOG_FILE" | tr -d ' ')
    run B fill --label "工作邮箱" --value "$email"
    run B click --role button --name "发送登录链接"
    run B wait-text "请查收邮件"
  fi
  run B screenshot --path "$EV/model-login-sent.png"
  url=$(B magic-link --email "$email" --offset "$offset")
  log "magic-link $email"
  printf '%s\n' "$url" >"$EV/model-magic-link.txt"
  run B goto "$url"
  run B wait-text "确认登录"
  run B click --role button --name "登录"
  run B wait-url /
  run B wait-text "验收租户"
}

ask() {
  local question=$1 shot=$2 open
  # The shell stays mounted across form posts, so the panel often stays open.
  # Clicking AI 助手 again toggles it shut and the aside covers the button.
  open=$(B count --selector 'textarea[aria-label="向 AI 助手提问"]')
  if [[ $open == 0 ]]; then
    run B click --role button --name "AI 助手"
    run B wait-selector 'textarea[aria-label="向 AI 助手提问"]'
  fi
  run B fill --label "向 AI 助手提问" --value "$question"
  run B click --role button --name "发送"
  run B wait-text "验收回复：${question}" --timeout 90000
  if [[ -n $shot ]]; then
    run B screenshot --path "$EV/$shot"
  fi
}

calls() {
  "$DIR/sql.sh" "$STATE_DIR" "SELECT purpose, model, coalesce(route, ''), coalesce(fallback_reason, '') FROM platform.llm_calls c JOIN platform.tenants t ON t.id = c.tenant_id WHERE t.slug = 'verify' ORDER BY c.created_at"
}

require_call() {
  local row=$1
  grep -Fqx "$row" <<<"$CALLS" || die "missing llm_calls row [$row]"
}

log "drive model provider and assistant against $BASE_URL"
login_as "$ADMIN_EMAIL"
run B click --role link --name "模型服务"
run B wait-url /model-provider
expect_title "模型服务 · CRM 数据分析平台"
run B wait-text "当前使用平台默认的模型服务"
run B wait-selector '[data-tier-fast="default"]'
run B wait-selector '[data-tier-reasoning="default"]'
run B screenshot --path "$EV/model-provider-platform.png"
run B snapshot --path "$EV/model-provider-platform.aria.txt"

run B fill --within "$WITHIN_TENANT" --label "端点" --value "$TENANT_URL"
run B fill --within "$WITHIN_TENANT" --label "模型名" --value "tenant-default"
run B fill --within "$WITHIN_TENANT" --label "API Key" --value "$TENANT_KEY"
run B click --within "$WITHIN_TENANT" --role button --name "保存"
run B wait-text "当前使用本租户的配置"

run B fill --within "$WITHIN_FAST" --label "模型名" --value "fast-model"
run B click --within "$WITHIN_FAST" --role button --name "保存"
run B wait-text "模型 fast-model，端点沿用本租户默认"
run B wait-selector '[data-tier-fast="tenant"]'

run B fill --within "$WITHIN_REASON" --label "模型名" --value "reason-model"
run B fill --within "$WITHIN_REASON" --label "端点" --value "$TIER_URL"
run B fill --within "$WITHIN_REASON" --label "API Key" --value "$REASON_KEY"
run B click --within "$WITHIN_REASON" --role button --name "保存"
run B wait-text "模型 reason-model，端点 ${TIER_URL}"
run B wait-selector '[data-tier-reasoning="tenant"]'
run B screenshot --path "$EV/model-provider-saved.png"
run B snapshot --path "$EV/model-provider-saved.aria.txt"

run B click --role button --name "测试连通性"
run B wait-text "连通成功" --timeout 60000
run B wait-text "支持工具调用" --timeout 60000
run B screenshot --path "$EV/model-provider-connectivity.png"

ask "档位推理" assistant-bound.png

run B click --within "$WITHIN_RESET_REASON" --role button --name "恢复默认" --confirm accept
run B wait-selector '[data-tier-reasoning="default"]'
run B click --within "$WITHIN_RESET_FAST" --role button --name "恢复默认" --confirm accept
run B wait-selector '[data-tier-fast="default"]'
run B screenshot --path "$EV/model-provider-tier-reset.png"

ask "恢复后回落" assistant-unbound.png

if "$DIR/sql.sh" "$STATE_DIR" "UPDATE platform.model_providers SET reasoning_model = 'blocked-by-readonly' WHERE false"; then
  die "sql.sh accepted a write"
fi
log "sql.sh rejected a write, as it should"
written=$("$DIR/sql-write.sh" "$STATE_DIR" "UPDATE platform.model_providers mp SET reasoning_model = 'dirty-model', reasoning_base_url = '${DIRTY_URL}', reasoning_api_key = NULL FROM platform.tenants t WHERE mp.tenant_id = t.id AND t.slug = 'verify' RETURNING reasoning_model")
[[ $written == dirty-model ]] || die "sql-write did not return dirty-model (got ${written:-empty})"
stored=$("$DIR/sql.sh" "$STATE_DIR" "SELECT mp.reasoning_model, coalesce(mp.reasoning_base_url, ''), coalesce(mp.reasoning_api_key, '') FROM platform.model_providers mp JOIN platform.tenants t ON t.id = mp.tenant_id WHERE t.slug = 'verify'")
[[ $stored == "dirty-model|${DIRTY_URL}|" ]] || die "dirty row mismatch: $stored"
printf '%s\n' "$stored" >"$EV/dirty-row.sql.txt"

run B goto /model-provider
run B wait-text "模型 dirty-model，端点 ${DIRTY_URL}"
run B screenshot --path "$EV/model-provider-dirty.png"

ask "脏档位" assistant-dirty.png
if ! grep -F 'model_providers 的 reasoning 档位有端点但没有 Key，按未绑定该档位处理' "$LOG_FILE" >"$EV/dirty-warn.txt"; then
  sleep 1
  grep -F 'model_providers 的 reasoning 档位有端点但没有 Key，按未绑定该档位处理' "$LOG_FILE" >"$EV/dirty-warn.txt" || die "server log has no dirty-tier warning"
fi

run B click --within "$WITHIN_RESET_PLATFORM" --role button --name "恢复平台默认" --confirm accept
run B wait-text "当前使用平台默认的模型服务"
run B screenshot --path "$EV/model-provider-platform-reset.png"

ask "平台推理" assistant-platform.png

CALLS=$(calls)
printf '%s\n' "$CALLS" >"$EV/llm-calls.txt"
log "llm_calls:"
printf '%s\n' "$CALLS" | tee -a "$EV/drive-model.log" >&2
require_call "connectivity|tenant-default||"
require_call "tool_probe|tenant-default||"
require_call "tool_probe|reason-model|reasoning|"
require_call "assistant|reason-model|reasoning|"
require_call "assistant|tenant-default|reasoning|unbound"
require_call "assistant|platform-reasoning|reasoning|"

cp "$STUB_LOG" "$EV/llm-stub.jsonl"
python3 - "$EV/llm-stub.jsonl" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
def seen(suffix, model, last4):
    return any(r["path"].split("?")[0].endswith(suffix) and r["model"] == model and r["authLast4"] == last4 for r in rows)
missing = []
if not seen("/tier-reason/v1/chat/completions", "reason-model", "BBBB"):
    missing.append("reason-model")
if not seen("/tenant/v1/chat/completions", "tenant-default", "AAAA"):
    missing.append("tenant-default")
if not seen("/platform-reasoning/v1/chat/completions", "platform-reasoning", "DDDD"):
    missing.append("platform-reasoning")
dirty = [r["path"] for r in rows if "/dirty/" in r["path"]]
if missing or dirty:
    raise SystemExit(f"stub log mismatch missing={missing} dirty={dirty}")
print(f"stub requests={len(rows)} dirty=0")
PY

log "drive-model PASS"
