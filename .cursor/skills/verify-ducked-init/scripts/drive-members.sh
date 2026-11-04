#!/usr/bin/env bash
# Log in as the seeded admin, invite eng@verify.test as a data engineer, and prove the member, the audit row, the console mail, and a second login.
# Usage: scripts/drive-members.sh [run-id-or-state-dir]
set -euo pipefail
DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
source "$DIR/lib.sh"
verify_load_state "${1:-}"
EV=$EVIDENCE_DIR
mkdir -p "$EV"
: >"$EV/drive.log"

log() { printf '%s\n' "$*" | tee -a "$EV/drive.log" >&2; }
run() { log "+ $*"; "$@"; }
B() { node "$DIR/browser.mjs" "$@"; }

expect_title() {
  local want=$1 got
  got=$(B title)
  log "title=$got"
  [[ $got == "$want" ]] || { echo "title mismatch: [$got] want [$want]" | tee -a "$EV/drive.log" >&2; exit 1; }
}

login_as() {
  local email=$1 prefix=$2 offset url
  offset=$(wc -c <"$LOG_FILE" | tr -d ' ')
  run B goto /login
  run B screenshot --path "$EV/${prefix}-login-form.png"
  run B fill --label "工作邮箱" --value "$email"
  run B click --role button --name "发送登录链接"
  run B wait-text "请查收邮件"
  run B screenshot --path "$EV/${prefix}-login-sent.png"
  url=$(B magic-link --email "$email" --offset "$offset")
  log "magic-link $email $url"
  printf '%s\n' "$url" >"$EV/${prefix}-magic-link.txt"
  run B goto "$url"
  run B wait-text "确认登录"
  run B screenshot --path "$EV/${prefix}-login-confirm.png"
  run B click --role button --name "登录"
  run B wait-url /
  run B wait-text "验收租户"
}

log "drive members against $BASE_URL"
login_as "$ADMIN_EMAIL" admin
expect_title "CRM 数据分析平台"
run B wait-text "当前租户 · 默认空间 · admin@verify.test（管理员）"
run B screenshot --path "$EV/home-admin.png"
run B snapshot --path "$EV/home-admin.aria.txt"

run B click --role link --name "成员"
run B wait-url /members
expect_title "成员 · CRM 数据分析平台"
run B fill --label "邮箱" --value "eng@verify.test"
run B select --label "角色" --value "data_engineer"
run B screenshot --path "$EV/members-filled.png"
run B click --role button --name "邀请"
run B wait-selector '[data-email="eng@verify.test"]'
role=$(B value --label "eng@verify.test 的角色")
log "selected-role=$role"
[[ $role == data_engineer ]]
run B screenshot --path "$EV/members-saved.png"
run B snapshot --path "$EV/members.aria.txt"

run B click --role link --name "审计日志"
run B wait-url /audit
expect_title "审计日志 · CRM 数据分析平台"
run B wait-text "邀请成员"
run B wait-text "eng@verify.test，角色：数据工程师"
run B screenshot --path "$EV/audit.png"
run B snapshot --path "$EV/audit.aria.txt"

"$DIR/sql.sh" "$STATE_DIR" \
  "SELECT email, role::text FROM platform.members m JOIN platform.tenants t ON t.id = m.tenant_id WHERE t.slug = 'verify' ORDER BY 1" \
  | tee "$EV/members.sql.txt" | tee -a "$EV/drive.log"
grep -qx 'admin@verify.test|admin' "$EV/members.sql.txt"
grep -qx 'eng@verify.test|data_engineer' "$EV/members.sql.txt"

"$DIR/sql.sh" "$STATE_DIR" \
  "SELECT action, coalesce(actor_email, ''), detail->>'email', detail->>'role' FROM platform.audit_logs WHERE action = 'member.invited'" \
  | tee "$EV/audit.sql.txt" | tee -a "$EV/drive.log"
grep -qx 'member.invited|admin@verify.test|eng@verify.test|data_engineer' "$EV/audit.sql.txt"

mail_ok=0
for _ in $(seq 1 40); do
  if awk 'BEGIN{RS="======== 邮件（开发环境，输出到控制台）========"} index($0, "收件人：eng@verify.test") && index($0, "邀请你以「数据工程师」角色加入 验收租户。") { print; found=1 } END { exit !found }' "$LOG_FILE" >"$EV/invite-mail.txt"; then
    mail_ok=1
    break
  fi
  sleep 0.25
done
[[ $mail_ok == 1 ]] || { echo "invite mail was not printed to the server log" | tee -a "$EV/drive.log" >&2; exit 1; }
grep -F "在登录页输入本邮箱即可收到一次性登录链接：${BASE_URL}/login" "$EV/invite-mail.txt"
log "invite mail captured"

run B click --role button --name "退出登录"
run B wait-url /login
login_as "eng@verify.test" eng
expect_title "CRM 数据分析平台"
run B wait-text "当前租户 · 默认空间 · eng@verify.test（数据工程师）"
run B screenshot --path "$EV/home-engineer.png"
run B snapshot --path "$EV/home-engineer.aria.txt"
count=$(B count --selector 'a[href="/members"]')
log "members-link-count=$count"
[[ $count == 0 ]]
printf 'members-link-count=%s\n' "$count" >"$EV/engineer-nav.txt"
log "DRIVE PASS members eng@verify.test data_engineer"
echo "DRIVE PASS evidence=$EV"
