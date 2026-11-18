# Template upgrade notes

A published template locked behind the registry's latest version shows an upgrade banner. The banner lists one line per version after the lock, `vN：` plus that version's `changes`. After 预览升级差异 succeeds, the result header repeats the same list above the migration table, then a one-line summary, the comparison, and a 下游影响 section. A member with `results:read` can open at most 10 sample consumers from one matrix cell or one changed output column. The stock test switch makes RFM and 流失预警 one step newer (v2). Cohort stays at v1 when it was published at v1, so that page has no banner.

## Sub-features

- `upgrade-banner` shows `有新的模板版本 v2（当前 v1）` and one `[data-upgrade-changes]` item with the RFM v2 sentence.
- `upgrade-preview` repeats that sentence under `v1 → v2，统计日 <date>` and makes `[data-upgrade-changes]` appear twice. The preview body before a sample click contains no 64-hex consumer id.
- `upgrade-summary` shows `[data-upgrade-summary]`. On RFM the sentence includes `没变的人占`.
- `upgrade-columns` on churn shows `[data-upgrade-columns]` above `[data-upgrade-metric]`. The metric line matches `取值变化`.
- `upgrade-downstream` is `[data-downstream]`. RFM lists `serving.rfm`, `发布后下一次计算时切换`, `GET /api/v1/consumers/:consumerId`, and `GET /api/v1/consumers/by-source/:source/:customerId`. Churn's text is `没有下游使用` and does not list `serving.rfm`.
- `upgrade-sample-cell` opens `[data-upgrade-sample]` from a non-zero `button[data-sample-cell]`. The title is `样例消费者（最多 10 个，按 consumer_id 排序，原分群 → 新分群）`. There are at most 10 `[data-sample-row]` values, sorted by that attribute, with headers `v1 segment` and `v2 segment`. A second click of the same cell returns the same rows in the same order.
- `upgrade-sample-column` opens the sample from `button[data-sample-column="at_risk"]`. The title is `样例消费者（最多 10 个，按 consumer_id 排序，换了取值）`, with headers `v1 at_risk` and `v2 at_risk`.
- `upgrade-sample-audit` writes one `platform.audit_logs` row with `action = 'template.preview_sampled'` per click. `detail` names the cell or the column and `count`. It does not contain `consumer_id` or a 64-hex consumer id. The audit page label is `查看模板升级样例`.
- `upgrade-cohort` on a cohort locked at v1, with no newer registry version, has no `[data-upgrade-banner]` and no `[data-upgrade-changes]`.
- `upgrade-churn` shows a different sentence from RFM: the 流失预警 v2 note.

## How to get to it (user POV)

- Choose `分析`, then the template's parameter page. The direct path for RFM is `/analytics/templates/rfm`. The heading is `RFM 分层 · 模板参数`. Churn is `/analytics/templates/churn`.
- The sample clicks are for a viewer (`results:read`). An analyst and an admin also see the samples. The analyst sees `升级到新版本`. The viewer does not.
- `launch.sh` writes `TEMPLATE_TEST_VERSIONS` into `app.env` only when the launch shell already exported it, and it does not publish a template. Export the variable before `launch.sh` when this recipe needs the banner. A launch that does not export it has no banner.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- The dev server process was started with `TEMPLATE_TEST_VERSIONS=1`, because `launch.sh` copied that variable from the launch shell into `app.env`. A flag added after the process is up does not count. Restart the process from the updated `app.env` if the flag was not in the original launch.
- RFM is published with `template_version` 1. Latest under the flag is 2. If the template was auto-enabled while the flag was already set, it locks at 2 and the banner is absent.
- `silver.order` and `silver._identities` exist. Without them, 预览升级差异 returns an error, `upgradeDiff` stays null, and the header list does not render. The banner list still does.
- Signed in as the viewer for the sample and downstream steps. The shell link name is `我的设置（<email>）`. The analyst path still applies to the banner and to `升级到新版本`.

