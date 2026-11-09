# 新建指标（条件构建器）

有起草权限的成员在 `/analytics/definitions/new?kind=metric` 上不写 YAML，而是用构建器选基础实体、聚合、字段、过滤条件与时间窗口，「检查」只编译给出三 / 四句摘要与 SQL、不保存，确认后保存成第 1 版草稿，走与手写 YAML 完全相同的校验与双人发布（issue #515）。

## Sub-features

- `builder-check` 用构建器拼出指标并「检查」：显示摘要（`data-summary`）、生成的 YAML（`data-generated-yaml`）与编译出的 SQL（`data-compiled-sql`），`dsl_versions` 不增加行。
- `builder-save` 填键后保存：跳到定义页、状态是第 1 版草稿，定义页的 YAML 与检查时显示的一致。
- `builder-empty-row` 「添加一行」加的条件行不选字段就保存 / 检查：空行被忽略，页面不因它报问题。
- `builder-invalid-400` 不合法的表单（sum 选文本字段、`fieldsFor` 没有的字段、敏感字段、ratio 缺分子或分母）按行列返回 400 与问题列表，不落库。
- `builder-yaml-mode` `?mode=yaml` 切到 YAML 编辑：也能只检查不保存，摘要与 SQL 同样显示。
- `builder-handmade-form` 手工构造 `form` 提交（词表外的聚合，如 `median`）：返回 400、正文有 `measure.agg`（ratio 分子是 `measure.numerator.agg`）问题，整页照常渲染，不是 500。

## How to get to it (user POV)

- 分析页点「新建指标」，默认进构建器（`?kind=metric`，`mode` 缺省是 builder）。
- 页面上的「构建器 / YAML」pill 切换两种模式；标签（`?kind=tag`）只有 YAML，没有切换。
- 构建器里选基础实体 → 聚合 → 字段；ratio 时填分子、分母两块；「添加一行」加过滤条件；时间窗口可不填。
- 「检查」只编译不保存；「校验并保存草稿」保存后跳到定义页。

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- Signed in as a member with draft permission. Launch seeds only `admin@verify.test`（admin 可以起草）；要按角色验证就先照 [Invite a member](./members.md) 邀请一位 `analyst` 并登录。
- Evidence paths below are relative to the evidence directory of the READY line.

- **打开构建器。** Run `browser.mjs goto /analytics/definitions/new?kind=metric` and `browser.mjs wait-text "新建指标"`. The page shows `构建器` and `YAML` pills, the `基础实体` select, and one `添加一行` button. Run `browser.mjs screenshot --path <evidence>/builder-open.png`.
- **拼一个指标并检查。** 选实体与聚合：`browser.mjs select --label "基础实体" --value order`, `browser.mjs select --label "聚合" --value sum`, `browser.mjs select --label "字段" --value amount`. 加一条过滤：`browser.mjs click --role button --name "添加一行"`, then `browser.mjs select --label "条件字段" --value status` and `browser.mjs select --label "条件运算" --value eq`, `browser.mjs fill --within '[data-cond-rows="filter"]' --label "条件取值" --value paid`（多行时取值输入框重名，用 `--within` 限定到所在条件块；只有一行时直接 `--label "条件取值"`）。时间窗口：`browser.mjs select --label "时间窗口字段" --value paid_at`, `browser.mjs fill --label "时间窗口天数" --value 30`. 点检查：`browser.mjs click --role button --name "检查"` and `browser.mjs wait-text "近 30 天，按支付时间。"`. The page shows the summary list, the generated YAML and the compiled SQL. Run `browser.mjs screenshot --path <evidence>/builder-check.png` and `browser.mjs count --selector '[data-summary] li'` (3 for a non-ratio metric).
- **检查不落库。** After the check, `scripts/sql.sh "SELECT count(*) FROM platform.dsl_versions"` still returns the count from before the check (0 on a fresh tenant).
- **保存草稿。** `browser.mjs fill --label "键" --value paid_amount_30d`, `browser.mjs click --role button --name "校验并保存草稿"`, `browser.mjs wait-url /analytics/definitions/metric/paid_amount_30d`. The definition page shows `第 1 版草稿`. Run `browser.mjs screenshot --path <evidence>/builder-saved.png`. `SELECT count(*) FROM platform.dsl_versions` is now 1.
- **空行被忽略。** Back on the builder, add a condition row and leave the field unselected: `browser.mjs click --role button --name "添加一行"` then fill the rest of the form and 检查 / 保存. The empty row is dropped: the saved YAML has no extra `filter` entry and the check reports no problem about it.
- **ratio 区分多个「添加一行」。** `browser.mjs select --label "聚合" --value ratio` shows 分子 and 分母 blocks, each with its own `添加一行`. Scope every repeated control by its block: `browser.mjs click --within '[data-cond-rows="numerator"]' --role button --name "添加一行"` adds a row only in the numerator; the same with `denominator` works independently. The per-row selects are likewise scoped: `browser.mjs select --within '[data-cond-rows="numerator"]' --label "条件字段" --value status`.
- **不合法 400。** The builder never offers an illegal pick (sum / avg list numeric fields only, and changing 聚合 drops a field that no longer fits), so reach this through the hidden `form`: with the page open, set it from the console to a sum over a text field (`{"base":"order","agg":"sum","field":"channel","filter":[]}`) or to a field the page never offered, then click 检查: the page stays and lists problems by line and column（`第 N 行第 M 列（measure…）`）, no definition is written. Run `browser.mjs screenshot --path <evidence>/builder-invalid.png`.
- **YAML 模式。** `browser.mjs goto /analytics/definitions/new?kind=metric&mode=yaml`, paste a YAML definition into the editor, 检查: summary and SQL render, `dsl_versions` unchanged.
- **手工 form 提交（不是 500）。** While signed in, replay the hidden field by hand against this server: `curl -s -o <evidence>/handmade-form.html -w '%{http_code}' -X POST --cookie <session cookie from the browser profile or a fresh login> $BASE_URL/analytics/definitions/new --data 'kind=metric&key=x&intent=check&form={"base":"order","agg":"median","field":"amount","filter":[]}'`. The status is 400, the body contains `measure.agg` and `应为以下之一`, and it does NOT contain `出错了`. Repeat with `agg: ratio` and `numerator: { agg: median, filter: [] }`: 400 with `measure.numerator.agg`. Run the same through the browser too if you prefer: with the page open, set the hidden `form` input from the console and click 检查.

## Gotchas

- `添加一行` appears once per filter block（顶层 + ratio 的分子、分母），`条件字段` / `条件运算` / `条件取值` repeat per row. Unscoped `click --name "添加一行"` works only while a single block exists; after switching 聚合 to `ratio`, always pass `--within`.
- The `字段` list depends on 聚合 (sum / avg list numeric fields only), so a sum over `channel` (a text field on `order`) is only reachable through a handmade `form`.
- 检查 and 保存 both validate the same way; a `check` that passes but a `save` that fails means the key, not the form (duplicate or invalid key → 400 on the key).
- The browser shows server-normalized state only after a full page load. With JS on, the mounted builder keeps client state after a submit; verify a 400 page by reading the response document (curl) or a hard reload, not by trusting the mounted controls.
- Sensitive fields (phone, email on `customer`) never appear in any select. If a field name can be typed in, it came from somewhere else — that is the handmade-form path, and it must still 400.
- `dsl_versions` is a `platform` table in the verify run's own database; the tenant is `verify`. Count before and after each step instead of assuming 0.
