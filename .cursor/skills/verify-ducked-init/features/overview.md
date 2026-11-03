# Tenant overview

The home page tells the signed-in member which tenant, space, and role they are in, how many tasks are queued, running, failed, or succeeded, how many data sources exist, and which operations that role can and cannot do.

## Sub-features

- `overview-identity` shows the tenant name, default space, email, and role.
- `overview-counts` shows zero tasks and zero data sources on a fresh tenant.
- `overview-permissions` lists every permission as available for the admin.
- `overview-nav` shows the admin navigation, including members and audit.

## How to get to it (user POV)

- Sign in. The confirm button lands on `/`.
- Choose `概览` in the top nav from any other signed-in page.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- The browser is signed in as `admin@verify.test` (see [login](./login.md)).
- No task has been enqueued and no data source has been registered in this database.

- **Open overview.** From another page, choose `概览`. Run `node .cursor/skills/verify-ducked-init/scripts/browser.mjs click --role link --name "概览"` and `browser.mjs wait-url /`. Immediately after login, skip the click; the path is already `/`.
- **Identity.** The document title is `CRM 数据分析平台`. The heading is `验收租户`. The description reads `当前租户 · 默认空间 · admin@verify.test（管理员）`. Run `browser.mjs title`, `browser.mjs wait-text "验收租户"`, and `browser.mjs wait-text "当前租户 · 默认空间 · admin@verify.test（管理员）"`.
- **Counts.** The page shows `进行中`, `失败`, `成功`, and `数据源数`, each with value `0`. The hint under `进行中` reads `排队 0 · 运行 0`. Run `browser.mjs wait-text "数据源数"` and `browser.mjs wait-text "排队 0 · 运行 0"`.
- **Permissions.** The section heading is `我的权限`. `邀请成员、修改角色与移除成员` is visible. Run `browser.mjs wait-text "我的权限"` and `browser.mjs wait-selector '[data-permission="members:manage"][data-allowed="true"]'`.
- **Nav.** `成员` and `审计日志` are links. Run `browser.mjs count --selector 'a[href="/members"]'` and expect `1`.
- **Proof.** Run `browser.mjs screenshot --path <evidence>/overview.png` and `browser.mjs snapshot --path <evidence>/overview.aria.txt`. Both show `CRM 数据分析平台`, `验收租户`, and `admin@verify.test`.

## Gotchas

- The heading is the tenant name, not the word 概览. The nav link `概览` is how you get there.
- A viewer does not get `数据源数` and does not get a `成员` link. This recipe is the admin seed. Do not treat a missing members link as an admin failure if you signed in as someone else.
- Counts are for this tenant only. Another verification database does not change them.
- Task counts stay at zero until some UI action enqueues work. Do not start `pnpm dispatcher` or insert into `platform.tasks` to make the numbers move for this check.
