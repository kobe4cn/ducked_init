---
name: verify-ducked-init
description: "Drive the CRM 数据分析平台 web app (repo ducked_init, package duckdb_crm) in a real browser against an isolated dev server. Use when a PR-acceptance agent must launch the React Router app from an empty database, log in with a Magic Link, exercise overview, members, tasks, audit, the metric builder, model provider, or the AI assistant, and capture evidence. When the diff changes no page, skip the browser launch. Run the named test files, point a script that rewrites an external file at a temporary server, run sh -n on changed shell scripts, and record the risk class. When the diff touches SeaweedFS startup or volume config (db_script/docker-compose.yml, db_script/seaweedfs/master.toml, the SeaweedFS step in .github/workflows/ci.yml, or db_script/start.sh), start that compose stack, check master Max is 2000, confirm one new bucket's first write adds 1 volume, and run scripts/bench-bucket-per-tenant.ts --write-each on a small bucket count."
---

# Verify CRM 数据分析平台

The primary surface is the multi-tenant React Router app in `app/` (SSR, Vite dev server). Members sign in with a one-time Magic Link. There is no password. This skill launches a disposable copy, drives it in system Chrome through Playwright, and leaves proof files behind after teardown.

Do not drive a server you did not start. Do not point this flow at the developer's `crm_platform` database or port 5173.

Two instances can run side by side. Each `launch.sh` picks its own port, PostgreSQL database (`crm_platform_verify_<run-id>`), and lake directory. Cluster-wide lake roles are named from the tenant id, so they do not collide. Both processes share the checkout's `node_modules/.vite` cache. Pass the run id to `doctor.sh`, `drive-members.sh`, `browser.mjs` is pinned to the `current` symlink unless `VERIFY_STATE_DIR` is set. The symlink always points at the latest launch.

`/ops` (operator Magic Link plus TOTP) is not in this map. The dispatcher is not started. Registering a data source needs a separate read-only database, which this launch does not create.

## Changes that do not touch a page

If the diff changes no route, page, or client state, skip `launch.sh`. The browser map does not exercise that diff.

Record the command output for each check. Record a skipped file as skipped.

- Run the test files named in the ticket. `vitest.config.ts` always runs `test/global-setup.ts`, which needs PostgreSQL even when the test is a pure function. If PostgreSQL refuses the connection, report that the vitest file was not run. A temporary `node --import tsx` script may call the pure function. Label that run as a temporary script.
- Point a script that rewrites an external file at a temporary server you started. Do not point it at a filer that was already listening, including the developer's SeaweedFS and a shared `policies.json`. Show one orphan removed, one live entry left as it was, malformed input and an empty body left unwritten, a second run that does not write, and a read-back that disagrees with the write followed by a restore of the backup.
- Run `sh -n` on each changed shell script.
- Say whether the change is high-risk, and why. The classes are an auth or core authorization change, production secrets or high-privilege access, payments, a destructive database migration, mass data deletion, a core security control, and production infrastructure.

A diff that touches SeaweedFS startup or volume config still skips the browser. Run the subsection below. A green CI run does not cover it: CI only creates `crm-lake`, and a missed `master.toml` mount still lets weed start.

### SeaweedFS startup and volume config

Run this when the diff touches any of `db_script/docker-compose.yml`, `db_script/seaweedfs/master.toml`, the SeaweedFS step in `.github/workflows/ci.yml`, or `db_script/start.sh`. A missed mount fails open. Weed starts, and each new bucket's first write takes the default 7 volumes instead of the 1 in `master.toml`. Comparing the four files is not the check.

Do not point this at a SeaweedFS that was already listening, including the developer's. If port 8333, 8888, or 9333 is held by a container this run did not start, stop and say so.

`db_script/start.sh` is the Apple Container path. On Linux, `sh -n db_script/start.sh` is the check for that file. Do not execute it.

Start the compose services from this checkout and wait until `create-bucket` has exited 0. It uses the `amazon/aws-cli` image to create `crm-lake` at `http://seaweedfs:8333`. That first `s3 mb` can grow one volume on the default collection. That volume is not the check below.

```bash
docker compose -f db_script/docker-compose.yml up -d seaweedfs create-bucket
docker compose -f db_script/docker-compose.yml wait create-bucket
```

On a Linux host, container-to-container traffic needs the docker FORWARD chain to accept packets. If `create-bucket` never finishes its `s3 ls` loop, run `iptables-legacy -P FORWARD ACCEPT` and start the two services again (`up -d --force-recreate create-bucket` so the exited container runs again).

Then, from the host, against the published ports:

