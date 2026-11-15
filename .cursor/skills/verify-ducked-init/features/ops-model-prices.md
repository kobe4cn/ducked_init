# Operator model prices

An operator opens `/ops/model-prices` and sets the per-million-token input and output price for a model name. Saving an existing model name updates that row. The same numbers again do not write an audit row. A tenant admin who opens the page is sent to `/ops/login`.

## Sub-features

- `ops-model-prices-login` signs in with an operator Magic Link and binds TOTP on the first login.
- `ops-model-prices-empty` shows `暂无模型单价。在下面填模型名与单价，保存第一条。` and the save form.
- `ops-model-prices-create` saves `m-fast` at input `2`, output `8`, currency `CNY`. The row `[data-model="m-fast"]` shows those values.
- `ops-model-prices-update` saves `m-fast` at input `3`, output `8`, currency `CNY`. `/ops/audit` shows one `新增模型单价` and one `修改模型单价`, and the tenant cell is `平台`.
- `ops-model-prices-noop` saves `3` / `8` / `CNY` again, then `3.0000` / `8.0000` / `CNY`. The audit still has one update, and `updated_at` does not move.
- `ops-model-prices-reject` rejects a model name of only spaces, input `-1`, input `2.50001`, currency `EUR`, and an empty model name. Each stays on `/ops/model-prices` with `操作未完成`, and the stored row does not change.
- `ops-model-prices-member` opens `/ops/model-prices` with only a tenant-admin session. The browser lands on `/ops/login`, and the price row is not in the page.

## How to get to it (user POV)

- Create the operator with `npm run operator:create -- --email ops@example.com` after sourcing this run's `app.env`. The product has no page that creates an operator.
- Create the tenant admin with `npm run tenant:create -- --slug acme --name "示例商贸" --admin-email admin@acme.com` in the same environment. `launch.sh` already created `admin@verify.test`; either admin is enough for the member check.
- Open `/ops/login`. The document title is `运营后台登录 · CRM 数据分析平台`.
- After the Magic Link, the confirm page title is `确认登录 · 运营后台`. The button is `继续`.
- The first TOTP page title is `TOTP 验证 · 运营后台`. The button is `确认绑定并登录`.
- The prices page is `/ops/model-prices`. The heading is `模型单价`. The nav link is `模型单价`.
- Operator audit is `/ops/audit`. The heading is `审计日志`.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- Source that run's `app.env`, then create the operator and the `acme` tenant from the repo root. Do not insert them with `sql-write.sh`.
- `sql.sh "SELECT count(*) FROM platform.model_prices"` is `0`.

