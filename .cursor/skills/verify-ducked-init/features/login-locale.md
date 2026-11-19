# Login page locale

A signed-out visitor sees the login page in Chinese when English is off, and in English when the server was launched with `CRM_ENABLE_EN_LOCALE=1` and the browser holds the plaintext cookie `crm_locale=en`. The document language follows. A sixth request for one email in a window of 1 minute says `1 minute`; a window of 5 minutes says `5 minutes`. Clearing the cookie or the flag returns the page to Chinese. The Magic Link mail stays Chinese.

## Sub-features

- `login-locale-zh` shows the existing Chinese card and `lang=zh-CN` when the flag is off, including when the English cookie is present.
- `login-locale-en` shows the English card and `lang=en` with the flag on and the plaintext cookie set, and the check-mail alert stays English after hydration.
- `login-locale-rate` shows the English plural on the 6th submit, and the Chinese sentence when the flag is off.
- `login-locale-off` returns to Chinese as soon as the cookie is cleared or the flag is off.

## How to get to it (user POV)

- Open `/login` while signed out.
- There is no language switch on the page. English is the cookie plus the server flag.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS` before the cookie is set. Doctor requests `/login` with no cookie, so it still requires `登录 CRM 数据分析平台` while the flag is on.
- No browser session is signed in.
- The browser daemon was started from this version of `browser.mjs`. An older daemon has no `lang` or `cookie` command. Stop it (kill the pid in `browser.pid` and remove `browser.sock`) and run a command again.
- `admin@verify.test` is the seeded admin. Use a different email for each rate-limit run. The counter is stored per email and survives a server restart.

- **Chinese, flag off.** Launch with `CRM_ENABLE_EN_LOCALE`, `MAGIC_LINK_RATE_LIMIT`, and `MAGIC_LINK_RATE_WINDOW_MINUTES` unset. Run `node .cursor/skills/verify-ducked-init/scripts/browser.mjs goto /login`. Run `browser.mjs lang` and `browser.mjs title`. `lang` prints `zh-CN`. The title is `登录 · CRM 数据分析平台`. The text `登录 CRM 数据分析平台` is visible. Run `browser.mjs screenshot --path <evidence>/login-zh.png`. Run `browser.mjs cookie --name crm_locale --value en`, `browser.mjs goto /login`, and `browser.mjs lang`. `lang` is still `zh-CN` and the title is still the Chinese one. Run `browser.mjs cookie --clear`.
- **English page.** Stop that server with `cleanup.sh`. Export `CRM_ENABLE_EN_LOCALE=1`, `MAGIC_LINK_RATE_LIMIT=5`, and `MAGIC_LINK_RATE_WINDOW_MINUTES=1`, then launch again. Run `browser.mjs cookie --name crm_locale --value en` and `browser.mjs goto /login`. `browser.mjs lang` prints `en`. The title is `Sign in · CRM Data Analytics Platform`. The visible text includes `Work email`, `Send Magic Link`, and `The platform is invite-only and does not offer sign-up.` Run `browser.mjs screenshot --path <evidence>/login-en.png`. Run `browser.mjs console --clear`, `browser.mjs goto /login`, and `browser.mjs console`. No line has type `error` or `pageerror`.
- **Check your email.** Note the server log size. Fill `Work email` with `admin@verify.test` and click `Send Magic Link`. Run `browser.mjs wait-text "Check your email"`. Wait, then run `browser.mjs lang` again. It is still `en`, and the title is still English. The console mail block is addressed `收件人：admin@verify.test`, the subject is `登录 CRM 数据分析平台`, and the body is Chinese.
- **One minute.** On that same server, reload `/login` and submit `rate1m@verify.test` six times. The first five show `Check your email`. The sixth is HTTP 429 and the page shows `Too many requests. Please try again in 1 minute.` Run `browser.mjs screenshot --path <evidence>/login-en-rate-1m.png`.
- **Five minutes.** Clean up and launch again with `CRM_ENABLE_EN_LOCALE=1`, `MAGIC_LINK_RATE_LIMIT=5`, and `MAGIC_LINK_RATE_WINDOW_MINUTES=5`. Set the same cookie and submit `rate5m@verify.test` six times. The sixth shows `Too many requests. Please try again in 5 minutes.`
- **Cookie cleared.** With the flag still on, run `browser.mjs cookie --clear` and `browser.mjs goto /login`. `lang` prints `zh-CN` and the title is `登录 · CRM 数据分析平台`.
- **Flag off, cookie on.** Clean up and launch with the flag unset and `MAGIC_LINK_RATE_LIMIT=5`. Set `crm_locale=en` and open `/login`. `lang` is `zh-CN`. Submit a new email six times. The sixth shows `申请过于频繁，请 5 分钟后再试。` when the window is 5, or `请 1 分钟后再试。` when the window is 1.

## Gotchas

- `cookie --value en` must be the raw characters `en`. A value produced by react-router `createCookie` is not English. `EN` and `english` stay Chinese.
- The form POST from the hydrated page goes to `/login.data`, not `/login`. A document POST to `/login` is still a 429 when the limit is hit.
- A success replaces the form with the alert. Reload `/login` before the next submit.
- Launch's default limit is 50 per 15 minutes. The sixth submit does not 429 on that server.
- `doctor.sh` does not send the cookie. An English page is not a doctor failure.
- `lang` before the first `goto` prints an empty string. The new Chrome page has not loaded `/login` yet.
- The card is `max-w-sm`. The English title wraps before `Platform`, and the subtitle breaks `one-time`. That wrap is the layout, not overflow.
- Do not change the mail subject or body. They stay Chinese.
