# 新建标签（条件构建器）

有起草权限的成员在 `/analytics/definitions/new?kind=tag` 上不写 YAML，用构建器选已发布的数值指标拼规则：单指标（全部规则比较同一个指标）或多指标（每条规则选 all / any 一层的「指标 + 比较」），再填缺值策略与默认值，保存成第 1 版草稿，走与手写 YAML 完全相同的校验与双人发布（issue #518）。标签没有「检查」按钮：不合法的定义在保存时按行列报出。

## Sub-features

- `tag-save` 用多指标规则（all）保存：跳到定义页、状态是第 1 版草稿，定义页的 YAML 与构建器拼出的内容一致，`dsl_versions` 加一行。
- `tag-any` 一条规则切成 any：任一条件命中就给取值，构建器里是同一张表单只换组合方式。
- `tag-missing` 缺值策略三态（缺省 / 按数值 / 记空）：只对规则里引用到的指标出现，没写的按缺省（计数 / 求和记 0，其余记空）。
- `tag-yaml-mode` `?mode=yaml` 切到 YAML 编辑：需求框（用模型生成草稿）与编辑框只在 YAML 模式出现，构建器模式没有需求框。

## How to get to it (user POV)

- 分析页点「新建标签」，默认进构建器（`?kind=tag`，`mode` 缺省是 builder）。
- 页面上的「构建器 / YAML」pill 切换两种模式（切换不带内容过去：新建页不做 YAML → 构建器的转换）。
- 构建器里选写法（单指标 / 多指标）→ 每条规则填取值与条件行（指标下拉 + 比较运算 + 数字）→ 需要时给引用到的指标选缺值策略 → 填默认值与键，「校验并保存草稿」保存后跳到定义页。

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- Signed in as a member with draft permission. Launch seeds only `admin@verify.test`（admin 可以起草）。
- The tenant has at least two published numeric metrics without dimensions（先照 [新建指标（条件构建器）](./metric-builder.md) 建 `revenue_30d`（sum amount、窗口 30 天）与 `order_count_30d`（count、窗口 30 天）并各发布一版）；带维度或只有草稿的指标不会出现在下拉里。
- Evidence paths below are relative to the evidence directory of the READY line.

- **打开构建器。** Run `browser.mjs goto /analytics/definitions/new?kind=tag` and `browser.mjs wait-text "新建标签"`. The page shows `构建器` and `YAML` pills, the `写法（单指标 / 多指标）` select, and `添加一条规则`; the metric selects list only the published numeric metrics（`revenue_30d`、`order_count_30d`），没有带维度或草稿指标。Run `browser.mjs screenshot --path <evidence>/tag-builder-open.png`.
- **拼一条多指标规则。** 切写法与组合方式：`browser.mjs select --label "写法（单指标 / 多指标）" --value multi`. 加规则：`browser.mjs click --role button --name "添加一条规则"`, `browser.mjs fill --label "规则取值" --value high`. 第一个条件行选 `browser.mjs select --label "条件指标" --value revenue_30d`, `browser.mjs select --label "比较" --value gte`, `browser.mjs fill --label "比较数字" --value 1000`; 第二行用 `browser.mjs click --role button --name "添加一行"` 后同样选 `order_count_30d` ≥ 3（默认组合方式是 all：全部满足）。
- **缺值策略。** 引用了两个指标后，缺值策略区各出一行：`browser.mjs select --label "order_count_30d 的缺值策略" --value value`（按数值）并 `browser.mjs fill --label "order_count_30d 的缺省数值" --value 0`；`revenue_30d` 一行保持缺省。Run `browser.mjs screenshot --path <evidence>/tag-builder-filled.png`.
- **保存草稿。** `browser.mjs fill --label "默认值（都没命中时的取值）" --value normal`, `browser.mjs fill --label "键" --value value_tier`, `browser.mjs click --role button --name "校验并保存草稿"`, `browser.mjs wait-url /analytics/definitions/tag/value_tier`. The definition page shows `第 1 版草稿` and a YAML whose first rule is `value: high` with `all: [{metric: revenue_30d, gte: 1000}, {metric: order_count_30d, gte: 3}]` and `default: normal`. Run `browser.mjs screenshot --path <evidence>/tag-saved.png`. `scripts/sql.sh "SELECT count(*) FROM platform.dsl_versions"` is one more than before the save.
- **any 一层。** Back on the builder, switch a rule's `条件的组合方式` to `any` and save under a new key: the saved YAML writes the same items under `any:`（任一满足）。
- **不合法 400（default 为空）。** Leave 默认值 empty and save: the page stays, lists `（default）：取值不能为空` by line and column, and `dsl_versions` is unchanged. The builder never offers an illegal metric pick, so other invalid shapes (handmade `form`) are covered by the HTTP tests, not by hand-driving.
- **YAML 模式。** `browser.mjs goto /analytics/definitions/new?kind=tag&mode=yaml`: the page shows the 需求 box and the YAML editor, no `data-tag-builder`; `?kind=tag`（无 mode）shows the builder and no 需求 box.

## Gotchas

- The metric selects only list published, dimension-free, numeric metrics of the current tenant. A missing option usually means the metric is still a draft or has dimensions — publish or rebuild it, do not hand-type keys (the builder has no free-text metric input).
- Empty rules（取值没填）and empty condition rows（没选指标或数字没填）are dropped on save, not reported as problems — that is intended（「空行保存时忽略」）.
- 没有可引用的指标时构建器只剩一句提示「先发布一个数值型指标（没有维度）」，仍能切到 YAML 模式手写。
- The mounted builder keeps client state after a submit with JS on; verify a 400 page by reading the response document (curl) or a hard reload, not by trusting the mounted controls.
