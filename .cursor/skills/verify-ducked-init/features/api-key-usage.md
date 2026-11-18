# API key usage on consumer lookup

A successful lookup with an API key adds 1 to `platform.api_key_usage.calls` for that tenant, key, endpoint, and UTC day. A failed lookup does not. There is no page for the counter. The browser map does not show it.

## Sub-features

- `usage-by-id` — `GET /api/v1/consumers/:consumerId` with no `snapshot` query, when the body is 200, increments the row whose `endpoint` is `consumers.byId`.
- `usage-by-source` — `GET /api/v1/consumers/by-source/:source/:customerId` with no `snapshot` query, when the body is 200, increments the row whose `endpoint` is `consumers.bySource`.
- `usage-skip` — 401 (missing key, wrong key, revoked key, paused tenant), 404, 503, and any request with `?snapshot=` (by-source returns 400) leave the counter unchanged.
- `usage-isolated` — each row's `tenant_id` is the tenant that owns the key. One tenant's rows do not use the other tenant's key.
- `usage-aside` — `GET /api/v1/catalog` and `POST /api/v1/exports` do not write `api_key_usage`. `last_used_at` still moves at most once a minute and is not the counter.
- `usage-write-fails-open` — if the usage insert fails, the lookup still returns 200 and the log contains `[api-usage]`. `last_used_at` from `requireApiKey` stays updated.

## How to get to it (user POV)

- There is no counter page. An admin creates a key at `/api-keys` (button that submits `intent=create`). The plaintext is the `data-api-key` element on that response only.
- The external caller sends `Authorization: Bearer <key>` to the two lookup paths. The stored effect is a row in `platform.api_key_usage`, read with `scripts/sql.sh`.

## Driving it with Playwright

Preconditions:

- `launch.sh` has printed `READY` and `doctor.sh` has printed `DOCTOR PASS` for this run.
- The database is the one that launch created. `platform.api_key_usage` and `platform.serving_stores` are empty. Do not run this twice on the same database.
- Do not open `browser.mjs` for the counter. The helper logs in with the console Magic Link, creates the keys, builds one encrypted serving file per tenant, and issues the HTTP calls.

- **Run the helper.** `.cursor/skills/verify-ducked-init/scripts/api-key-usage.sh [run-id]`. Exit 0. The log is `$EVIDENCE_DIR/api-key-usage.log`.
- **Success accumulates.** After the first by-id 200, `sql.sh` shows one row: `endpoint=consumers.byId`, `calls=1`, `day` equal to `(now() AT TIME ZONE 'UTC')::date`. The by-source 200 adds a second row with `endpoint=consumers.bySource` and `calls=1`. A second by-id 200 changes the first row to `calls=2` and does not insert another row.
- **Skips.** Before any serving file exists, a valid key gets 503 and the table stays empty. Missing, wrong, and revoked keys get the same 401 body and add no row. `?snapshot=` on by-id is 404 for an unknown snapshot and adds no row. `?snapshot=` on by-source is 400 and adds no row. After the serving file exists, an unknown consumer is 404 and the counts stay put.
- **Other routes and last_used_at.** Catalog returns 200 with `definitions`. A second catalog call in the same minute does not change `last_used_at`. Setting `last_used_at` two minutes back, then calling catalog again, changes `last_used_at`. `POST /api/v1/exports` with `{ "conditions": [] }` is 400. `GET /api/v1/exports/<unknown id>` is 404. None of those writes a usage row.
- **Two tenants.** The helper creates slug `usageb`. Each key's usage rows have that key's `tenant_id`. A count of rows whose `tenant_id` disagrees with the key is 0.
- **Write failure.** The helper installs a trigger that raises on insert or update, calls by-id, and drops the trigger. The response is 200, `calls` is unchanged, the server log contains `[api-usage]`, and `last_used_at` has moved. The next by-id after the trigger is gone increments `calls` by 1.

## Gotchas

- An empty launch has no serving store. The lookup is 503, not 200. 503 is a real non-counting result. It is not a pass for the success path. The helper builds the serving file with `tenantServingKey` and points `platform.serving_stores` at it. That file is under this run's state directory and goes away with `cleanup.sh`.
- The Magic Link is written after the login response returns. Poll the server log. Measure the offset with the file's byte length. A character offset skips the new block once the log contains non-ASCII text.
- Requesting a new link invalidates the previous unused link.
- `?snapshot=` returns before `recordApiKeyUsage`, including when the snapshot is missing (404). Do not treat a 404 snapshot as a counted lookup.
- `last_used_at` is updated by `requireApiKey`, at most once a minute. A catalog call inside that minute does not move it. That is the cadence, not a failure. The usage table is a different write.
- The usage insert is not in the same transaction as the lookup or as the `last_used_at` update. A failing insert still returns the consumer JSON, and `last_used_at` stays at the new value.
- Catalog and the export routes call `requireApiKey` and must not call `recordApiKeyUsage`.
- The helper's second tenant is `usageb`. `cleanup.sh` drops the launch tenant's lake roles only. Drop `usageb`'s `lake_<id>` and `lake_<id>_ro` roles yourself if cleanup leaves them.
- Do not point this at `crm_platform` or at a database this launch did not create.
