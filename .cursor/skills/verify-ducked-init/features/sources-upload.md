# Upload a CSV and preview it

A member who can write sources opens `/sources`, chooses 文件上传, and previews a CSV before registering it. Preview shows the detected encoding (UTF-8 or GBK), delimiter, header row, each column's name and type, and up to the first 20 rows. The member can change those options and preview again. 校验并登记 submits the same file once more with the confirmed options. Preview does not create a data source, write the lake, or add an audit row.

## Sub-features

- `sources-open` shows the register form on an empty tenant.
- `sources-preview-gbk` reads a GBK CSV as encoding `gbk`, delimiter `,`, header on, Chinese column names, and the first rows without mojibake.
- `sources-preview-delim` re-reads the same file with delimiter `;` as one column.
- `sources-preview-type` re-reads after a column type change and keeps that type in the control.
- `sources-register` stores those options on the new source and redirects to its detail page.
- `sources-preview-inert` leaves `platform.sources`, `source.file_uploaded`, and the lake `_uploads` tree unchanged, and leaves no `crm-preview-*` directory in the temp dir.
- `sources-analyst` shows the source list to an analyst and no register form. A preview POST from that session is HTTP 403.
- `sources-over-limit` rejects a body over the tenant upload cap with HTTP 413 before the preview runs. The preview button itself does not render that message.

## How to get to it (user POV)

- Choose `数据源` in the top nav. The path is `/sources`.
- On a tenant with no sources the register card is already open. The heading inside it is `登记数据源`.
- After at least one source exists, the same card is collapsed. Its visible text is `登记新的数据源`. That summary is not a button whose accessible name `browser.mjs click` can hit, and the form fields stay in the DOM but hidden. Start this recipe from launch's empty tenant.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- Signed in as `admin@verify.test`. That admin has `sources:write`.
- No source has been registered yet. Launch's empty tenant satisfies this.
- A GBK CSV is on disk. Three data rows are enough. The header line is `报名编号,姓名,手机,活动,报名时间,是否到场` and the first data row contains `张三`. Python `text.encode('gbk')` produces the file. Do not save it as UTF-8.

