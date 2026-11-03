# Audit log

An admin reads the tenant's recent critical actions. Launch writes one: the tenant was created. Later UI actions, such as inviting a member, append rows. The page does not edit history.

## Sub-features

- `audit-open` opens the audit log from the top nav.
- `audit-created` shows the tenant-creation row from launch.
- `audit-order` lists newer rows first. Launch's catalog init does not add a row.

## How to get to it (user POV)

- Choose `审计日志` in the top nav. The path is `/audit`.
- A data engineer, analyst, or viewer has no `审计日志` link and is not allowed to open the page.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- Signed in as `admin@verify.test`.
- Drive this before [invite a member](./members.md) if you need the list to contain only the launch rows. After an invite, `邀请成员` is also present; that does not remove the launch rows.

- **Open the log.** Choose `审计日志`. Run `node .cursor/skills/verify-ducked-init/scripts/browser.mjs click --role link --name "审计日志"` and `browser.mjs wait-url /audit`. The document title is `审计日志 · CRM 数据分析平台`. The heading is `审计日志`. The description contains `本租户最近 200 条关键操作记录，按时间倒序。`
- **Tenant created.** The page shows `开通租户`, actor `运营者（运营命令）`, and `租户「验收租户」，首个管理员 admin@verify.test`. Run `browser.mjs wait-text "开通租户"` and `browser.mjs wait-selector '[data-audit-action="开通租户"]'`. On a fresh launch that is the only row.
- **Stored rows.** Run `scripts/sql.sh "SELECT action FROM platform.audit_logs a JOIN platform.tenants t ON t.id = a.tenant_id WHERE t.slug = 'verify' ORDER BY a.created_at, a.id"`. Before any invite, stdout is `tenant.created`. The page shows `开通租户`.
- **Proof.** Run `browser.mjs screenshot --path <evidence>/audit-baseline.png` and `browser.mjs snapshot --path <evidence>/audit-baseline.aria.txt`. Both show `审计日志` and `开通租户`.

## Gotchas

- The action column is the Chinese label (`开通租户`, `邀请成员`). The stored `action` value (`tenant.created`, `member.invited`) appears in SQL, not in the table cell. `data-audit-action` uses the Chinese label.
- `pnpm tenant:create` initializes the lake (`catalog_initialized_at` is set; doctor checks it) and does not write `初始化数据湖`. That label is recorded when an operator runs lake init again from the ops tenant page, which this map does not drive. Do not wait for `初始化数据湖` after launch.
- Launch creates the tenant through `pnpm tenant:create`, which records the actor as `运营者（运营命令）` because no operator email was passed. Do not expect `admin@verify.test` on the `开通租户` row.
- The page is newest first. Comparing it to `ORDER BY created_at` without reversing the order looks like a mismatch.
- Signing in does not write an audit row. A missing login row is not a failure.
- `/audit` as a data engineer is a 403, not an empty table. This recipe stays on the admin session.
