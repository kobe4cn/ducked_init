# 运营后台模型调用汇总

An operator opens 模型调用 and sees every tenant's calls for the last 7 or 30 days, grouped by tenant, model, purpose, and source. The table has a 来源 column immediately after 用途. One tenant/model/purpose group is one row per source: 租户, 平台, or — when the stored source is empty. Inside that group the order is tenant, then platform, then the empty source. A call 40 days old is on neither window. The page shows counts, tokens, cost, and an error rate. It does not show the error text.

## Sub-features

- `ops-llm-usage-source` adds 来源 after 用途 and splits one tenant/model/purpose group into one row per source.
- `ops-llm-usage-order` lists those rows as 租户, then 平台, then —.
- `ops-llm-usage-window` counts a 10-day call on 30 days only. A 40-day call is on neither window. Another tenant stays on its own rows.

## How to get to it (user POV)

- Sign in at `/ops/login` with the operator Magic Link and TOTP. The nav link is `模型调用`, after `模型单价`. The path is `/ops/llm-usage`.
- The heading is `模型调用`. The title is `模型调用 · 运营后台`.
- `近 7 天` goes to `/ops/llm-usage?days=7`. `近 30 天` goes to `/ops/llm-usage?days=30`.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- The operator exists. Source this run's `app.env` and run `pnpm operator:create --email ops@verify.test`. Do not insert the operator with `sql-write.sh`.
- Signed in with the operator recipe in [ops-quota.md](./ops-quota.md). The confirm control is the button `继续`. Do not `wait-text "确认登录"`: that string is the member page. This page's text is `确认登录运营后台`. After TOTP is bound, the submit button is `登录`.
- The rows come from the **调用来源** inserts in [llm-usage.md](./llm-usage.md): verify has tenant, platform, and an empty source on `m-src` / `connectivity`, plus a platform row 40 days old; the other tenant has one tenant-source row. `scripts/sql.sh` shows those groups before the page is opened.

- **Seven days.** Run `browser.mjs goto '/ops/llm-usage?days=7'` and `browser.mjs wait-text "来源"`. The header row's accessible name is `租户 模型 用途 来源 调用 token（输入 / 输出） 金额 错误`, so 来源 follows 用途. `count --selector 'tr[data-tenant]'` is `4`. `text --selector '[data-tenant="验收租户"][data-source="tenant"]'` contains `租户` and calls `2`. The platform row's calls are `1` and its source text is `平台`. The `[data-source="none"]` row's source text is `—` and its calls are `1`. `text --selector '[data-tenant="其他租户"][data-source="tenant"] [data-col="tokens"]'` is `99,999 / 99,999`. In the snapshot, 验收租户's 租户 row comes before its 平台 row, which comes before its — row. The page does not contain `legacy-row`, `boom-40`, or `HTTP 500`. The error cell of the empty-source row is `1（100%）`. Run `browser.mjs console` and require no line that starts with `error` or `pageerror`. Run `browser.mjs screenshot --path <evidence>/ops-llm-usage-days7.png` and `browser.mjs snapshot --path <evidence>/ops-llm-usage-days7.aria.txt`.
- **Thirty days.** Run `browser.mjs click --role link --name "近 30 天"`. The URL query contains `days=30`. 验收租户's tenant row is `3` calls and `33 / 13` tokens. The platform row stays `1` call and `20 / 5` tokens. The empty-source row stays `1`.

## Gotchas

- `wait-text "确认登录"` never matches this login. The visible text is `确认登录运营后台`.
- A tenant admin who opens `/ops/llm-usage` is sent to `/ops/login`. The operator cookie and the member cookie are different.
- `data-source` for an empty source is the attribute `none`, not the word `null`. The visible cell is `—`.
- The 40-day platform row must not raise the platform call count above 1. A count of 2 means the window filter dropped it.
- Cost reads `未配置单价` until an operator saves a price for `m-src`. That text is the existing cost column, not a source-column failure.
- `console` counts from the moment this Chrome process started. The first line is `console-events=<N>`. A `debug`, `log`, or `info` line is not a failure: Vite prints `[vite] connecting...` and React DevTools prints an `info` line in development. `error` and `pageerror` are failures.