- **Request the operator link.** Run `browser.mjs goto /ops/login`, then fill label `运营者邮箱` with `ops@example.com` and click the button `发送登录链接`. Wait for `请查收邮件`. Record `wc -c` of the server log before the click. `browser.mjs magic-link --email ops@example.com --offset <bytes>` prints the URL. The path is `/ops/auth/verify`.
- **Confirm and bind TOTP.** `goto` that URL and click the button `继续`. Wait for `绑定 TOTP`. The secret is the text of `[data-totp-secret]` (spaces are allowed). From the repo root, print the current code with `node --import tsx -e 'import { totpCode } from "./app/.server/totp.ts"; console.log(totpCode(process.argv[1]))' "<secret>"`. Fill label `验证码` and click `确认绑定并登录`. Wait until the path is `/ops`.
- **Empty prices.** Click the link `模型单价`. Wait until the path is `/ops/model-prices`. `wait-text` is exact, so wait for the whole sentence `暂无模型单价。在下面填模型名与单价，保存第一条。`. Screenshot and snapshot the page.
- **Create m-fast.** Fill `模型名` with `m-fast`, `输入单价` with `2`, `输出单价` with `8`, and `select --label 币种 --value CNY`. Click `保存`. Wait for `[data-model="m-fast"]`. `text --selector '[data-model="m-fast"]'` contains `m-fast`, `2`, `8`, and `CNY`. `sql.sh "SELECT model, input_per_m_tok::text, output_per_m_tok::text, currency FROM platform.model_prices"` prints `m-fast|2.0000|8.0000|CNY`.
- **Update to 3.** Fill the same labels with `m-fast`, `3`, `8`, and `CNY`, then click `保存`. The row text contains `3` and the timestamp moves. On `审计日志`, `[data-audit-action="新增模型单价"]` contains `运营者 ops@example.com`, `平台`, and `m-fast：输入 2、输出 8 CNY / 百万 token`. `[data-audit-action="修改模型单价"]` contains `平台` and `m-fast：输入 2 → 3、输出 8 → 8（CNY → CNY）`. `sql.sh` shows `tenant_id` null, `actor_email` `ops@example.com`, and the update `detail` has `from` and `to` with both prices and `CNY`.
- **Same value.** Save `m-fast` / `3` / `8` / `CNY` again, then `3.0000` / `8.0000` / `CNY`. The row timestamp stays on the update from the previous step. `sql.sh` still counts one `model_price.created` and one `model_price.updated`.
- **Rejected values the form can submit.** Spaces in `模型名` (`   `) show `模型名不能为空`. Input `-1` must be passed as `--value=-1` (a leading dash is an option flag). It shows `输入单价不能是负数`. Input `2.50001` shows `输入单价最多 4 位小数，整数部分最多 8 位`. Each response stays on `/ops/model-prices`, the alert title is `操作未完成`, and `sql.sh` is still `m-fast|3.0000|8.0000|CNY`.
- **EUR.** The currency control is `<select id="price-currency">` and its only options are `CNY` and `USD`. `select --value EUR` cannot choose a missing option. In the page, add `<option value="EUR">`, set the select to `EUR`, set the other fields, and click `保存` in that same turn. A later `fill` re-renders the uncontrolled select and drops the extra option. The POST body contains `currency=EUR`. The alert is `币种只能是 CNY 或 USD`. The stored row is unchanged.
- **Empty model name.** The input is `required`, so Chrome does not submit a fully empty name. Clear `required` on `#price-model`, set its value to an empty string, and submit. The status is `400` and the alert is `模型名不能为空`.
- **Member.** Use a second Chrome profile that has no `crm_ops_session` cookie. Sign in as `admin@acme.com` from `/login` (button `登录` on the member confirm page). The `h1` is `示例商贸`. `goto /ops/model-prices`. The path is `/ops/login`, the title is `运营后台登录 · CRM 数据分析平台`, and `[data-model="m-fast"]` is absent. `goto /` still shows `示例商贸`.

## Gotchas

- `magic-link` matches `/ops/auth/verify` as well as `/auth/verify`. Pass `--email` and an offset taken before that submit.
- The operator confirm button is `继续`. The member confirm button is `登录`. After TOTP is already bound, the operator submit button is `登录`, not `确认绑定并登录`.
- The first TOTP page shows the secret once. Keep it. `totpCode` accepts the grouped secret; spaces are stripped.
- `browser.mjs fill --value -1` fails before it reaches the page. Use `--value=-1`.
- Do not treat a browser that refuses to submit an empty model name as a passed `400`. The `400` is the response after `required` is removed. The stored row after that response is the check that the value was unchanged.
- A tenant member is not answered with `403` on this page. `requireOperator` redirects a missing operator session to `/ops/login`. The operator cookie and the member cookie are different. A profile that still has the operator session will open the prices page.
- Audit text on `/ops/audit` uses `新增模型单价` and `修改模型单价`. The action codes `model_price.created` and `model_price.updated` are in SQL. `data-audit-action` is the Chinese label. The tenant cell for a null `tenant_id` is `平台`.
- This page is not on `main` until the model-price change is merged. Driving the recipe before that change returns 404.
