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
- [Login page locale](./login-locale.md) covers Chinese copy with `lang=zh-CN` when `CRM_ENABLE_EN_LOCALE` is off, English copy with `lang=en` when that variable is `1` and the plaintext cookie `crm_locale=en` is set, the 1-minute and 5-minute rate-limit sentences, and the return to Chinese when the cookie or the flag is cleared. `launch.sh` writes the flag and the rate-limit numbers from the launch shell.
- [模型调用的数字和日期](./llm-usage-locale.md) covers `/llm-usage` thousands separators and 24-hour times with no cookie, `M/D/YYYY, h:mm:ss AM/PM` after `crm_locale=en`, and the return to 24-hour times after `cookie --clear --name crm_locale`, which deletes only that cookie and leaves the login session. A cookie value other than `en` stays Chinese. The amount column is unchanged.
- [Tenant overview](./overview.md) covers the signed-in home page: tenant, space, role, task counts, and the permission list.
- [Invite a member](./members.md) covers inviting a data engineer, the members table, the audit row, the console mail, and signing in as that person.
- [Task list](./tasks.md) covers the empty task list on a freshly seeded tenant. It does not expand `查看结果` and does not start the dispatcher.
- [Snapshot pages](./snapshots.md) covers a repurchase snapshot, a CLV snapshot, and one other template's generic snapshot once those rows exist. The tenant created by `launch.sh` has none. An empty `还没有结果快照。` is not a pass.
- [Cohort snapshot](./cohort-snapshot.md) covers the retention matrix, the per-person tab, and pagination that keeps `tab=consumers`. A launch with no snapshot is not a pass. `sql.sh` cannot read the gold table.
- [Template upgrade notes](./template-upgrade.md) covers the RFM upgrade banner, the preview header, the summary line, the churn column table and metric line, a matrix-cell sample, an output-column sample, downstream impact, and the downstream API key list (`[data-downstream-keys]`: name, revoked mark, and last-30-UTC-day call count) when `TEMPLATE_TEST_VERSIONS=1` and the published template is locked behind the latest version. `launch.sh` copies that variable only when the launch shell already exported it. A launch that does not export it is not this check.
- [用户 360 快照](./user360-snapshot.md) covers the default 汇总 tab (three cards and six channel counts), a single-row lookup, the format and not-found hints, and the 逐人明细 tab including a page that clamps and stays on that tab. A launch with no snapshot is not a pass. `scripts/sql.sh` cannot reconcile the gold table.
- [Upload a CSV and preview it](./sources-upload.md) covers `/sources` file upload: GBK preview, a delimiter change, a column-type change, register, no source or lake write from preview alone, analyst 403, and the upload-size 413.
- [Data source scroll](./source-scroll.md) covers a read-only Postgres source with enough tables that the sync-scope button is below a 1440×900 viewport: saving the scope, confirming a watermark, declaring a key, confirming a soft-delete column, an empty-key error, and `window.scrollY` staying put.
- [定义页的断言失败](./definition-failure.md) covers a published order metric whose latest compute failed 金额非负: the red alert (name, row count, task time, the no-snapshot sentence), the first failing keys and source mapping and the `/quality?task=` link for a role with `sources:read`, the same alert without those for a viewer, and the alert disappearing after a successful recompute.
- Assertion-failure task error, mail, and audit have no browser feature. The definition-page alert does not read `platform.tasks.error`, the console mail, or the `assertion.failed` description. When a diff changes those strings, skip `launch.sh` and follow [Assertion failure alert](../SKILL.md#assertion-failure-alert).
- [新建指标（条件构建器）](./metric-builder.md) covers building a metric with the condition builder: check without saving (summary + SQL), save as draft v1, ignored empty rows, invalid forms 400, YAML mode, handmade `form` submissions, and the out-of-vocabulary agg field dropdown (every field stays listed, the current field stays selected, and a supported agg filters by type again).
- [一句话解析指标](./metric-parse.md) covers 解析一句话 filling the builder and showing 逐项说明 without saving, the amber 这些词有多种理解 block when two published metrics share an alias (builder parse and YAML 用模型生成草稿, with `/knowledge?item=` links), and the block disappearing after that word's default is accepted. The stock LLM stub cannot drive it.
- [新建标签（条件构建器）](./tag-builder.md) covers building a tag from published numeric metrics: single/multi-metric rules with one level of all / any, missing-value strategy, default, save as draft v1 with the same YAML as handwritten, and YAML mode.
- [Audit log](./audit.md) covers the tenant-creation row written by launch. Lake init during launch does not add an audit row.
- [Operator tenant storage quota](./ops-quota.md) covers `/ops/tenants/<id>`: Magic Link plus TOTP, the default quota, a saved value that survives reload, the tenant audit row, rejected values, the numeric bounds, and a tenant member who cannot set it.
- [Operator model prices](./ops-model-prices.md) covers `/ops/model-prices`: Magic Link plus TOTP, an empty table, create and update `m-fast`, two operator audit rows with tenant `平台`, a same-value save that does not add an audit row, rejected prices, and a tenant admin sent to `/ops/login`.
- [模型服务](./model-provider.md) covers the tenant provider, the fast and reasoning cards, input values after save and after 恢复默认 (the other card unchanged, API Key not echoed), a rejected tier draft, embedding 恢复平台默认, 测试连通性, a dirty tier row, and the vector store card (encrypted URL, blank field keeps the ciphertext, one audit row, data engineer 403). Open `管理` before `模型服务`.
- [Operator model-call summary](./ops-llm-usage.md) covers `/ops/llm-usage`: the `来源` column after `用途`, one row per source inside a tenant/model/purpose group, the labels `租户` / `平台` / `—`, and the order tenant then platform then a row with no source. A call 40 days old is on neither window.
- [模型调用](./llm-usage.md) covers `/llm-usage` for an admin: empty state, 7/30 day purpose stats and a separate totals row, the `调用来源` card (`租户 n / 平台 n`, and `未记录 n` only when a source is empty), schema pass rate 「—」 when nothing was checked, pagination and a truncated error, 403 for the other roles, a second tenant's rows staying on that tenant, and a connectivity success plus an unreachable-endpoint failure.
- [AI 助手](./assistant.md) covers sending a message and checking the stub request plus the `llm_calls` row (model, route, fallback_reason).
- [记为知识提案](./assistant-knowledge.md) covers candidate buttons, the confirm card, the pending term-default proposal, the 409/403/400/404 posts, a shared viewer, and the lineage tab switch that must not reload the panel. The stock LLM stub does not drive it.
- [业务知识（词的默认指向）](./knowledge.md) covers a pending `term_default` proposal on `/knowledge`: the text, accept and reject only, accepting it, replacing the same word on another target, a viewer who cannot accept, and a rejected edited accept.
- [API key usage on consumer lookup](./api-key-usage.md) covers `platform.api_key_usage`: a successful by-id and by-source lookup each add 1, a repeat accumulates on the same row, and 401, 404, 503, and `?snapshot=` do not. There is no counter page. After `launch.sh` and `doctor.sh`, run `scripts/api-key-usage.sh` and do not open the browser for the counter.
- Catalog embeddings have no browser feature. `platform.catalog_embeddings` is not shown on a page. When a diff touches `app/.server/catalog/embeddings.ts` or `app/.server/catalog/vector-store.ts`, skip `launch.sh` and follow [Catalog embeddings](../SKILL.md#catalog-embeddings).