1. `curl -sS http://127.0.0.1:9333/dir/status`. `Max` is `Topology.Max` (the field `scripts/bench-bucket-per-tenant.ts` reads). It must be `2000`. A number derived from disk size means `-volume.max=2000` did not take effect.

2. Record the volume count, create one new bucket, write one object, and read the count again. The count is the sum of `Volumes` on every data node: `Topology.DataCenters[].Racks[].DataNodes[].Volumes`. Use a new bucket name, not `crm-lake`. `s3 mb` of that bucket does not change the count. The PUT must raise it by 1. A rise of 7 means `db_script/seaweedfs/master.toml` was not mounted and `copy_1` stayed at the default. Read the count immediately before the PUT and immediately after it. On 4.50, `s3 rb --force` of that new bucket deletes the empty volume and the count falls back, so a count taken after the delete is not the check. The log line `reading /etc/seaweedfs/master.toml` is not proof: weed prints it only at glog verbosity 1, and the compose, CI, and `start.sh` commands do not pass `-v=1`.

```bash
curl -sS http://127.0.0.1:9333/dir/status | node --input-type=module -e '
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const t = JSON.parse(Buffer.concat(chunks).toString()).Topology;
let volumes = 0;
for (const dc of t?.DataCenters ?? []) for (const rack of dc.Racks ?? []) for (const node of rack.DataNodes ?? []) volumes += node.Volumes ?? 0;
console.log(JSON.stringify({ max: t?.Max, free: t?.Free, volumes }));
'
docker run --rm --network host \
  -e AWS_ACCESS_KEY_ID=crm -e AWS_SECRET_ACCESS_KEY=crm-secret -e AWS_DEFAULT_REGION=us-east-1 \
  amazon/aws-cli:latest --endpoint-url http://127.0.0.1:8333 s3 mb s3://verify-vol-delta
printf x | docker run --rm -i --network host \
  -e AWS_ACCESS_KEY_ID=crm -e AWS_SECRET_ACCESS_KEY=crm-secret -e AWS_DEFAULT_REGION=us-east-1 \
  amazon/aws-cli:latest --endpoint-url http://127.0.0.1:8333 s3 cp - s3://verify-vol-delta/first-write
```

Run the volume-count command again. Then remove the bucket:

```bash
docker run --rm --network host \
  -e AWS_ACCESS_KEY_ID=crm -e AWS_SECRET_ACCESS_KEY=crm-secret -e AWS_DEFAULT_REGION=us-east-1 \
  amazon/aws-cli:latest --endpoint-url http://127.0.0.1:8333 s3 rb s3://verify-vol-delta --force
```

3. Run a small `--write-each` bench and keep the output. Exit code 0, a line `每桶首写 3/3 次成功`, and no `No writable volumes`. The script deletes the accounts and buckets it created. The checkpoint also first-writes a probe bucket, so `volumes` in the JSON is higher than `--buckets` (default-collection volume, plus one volume per bench bucket, plus the probe). The pass line is the `3/3` summary, not that volume total.

```bash
node --import tsx scripts/bench-bucket-per-tenant.ts \
  --backend seaweedfs --endpoint localhost:8333 \
  --access-key crm --secret-key crm-secret \
  --filer http://localhost:8888 --master localhost:9333 \
  --buckets 3 --checkpoints 3 --write-each \
  --out /tmp/bpt-verify-write-each.json
```

When CI for this exact commit is already green, adopt that run. Leave the full suite unrun. Still run the targeted files when they can run. The SeaweedFS steps above still run when the diff touches those files.

## Launch

Preconditions, once per machine, not done by the script:

- From the repo root: `pnpm install --frozen-lockfile`
- PostgreSQL 15 or newer reachable by a role that has `CREATEDB` and `CREATEROLE`. Default admin URL: `postgres://crm:crm@127.0.0.1:5432/postgres` (the `postgres` service in `db_script/docker-compose.yml`, started with `docker compose --profile pg up -d postgres`). Override with `VERIFY_PG_ADMIN_URL`.
- For Drive: Google Chrome or Chromium on `PATH`, or `CHROME_PATH` set to the executable. On macOS the system Chrome is not on `PATH`: set `CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`. The first browser command installs `playwright-core@1.64.1` into `.cursor/skills/verify-ducked-init/.tools` (gitignored). It does not download a Playwright browser.
- First tenant creation downloads DuckDB extensions (`ducklake`, `postgres`, `httpfs`) from `extensions.duckdb.org`.

```bash
.cursor/skills/verify-ducked-init/scripts/launch.sh
```