- **Open sources.** Choose `数据源`. Run `node .cursor/skills/verify-ducked-init/scripts/browser.mjs goto /sources` and `browser.mjs wait-text "数据源"`. The heading is `数据源`. The register card is open.
- **Choose file upload.** Run `browser.mjs select --label "类型" --value "upload"`. The selected option's visible label is `文件上传`. Run `browser.mjs fill --label "名称" --value "活动报名表（上传）"` and `browser.mjs fill --label "表名" --value "signups"`. Run `browser.mjs set-file --selector "#source-file" --path <gbk.csv>`. `fill` cannot set a file input. Run `browser.mjs screenshot --path <evidence>/sources-form.png`.
- **Preview.** Choose `预览`. Run `browser.mjs click --role button --name "预览"` and `browser.mjs wait-text "张三"`. Run `browser.mjs value --label "编码"` and expect `gbk`. Run `browser.mjs value --label "分隔符"` and expect `,`. Run `browser.mjs value --label "手机 的类型"` and expect `BIGINT`. The table header row is `报名编号 姓名 手机 活动 报名时间 是否到场`. Run `browser.mjs screenshot --path <evidence>/sources-gbk-preview.png` and `browser.mjs snapshot --path <evidence>/sources-gbk-preview.aria.txt`.
- **Nothing was saved.** Run `scripts/sql.sh "SELECT count(*) FROM platform.sources"` and expect `0`. Run `scripts/sql.sh "SELECT count(*) FROM platform.audit_logs WHERE action = 'source.file_uploaded'"` and expect `0`. The run's lake directory has no `_uploads` file. `/tmp` has no directory whose name starts with `crm-preview-`.
- **Change the delimiter.** Run `browser.mjs select --label "分隔符" --value ";"`. The button name is now `重新预览`. Run `browser.mjs click --role button --name "重新预览"` and `browser.mjs wait-text "报名编号,姓名,手机,活动,报名时间,是否到场"`. Run `browser.mjs count --selector '[data-upload-preview] table thead th'` and expect `1`.
- **Change a column type.** Run `browser.mjs select --label "分隔符" --value ","`, `browser.mjs click --role button --name "重新预览"`, and `browser.mjs wait-text "秋季发布会"`. Run `browser.mjs count --selector '[data-upload-preview] table thead th'` and expect `6`. Run `browser.mjs select --label "手机 的类型" --value "VARCHAR"` and `browser.mjs click --role button --name "重新预览"`. When the request finishes the button name is `预览` again and `browser.mjs value --label "手机 的类型"` is `VARCHAR`.
- **Register.** Choose `校验并登记`. Run `browser.mjs click --role button --name "校验并登记"`. Poll `browser.mjs url` until the path matches `/sources/<id>`. The connection list shows `options` whose JSON has `encoding` `gbk`, `delim` `,`, `header` true, `skip` 0, and `手机` `VARCHAR`. Run `scripts/sql.sh "SELECT config->>'options' FROM platform.sources"`. The same JSON is stored. `source.file_uploaded` now has one row. Run `browser.mjs screenshot --path <evidence>/sources-registered.png`.
- **Analyst.** Invite `an@verify.test` with role value `analyst` using the members recipe, then sign in as that person. On `/sources` the existing source card is visible and `browser.mjs count --selector 'button:has-text("预览")'` is not the check: the accessible snapshot has no button named `预览` and no heading `登记数据源`. From that signed-in page, `POST /sources` with `intent=preview` and a small CSV returns HTTP 403. `platform.sources` does not gain a row.
- **Over the upload cap.** `scripts/sql-write.sh` may set `max_upload_mb` to `1` on the `verify` tenant. That column is not on the tenant member form. With the admin session, choose 文件上传, set `#source-file` to a CSV larger than 1 MiB, and choose `预览`. The preview panel does not show an alert. The same form posted as a document request returns HTTP 413 and the body contains `文件超过本租户上传上限 1 MiB` and `未能登记`. A `Content-Length` larger than the cap, with a shorter body actually sent, also returns 413 without waiting to read the declared length. `platform.sources` does not gain a row.

## Gotchas

- The preview control is a `type="button"` inside the register `<form>`. It submits with `useFetcher` to `/sources` and `intent=preview`. It does not navigate, and the selected file stays in the input. A full form submit would lose the file and jump away.
- After a preview, changing 编码, 分隔符, 第一行是表头, or 表头前跳过的行数 renames the button to `重新预览`. Changing only a column type does the same until the new preview returns.
- Column type controls are named `<column name> 的类型`, for example `手机 的类型`. The source-kind control is named `类型` and its upload value is `upload`, not the visible label `文件上传`.
- `set-file` is the only way to put a path into `#source-file`. The input `accept` is `.csv`.
- When sources already exist, do not look for a button named `登记新的数据源`. The collapsed card is a `<summary>` whose snapshot role is a group, and `click --role button` and `click --role group` both time out. Reload is not enough to open it. Run this recipe before the first register.
- The 413 response from `readLimitedForm` is `{ error, values }` with status 413. The preview panel renders only `previewError`, so the 预览 button leaves the panel unchanged when the file is over the cap. 校验并登记 is a document POST and does show `未能登记` plus the limit sentence. Do not mark the missing preview alert as a skill failure; it is the current product behavior.
- Saving 同步范围 and choosing `立即同步` needs `pnpm dispatcher` sourced from this run's `app.env`. Stop that process before `cleanup.sh`. Cleanup does not know about it. Publishing the mapping draft needs a second member with publish permission. Saving the draft is enough to show the profiled column types (手机 stays `VARCHAR` when that was the confirmed preview type). This recipe does not publish.
- The first hit on a cold dev server can log `Failed to fetch dynamically imported module` while Vite optimizes dependencies. Retry the login once. Later preview and register requests in the same server log should not add that line.
