# Invite a member

An admin invites an email, picks a role, and sees that person in the members table. The audit log and the development mail log record the invite. The invited person can sign in and does not see member administration.

## Sub-features

- `members-open` shows the invite form and the current admin.
- `members-invite` adds `eng@verify.test` as a data engineer.
- `members-audit` shows the invite on the audit page.
- `members-mail` prints the invite to the server log.
- `members-signin` lets the invited person sign in and hides member administration.

## How to get to it (user POV)

- Choose `成员` in the top nav. The path is `/members`.
- Admins also see `邀请成员、修改角色与移除成员` on the overview, but that line is not a link. The nav entry is the way in.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- Signed in as `admin@verify.test`.
- `eng@verify.test` is not already a member. Launch's empty tenant satisfies this. Do not run this recipe twice on the same database.

The whole recipe is `.cursor/skills/verify-ducked-init/scripts/drive-members.sh`. The commands below are what it runs.

- **Open members.** Choose `成员`. Run `node .cursor/skills/verify-ducked-init/scripts/browser.mjs click --role link --name "成员"` and `browser.mjs wait-url /members`. The title is `成员 · CRM 数据分析平台`. The heading is `成员`. `[data-email="admin@verify.test"]` is visible and the text `你` is in that row.
- **Fill the invite.** Run `browser.mjs fill --label "邮箱" --value "eng@verify.test"` and `browser.mjs select --label "角色" --value "data_engineer"`. The role control shows the value `data_engineer` (label `数据工程师`). Run `browser.mjs screenshot --path <evidence>/members-filled.png`.
- **Invite.** Choose `邀请`. Run `browser.mjs click --role button --name "邀请"` and `browser.mjs wait-selector '[data-email="eng@verify.test"]'`. Run `browser.mjs value --label "eng@verify.test 的角色"` and expect `data_engineer`. Run `browser.mjs screenshot --path <evidence>/members-saved.png` and `browser.mjs snapshot --path <evidence>/members.aria.txt`.
- **Audit view.** Choose `审计日志`. Run `browser.mjs click --role link --name "审计日志"`, `browser.mjs wait-url /audit`, `browser.mjs wait-text "邀请成员"`, and `browser.mjs wait-text "eng@verify.test，角色：数据工程师"`. `[data-audit-action="邀请成员"]` is visible. Run `browser.mjs screenshot --path <evidence>/audit.png`.
- **Stored member.** Run `scripts/sql.sh "SELECT email, role::text FROM platform.members m JOIN platform.tenants t ON t.id = m.tenant_id WHERE t.slug = 'verify' ORDER BY 1"`. Stdout contains `admin@verify.test|admin` and `eng@verify.test|data_engineer`.
- **Stored audit.** Run `scripts/sql.sh "SELECT action, coalesce(actor_email, ''), detail->>'email', detail->>'role' FROM platform.audit_logs WHERE action = 'member.invited'"`. Stdout is `member.invited|admin@verify.test|eng@verify.test|data_engineer`.
- **Mail.** The server log gains a console-mail block whose recipient is `eng@verify.test`, whose body contains `admin@verify.test 邀请你以「数据工程师」角色加入 验收租户。`, and whose login URL is `<BASE_URL>/login`. Copy that block to `<evidence>/invite-mail.txt`. The invite mail has no `/auth/verify` token.
- **Sign in as the invitee.** Choose `退出登录`. Run `browser.mjs click --role button --name "退出登录"` and `browser.mjs wait-url /login`. Sign in as `eng@verify.test` with the login recipe. The overview contains `当前租户 · 默认空间 · eng@verify.test（数据工程师）`. Run `browser.mjs count --selector 'a[href="/members"]'` and expect `0`. Run `browser.mjs screenshot --path <evidence>/home-engineer.png`.

## Gotchas

- Inviting an email that is already a member shows `操作未完成` and `已是本租户成员`. The table does not gain a second row. Treat a second run on the same database as a failed precondition, not as a product bug.
- The role `<select>` option value is `data_engineer`. The visible label is `数据工程师`. Selecting by the Chinese label through `select --value` will not match.
- Removing a member or changing your own role opens a `confirm()` dialog. This recipe does not do either. Accepting or dismissing that dialog is required before those buttons will submit.
- The invite mail is queued after the redirect. Wait until the block appears in the log. The members table is already updated before the mail is printed.
- The invite mail tells the person to use `/login`. It is not itself a Magic Link. Signing in as the invitee is a separate login request.
- `邮箱` is the invite field's label. Row role controls are named `<email> 的角色`, not `角色`.
