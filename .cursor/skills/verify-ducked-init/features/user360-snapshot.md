# 用户 360 快照

A member who can read results opens one user 360 snapshot and lands on 汇总: three cards, six channel counts in a fixed order, and a lookup box. 逐人明细 is a separate tab with the full paged table. A bad id or a missing id stays on the page with a hint.

## Sub-features

- `user360-summary` is the default tab. The URL has no `tab`. The cards are 总人数, 有订单人数, and 参考日期. The channel order is sms, email, push, wechat, app, other.
- `user360-lookup-found` submits one real `consumer_id` and shows exactly one row, every column, 是 / 否 on the consent columns, and the same id in the input.
- `user360-lookup-invalid` submits `abc!` and shows the format hint. The page stays up. There is no result row.
- `user360-lookup-missing` submits `no-such-id` and shows the not-found hint. The page stays up. There is no result row.
- `user360-consumers` opens 逐人明细. The URL is `?tab=consumers`. The table has every column and the pager says 每页 50 位.
- `user360-clamp` opens `?tab=consumers&page=999`. The pager shows the last page. The tab stays 逐人明细.

## How to get to it (user POV)

- Sign in as a member with 查看结果层 (analyst, viewer, data engineer, or admin). Open `/analytics`, then the 用户 360 snapshot.
- Or open `/analytics/snapshots/<id>` directly. Without `?tab=` that is 汇总.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- The signed-in tenant already has a user 360 snapshot. `launch.sh` does not create one. The empty `/analytics` sentence `还没有结果快照。RFM 分层等分析模板运行成功后，快照会出现在这里。` is not a pass.
- `scripts/sql.sh` cannot read the gold table. Do not treat a PostgreSQL query as the channel reconciliation.
- The three cards sit above the tabs, so they are visible on 逐人明细 too. `wait-text "总人数"` does not prove the current tab. 汇总 is the tab that shows `各渠道同意人数` and the lookup box. 逐人明细 is the tab that shows the pager.

- **Open 汇总.** Run `node .cursor/skills/verify-ducked-init/scripts/browser.mjs goto /analytics/snapshots/<id>`. Run `browser.mjs wait-text "各渠道同意人数"` and `browser.mjs url`. The URL has no `tab`. Run `browser.mjs wait-text "总人数"`, `browser.mjs wait-text "有订单人数"`, and `browser.mjs wait-text "参考日期"`. Run `browser.mjs wait-text "sms"`, `browser.mjs wait-text "email"`, `browser.mjs wait-text "push"`, `browser.mjs wait-text "wechat"`, `browser.mjs wait-text "app"`, and `browser.mjs wait-text "other"`. Run `browser.mjs screenshot --path <evidence>/01-summary-default.png` and `browser.mjs snapshot --path <evidence>/01-summary-default.aria.txt`. The snapshot has no consumer table on this tab.
- **Look up one person.** Run `browser.mjs fill --label "按 consumer_id 查单人" --value "<consumer_id>"` and `browser.mjs click --role button --name "查询"`. Run `browser.mjs wait-text "<consumer_id>"` and `browser.mjs url`. The URL contains `tab=summary` and `consumer=<consumer_id>`. Run `browser.mjs value --label "按 consumer_id 查单人"`. Stdout is that same id. The row shows 是 or 否 on the consent columns, not true or false. Run `browser.mjs screenshot --path <evidence>/03-lookup-found.png` and `browser.mjs snapshot --path <evidence>/03-lookup-found.aria.txt`.
- **Reject a bad id.** Run `browser.mjs fill --label "按 consumer_id 查单人" --value "abc!"` and `browser.mjs click --role button --name "查询"`. Run `browser.mjs wait-text "consumer_id 格式不对：只允许字母、数字、下划线与连字符，最长 80 字符"`. The URL contains `consumer=abc%21`. Run `browser.mjs screenshot --path <evidence>/04-lookup-invalid.png`. There is no result table.
- **Miss an id.** Run `browser.mjs fill --label "按 consumer_id 查单人" --value "no-such-id"` and `browser.mjs click --role button --name "查询"`. Run `browser.mjs wait-text "这张快照里没有这个 consumer_id"`. Run `browser.mjs screenshot --path <evidence>/05-lookup-missing.png`. There is no result table.
- **Open 逐人明细.** Run `browser.mjs click --role link --name "逐人明细"`. Run `browser.mjs wait-text "每页 50 位"` and `browser.mjs url`. The path ends with the snapshot id and the query is `tab=consumers`. Run `browser.mjs screenshot --path <evidence>/02-consumers-tab.png` and `browser.mjs snapshot --path <evidence>/02-consumers-tab.aria.txt`.
- **Clamp the page.** Run `browser.mjs goto /analytics/snapshots/<id>?tab=consumers&page=999`. Run `browser.mjs wait-text "每页 50 位"` and `browser.mjs url`. The URL still contains `tab=consumers` and `page=999`. The pager names the last page, not page 999. Run `browser.mjs screenshot --path <evidence>/06-consumers-clamp.png`.

HTTP status for `abc!` and `no-such-id` is 200. `browser.mjs` does not print status. A signed-in `curl -D` of those two URLs is the status check. An unsigned request is 302 to `/login`. Another tenant's snapshot id is 404.

## Gotchas

- The cards are outside the tab body. Seeing 总人数 on 逐人明细 is expected. The channel grid and the lookup box are only on 汇总.
- `page=999` does not redirect. The address bar keeps 999. The pager text is the clamped page.
- Consent cells render 是 and 否. true and false on the page are a failure.
- The snapshot table has no name, phone, or email. Those source values must not appear in the HTML.
- Channel counts of 0 are a pass when the source has no granted row for that channel. Reconcile sms, email, push, wechat, app, and other against the source, including the zeros.
- `wait-text` is exact. `第 1 / 1 页，每页 50 位` matches only when the last page is page 1. With more than 50 people the clamped pager is `第 <last> / <last> 页，每页 50 位`.
