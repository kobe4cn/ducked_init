# Definition page assertion failure

A published metric or tag page (`/analytics/definitions/<kind>/<key>`) shows a red alert when the latest `gold.dsl` task for that definition failed an error-level assertion and that task is newer than the latest snapshot (or there is no snapshot yet). The alert names the assertion, the failing row count, and the task time. A member with `sources:read` also sees up to three failing keys per assertion, the source mapping names (`源 · 表 → 实体`), and a `查看样本` link to `/quality?task=<task id>`. A viewer sees the assertion and the row count only. A later successful compute removes the alert.

## Sub-features

- `definition-failure-alert` shows the red alert with the assertion name, the failing row count, the task time, and `还没有可用的快照` when the definition has never had a snapshot.
- `definition-failure-samples` shows the failing key, the mapping name, and `查看样本` for a role with `sources:read`, and the quality page lists only that task.
- `definition-failure-viewer` shows the same alert to a viewer and omits the keys, the mapping, and the link from the document.
- `definition-failure-cleared` removes the alert after the source value is fixed, synced, merged, and recomputed.

## How to get to it (user POV)

- Choose `指标与标签` under `分析`, open the metric, or go to `/analytics/definitions/metric/revenue`.
- The alert sits in the `重新计算` panel, above `data-last-refresh`.
- `查看样本` goes to `/quality?task=<id>`. A viewer who opens `/quality` directly sees `无权访问`.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- PostgreSQL is the one this run started. Do not use `crm_platform` or a `crm_platform_verify_*` database as the source.
- Create a throwaway source database `crm_src_<token>` (`<token>` is `[a-z0-9]{1,24}`) owned by `crm`, schema `crm`, and a login `ro_<token>` with password `verify-reader-secret`. The reader may `CONNECT` and `SELECT` on `crm.customers` and `crm.orders` only. Revoke `CREATE` on the database and on schemas `public` and `crm` from `PUBLIC` and from the reader. The reader must not own the tables.
- `crm.customers` has `id int primary key`, `name`, `mobile`, `email`, `unionid`, `updated_at timestamp not null`, with two rows (ids 1 and 2). `crm.orders` has `order_no text primary key`, `customer int`, `status text`, `amount numeric(18,2)`, `created_at`, `paid_at`, `updated_at timestamp not null`. Insert `O1` amount 120, `O2` amount 80, and `A7` amount -10, all `status` `paid`, `customer` 1 or 2.
- Signed in as `admin@verify.test`. Invite `eng@verify.test` with role value `data_engineer` and `viewer@verify.test` with role value `viewer` using the members recipe. Do not `wait-text` the nav label `成员`: that link is inside a closed menu and the exact text match hits a hidden node.
- Start the dispatcher in a session that stays alive, with this run's `app.env` sourced and `MAIL_HOST`, `MAIL_USER`, and `MAIL_PASS` unset: `pnpm dispatcher`. Stop that process before `cleanup.sh`. Cleanup does not know about it.