Optional environment: `VERIFY_RUN_ID` (`^[a-z][a-z0-9]{0,30}$`), `VERIFY_PORT`, `VERIFY_PG_ADMIN_URL`, `VERIFY_EVIDENCE_DIR`, `VERIFY_STATE_ROOT` (default `/tmp/verify-ducked-init`).

What it does, in order:

1. Create empty database `crm_platform_verify_<run-id>` and empty lake directory `$STATE_DIR/lake`.
2. Write `$STATE_DIR/app.env` with `PLATFORM_DATABASE_URL`, `PLATFORM_LAKE_URI` (that lake directory), a new `PLATFORM_MASTER_KEY`, `MAILER=console`, and `MAGIC_LINK_RATE_LIMIT=50`. It also writes `APP_ORIGIN=<base url>` there and exports it for migrate, tenant create, and the dev server, so magic links point at this run's server. It unsets `MAIL_HOST`, `MAIL_USER`, and `MAIL_PASS`. Explicitly exported variables win: Vite's `loadEnv` (which React Router dev merges into `process.env`) and Node `--env-file` only fill variables that are not set. An unset variable is not set, so a repo `.env` fills it back in. That is why `APP_ORIGIN` is exported rather than unset; the unset `MAIL_*` variables may be refilled from a repo `.env`, but the exported `MAILER=console` wins, so mail stays in `server.log`. Every `LLM_*` variable that is set in the launch shell is copied into the same file, including an empty value. The dev server sources `app.env`, so a local stub does not depend on the server process inheriting the parent shell. Leave a name unset only when a repo `.env` is allowed to fill it. Model-provider and assistant drives export the stub's `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, and `LLM_REASONING_*` before launch, and export `LLM_FAST_*` and `LLM_EMBEDDING_*` as empty. Use fake keys aimed at `127.0.0.1`.
3. `pnpm db:migrate` then `pnpm tenant:create --slug verify --name 验收租户 --admin-email admin@verify.test`. Launch fails if the log contains `初始化失败` or `catalog_initialized_at` is null.
4. Start `pnpm dev --host 127.0.0.1 --port <port> --strictPort` and record its pid. Stdout is redirected to the state directory's `server.log`, so Vite's clear-screen is not a TTY and does not erase the log.

Ready means usable. A line beginning with `READY ` is printed only after `GET http://127.0.0.1:<port>/login` returns 200 and the body contains `登录 CRM 数据分析平台`, and the admin row and initialized lake were written. The Vite `Local:` log line only means the process is listening. Evidence of this check is `$EVIDENCE_DIR/launch-ready.txt`.

Seeded identities:

| | |
| --- | --- |
| Base URL | `http://127.0.0.1:<port>` (printed in the READY line) |
| Tenant | slug `verify`, name `验收租户`, space `默认空间` |
| Admin | `admin@verify.test`, role `admin` |

Teardown is `scripts/cleanup.sh`. Run it after a failed launch too.

## Doctor

Run this before driving whenever the instance looks off. It only reads:

```bash
.cursor/skills/verify-ducked-init/scripts/doctor.sh
.cursor/skills/verify-ducked-init/scripts/doctor.sh <run-id>
```

It exits 0 only when all of these are true, and writes the same lines to `$EVIDENCE_DIR/doctor.txt`:

- The recorded server pid is alive.
- `/proc/net/tcp` shows `$PORT` in `LISTEN`, and the process that owns that socket is a descendant of the recorded pid. (`ss` is not required.)
- `curl -sS -o $STATE_DIR/doctor-login.html -w '%{http_code}' $BASE_URL/login` is `200` and the body contains `登录 CRM 数据分析平台`.
- This query returns `verify|验收租户|默认空间|admin@verify.test|admin`:

```sql
SELECT t.slug, t.name, s.name, m.email, m.role::text
FROM platform.tenants t
JOIN platform.spaces s ON s.tenant_id = t.id AND s.is_default
JOIN platform.members m ON m.tenant_id = t.id
WHERE t.slug = 'verify' AND m.email = 'admin@verify.test'
```

- The tenant lake has `catalog_initialized_at` set, `data_path` under the run's lake directory, and `db_role` equal to the role recorded at launch.
- The server log does not contain `[后台任务失败]`.

`scripts/sql.sh "SELECT ..."` runs a single query against that database (`-tA -F'|'`) with `default_transaction_read_only=on`, so writes fail with `cannot execute … in a read-only transaction`.