- **Open RFM.** Run `browser.mjs goto /analytics/templates/rfm` and `browser.mjs wait-text "有新的模板版本 v2（当前 v1）"`. Run `browser.mjs count --selector '[data-upgrade-banner]'` and expect `1`. Run `browser.mjs count --selector '[data-upgrade-changes]'` and expect `1`. Run `browser.mjs text --selector '[data-upgrade-changes]'` and expect `v2：分群名加 v2: 前缀，用于验证升级流程；所有人的分群名都会变`. Run `browser.mjs screenshot` and `browser.mjs snapshot`.
- **Preview.** Scope the date and the button with `--within 'form:has(input[name="intent"][value="preview-upgrade"])'`. Run `browser.mjs fill --label "参考日期（不填为今天）" --value "<YYYY-MM-DD>"` with a date that is not after today (UTC) and that still covers the silver orders (`2024-12-31` covers the stock orders). Run `browser.mjs click --role button --name "预览升级差异"`. Run `browser.mjs text --selector '[data-upgrade-diff]'`. The first line is `v1 → v2，统计日 <that date>`. The same v2 sentence follows, then `[data-upgrade-summary]` (the text includes `没变的人占`), then the migration table (`原分群`, `新分群`, `人数`) with `v2:` on the new segment names. Run `browser.mjs count --selector '[data-upgrade-changes]'` and expect `2`. Run `browser.mjs count --selector '[data-upgrade-changes] li'` and expect `2`. Run `browser.mjs html` and expect no 64-hex consumer id in that preview. Screenshot and snapshot again.
- **Downstream, RFM.** On that same preview, run `browser.mjs text --selector '[data-downstream]'`. Expect `下游影响`, `服务库表 serving.rfm`, `发布后下一次计算时切换`, `GET /api/v1/consumers/:consumerId`, and `GET /api/v1/consumers/by-source/:source/:customerId`. This needs a serving store whose snapshots include `rfm`. A tenant with no serving store, or no RFM snapshot, shows `没有下游使用` instead, and that is not a pass for this bullet.
- **Sample one matrix cell.** Run `browser.mjs click --selector 'button[data-sample-cell]'` on one non-zero cell (the accessible name is `查看 <from> → <to> 的样例消费者`). Run `browser.mjs wait-selector '[data-upgrade-sample]'`. The title text is `样例消费者（最多 10 个，按 consumer_id 排序，原分群 → 新分群）` and is not `换了取值`. The table headers include `consumer_id`, `v1 segment`, and `v2 segment`. Run `browser.mjs html` and count `data-sample-row`: at most 10, and the attribute values are sorted ascending. Record those values. Click the same `data-sample-cell` again and wait until `sql.sh` shows one more `template.preview_sampled` row (the sample table is already on the page, so `wait-selector` returns before the new response). The new `data-sample-row` list equals the first list. Screenshot and snapshot.
- **Audit.** Run `sql.sh` `SELECT action, detail::text FROM platform.audit_logs WHERE action = 'template.preview_sampled' ORDER BY created_at`. Each new click adds one row. `detail` has `template`, `from`, `to`, `cell` or `column`, and `count`. It does not contain `consumer_id` or a 64-hex id. As an admin, open `审计日志`. The row label is `查看模板升级样例` and the description names the segment pair or the column and the returned count, not a consumer id.
- **Locked at latest.** Run `browser.mjs goto /analytics/templates/cohort`. The heading is `同期群 · 模板参数` and the page says `当前生效：第 1 版`. Run `browser.mjs count --selector '[data-upgrade-banner]'` and expect `0`. Run `browser.mjs count --selector '[data-upgrade-changes]'` and expect `0`.
- **Other template's note.** Run `browser.mjs goto /analytics/templates/churn` and `browser.mjs text --selector '[data-upgrade-changes]'`. Expect `v2：at_risk 取反；minOrders 不超过 10，用于验证升级流程；所有人的 at_risk 都会翻转`. Scope the preview form the same way and fill `2024-10-15`, then click `预览升级差异`. Expect `[data-upgrade-summary]`, `[data-upgrade-columns]` before `[data-upgrade-metric]`, and a metric line matching `取值变化`. `[data-downstream]` is `没有下游使用` and does not contain `serving.rfm`.
- **Sample one changed column.** Run `browser.mjs click --selector 'button[data-sample-column="at_risk"]'` (accessible name `查看 at_risk 换了取值的样例消费者`). The sample title is `样例消费者（最多 10 个，按 consumer_id 排序，换了取值）`. Headers include `v1 at_risk` and `v2 at_risk`. `data-sample-row` count is at most 10. A second click of the same button returns the same rows. Screenshot and snapshot.

## Gotchas

- `wait-text` is exact. `v1 → v2` does not match the preview line `v1 → v2，统计日 2024-12-31`. Read `[data-upgrade-diff]` instead.
- The heading is `RFM 分层 · 模板参数`, not `RFM`. `wait-text "同期群"` does not match `同期群 · 模板参数`.
- A fresh `launch.sh` tenant has no template row. Do not call the missing banner a pass or a product failure.
- Stock `TEMPLATE_HISTORY` is empty, so the flag shows exactly one note (v2). Several notes means every version from the lock plus one through latest, each as its own `vN：` line, on both the banner and the preview header. Do not edit the registry on the branch under test to manufacture that list.
- An empty `changes` string still renders a list item `vN：`. The registry test forbids an empty note on version > 1. A blank item is not the happy path.
- The date control's accessible name is `参考日期（不填为今天）`. The recompute form and the preview form both use it. Scope the preview with `--within 'form:has(input[name="intent"][value="preview-upgrade"])'`. Leaving it empty previews today (UTC), which misses the stock 2024 orders.
- A matrix-cell sample title is `原分群 → 新分群`. `换了取值` is only the title for an output-column sample. A cell labeled `换了取值` is a failure.
- `wait-selector '[data-upgrade-sample]'` succeeds immediately when a sample is already open. For the second click, wait on the new audit row.
- Sampling does not create a lake table and does not enqueue a task. Compare `information_schema.tables` and `platform.tasks` before and after if the ticket asks. The count API (`preview-upgrade`) still has no consumer id; the sample table does.
- Downstream lists table names and API paths only. A 30-day API key call count is not on this page.
- Preview does not change the published version. The version table stays `v1` / `已发布` / `platform`.
- `launch.sh` does not turn the test versions on by itself. Export `TEMPLATE_TEST_VERSIONS=1` before launch when this recipe needs them. Auto-enabling a template while that flag is already set locks the publish at v2 and the banner stays absent.
