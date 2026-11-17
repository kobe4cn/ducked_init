# Cohort snapshot

A cohort snapshot opens on the retention matrix. Each row is a `cohort_start` date. Each column is one period. A cell shows how many people ordered in that period and the rate against period 0. The per-person rows are on another tab, and paging that tab keeps `tab=consumers` in the URL.

## Sub-features

- `cohort-matrix-default` opens `/analytics/snapshots/<id>` with no `tab` and shows the matrix, three cards, and no per-person rows.
- `cohort-matrix-zero` shows a period nobody ordered in as `0 / 0.0%`, and period 0 as `100.0%`.
- `cohort-consumers-tab` opens `?tab=consumers` and joins `active_periods` with `、`.
- `cohort-consumers-page` keeps `tab=consumers` on `下一页 →` and `← 上一页`.

## How to get to it (user POV)

- Sign in. Choose `分析`. The path is `/analytics`.
- In the snapshot table, the template link name is `同期群`. It goes to `/analytics/snapshots/<id>`. An expired row has no link.
- The same page is `goto /analytics/snapshots/<id>`.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- Signed in as a member who can read results. Launch's admin is `admin@verify.test`.
- This tenant already has an unexpired cohort snapshot. `launch.sh` does not create one. Do not start from the empty analytics sentence and call that a pass.
- `scripts/sql.sh` cannot read the gold snapshot table. Do not use it to check cell counts.

- **Empty launch.** On a tenant `launch.sh` just created, choose `分析`. Run `browser.mjs wait-text "还没有结果快照。RFM 分层等分析模板运行成功后，快照会出现在这里。"`. There is no link named `同期群`. Record this as the empty state, not as a matrix pass.
- **Open the matrix.** Run `browser.mjs goto /analytics/snapshots/<id>`. Run `browser.mjs wait-text "留存矩阵"` and `browser.mjs wait-text "第 0 期"`. Run `browser.mjs url`. The URL has no `tab` query. The document title starts with `同期群 · `.
- **Cards.** Run `browser.mjs text --selector '[data-cohort-count]'`. The text includes `同期群数`. Run `browser.mjs text --selector '[data-cohort-total]'`. The text includes `总人数`. Run `browser.mjs text --selector '[data-cohort-granularity]'`. The value is `按月` or `按周`.
- **Cells.** A cell is `[data-cohort="<YYYY-MM-DD>"][data-period="<k>"]`. Run `browser.mjs text --selector` on period 0. The text is `<n> / 100.0%`. Run it on a period whose `data-consumers` is `0`. The text is `0 / 0.0%`. Run `browser.mjs count --selector '[data-consumer]'`. The count is `0`.
- **Per-person tab.** Run `browser.mjs click --role link --name "逐人明细"`. Run `browser.mjs url`. The URL contains `tab=consumers`. Run `browser.mjs count --selector '[data-consumer]'`. The count is this page's row count, at most `50`. When the page count is known, run `browser.mjs wait-text "第 1 / <M> 页，每页 50 位"`. A multi-period `active_periods` cell contains `、`, for example `0、1、2`.
- **Next page.** When `M` is greater than 1, run `browser.mjs click --role link --name "下一页 →"`. Run `browser.mjs url`. The URL contains `tab=consumers` and `page=2`. Run `browser.mjs snapshot --path <evidence>/cohort-consumers-page2.aria.txt`. The link `← 上一页` has `/url` ending in `?tab=consumers&page=1`.
- **Back to the matrix.** Run `browser.mjs click --role link --name "留存矩阵"`. Run `browser.mjs wait-text "第 0 期"` before reading the URL. Run `browser.mjs url`. The URL has no `tab`. Run `browser.mjs count --selector '[data-consumer]'`. The count is `0`.
- **Proof.** Save a screenshot and an ARIA snapshot of the matrix and of `?tab=consumers`, under the evidence directory. The matrix snapshot shows `第 0 期` and a rate such as `100.0%`. The consumers snapshot shows `、` in a cell when a person ordered in more than one period.

## Gotchas

- The three cards stay on both tabs. `wait-text "同期群数"` is true on `?tab=consumers`. It does not prove the matrix is showing. Wait for `第 0 期`, or count `[data-consumer]` as `0`.
- `click` returns before the client navigation finishes. Reading `url` on the next command can still show `?tab=consumers`. Wait for `第 0 期` first when leaving the per-person tab.
- `wait-text` is exact. `10 / 100.0%` matches the cell. `100.0%` alone does not, because the cell text is the count, a space, a slash, a space, and the rate.
- Period 0 is the denominator. A generated cohort row includes offset 0, so that cell is `100.0%` and a later empty period is `0 / 0.0%`, not `NaN`.
- One page has no `下一页 →`. Do not report pagination as verified from a single page.
- The pager unit is `位`. The sentence is `第 N / M 页，每页 50 位`.
- `?tab=` is a whitelist. A value other than `matrix` or `consumers` renders the matrix. This recipe does not require driving that fallback.
