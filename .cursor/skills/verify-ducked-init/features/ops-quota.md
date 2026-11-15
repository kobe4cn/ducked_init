# Operator tenant storage quota

An operator opens one tenant in `/ops` and sets `租户存储配额（MiB）`. The field is generated with the other quota inputs. A tenant admin cannot post that form. The admin does see the change on the tenant audit log.

## Sub-features

- `ops-login` signs in with an operator Magic Link and binds TOTP on the first login.
- `ops-quota-default` shows `10240` for a tenant created by `launch.sh`, with the other quota inputs at their defaults.
- `ops-quota-save` sets `20480`, reloads, and leaves the other quota inputs unchanged.
- `ops-quota-audit` shows `调整配额` and `存储 10240 MiB → 20480 MiB` to the tenant admin.
- `ops-quota-reject` posts `0`, `-1`, `1048577`, and a non-numeric value. Each response is HTTP 400 and the stored value does not change.
- `ops-quota-bounds` accepts `1` and `1048576`.
- `ops-quota-member` posts the same form with only a tenant-member session. The response redirects to `/ops/login` and the stored value does not change.

## How to get to it (user POV)

- Create the operator on the server with `pnpm operator:create`. The product has no page that creates an operator.
- Open `/ops/login`. The document title is `运营后台登录 · CRM 数据分析平台`.
- After the Magic Link, the confirm page title is `确认登录 · 运营后台`. The button is `继续`.
- The first TOTP page title is `TOTP 验证 · 运营后台`. The button is `确认绑定并登录`.
- The tenant page is `/ops/tenants/<tenant id>`. The heading is the tenant name (`验收租户`). The quota section heading is `配额`.
- The tenant admin reads the result on `/audit`, not on `/ops`.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- `scripts/sql.sh` shows `storage_quota_mb` `10240` for slug `verify`, and `memory_limit_mb|threads|max_concurrent_tasks|max_upload_mb` are `2048|2|1|100`.
- Source that run's `app.env`, then run `pnpm operator:create --email ops@verify.test` from the repo root. Do not insert the operator with `sql-write.sh`.

- **Request the operator link.** Run `browser.mjs goto /ops/login`, then fill label `运营者邮箱` with `ops@verify.test` and click the button `发送登录链接`. Wait for `请查收邮件`. Record `wc -c` of the server log before the click. `browser.mjs magic-link --email ops@verify.test --offset <bytes>` prints the URL. The console block is addressed to `ops@verify.test` and the path is `/ops/auth/verify`.
- **Confirm and bind TOTP.** `goto` that URL and click the button `继续`. Wait for `绑定 TOTP`. The secret is the text of `[data-totp-secret]` (spaces are allowed). From the repo root, print the current code with `node --import tsx -e 'import { totpCode } from "./app/.server/totp.ts"; console.log(totpCode(process.argv[1]))' "<secret>"`. Fill label `验证码` and click `确认绑定并登录`. Wait until the path is `/ops`.
- **Default quota.** `goto /ops/tenants/<id>` using the id from `sql.sh "SELECT id FROM platform.tenants WHERE slug = 'verify'"`. Wait for `租户存储配额（MiB）`. `value --label "租户存储配额（MiB）"` is `10240`. The other labels read `2048`, `2`, `1`, and `100`: `单任务内存上限（MiB）`, `单任务线程数`, `并发任务数`, `单个上传文件上限（MiB）`. Screenshot and snapshot the page.
- **Save 20480.** `fill --label "租户存储配额（MiB）" --value 20480 --within 'form:has(#quota-storageQuotaMb)'`. Click the button `保存` with that same `--within`. `保存` also appears on the rename form. Wait for the tenant path. `value --label` is `20480`. `goto` the same path again. The value is still `20480`, and the other four inputs are unchanged. Screenshot the reloaded page.
- **Stored row.** `sql.sh "SELECT memory_limit_mb, threads, max_concurrent_tasks, max_upload_mb, storage_quota_mb FROM platform.tenants WHERE slug = 'verify'"` prints `2048|2|1|100|20480`. The `tenant.quota_changed` row's `detail` mentions `storageQuotaMb` `10240` and `20480` and the same other numbers on both sides.
- **Audit page.** In the same browser, sign in as `admin@verify.test` from `/login` (button `登录` on the member confirm page). Open `审计日志`. The row `[data-audit-action="调整配额"]` contains `存储 10240 MiB → 20480 MiB` and the actor `运营者 ops@verify.test`. Screenshot that page.
- **Rejected values.** The input is `type="number"` with `min` and `max`, so Chrome does not submit `0`, `-1`, `1048577`, or a non-numeric token. Sign in again with curl: a cookie jar, `POST /ops/login`, the new Magic Link `POST`, then `POST /ops/totp` with a new code from the same secret. `POST /ops/tenants/<id>` as `application/x-www-form-urlencoded` with `intent=set-quota` and all five fields. For each of `storageQuotaMb` `0`, `-1`, `1048577`, and `abc`, keep the other four at `2048`, `2`, `1`, `100`. Do not follow redirects. Each status is `400` and the body contains `租户存储配额必须是 1 到`. `sql.sh` still prints `20480`.
- **Bounds.** With that operator jar, the same POST with `storageQuotaMb` `1` returns `302` and `Location: /ops/tenants/<id>`. `sql.sh` prints `1`. Repeat with `1048576`. `sql.sh` prints `1048576`. The other four columns stay `2048|2|1|100`.
- **Member.** A second cookie jar completes member login only (`POST /login`, then `POST` the member Magic Link). `POST` the quota form with `storageQuotaMb` set to a new number. The status is `302` and `Location` is `/ops/login`. `sql.sh` is unchanged. A POST with no cookie does the same.

## Gotchas

- `magic-link` matches `/ops/auth/verify` as well as `/auth/verify`. Pass `--email ops@verify.test` and an offset taken before the operator submit, or it can print an older member link for a different address.
- The operator confirm button is `继续`. The member confirm button is `登录`. Clicking `登录` on the operator page does not match.
- The first TOTP page shows the secret once. A later login to the same operator asks for a code and does not show `data-totp-secret`. Keep the secret from the first bind.
- `保存` is not unique on the tenant page. Without `--within 'form:has(#quota-storageQuotaMb)'` the click can hit `租户改名`.
- Do not treat a browser that refuses to submit `0` as a passed `400`. The `400` is the curl response. The stored row after that response is the check that the value was unchanged.
- `requireOperator` redirects a missing operator session to `/ops/login`. A tenant member is not answered with `403` on this form. The pass is the redirect plus an unchanged row.
- Quota text on `/audit` uses the short label `存储`. The action code `tenant.quota_changed` is in SQL. `data-audit-action` is `调整配额`.
