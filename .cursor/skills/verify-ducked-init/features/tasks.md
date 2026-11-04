# Task list

Any signed-in member can open the task list and see this tenant's recent jobs. On a tenant that launch just created, the list is empty: lake initialization does not enqueue a row the page shows.

## Sub-features

- `tasks-open` opens the task list from the top nav.
- `tasks-empty` shows the empty state when the tenant has no jobs.
- `tasks-identity` keeps the signed-in admin in the shell while the list is empty.

## How to get to it (user POV)

- Choose `任务` in the top nav. The path is `/tasks`.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- Signed in as `admin@verify.test`.
- This database has not had a task enqueued through the UI. Launch does not enqueue one.

- **Open tasks.** Choose `任务`. Run `node .cursor/skills/verify-ducked-init/scripts/browser.mjs click --role link --name "任务"` and `browser.mjs wait-url /tasks`. The document title is `任务 · CRM 数据分析平台`.
- **Empty state.** The heading is `任务`. The page contains `暂无任务。采集、同步、核对、合并等后台任务提交后会出现在这里。` Run `browser.mjs wait-text "任务"` and `browser.mjs wait-text "暂无任务。采集、同步、核对、合并等后台任务提交后会出现在这里。"`. Run `browser.mjs count --selector '[data-task-kind]'` and expect `0`.
- **Shell.** The avatar name is `我的设置（admin@verify.test）`. Run `browser.mjs count --selector 'a[href="/settings"]'` and expect `1`.
- **Stored tasks.** Run `scripts/sql.sh "SELECT count(*) FROM platform.tasks t JOIN platform.tenants n ON n.id = t.tenant_id WHERE n.slug = 'verify'"`. Stdout is `0`.
- **Proof.** Run `browser.mjs screenshot --path <evidence>/tasks-empty.png` and `browser.mjs snapshot --path <evidence>/tasks-empty.aria.txt`. Both show `任务` and `暂无任务`.

## Gotchas

- An empty list is the correct result for this seed. Starting `pnpm dispatcher` or inserting into `platform.tasks` is not the user path.
- The page says `本租户最近 200 个任务` even when there are none. That number is the page size, not a count of rows.
- When a task does exist, its row is `[data-task-kind="<kind>"][data-task-status="<status>"]` and the status text is `排队中`, `运行中`, `成功`, or `失败`. A succeeded row can be expanded with `查看结果`. This seed has no such row; do not report the expand control as verified from the empty state.
- Viewers can open `/tasks` too. They cannot open `/members`. Do not follow a missing members link on a viewer session as a task-list failure.
