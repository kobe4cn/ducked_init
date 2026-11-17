---
name: verify-ducked-init
description: "Drive the CRM 数据分析平台 web app (repo ducked_init, package duckdb_crm) in a real browser against an isolated dev server. Use when a PR-acceptance agent must launch the React Router app from an empty database, log in with a Magic Link, exercise overview, members, tasks, audit, the metric builder, model provider, the LLM usage page, the AI assistant, the file-upload source preview on /sources, the data-source page scroll position, the knowledge page, the operator tenant storage quota, or the operator model price page, and capture evidence. When the diff changes scripts/crm-seed/setup.ts recompute, run that step against an isolated database and record task asOf. When the diff changes no page, skip the browser launch. When the diff touches app/.server/catalog/embeddings.ts or app/.server/catalog/vector-store.ts, skip the browser and run the Catalog embeddings section. When the diff adds a drizzle migration, also migrate a database that already has rows at the parent commit and confirm only the new column changes. Run the named test files, point a script that rewrites an external file at a temporary server, run sh -n on changed shell scripts, and record the risk class. When the diff touches SeaweedFS startup or volume config (db_script/docker-compose.yml, db_script/seaweedfs/master.toml, the SeaweedFS step in .github/workflows/ci.yml, or db_script/start.sh), start that compose stack, check master Max is 2000, confirm one new bucket's first write adds 1 volume, and run scripts/bench-bucket-per-tenant.ts --write-each on a small bucket count. When the diff changes per-tenant bucket isolation (initTenantCatalog creating a bucket, prefixPolicy, createBucket or deleteBucket, resetDb deleting buckets, or drop-test-resources collecting buckets), start a disposable SeaweedFS and check exclusive buckets, idempotent create, cross-tenant 403, legacy prefix conditions, and suffix cleanup. Do not delete every lake-* bucket."
---

# Verify CRM 数据分析平台

The primary surface is the multi-tenant React Router app in `app/` (SSR, Vite dev server). Members sign in with a one-time Magic Link. There is no password. This skill launches a disposable copy, drives it in system Chrome through Playwright, and leaves proof files behind after teardown.

Do not drive a server you did not start. Do not point this flow at the developer's `crm_platform` database or port 5173.

Two instances can run side by side. Each `launch.sh` picks its own port, PostgreSQL database (`crm_platform_verify_<run-id>`), and lake directory. Cluster-wide lake roles are named from the tenant id, so they do not collide. Both processes share the checkout's `node_modules/.vite` cache. Pass the run id to `doctor.sh`, `drive-members.sh`, `browser.mjs` is pinned to the `current` symlink unless `VERIFY_STATE_DIR` is set. The symlink always points at the latest launch.

`/ops` is in this map for the tenant storage-quota form and the model price page. Drive those with [features/ops-quota.md](features/ops-quota.md) and [features/ops-model-prices.md](features/ops-model-prices.md) after `launch.sh`. Other operator pages are not in the map. The dispatcher is not started. Registering a data source needs a separate read-only database, which this launch does not create. Scroll preservation on that page is [features/source-scroll.md](features/source-scroll.md). `scripts/seed-readonly-postgres.sh` creates the database.

## Changes that do not touch a page

