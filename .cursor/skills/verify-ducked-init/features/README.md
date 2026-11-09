# CRM 数据分析平台 verification map

This directory is the maintained source for verifying the user-facing behavior of the CRM 数据分析平台 web app. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `.cursor/skills/verify-ducked-init/scripts/launch.sh` and wait for a `READY ` line.
- Run `.cursor/skills/verify-ducked-init/scripts/doctor.sh` and require `DOCTOR PASS`.
- The instance serves `BASE_URL` from that READY line. The database and lake directory belong to that run only.
- Seeded tenant: slug `verify`, name `验收租户`, space `默认空间`, admin `admin@verify.test`.
- `MAILER=console`. Magic Link and invite mail are printed to the server log, not sent over SMTP.
- Put nothing on a shared `crm_platform` database. Never drive an instance that this launch did not start.
- System Chrome is available (`CHROME_PATH` or `google-chrome` / `chromium` on `PATH`).

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Drive the browser with `node .cursor/skills/verify-ducked-init/scripts/browser.mjs`. Names and labels are exact accessible names.
- Read or write SQL only as a second view of something the UI already did. Use `scripts/sql.sh`. Do not insert members, sessions, or audit rows.
- Copy log excerpts into the evidence directory before cleanup. Cleanup deletes the server log.
- Restore nothing by deleting proof files. Cleanup may drop the database; it must not delete evidence.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot (`snapshot --path`) and a screenshot (`screenshot --path`) that show the brand `CRM 数据分析平台` or the page title.
- Mutation proof includes a second user-facing view and a read-only SQL view of the stored row.
- Mail proof is the console block copied out of the server log, including the recipient and the link or the login URL it actually printed.
- Record the feature id, the base URL, and the entry point with the artifacts.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with Playwright` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Log in with a Magic Link](./login.md) covers requesting a link, confirming it, and landing on the tenant overview.
- [Tenant overview](./overview.md) covers the signed-in home page: tenant, space, role, task counts, and the permission list.
- [Invite a member](./members.md) covers inviting a data engineer, the members table, the audit row, the console mail, and signing in as that person.
- [Task list](./tasks.md) covers the empty task list on a freshly seeded tenant.
- [新建指标（条件构建器）](./metric-builder.md) covers building a metric with the condition builder: check without saving (summary + SQL), save as draft v1, ignored empty rows, invalid forms 400, YAML mode, and handmade `form` submissions.
- [新建标签（条件构建器）](./tag-builder.md) covers building a tag from published numeric metrics: single/multi-metric rules with one level of all / any, missing-value strategy, default, save as draft v1 with the same YAML as handwritten, and YAML mode.
- [Audit log](./audit.md) covers the tenant-creation row written by launch. Lake init during launch does not add an audit row.