`scripts/sql-write.sh "UPDATE ..."` runs one statement against the same database with writes allowed. It refuses, before connecting, when the run id, `DB_NAME`, or the database name in `DATABASE_URL` is not `crm_platform_verify_<run-id>` (`^[a-z][a-z0-9]{0,30}$` for the run id). After connecting it checks `current_database()` and still refuses a mismatch, so the statement is not run. Use it for a state the form rejects, such as a tier endpoint with a null key. Do not use it to insert members, sessions, or audit rows.

## Drive

Prefer `scripts/browser.mjs`. The first command starts one system Chrome (1440×900) and leaves its pid in `$STATE_DIR/browser.pid`. Later commands reconnect to that same page, so a client-rendered result such as `请查收邮件` is still there for the next command. Labels and accessible names are exact. At this width the admin nav wraps, and the link name is still the full label (`概览`, `成员`, `审计日志`). Do not click by coordinates. Cleanup kills that pid and its children.

```bash
node .cursor/skills/verify-ducked-init/scripts/browser.mjs goto /login
node .cursor/skills/verify-ducked-init/scripts/browser.mjs fill --label "工作邮箱" --value "admin@verify.test"
node .cursor/skills/verify-ducked-init/scripts/browser.mjs click --role button --name "发送登录链接"
node .cursor/skills/verify-ducked-init/scripts/browser.mjs wait-text "请查收邮件"
node .cursor/skills/verify-ducked-init/scripts/browser.mjs magic-link --email admin@verify.test --offset <bytes>
node .cursor/skills/verify-ducked-init/scripts/browser.mjs screenshot --path <evidence>/login.png
node .cursor/skills/verify-ducked-init/scripts/browser.mjs snapshot --path <evidence>/login.aria.txt
```

`magic-link` does not open Chrome. It prints the newest `http://127.0.0.1:<port>/auth/verify?token=...` line from the server log whose console-mail block is addressed to `--email`, considering only bytes at or after `--offset`. Record the offset with `wc -c < $LOG_FILE` before submitting the login form. Opening that URL does not log the user in. The page shows `确认登录`; the session cookie is set only by clicking the button named `登录` (`POST`). Then wait until the path is `/`.

Stable handles used by the map:

- Login: label `工作邮箱`, button `发送登录链接`, text `请查收邮件`, text `确认登录`, button `登录`. Document title `登录 · CRM 数据分析平台`, then `确认登录 · CRM 数据分析平台`.
- Shell: brand text `CRM 数据分析平台`, nav links are the visible labels (`概览`, `成员`, `任务`, `审计日志`, …), avatar link name `我的设置（<email>）`, button `退出登录`.
- Pages: `h1` is the page title (`验收租户` on `/`, `成员` on `/members`, `任务` on `/tasks`, `审计日志` on `/audit`).
- Members: label `邮箱`, label `角色` (option values `admin`, `data_engineer`, `analyst`, `viewer`), button `邀请`, row `[data-email="<email>"]`, role control label `<email> 的角色`.
- Audit rows: `[data-audit-action="<Chinese action label>"]`. `邀请成员` is the label for `member.invited`.
- Tasks rows: `[data-task-kind]` and `[data-task-status]`.
- Model provider: nav `模型服务`, path `/model-provider`, heading `模型服务`, button `测试连通性`, button `恢复平台默认`, button `恢复默认`. `端点`, `模型名`, `API Key`, and `保存` repeat across cards. Scope them with `--within 'form:has(#...)'`. `恢复默认` and `恢复平台默认` need `--confirm accept`. After a save or a reset, read the inputs with `value --label`. A successful save leaves `API Key` empty. A 400 from `set-hidden` on `tier` leaves the typed draft in place.
- Assistant: button `AI 助手` (it toggles the panel), textarea label `向 AI 助手提问`, button `发送`.

The members journey, including login, invite, audit, SQL, the console mail, logout, and a second login as the invitee:

```bash
.cursor/skills/verify-ducked-init/scripts/drive-members.sh
.cursor/skills/verify-ducked-init/scripts/drive-members.sh <run-id>
```

Other features are driven with the same `browser.mjs` commands. See `features/`.

## Evidence

Write proof under the `evidence=` directory from the READY line. The default is `/opt/cursor/artifacts/verify-ducked-init/<run-id>/`. That directory is not inside the state directory.

A proof is a real user path: browser UI on this dev server, not a domain function, not an HTTP test helper, not a direct insert. Capture the action and the resulting state (screenshot of the filled form and of the page after the action, plus an ARIA snapshot). Verify the side effect in a second user-facing view and in stored state. For an invite that is the members table, the audit page, `platform.members`, `platform.audit_logs`, and the console mail block in the server log (copy the block into the evidence directory; cleanup deletes the log).

