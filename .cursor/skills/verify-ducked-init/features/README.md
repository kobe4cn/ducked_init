# CRM 数据分析平台 verification map

This directory is the maintained source for verifying the user-facing behavior of the CRM 数据分析平台 web app. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `.cursor/skills/verify-ducked-init/scripts/launch.sh` and wait for a `READY ` line.
- Run `.cursor/skills/verify-ducked-init/scripts/doctor.sh` and require `DOCTOR PASS`.
- The instance serves `BASE_URL` from that READY line. The database and lake directory belong to that run only.
- Seeded tenant: slug `verify`, name `验收租户`, space `默认空间`, admin `admin@verify.test`.
- `MAILER=console`. Magic Link and invite mail are printed to the server log, not sent over SMTP.
- Put nothing on a shared `crm_platform` database. Never drive an instance that this launch did not start.
- System Chrome is available (`CHROME_PATH` or `google-chrome` / `chromium` on `PATH`).

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Drive the browser with `node .cursor/skills/verify-ducked-init/scripts/browser.mjs`. Names and labels are exact accessible names.
- Read stored rows with `scripts/sql.sh`. It is read-only.
- A state the form rejects, such as a tier endpoint with no API key, is written with `scripts/sql-write.sh`. It runs only against `crm_platform_verify_<run-id>` and refuses any other database name before connecting. Do not use it to insert members, sessions, or audit rows.
- Copy log excerpts into the evidence directory before cleanup. Cleanup deletes the server log.
- Restore nothing by deleting proof files. Cleanup may drop the database; it must not delete evidence.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot (`snapshot --path`) and a screenshot (`screenshot --path`) that show the brand `CRM 数据分析平台` or the page title.
- Mutation proof includes a second user-facing view and a read-only SQL view of the stored row.
- Mail proof is the console block copied out of the server log, including the recipient and the link or the login URL it actually printed.
- Record the feature id, the base URL, and the entry point with the artifacts.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with Playwright` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Log in with a Magic Link](./login.md) covers requesting a link, confirming it, and landing on the tenant overview.
- [Tenant overview](./overview.md) covers the signed-in home page: tenant, space, role, task counts, and the permission list.
- [Invite a member](./members.md) covers inviting a data engineer, the members table, the audit row, the console mail, and signing in as that person.
- [Task list](./tasks.md) covers the empty task list on a freshly seeded tenant. It does not expand `查看结果` and does not start the dispatcher.
- [Upload a CSV and preview it](./sources-upload.md) covers `/sources` file upload: GBK preview, a delimiter change, a column-type change, register, no source or lake write from preview alone, analyst 403, and the upload-size 413.
- [Data source scroll](./source-scroll.md) covers a read-only Postgres source with enough tables that the sync-scope button is below a 1440×900 viewport: saving the scope, confirming a watermark, declaring a key, confirming a soft-delete column, an empty-key error, and `window.scrollY` staying put.
- [定义页的断言失败](./definition-failure.md) covers a published order metric whose latest compute failed 金额非负: the red alert (name, row count, task time, the no-snapshot sentence), the first failing keys and source mapping and the `/quality?task=` link for a role with `sources:read`, the same alert without those for a viewer, and the alert disappearing after a successful recompute.
- [新建指标（条件构建器）](./metric-builder.md) covers building a metric with the condition builder: check without saving (summary + SQL), save as draft v1, ignored empty rows, invalid forms 400, YAML mode, handmade `form` submissions, and the out-of-vocabulary agg field dropdown (every field stays listed, the current field stays selected, and a supported agg filters by type again).
- [新建标签（条件构建器）](./tag-builder.md) covers building a tag from published numeric metrics: single/multi-metric rules with one level of all / any, missing-value strategy, default, save as draft v1 with the same YAML as handwritten, and YAML mode.
- [Audit log](./audit.md) covers the tenant-creation row written by launch. Lake init during launch does not add an audit row.
- [Operator tenant storage quota](./ops-quota.md) covers `/ops/tenants/<id>`: Magic Link plus TOTP, the default quota, a saved value that survives reload, the tenant audit row, rejected values, the numeric bounds, and a tenant member who cannot set it.
- [Operator model prices](./ops-model-prices.md) covers `/ops/model-prices`: Magic Link plus TOTP, an empty table, create and update `m-fast`, two operator audit rows with tenant `平台`, a same-value save that does not add an audit row, rejected prices, and a tenant admin sent to `/ops/login`.
- [模型服务](./model-provider.md) covers the tenant provider, the fast and reasoning cards, input values after save and after 恢复默认 (the other card unchanged, API Key not echoed), a rejected tier draft, embedding 恢复平台默认, 测试连通性, and a dirty tier row.
- [模型调用](./llm-usage.md) covers `/llm-usage` for an admin: empty state, 7/30 day purpose stats and a separate totals row, schema pass rate 「—」 when nothing was checked, pagination and a truncated error, 403 for the other roles, a second tenant's rows staying on that tenant, and a connectivity success plus an unreachable-endpoint failure.
- [AI 助手](./assistant.md) covers sending a message and checking the stub request plus the `llm_calls` row (model, route, fallback_reason).
- [记为知识提案](./assistant-knowledge.md) covers candidate buttons, the confirm card, the pending term-default proposal, the 409/403/400/404 posts, a shared viewer, and the lineage tab switch that must not reload the panel. The stock LLM stub does not drive it.
- [业务知识（词的默认指向）](./knowledge.md) covers a pending `term_default` proposal on `/knowledge`: the text, accept and reject only, accepting it, replacing the same word on another target, a viewer who cannot accept, and a rejected edited accept.
- Catalog embeddings have no browser feature. `platform.catalog_embeddings` is not shown on a page. When a diff touches `app/.server/catalog/embeddings.ts` or `app/.server/catalog/vector-store.ts`, skip `launch.sh` and follow [Catalog embeddings](../SKILL.md#catalog-embeddings).