- **Register the source.** On `/sources` the register card is open. `select --label "类型" --value postgres`, then fill `名称` `CRM`, `主机` `127.0.0.1`, `端口` `5432`, `数据库名` `crm_src_<token>`, `schema` `crm`, `用户名` `ro_<token>`, `密码` `verify-reader-secret`. Choose `校验并登记`. The path becomes `/sources/<id>`. The listed tables are `customers` and `orders`.
- **Sync.** `click --role checkbox --name customers` and the same for `orders`, then `click --role button --name "保存同步范围"`. Wait until `sql.sh` shows `source.profile` `succeeded`. Two buttons are named `确认为水位线`. `click --role` refuses the duplicate. `click --selector 'li[data-candidate="updated_at"] button'` confirms one table; run it again for the other. `count --selector 'li[data-candidate="updated_at"] button'` is then 0. Choose `立即同步` and wait until `source.sync` is `succeeded`.
- **Map and publish.** On `/mappings`, `select --label "表或源视图" --value customers` and `select --label "目标实体" --value customer`, then `click --role button --name "按规则生成草稿"` and `校验并保存草稿`. The path becomes `/mappings/<id>`. Open `新建映射` with `click --selector 'summary:has-text("新建映射")'`, repeat for `orders` / `order`, and save. The form mode is the default tab. Do not fill the YAML textarea: it has no accessible name, so `fill --label` cannot see it. Sign in as `eng@verify.test` and `click --role button --name "发布 v1"` on each mapping. Wait until both `silver.merge` tasks are `succeeded`. The order merge writes 3 rows.
- **Publish the metric.** As the engineer, open `/analytics/definitions/new?kind=metric`. `select --label "基础实体" --value order`, then `select --label "聚合" --value sum`. The `字段` list gains `amount` only after `sum` is selected. `select --label "字段" --value amount`, `fill --label "键" --value revenue`, and `click --role button --name "校验并保存草稿"`. The path is `/analytics/definitions/metric/revenue`. Sign in as the admin (the engineer saved the draft, so the engineer cannot publish it) and `click --role button --name "发布 v1"`.
- **Failure alert.** Wait until `gold.dsl` is `failed` and its error contains `金额非负（silver.order，1 行不合格）`. Reload the definition page. `wait-selector '[data-last-failure]'`. The alert text contains `最近一次计算未通过`, `金额非负（silver.order，1 行不合格）`, `不合格的键：A7`, `来源映射：CRM · orders → order`, and `还没有可用的快照`. It does not contain `继续使用上一版`. `count --selector '[data-failure-samples]'` is 1. Run `screenshot` and `snapshot`. This is the no-snapshot wording: the publish-time compute is the first one, and it fails before any snapshot exists. When a snapshot is already present, the same alert ends with `分析页继续使用上一版` instead.
- **Samples.** `click --role link --name "查看样本"`. The path is `/quality?task=<the failed gold.dsl id>`. `text --selector '[data-task-filter]'` contains `只看任务` and that id. `wait-text "只看任务"` does not match: the text node includes the id. The quarantine row `[data-quarantine-key="A7"]` for `金额非负` shows amount `-10.00` and a link `CRM · orders → order`. Every task id in the run table is that same id.
- **Viewer.** `goto /` and `click --role button --name "退出登录"`. A 403 page has no logout button; do not look for it there. Sign in as `viewer@verify.test` and open the definition page. `[data-last-failure]` is present and its text contains `金额非负（silver.order，1 行不合格）` and `还没有可用的快照`. `count --selector '[data-failure-samples]'` is 0 and `count --selector 'a[href*="/quality"]'` is 0. `html --path <evidence>/definition-failure-viewer.html` and check that file: it contains `data-last-failure` and the assertion sentence, and it does not contain `不合格的键`, `data-failure-samples`, or `/quality?task=`. Do not fail the file for containing `A7` inside a font `unicode-range` (`U+A720`). `goto /quality` shows heading `无权访问` and the document request is HTTP 403.
- **Cleared.** In the source database, set `A7`'s amount to `10` and `updated_at` to `now()`. Sign in as the admin, open the source, and choose `立即同步`. Wait until the new `source.sync` and the following `silver.merge` are `succeeded`. Open the definition page and `click --role button --name "重新计算"`. Wait until the newest `gold.dsl` is `succeeded`. Reload. `count --selector '[data-last-failure]'` is 0. `text --selector '[data-last-refresh]'` contains `最近一次刷新` and `来源 手动`. A merge can also enqueue a `gold.dsl` of its own before the click; that success already removes the alert, and the manual recompute is what sets the source to `手动`.

## Gotchas

- The reader account is rejected when it can `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, or `CREATE` on the database or on a non-system schema. Owning the tables counts as writable.
- `click --role button --name "确认为水位线"` matches two buttons and throws. Use the `updated_at` selector, twice.
- `wait-text` is exact. `已选入` and `只看任务` are prefixes of longer nodes.
- Select `字段` `amount` only after `聚合` is `sum`. Before that the option is not in the list, and saving the empty builder returns `构建器的内容读不出来`.
- The person who last saved a draft cannot publish it. Admin drafts the mappings and the engineer publishes them; the engineer drafts the metric and the admin publishes it.
- Stop the dispatcher before `cleanup.sh`. Drop `crm_src_<token>` and `ro_<token>` after the evidence is copied. Do not drop `crm_platform` or the `crm_platform_verify_*` database from this recipe; `cleanup.sh` drops the launch database.
