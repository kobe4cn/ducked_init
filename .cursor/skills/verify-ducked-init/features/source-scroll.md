# Data source scroll

On a data source with enough tables, saving the sync scope, confirming a watermark, declaring a business key, and confirming a soft-delete column post back to the same page. The viewport stays where the member was. An empty key declaration shows its error without jumping to the top.

## Sub-features

- `source-scroll-scope` keeps `window.scrollY` when saving the sync scope, and the selected tables stay selected.
- `source-scroll-watermark` keeps `window.scrollY` when confirming a watermark, and the row shows `已确认`.
- `source-scroll-key` keeps `window.scrollY` when declaring a unique column as the business key, and the row shows `已确认` after the check succeeds.
- `source-scroll-soft-delete` keeps `window.scrollY` when confirming a soft-delete column on a table that already has a primary key, and the row shows `已确认`.
- `source-scroll-error` keeps `window.scrollY` when the key form is submitted with no column, and the alert says `请选择组成业务主键的字段`.

## How to get to it (user POV)

- Sign in as the admin. Choose `数据源`. Register a PostgreSQL source. The detail page opens at `/sources/<id>`.
- The four forms are on the overview tab, under `同步范围` and `源表`. They are below the fold when the source lists about 25 tables.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- Signed in as `admin@verify.test`.
- `scripts/seed-readonly-postgres.sh crm_src_<token>` has printed the connection fields. `<token>` matches `[a-z0-9]{1,24}`, the same range the script accepts. The script creates schema `scroll`, 25 tables, and a login that can `SELECT` and cannot `INSERT`. A second run against a new database reuses the role instead of failing `CREATE ROLE`.
- `pnpm dispatcher` is running with this run's `app.env` sourced, and only this run's database. Stop that process before `cleanup.sh`.

- **Register.** On `/sources`, fill `名称` `scrollsrc`, `主机`, `端口`, `数据库名`, `schema` `scroll`, `用户名`, and `密码` from the seed script. Choose `校验并登记`. The path becomes `/sources/<id>`. The page lists 25 tables.
- **Scope.** Run `browser.mjs click --role button --name "全选过滤结果"`. Run `browser.mjs scroll-into --role button --name "保存同步范围"`. The printed scroll is greater than 400. Run `browser.mjs scroll-y` and record it as before. Run `browser.mjs click --role button --name "保存同步范围"`. The row text is `已选入（admin@verify.test，<本地时间>）`, which is not the exact string `已选入`. Run `browser.mjs wait-selector '[data-in-scope="true"]'`. Run `browser.mjs scroll-y` again. The value stays within 150 of the value before the click, and it is not 0. Run `scripts/sql.sh` for `platform.source_tables` of this source: `in_scope` is true on all 25 rows.
- **Profile.** Run `browser.mjs wait-selector '[data-profile-status="succeeded"]'`. The dispatcher has to finish `source.profile` first.
- **Empty key.** The disclosure is a `<summary>`, not a button. Run `browser.mjs click --selector '[data-table="nokey_02"] summary'`. Run `browser.mjs scroll-into --role button --name "在源端全表检查并确认" --within '[data-table="nokey_02"]'`. Record `scroll-y`. Run `browser.mjs click --role button --name "在源端全表检查并确认" --within '[data-table="nokey_02"]'` with no column checked. Run `browser.mjs wait-text "请选择组成业务主键的字段"`. `scroll-y` stays within 150 of the value before the click.
- **Watermark.** `确认为水位线` is on every profiled table, so an unscoped click matches many buttons. Run `browser.mjs scroll-into --role button --name "确认为水位线" --within '[data-table="pad_20"]'`. Record `scroll-y`. Run `browser.mjs click --role button --name "确认为水位线" --within '[data-table="pad_20"]'`. The badge text is `已确认（admin@verify.test）`, not `已确认`. Run `browser.mjs wait-text "已确认（admin@verify.test）" --within '[data-table="pad_20"]'`. `scroll-y` stays within 150. `platform.source_tables.watermark_column` for `pad_20` is `updated_at`.
- **Key.** Run `browser.mjs click --selector '[data-table="nokey_01"] summary'`. The checkbox accessible name is `code （样本中唯一）` because the sample values are unique. `click --role checkbox --name "code"` times out on this row. Run `browser.mjs click --role checkbox --name "code （样本中唯一）" --within '[data-table="nokey_01"]'`. Run `browser.mjs scroll-into --role button --name "在源端全表检查并确认" --within '[data-table="nokey_01"]'`. Record `scroll-y`. Run `browser.mjs click --role button --name "在源端全表检查并确认" --within '[data-table="nokey_01"]'`. The check is a task. Run `browser.mjs wait-text "已确认（admin@verify.test）" --within '[data-table="nokey_01"]' --timeout 120000`. `scroll-y` stays within 150. `key_columns` is `{code}`.
- **Soft delete.** Run `browser.mjs scroll-into --role button --name "确认为软删除字段" --within '[data-table="pad_19"]'`. Record `scroll-y`. Run `browser.mjs click --role button --name "确认为软删除字段" --within '[data-table="pad_19"]'`. Run `browser.mjs wait-text "已确认（admin@verify.test）" --within '[data-table="pad_19"]'`. `scroll-y` stays within 150. `soft_delete_column` is `is_deleted`.
- **Duplicate key.** Run `browser.mjs click --selector '[data-table="dupkeys"] summary'`. This column is not unique in the sample, so the checkbox name is `code` with no suffix. Run `browser.mjs click --role checkbox --name "code" --within '[data-table="dupkeys"]'`, then `browser.mjs click --role button --name "在源端全表检查并确认" --within '[data-table="dupkeys"]'`. Run `browser.mjs wait-text "code=same 出现 2 次" --timeout 120000` and `browser.mjs wait-text "新声明 code 未通过全表检查，没有生效"`. `key_columns` stays empty. The `source.keycheck` task result has `"ok": false`.
- **Other actions.** `测试连接` has no `preventScrollReset`. Scrolled down, it still reports `连接正常` and `scroll-y` returns 0. `立即同步` still enqueues `source.sync`.
- **Proof.** Save the `scroll-y` numbers and a screenshot after each submit under the evidence directory. `screenshot` is the full page. The scroll proof is the pair of numbers.

## Gotchas

- Launch does not create a data source. The platform rejects a writable account, so the seed script's login is the one to type. Do not register as `crm`.
- Watermark, key, and soft-delete controls appear only after `source.profile` succeeds. Start the dispatcher after launch, with this run's `app.env`.
- A table with a primary key does not show `声明业务主键`. Use `nokey_*` for the key form and `pad_*` for soft delete. Soft delete also needs a column whose name matches `delet` or `remov` and whose type is boolean, integer, or a date.
- The empty-key error is an alert at the top of the page. If scroll is preserved, that alert is above the viewport. Read it with `text --selector '[role="alert"]'`. Do not scroll up before recording `scroll-y`.
- Confirming a key only queues `source.keycheck`. The badge is the whole string `已确认（admin@verify.test）`. `wait-text "已确认"` does not match it. A duplicate value stays unconfirmed and the finding line is `code=same 出现 2 次`.
- `click --role button --name "声明业务主键"` does not open the disclosure. Use `click --selector '[data-table="<table>"] summary'`.
- `重新列出表并采集` and `立即同步` do not set `preventScrollReset`. They reset scroll. That is the surrounding behavior, not a failure of those actions.
