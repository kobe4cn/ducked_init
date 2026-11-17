# Snapshot pages

An analyst opens one repurchase snapshot, one CLV snapshot, and one other template snapshot. The repurchase page states the repurchase rate as `X / Y 人` and the median days to a second order. The CLV page states the share of CLV held by the top decile and a decile table of headcount and CLV totals. Both keep a paged detail table of hashed `consumer_id` values. A generic template snapshot keeps the plain detail table and does not grow the repurchase or CLV cards.

## Sub-features

- `snapshots-empty` records that the tenant from `launch.sh` has no snapshot to open.
- `snapshots-repurchase` reads the rate, the median, the two counts, and the detail pager.
- `snapshots-clv` reads the top-decile share, the ten-decile table (only deciles that have people), and the detail pager.
- `snapshots-generic` opens another template, such as 用户 360, and checks that the repurchase and CLV cards are absent.
- `snapshots-dash` checks a null median and a zero CLV total render `—` and do not show `NaN` or `Infinity`.
- `snapshots-tenant` checks that a member of another tenant does not see the snapshot.

## How to get to it (user POV)

- Sign in as a member whose role is 分析师 and who has `查看结果层`.
- Open `/analytics`. Each snapshot is a link to `/analytics/snapshots/<id>`.
- The seeded `verify` tenant has no such link.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- This run's server is the one `launch.sh` started. Do not open port 5173 or the `crm_platform` database.
- A repurchase snapshot, a CLV snapshot, and one other template snapshot already exist for the analyst's tenant. `launch.sh` does not create them. If `/analytics` contains `还没有结果快照。`, stop this recipe and say it is blocked. Do not mark the cards as passed.
- A temporary script may create those snapshots in `crm_platform_verify_<run-id>` only. Label that run as a temporary script. Do not point it at `crm_platform`.
- `scripts/sql.sh` cannot read the gold tables. Cross-check the cards with a temporary read of the tenant lake, and keep that output in the evidence directory.

- **Empty launch.** Sign in as `admin@verify.test`. Run `browser.mjs goto /analytics`, `browser.mjs snapshot --path <evidence>/analytics-empty.aria.txt`, and `browser.mjs screenshot --path <evidence>/analytics-empty.png`. The page contains `还没有结果快照。` That is the empty state, not a verified snapshot.
- **Analyst.** The home text contains `（分析师）` and `查看结果层`. `wait-text` is exact, so the single word `分析师` does not match. Run `browser.mjs snapshot --path <evidence>/home-analyst.aria.txt`.
- **Repurchase.** Run `browser.mjs goto /analytics/snapshots/<repurchase-id>` and `browser.mjs wait-text "复购率"`. The title contains `复购 ·`. Run `browser.mjs text --selector '[data-repurchase-rate]'`, `browser.mjs text --selector '[data-median-days]'`, `browser.mjs text --selector '[data-repurchase-count]'`, and `browser.mjs text --selector '[data-total-count]'`. The rate text includes `<repurchased> / <total> 人`. The median is `<number> 天` or `—`. Run `browser.mjs count --selector '[data-consumer]'` and `browser.mjs snapshot --path <evidence>/repurchase.aria.txt`. Every `consumer_id` cell is a hash. Source names, phones, and emails are absent. The pager text is `第 N / M 页，每页 50 位`.
- **Second page.** When `M` is greater than 1, run `browser.mjs click --role link --name "下一页 →"`. Then `browser.mjs url` ends in `?page=2` and the pager text is `第 2 / 2 页，每页 50 位`. The `consumer_id` on that page is not a repeat of page 1. When `M` is 1, `?page=2` still shows `第 1 / 1 页，每页 50 位` and the same rows. `wait-url` can time out after the click has already landed; read `url` and the pager text.
- **CLV.** Run `browser.mjs goto /analytics/snapshots/<clv-id>` and `browser.mjs wait-text "前 10% 的人贡献的 clv 占比"`. Run `browser.mjs text --selector '[data-clv-top-share]'` and `browser.mjs count --selector '[data-clv-decile]'`. The share is a percent or `—`. Each decile row shows a headcount and a `¥` total. The first row says `第 1 档（最高）`. Deciles with nobody are omitted. The detail pager and the hashed `consumer_id` cells are the same shape as repurchase. Run `browser.mjs screenshot --path <evidence>/clv.png` and `browser.mjs snapshot --path <evidence>/clv.aria.txt`.
- **Generic template.** Open a snapshot whose template is not repurchase or CLV. Run `browser.mjs count --selector '[data-repurchase-rate]'` and `browser.mjs count --selector '[data-clv-top-share]'`. Both are `0`. The cards say `消费者` (or `行数` for a DSL snapshot) and `参考日期`. BOOLEAN cells say `是` or `否`. Empty cells say `—`. A page past the end, such as `?page=9` on a one-page snapshot, still shows `第 1 / 1 页，每页 50 位`.
- **Dash.** When no row has `days_to_second`, the median text is `—` and the page does not contain `NaN` or `Infinity`. When the total is greater than 0 and nobody repurchased, the rate is `0.0%`. When the total is 0, the rate is `—` and the hint is `0 / 0 人`. When the CLV total is 0, the share is `—` and the CLV total reads `¥0.00`.
- **Other tenant.** While signed in as a member of a different tenant, run `browser.mjs goto /analytics/snapshots/<id>`. The body is `404` and `页面不存在。` It does not contain `复购率` or the snapshot's numbers. That page has no `退出登录` button. Run `browser.mjs goto /` before signing out.

## Gotchas

- `launch.sh` creates the admin `admin@verify.test` only. An analyst of another tenant in the same database signs in with a separate Magic Link. Log out from `/`, not from the 404 page.
- The nav group `分析` is collapsed at 1440×900. Open `/analytics` by URL.
- `text --selector` prints the visible card. It does not print the `data-*` attribute value. The visible percent, `X / Y 人`, `—`, and `¥` amounts are the check.
- Card totals come from the live lake table. The pager length comes from `platform.snapshots.row_count`. A lake edit that does not update `row_count` will not add a page.
- Do not treat a green CI run of `test/http/analytics.test.ts` as this browser check. CI does not open Chrome against this dev server.
