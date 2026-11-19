# 模型调用的数字和日期

An admin on `/llm-usage` sees counts and token totals with thousands separators, and detail times in the UI language. With no `crm_locale` cookie the times are 24-hour `YYYY/M/D HH:mm:ss`. With the plaintext cookie `crm_locale=en` and `CRM_ENABLE_EN_LOCALE=1` the same instants are `M/D/YYYY, h:mm:ss AM/PM`, and the token text still has thousands separators. Deleting only that cookie brings the 24-hour form back. The page copy stays Chinese. The amount column does not follow the UI language.

## Sub-features

- `llm-usage-locale-zh` shows grouped numbers and 24-hour detail times when the cookie is absent, and the same when the cookie is present but is not exactly `en`.
- `llm-usage-locale-en` shows `M/D/YYYY, h:mm:ss AM/PM` detail times, grouped numbers, `lang=en`, and an unchanged amount column.
- `llm-usage-locale-back` returns to the 24-hour times and `lang=zh-CN` after only `crm_locale` is deleted, and the admin is still signed in.

## How to get to it (user POV)

- Sign in as the tenant admin and open `管理`, then `模型调用`. The path is `/llm-usage`. There is no language switch on the page. English numbers and dates are the cookie plus the server flag.
- The heading stays `模型调用`. The window links stay `近 7 天` and `近 30 天`.
- A detail time is the first cell of a `[data-call-id]` row. Token counts are the input and output cells of that row, and the totals card is `总 token`.

## Driving it with Playwright

Preconditions:

- Export `CRM_ENABLE_EN_LOCALE=1` before `launch.sh`. `app.env` contains `CRM_ENABLE_EN_LOCALE=1`. Launch writes that name even when the shell did not export it, and then the value is empty, which is Chinese.
- `doctor.sh` printed `DOCTOR PASS`. Doctor requests `/login` with no cookie, so it still requires `登录 CRM 数据分析平台`.
- Signed in as `admin@verify.test`.
- The browser daemon was started from this version of `browser.mjs`. An older daemon has no `cookie --clear --name`. Stop it (kill the pid in `browser.pid` and remove `browser.sock`) and run a command again.
- `scripts/sql.sh` is read-only. Insert with `scripts/sql-write.sh` one `platform.llm_calls` row for this run's verify tenant whose `created_at` is inside the last 30 days, `prompt_tokens` is `1234567`, and `completion_tokens` is `89012`. A second row in that window with `prompt_tokens` null, `error` set, and a model that has no `platform.model_prices` row is the error and empty-token case. The detail list only includes the 7-day or 30-day window, so an instant outside that window, including a fixed `2026-03-05` when today is later, is not on the page.
- Expected strings are that stored instant formatted with no `timeZone` option: `new Date(iso).toLocaleString('zh-CN')` and `new Date(iso).toLocaleString('en')`, run in the same timezone as the dev server. On UTC, `2026-11-05T04:07:08.000Z` is `2026/11/5 04:07:08` and `11/5/2026, 4:07:08 AM`. `2026-11-05T16:08:09.000Z` is `2026/11/5 16:08:09` and `11/5/2026, 4:08:09 PM`. `1234567` is `1,234,567` in both languages.
- `wait-text` matches the element's whole text. Wait for the full time string, not a slice of it.

- **Chinese, no cookie.** Run `browser.mjs goto '/llm-usage?days=30'`. `browser.mjs lang` prints `zh-CN`. The body contains the `zh-CN` time strings and `1,234,567`, and it contains neither `AM` nor `PM`. A null token cell is `—`. The failed row's error text is visible. Run `browser.mjs screenshot --path <evidence>/llm-usage-locale-zh.png` and `browser.mjs html --path <evidence>/llm-usage-locale-zh.html`.
- **English cookie.** Run `browser.mjs cookie --name crm_locale --value en` and `browser.mjs goto '/llm-usage?days=30'`. `lang` prints `en`. The body contains the `en` time strings, including `AM` or `PM`, and still contains `1,234,567`. The amount cell text is the same string as in the Chinese HTML (`未配置单价` when the model has no price, or `CNY` plus four decimal places from the server when it does). It does not gain a thousands separator. `count --selector 'div.lg\:grid-cols-5 > div'` is `5`. Run `browser.mjs console --clear`, `browser.mjs goto '/llm-usage?days=30'`, and `browser.mjs console`. No line has type `error` or `pageerror`. Run `browser.mjs screenshot --path <evidence>/llm-usage-locale-en.png`.
- **Cookie value other than `en`.** Run `browser.mjs cookie --name crm_locale --value EN` and open `/llm-usage?days=30` again. `lang` is `zh-CN`, the 24-hour times are back, and there is no `AM` or `PM`. The same is true for `crm_locale=fr`.
- **Delete only that cookie.** Run `browser.mjs cookie --clear --name crm_locale` and `browser.mjs goto '/llm-usage?days=30'`. The path is still `/llm-usage`, `lang` is `zh-CN`, the 24-hour times are back, and there is no `AM` or `PM`. The heading is still `模型调用`.

## Gotchas

- `cookie --clear` with no `--name` deletes the session cookie too. The next `/llm-usage` is the login page, which is not the Chinese-times check. Use `cookie --clear --name crm_locale`.
- `cookie --value en` must be the raw characters `en`. `EN`, `english`, and a react-router `createCookie` value stay Chinese. `getLocale` returns English only when `CRM_ENABLE_EN_LOCALE` is `1` and the cookie is exactly `en`.
- Detail times use the runtime timezone and no `timeZone` option. Compare the page text to `toLocaleString` of the stored instant, not to a hardcoded March date that the 30-day window will not show.
- The amount column is the server `formatCost` string. It stays put when the language changes. This page does not call `formatMoney` or `formatCompact`. Do not treat a missing 万 / K switch here as a failure.
- Page copy (heading, nav, card labels) stays Chinese in both states. Only numbers and dates change.
- `count --selector` for the five-card grid is `div.lg\:grid-cols-5 > div`. A second backslash makes the selector invalid. The viewport is 1440×900.
- `console` keeps one buffer. Judge the page on the `console` that follows `--clear` and a fresh `goto`. `debug` and `info` lines are not failures.
