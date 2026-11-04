# Log in with a Magic Link

A signed-out visitor asks for a one-time link with an invited email, opens the link from the development mail log, and confirms login. The app then shows that tenant's overview. An unknown email gets the same on-screen reply and no link.

## Sub-features

- `login-request` submits an invited email and shows the check-mail state.
- `login-confirm` opens the mailed URL and creates a session only after the confirm button.
- `login-land` shows the tenant overview for the mailbox that was invited.
- `login-unknown` shows the same check-mail state for an email that is not a member, and the log has no link for it.

## How to get to it (user POV)

- Open `/login` while signed out.
- After signing in, choose `退出登录`. The app returns to `/login`.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- No browser session is signed in. A fresh Chrome profile, or `退出登录` first.
- `admin@verify.test` is the seeded admin.

- **Open the form.** Go to the login page. Run `node .cursor/skills/verify-ducked-init/scripts/browser.mjs goto /login`. The document title is `登录 · CRM 数据分析平台` and the text `登录 CRM 数据分析平台` is visible. Run `browser.mjs title` and `browser.mjs screenshot --path <evidence>/login-form.png`.
- **Ask for a link.** Note the server log size with `wc -c < $LOG_FILE`. Fill the email and submit. Run `browser.mjs fill --label "工作邮箱" --value "admin@verify.test"` and `browser.mjs click --role button --name "发送登录链接"`. Run `browser.mjs wait-text "请查收邮件"`. The form is gone.
- **Read the link.** Run `browser.mjs magic-link --email admin@verify.test --offset <bytes>`. Stdout is one URL whose path is `/auth/verify` and whose host is the READY base URL. The log block is addressed `收件人：admin@verify.test` and contains `验收租户：` plus that URL.
- **Confirm.** Open the URL. Run `browser.mjs goto <url>` and `browser.mjs wait-text "确认登录"`. The title is `确认登录 · CRM 数据分析平台`. Run `browser.mjs screenshot --path <evidence>/login-confirm.png`. Click the button. Run `browser.mjs click --role button --name "登录"` and `browser.mjs wait-url /`.
- **Land.** The heading is `验收租户` and the page contains `当前租户 · 默认空间 · admin@verify.test（管理员）`. Run `browser.mjs wait-text "当前租户 · 默认空间 · admin@verify.test（管理员）"`, `browser.mjs screenshot --path <evidence>/home-admin.png`, and `browser.mjs snapshot --path <evidence>/home-admin.aria.txt`.
- **Unknown email.** Sign out, submit `nobody@verify.test`, and wait for `请查收邮件`. Run `browser.mjs click --role button --name "退出登录"`, `browser.mjs wait-url /login`, `browser.mjs fill --label "工作邮箱" --value "nobody@verify.test"`, `browser.mjs click --role button --name "发送登录链接"`, and `browser.mjs wait-text "请查收邮件"`. `browser.mjs magic-link --email nobody@verify.test --offset <bytes-before-submit>` exits non-zero. The page text is the same as for the admin.

## Gotchas

- `GET /auth/verify?token=...` does not consume the token. Only the `登录` button does. A proof that stops on the confirm page is not a login.
- The mail is written after the HTTP response, by a background task. Poll the log. Do not sleep a fixed time and fail once.
- Use the last link for that recipient after the offset you recorded. Requesting again invalidates the previous unused link.
- Launch sets `MAGIC_LINK_RATE_LIMIT=50` per 15 minutes. The repo default is 5. A sixth request on a server that was not launched by this skill returns `申请过于频繁` and HTTP 429.
- The on-screen reply does not say whether the email is registered. The log does: no block with a token means the email is not a member.
- Do not set `APP_ORIGIN`. Links must use the verification origin. A link aimed at port 5173 will not match this server's cookie.
- `登录` is also a substring of `发送登录链接` and `退出登录`. The harness matches accessible names exactly; do not loosen that.