`drive-members.sh` writes `home-admin.png`, `members-filled.png`, `members-saved.png`, `audit.png`, `home-engineer.png`, the matching `.aria.txt` snapshots, `members.sql.txt`, `audit.sql.txt`, `invite-mail.txt`, and `*-magic-link.txt`. Magic link files contain live login tokens. They are proof, not something to commit.

Do not mock SMTP. `MAILER=console` is the app's real development mailer. Do not start the dispatcher or call task handlers to manufacture a task for the empty task list. A ticket whose browser check needs a succeeded row is outside that map: start `pnpm dispatcher` with this run's `app.env` sourced, and stop that process before cleanup. Cleanup does not know about it.

## Cleanup

```bash
.cursor/skills/verify-ducked-init/scripts/cleanup.sh
.cursor/skills/verify-ducked-init/scripts/cleanup.sh <run-id>
```

This kills the recorded server pid and its descendants, kills Chrome only when its command line contains this run's `chrome-profile` path (the real state directory, not the `current` symlink; `browser.mjs` resolves it the same way), drops that run's database, drops the recorded `lake_<id>` and `lake_<id>_ro` roles, and deletes the state directory (lake files, server log, browser profile). It does not delete the evidence directory. A second cleanup with the same id fails because the state file is gone; the evidence remains.

Run cleanup after every failed launch or drive so ports, databases, and roles are not left behind.

## Gotchas

- 刚起来的 dev server 第一次被访问时，Vite 会做一次依赖优化并整页重载：第一次登录可能卡在「请查收邮件」后等待超时。重试一次即可，或先 `goto /login` 等几秒再开始填邮箱。

## Helpers

| Script | Invocation |
| --- | --- |
| `scripts/launch.sh` | `.cursor/skills/verify-ducked-init/scripts/launch.sh` |
| `scripts/doctor.sh` | `.cursor/skills/verify-ducked-init/scripts/doctor.sh [run-id]` |
| `scripts/drive-members.sh` | `.cursor/skills/verify-ducked-init/scripts/drive-members.sh [run-id]` |
| `scripts/browser.mjs` | `node .cursor/skills/verify-ducked-init/scripts/browser.mjs <command> ...` |
| `scripts/sql.sh` | `.cursor/skills/verify-ducked-init/scripts/sql.sh [run-id] "SQL"` |
| `scripts/sql-write.sh` | `.cursor/skills/verify-ducked-init/scripts/sql-write.sh [run-id] "SQL"` |
| `scripts/llm-stub.mjs` | `node .cursor/skills/verify-ducked-init/scripts/llm-stub.mjs --port 0 --log <file> --origin-file <file>` |
| `scripts/drive-model.sh` | `VERIFY_LLM_LOG=<stub jsonl> .cursor/skills/verify-ducked-init/scripts/drive-model.sh [run-id]` |
| `scripts/cleanup.sh` | `.cursor/skills/verify-ducked-init/scripts/cleanup.sh [run-id]` |
| `scripts/ensure-browser.sh` | `.cursor/skills/verify-ducked-init/scripts/ensure-browser.sh` |
| `scripts/lib.sh` | Sourced by the shell scripts. Do not execute it. |

`browser.mjs` calls `ensure-browser.sh` before opening Chrome. Commands: `goto`, `fill --label --value`, `click --role --name [--confirm accept|dismiss]`, `select --label --value`, `set-hidden --name --value`, `set-file --selector --path`, `wait-text`, `wait-url`, `wait-selector`, `screenshot --path`, `snapshot --path`, `title`, `url`, `text --selector`, `value --label`, `count --selector`, `magic-link --email [--offset]`. `set-file` sets an `<input type="file">`. `fill` cannot. The CSV upload field on `/sources` is `#source-file`. `goto /path` resolves against `BASE_URL`. `fill` / `click` / `select` / `set-hidden` / `value` also take `--within <css>` to scope the lookup inside one container — the metric builder repeats the same labels (several `添加一行` buttons, one per filter block), so scope with the container: `--within '[data-cond-rows="numerator"]'`. `click --confirm accept` accepts one `window.confirm` opened by that click (恢复默认, 恢复平台默认, removing a member). `click --confirm dismiss` cancels it. Without `--confirm`, the dialog is dismissed and a submit guarded by `confirm()` does not run. `set-hidden` writes a hidden input's DOM value directly, bypassing React — used to hand-craft the builder's `form` (see [新建指标（条件构建器）](./features/metric-builder.md)); the value survives only until the next render, so click 检查 right after.

Keep the map honest as the app changes with `/maintain-verification-skill`.