If the diff changes no route, page, or client state, skip `launch.sh`. The browser map does not exercise that diff. A diff that touches `app/.server/catalog/embeddings.ts` or `app/.server/catalog/vector-store.ts` still skips the browser. Run [Catalog embeddings](#catalog-embeddings).

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

### Per-tenant buckets

Run this when the diff changes who gets an object-storage bucket or who may delete one. The files are `app/.server/lake.ts` (`initTenantCatalog` and `layout`), `app/.server/s3-accounts.ts` (`prefixPolicy`), `app/.server/s3-client.ts` (`createBucket` and `deleteBucket`), `app/.server/lake-storage.ts` (`isTenantBucketRoot`), `test/http/harness.ts` (`resetDb`), and `scripts/drop-test-resources.ts`. A green CI run does not replace this section. CI does not show the bucket list, the policy document, or a cleanup of one named suffix. Skip `launch.sh`. There is no page to drive.

Start a SeaweedFS this run owns. Do not use one that was already listening, including the developer's, and do not share its `policies.json`. The compose services in the volume-config subsection (`seaweedfs` and `create-bucket`) are the right server even when those four files are not in the diff. If `docker` is not on `PATH`, run the SeaweedFS 4.50 `weed` binary instead. Set `-ip` and `-ip.bind` to the same address the S3 client dials. For a process on this host, both are `127.0.0.1`. A volume server that binds `127.0.0.1` while the filer advertises another address answers `PutObject` with HTTP 500 (`dial tcp <advertised>:8080: connect: connection refused`). An empty `.keep` can still read back as 200, so that GET is not proof that writes work.

```bash
weed server -dir=/tmp/verify-weed/data -ip=127.0.0.1 -ip.bind=127.0.0.1 \
  -s3 -s3.port=8333 -s3.iam.readOnly=false \
  -master.volumeSizeLimitMB=1024 -volume.max=2000
```

Put `db_script/seaweedfs/master.toml` in the weed process's current directory so `copy_1 = 1` is read. Platform credentials on that server are `AWS_ACCESS_KEY_ID=crm` and `AWS_SECRET_ACCESS_KEY=crm-secret`.

Use a new database named `crm_platform_test` plus a suffix `_i<token>`. The suffix must match `^_i\w+$`, which is what `scripts/drop-test-resources.ts` accepts. Point `PLATFORM_DATABASE_URL` at that database, `PLATFORM_LAKE_URI` at an `s3://` root on this server, and `TEST_S3_LAKE_URI` at the shared prefix without the suffix. Cleanup appends the suffix itself. Set `S3_ENDPOINT`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY` to this server. Migrate the database. A temporary `node --import tsx` script may call `createTenant`, `initTenantCatalog`, `resetDb`, and the S3 helpers. Label that run as a temporary script. Put the script outside the commit. When CI for this commit is already green, do not rerun the suite.

Record the command output for each of these:

- A new tenant's `platform.tenant_lakes.data_path` is `s3://lake-<tenant id>/`. That bucket is in `ListBuckets`. `GetUserPolicy` for `lake-<tenant id>` allows object operations on `arn:aws:s3:::lake-<tenant id>/*` and `s3:ListBucket` on `arn:aws:s3:::lake-<tenant id>`, and the document has no `Condition`. The tenant's own `GetObject`, `ListBucket`, and `PutObject` on that bucket return 200.
- With that tenant's keys, `GetObject`, `PutObject`, `DeleteObject`, and `ListBucket` on another tenant's bucket return HTTP 403 and `AccessDenied`. The same 403 is required for a bucket whose name is `lake-<id>` plus one extra character. `PutBucket` by the tenant returns 403.
- A second `PUT` of the same bucket on SeaweedFS 4.50 returns 409 `BucketAlreadyOwnedByYou`. Calling `initTenantCatalog` again still succeeds, and the access key already stored is left in place.
- A lake row whose `data_path` is a shared prefix (`s3://<bucket>/.../tenants/<id>/`) does not grow a `lake-<id>` bucket. Its policy still has a `Condition`. `setTenantS3Prefixes` with both that prefix and the tenant's own bucket keeps the `Condition` on the shared bucket. Listing the whole shared bucket with those keys returns 403.
- `resetDb` against this database, with `TEST_S3_LAKE_URI` set, deletes the recorded `s3://lake-<id>/` buckets and the tenant accounts. `pnpm sandcastle:cleanup _i<token>` then deletes that test database, any recorded bucket still left, and accounts whose policy names the suffixed prefix. The suffix is an argument of the script. `pnpm sandcastle:cleanup -- _i<token>` forwards `--` and the script exits 2. A bucket you created and did not record in a matched test database, including another `lake-*` name, is still listed after both commands. Do not list every `lake-*` bucket and delete them. Dev tenants use those names on a shared server. After the evidence is recorded, delete only the canaries this run created.

### Schema migration on existing rows

Run this when the diff adds a directory under `drizzle/`. CI applies migrations to empty databases. It does not show rows that already existed at the parent commit's schema. A green CI run does not replace this section. If the diff also changes a page, still run `launch.sh`. `launch.sh` migrates an empty database; it is not this check.

Do not point this at `crm_platform`, at a database `launch.sh` created, or at any `crm_platform_verify_*` database. Create two databases and drop them when the evidence is recorded. Names: `crm_migrate_<token>_up` and `crm_migrate_<token>_fresh`. `<token>` is `[a-z0-9]{1,12}`.

The parent tree is `HEAD^` of the commit under test (the PR base). Its `drizzle/` does not contain the new migration directory.

```bash
git worktree add --detach /tmp/verify-migrate-parent HEAD^
ln -sfn "$PWD/node_modules" /tmp/verify-migrate-parent/node_modules
```

`migratePlatformDb` in `app/.server/db/migrate.ts` reads `drizzle/` next to that file. Run it from the worktree for the upgrade database, then from the PR checkout for the same database and for the fresh database. Close the pool so the process exits:

```bash
PLATFORM_DATABASE_URL='postgres://crm:crm@127.0.0.1:5432/crm_migrate_<token>_up' \
  node --import tsx -e '
import { migratePlatformDb } from "./app/.server/db/migrate.ts";
import { closeDb } from "./app/.server/db/client.ts";
await migratePlatformDb();
await closeDb();
'
```

Before the second migrate, insert rows that omit the new column. For a column on `platform.tenants`, `slug` and `name` are required. Insert two rows and set the other integer quota columns to two different combinations. Record those values.

Fingerprint the `platform` schema before the second migrate and after it. Include columns (type, `attnotnull`, default, column comment), constraints, indexes, enums, tables, and table comments. Sort the lines. `diff` the two files. The only added line is the new column. Existing rows show the column default, and every other column on those rows is unchanged. `INSERT` of `NULL` into a `NOT NULL` column fails with `violates not-null constraint`.

Migrate `crm_migrate_<token>_fresh` from the PR checkout with no prior rows. Insert one row that omits the new column. It receives the default. The fresh fingerprint matches the upgraded fingerprint.

`pnpm db:migrate` on the database `launch.sh` creates is a second fresh-database run. It does not replace the upgrade database.

Copy the diff, the row listings, and the null-insert error into the evidence directory. Then:

```bash
git worktree remove --force /tmp/verify-migrate-parent
```

Drop both `crm_migrate_<token>_*` databases. Do not drop `crm_platform` or a `crm_platform_verify_*` database from this section. `cleanup.sh` drops only the launch database.

## crm-seed recompute

Run this when the diff changes the `recompute` step in `scripts/crm-seed/setup.ts`. CI does not run that script. A green CI run does not replace this section. Skip `launch.sh` here. The launch tenant has no published metrics.

Create a database named `crm_recomp_<token>`. `<token>` is `[a-z0-9]{1,12}`. Do not use `crm_platform` or a `crm_platform_verify_*` database. Migrate it from this checkout with `PLATFORM_DATABASE_URL` pointing at it. Point `PLATFORM_LAKE_URI` at an empty directory this run created. Set `PLATFORM_MASTER_KEY` and `MAILER=console`.

`setup.ts` reads `scripts/crm-seed/out/credentials.txt` and `scripts/crm-seed/out/truth.duckdb` before it looks at `--step` (`out/<set>/truth.duckdb` when `--set` is passed). `scripts/crm-seed/seed.ts` writes those, and it writes MySQL through `container exec mysql`, MongoDB through `container exec mongodb`, and objects to `localhost:8333`. Start those servers in this run. Do not point the script at a MySQL, MongoDB, or SeaweedFS that was already listening. If `container` is not on `PATH`, report this check blocked and keep the log. Do not treat a log of missing `silver.*` tables as a pass.

When those servers are the ones this run started:

```bash
node --env-file=<env> --import tsx scripts/crm-seed/setup.ts --tenant recomp<token> --step sources,mappings,definitions,recompute
```

Pass is all of these:

- The process exits 0.
- The log has no line containing `✘`.
- Every key under `scripts/crm-seed/definitions/metric/` and `definitions/tag/` that is published has a `platform.tasks` row with `kind = 'gold.dsl'`, `params->>'trigger' = 'manual'`, and `params->>'asOf'` equal to today's UTC date. For a metric whose yaml has `window:`, `params->>'sql'` contains that same date.
- A downstream tag that is still queued when the next metric is recomputed is drained and retried. The log contains `等 <key> 的下游算完`, and that key is not left failed.
- A yaml key that is not published is reported. The log contains `✘ 重新计算 <kind> <key>：` and the process still exits 0. Do not add that file on the branch under test. Unpublish one key in this database after `definitions`, or put the extra file only in a throwaway copy of the tree, then run `--step recompute` again.

`definitions` throws, before `recompute`, when a yaml names a field that no published mapping has produced (for example `event.x_guide_id` on `wecom_chats_30d`). That throw is not the `✘` line. Fix the missing mapping or report the check blocked.

Drop `crm_recomp_<token>` after the log and the task query are copied into the evidence directory. Do not drop `crm_platform` or a `crm_platform_verify_*` database.

## Catalog embeddings

Run this when the diff touches `app/.server/catalog/embeddings.ts` or `app/.server/catalog/vector-store.ts`. Skip `launch.sh`. There is no feature file and no page: nothing in the browser reads or writes `platform.catalog_embeddings`. A green CI run does not replace this section. CI runs the catalog embedding tests. It does not show the hash read `ensureEmbeddings` takes outside its platform transaction.

Create a database named `crm_verify_embed_<token>`. `<token>` is `[a-z0-9]{1,12}`. Do not use `crm_platform` or a `crm_platform_verify_*` database. Migrate it from this checkout with `PLATFORM_DATABASE_URL` pointing at it. Set `LLM_EMBEDDING_BASE_URL` to `http://127.0.0.1:9/v1`, and set `LLM_EMBEDDING_MODEL` and `LLM_EMBEDDING_API_KEY` to fake values. A temporary `node --import tsx` script may call `ensureEmbeddings`, `fillEmbeddings`, `readEmbeddings`, and `vectorHits`. Pass `setLlmFetch` a function that returns one numeric vector per input string and does not call the network. Label that run as a temporary script. Put the script outside the commit. When CI for this commit is already green, do not rerun the suite.

Pass for the sequential path is all of these, on one tenant, with a second tenant that has the same text hash:

- With the three `LLM_EMBEDDING_*` variables unset, `ensureEmbeddings` returns `off` and inserts no `catalog.embed` task. With them set, two calls while vectors are missing return `queued` and leave one `catalog.embed` row.
- `fillEmbeddings` writes one current-model row per distinct projection hash. The vector matches the stub. Rows for another model, and rows whose hash is not in the projection, are gone. The other tenant's row is unchanged. The next `ensureEmbeddings` returns `fresh` and does not insert a task. `vectorHits` on those projection rows returns one hit per row and does not insert a task.

Then open the window around the hash read. From a second connection, `BEGIN` and `LOCK TABLE platform.catalog_projection IN ACCESS EXCLUSIVE MODE`. Call `ensureEmbeddings`. Wait until `pg_stat_activity` shows that call waiting on a `Lock` for the projection select. While it waits, change `platform.catalog_embeddings`, then `COMMIT` the lock and record the return value and the task count.

Record both directions. Do not score them as identical to the parent unless the ticket says so:

- Projection hashes are already stored. Delete one current-model row while the projection select waits. A hash read inside the transaction returns `queued` and inserts one task. A hash read taken before the transaction returns `fresh` and inserts nothing: the in-memory set still contains the deleted hash.
- One projection hash has no row. Insert that row while the projection select waits. A hash read inside the transaction returns `fresh`. A hash read taken before the transaction returns `queued` and inserts one task.

Copy the log into the evidence directory. Drop `crm_verify_embed_<token>`. Do not drop `crm_platform` or a `crm_platform_verify_*` database.

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
- LLM usage: nav `模型调用` (immediately after `模型服务`, admin only), path `/llm-usage`, heading `模型调用`, links `近 7 天` and `近 30 天`. Purpose rows are `[data-purpose="<purpose>"]`, the totals row is `[data-purpose="total"]`, and the pager text is `第 N / M 页，每页 50 条`. A denied role sees `无权访问` and `仅管理员可以配置模型服务`. `wait-text` is exact, so the empty state is the whole sentence ending in `测试一次连通性。`.
- Assistant: button `AI 助手` (it toggles the panel), textarea label `向 AI 助手提问`, button `发送`. Candidate buttons use `[data-choice]`, the group is `[data-choices]`, and the confirm card is `[data-ask-card]` with buttons `记为知识提案` and `不用`. `scripts/llm-stub.mjs` never calls `catalog_search`, and `browser.mjs` does not record requests, so that path is [记为知识提案](features/assistant-knowledge.md): a temporary stub, a temporary seed, and a temporary request log. The history row's accessible name includes the owner and the timestamp.
- Knowledge: nav `业务知识`, path `/knowledge`, heading `业务知识`. Alias field label `新别名`, button `新增别名`, chip `[data-alias="<alias>"]`. A pending proposal is `[data-proposal="<id>"]`. Its text is `默认指向：『<词>』默认指这一条`. Button `接受` is inside that element; scope it with `--within`. `拒绝` is a closed `<summary>`, not a button the click command can hit. There is no `修改后接受` on a `term_default` proposal. See [features/knowledge.md](features/knowledge.md).
- Model prices: nav `模型单价`, path `/ops/model-prices`, heading `模型单价`, labels `模型名`, `输入单价`, `输出单价`, `币种`, button `保存`. A price row is `[data-model="<model>"]`. Operator audit labels are `新增模型单价` and `修改模型单价`. A value that starts with a dash needs `--value=-1`. `币种` has only `CNY` and `USD`.

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
| `scripts/seed-readonly-postgres.sh` | `.cursor/skills/verify-ducked-init/scripts/seed-readonly-postgres.sh <db-name>` |
| `scripts/lib.sh` | Sourced by the shell scripts. Do not execute it. |

`browser.mjs` calls `ensure-browser.sh` before opening Chrome. Commands: `goto`, `fill --label --value`, `click --role --name [--confirm accept|dismiss]` or `click --selector <css>`, `select --label --value`, `set-hidden --name --value`, `set-file --selector --path`, `wait-text`, `wait-url`, `wait-selector`, `screenshot --path`, `snapshot --path`, `title`, `url`, `text --selector`, `value --label`, `count --selector`, `scroll-y`, `scroll-into --selector <css>` or `scroll-into --role --name`, `magic-link --email [--offset]`. `click --selector` clicks one CSS match, including a `<summary>`. `scroll-y` prints `window.scrollY`. `scroll-into` scrolls that control into view and prints the scroll position after. `screenshot` captures the full page, so it is not the scroll measurement. `wait-text` is exact and accepts `--within`. `set-file` sets an `<input type="file">`. `fill` cannot. The CSV upload field on `/sources` is `#source-file`. `goto /path` resolves against `BASE_URL`. `fill` / `click` / `select` / `set-hidden` / `value` also take `--within <css>` to scope the lookup inside one container — the metric builder repeats the same labels (several `添加一行` buttons, one per filter block), so scope with the container: `--within '[data-cond-rows="numerator"]'`. `click --confirm accept` accepts one `window.confirm` opened by that click (恢复默认, 恢复平台默认, removing a member). `click --confirm dismiss` cancels it. Without `--confirm`, the dialog is dismissed and a submit guarded by `confirm()` does not run. `set-hidden` writes a hidden input's DOM value directly, bypassing React — used to hand-craft the builder's `form` (see [新建指标（条件构建器）](./features/metric-builder.md)); the value survives only until the next render, so click 检查 right after.

Keep the map honest as the app changes with `/maintain-verification-skill`.
