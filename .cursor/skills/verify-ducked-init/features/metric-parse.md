# 一句话解析指标

An analyst opens 新建指标, writes one sentence, and clicks 解析一句话. The builder fills in and the 逐项说明 panel appears. Nothing is saved. When two published metrics share an alias that the sentence uses, an amber block 这些词有多种理解 sits above that panel, and each candidate links to `/knowledge?item=<id>`. The same block appears in YAML mode after 用模型生成草稿. After one reading is accepted as the default, parsing the word again leaves the block out, and that metric is first in the retrieval section sent to the model.

## Sub-features

- `parse-fill` parses `近 30 天已支付订单的金额合计` on an empty builder. The builder shows 订单, 求和 of 实付金额, status `paid`, and a 30-day window on 支付时间. 逐项说明 lists 金额合计, 已支付, and 近 30 天. `platform.dsl_versions` does not grow.
- `parse-ambiguity` parses `营收` after `revenue_365d` and `gmv_365d` share that alias. The parse still fills the builder. `[data-ambiguity]` shows 这些词有多种理解 and links to both metrics. Opening one link lands on that metric's knowledge panel.
- `yaml-ambiguity` fills 需求 `营收` in YAML mode and clicks 用模型生成草稿. The same block appears, the editor contains the generated YAML, and `[data-generated]` is present. The row count does not grow.
- `parse-default` accepts a term-default proposal for `营收` → `revenue_365d`, then parses `营收` again. `[data-ambiguity]` is absent. The stub log's retrieval headings for that call start with `metric:revenue_365d` and still include `metric:gmv_365d`.

## How to get to it (user POV)

- Choose `分析`, then `指标与标签`, then `新建指标`. The path is `/analytics/definitions/new?kind=metric`. The heading is `新建指标`. The sentence field is labeled `一句话`. The button is `解析一句话`.
- `分析` is a closed `<summary>`. The link `指标与标签` is inside it. `新建指标` is a link on `/analytics`, not a nav item.
- The `YAML` pill switches to YAML mode. The field is labeled `需求`. The button is `用模型生成草稿`.
- Aliases are added on `/knowledge?item=metric%3A<key>`. The field is `新别名` and the button is `新增别名`.
- The default is set from `AI 助手`: pick one candidate, click `记为知识提案`, then `接受` on the knowledge page. See [记为知识提案](./assistant-knowledge.md).

## Driving it with Playwright

Preconditions:

- `launch.sh` printed `READY` and `doctor.sh` printed `DOCTOR PASS`.
- Before launch, point `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` at a temporary stub on `127.0.0.1` with a fake key. Export `LLM_REASONING_*`, `LLM_FAST_*`, and `LLM_EMBEDDING_*` as empty. `scripts/llm-stub.mjs` is not this stub: a `json_object` request gets `{"ok":true}`, which fails the parse schema, and it never calls `catalog_search`. Leave that file unchanged for [AI 助手](./assistant.md).
- The temporary stub, outside the commit, answers `/chat/completions` like this. A request whose tools include `ping` and not `catalog_search` returns a `ping` tool call. A request whose tools include `catalog_search`, whose latest user text contains `营收`, and which has no `role: tool` message yet, returns a `catalog_search` call with `{"query":"营收"}`. After a tool message, it returns the text `营收按哪个时间字段算？`. A `json_object` request whose system text contains `把成员的一句话解析` returns the parse object below. One whose system text contains `按成员的需求写一个指标定义` returns the draft object below (`base`, `measure`, `filter`, `window` only, no `spec` wrapper). Log each call's path, model, and the `##` headings under `# 与需求相关的条目` in the user message.
- Parse object: `spec` is `{ base: "order", measure: { agg: "sum", field: "amount" }, filter: [{ field: "status", op: "eq", value: "paid" }], window: { field: "paid_at", days: 30 } }`. `items` are `{ path: "measure.field", reason: "金额合计用 order.amount" }`, `{ path: "filter.0", reason: "已支付是 status 等于 paid" }`, and `{ path: "window", reason: "近 30 天按支付时间 paid_at" }`. `unknowns` and `unsupported` are empty arrays.
- Signed in as `analyst@verify.test`. Launch seeds only the admin. Invite the analyst and `eng@verify.test` as `data_engineer` from `/members` (see [Invite a member](./members.md)). `管理` is a closed summary; open it before the `成员` link.
- The two metrics do not exist on a fresh tenant. The analyst saves them. The engineer publishes them. The analyst adds the alias. Do not point any of this at `crm_platform`.

- **Open the builder.** `click --selector 'nav summary:has-text("分析")'`, then `click --role link --name "指标与标签"`, `wait-url /analytics`, then `click --role link --name "新建指标"` and `wait-selector 'textarea[name="sentence"]'`. Screenshot.
- **Wait until a control sticks.** After `goto`, a `select` or `fill` can land before hydration and then disappear. Read it back with `value --label`. Retry until the value is the one you set. The first read is often empty.
- **Parse the sentence.** `console --clear`. `fill --label "一句话" --value "近 30 天已支付订单的金额合计"` and confirm `value` is that sentence. `click --role button --name "解析一句话"`. `wait-selector '[data-parse-items]'`. `text --selector '[data-parse-items]'` contains `逐项说明`, `金额合计`, `已支付`, and `近 30 天`. `value --label "基础实体"` is `order`, `聚合` is `sum`, `字段` is `amount`, `条件字段` is `status`, `条件运算` is `eq`, `时间窗口字段` is `paid_at`, and `时间窗口天数` is `30`. The condition value `paid` is the selected option in the ARIA snapshot (`option "paid" [selected]`). `count --selector '[data-ambiguity]'` is `0`. `sql.sh` `SELECT count(*) FROM platform.dsl_versions` is unchanged. `console` has no `error` or `pageerror` line. Screenshot and snapshot. Do not click `校验并保存草稿`.
- **Save two drafts.** On a fresh builder, select `基础实体` `order`, `聚合` `sum`, `字段` `amount`, `时间窗口字段` `created_at`, fill `时间窗口天数` `30` and `键` `revenue_365d`, then `校验并保存草稿`. Repeat with `paid_at` and key `gmv_365d`. `wait-url` is `/analytics/definitions/metric/<key>`. SQL shows both rows `draft`.
- **Publish.** Sign in as `eng@verify.test`. On each definition page, `click --role button --name "发布 v1"` and `wait-text "第 1 版已发布"`. SQL shows both `published` and `published_by` is the engineer. The analyst cannot publish: the overview says publishing is for 管理员 and 数据工程师, and the analyst is the last saver.
- **Share the alias.** As the analyst, `goto '/knowledge?item=metric%3Arevenue_365d'`, `wait-selector 'input[aria-label="新别名"]'`, `fill --label "新别名" --value "营收"`, `click --role button --name "新增别名"`, and `wait-selector '[data-alias="营收"]'`. Repeat for `metric:gmv_365d`. SQL on `platform.knowledge_aliases` shows both targets with alias `营收` and `retired_at` null. Screenshot each panel.
- **Parse the ambiguous word.** On a fresh builder, fill `一句话` with `营收` and click `解析一句话`. `wait-selector '[data-ambiguity]'` and `[data-parse-items]`. The ambiguity text contains `这些词有多种理解` and `「营收」可能指`. The HTML has `href="/knowledge?item=metric%3Arevenue_365d"` and `href="/knowledge?item=metric%3Agmv_365d"`. The builder is still `order` / `sum` / `amount`. The hint on this path contains `请确认解析结果是否是你要的口径`. `dsl_versions` is unchanged. Screenshot and snapshot.
- **Open a candidate.** `click --role link --name "gmv_365d"`. The page URL is `/knowledge?item=metric%3Agmv_365d` and `[data-alias="营收"]` is present. `wait-url` can time out after the address is already that URL; `url` is the check. Screenshot.
- **YAML draft.** `goto '/analytics/definitions/new?kind=metric&mode=yaml'`. Fill `需求` with `营收` and confirm the value. Click `用模型生成草稿`. `wait-selector '[data-ambiguity]'` and `[data-generated]`. The block lists the same two links. Its hint contains `请确认模型选的是否是你要的口径`. The YAML editor text contains `base: order` and `# 模型根据需求生成，请核对`. `dsl_versions` is unchanged. Do not save. Screenshot.
- **Set the default.** Open `AI 助手` only when the textarea count is `0`. Fill `向 AI 助手提问` with `营收指哪一个` and click `发送`. `wait-selector '[data-choices]'`. The buttons are `gmv_365d` and `revenue_365d`. Click `revenue_365d`. `wait-selector '[data-ask-card]'`. The card text is `把『营收』默认指向 〈revenue_365d〉？`. Click `记为知识提案` and `wait-text "已提交，待复核"`. `goto '/knowledge?item=metric%3Arevenue_365d'`, `wait-selector '[data-proposal]'`, and `click --role button --name "接受" --within '[data-proposal]'`. Poll `count --selector '[data-proposal]'` until it is `0`. SQL shows the proposal `accepted` and `platform.knowledge_term_defaults` has `营收` on `metric:revenue_365d` with `retired_at` null.
- **Parse again.** On a fresh builder, parse `营收` and `wait-selector '[data-parse-items]'`. `count --selector '[data-ambiguity]'` is `0`. The HTML does not contain `这些词有多种理解`. The stub log line for this call has retrieval `["metric:revenue_365d", "metric:gmv_365d"]` (the default is first; the other metric is still listed). `dsl_versions` is unchanged. Screenshot.

## Gotchas

- `scripts/llm-stub.mjs` cannot drive this page. A parse that receives `{"ok":true}` fails schema validation and the builder stays empty. Use the temporary stub above. Do not edit `scripts/llm-stub.mjs`.
- The visible 逐项说明 sentences are the stub's `items.reason` values, passed through the path labels (计算什么, 条件第 1 行, 时间窗口). A different stub JSON produces a different panel. The builder fields are the validated `spec`, not the sentence text.
- Hydration wipes a `select` or `fill` that ran too early. The key field then shows the browser tooltip `Please fill out this field.` and the hidden `form` is still the empty count form. Read the value back before clicking 校验并保存草稿 or 解析一句话.
- `时间窗口天数` is not in the DOM until a window field is selected.
- `wait-text` is exact and can match a hidden nav link. `成员` inside a closed `分析` or `管理` group is not the page heading. Wait for `邀请成员`, a selector, or the panel text.
- `分析` and `管理` are `<summary>` elements. A link click times out while the group is closed.
- A fresh tenant has no published metrics, so parsing `营收` shows no amber block. That is not a pass for `parse-ambiguity`.
- Drafts are not in the catalog the search uses. Both metrics have to be published, and the alias has to be saved, before `营收` is ambiguous. The two windows have to differ (`created_at` versus `paid_at`); identical definitions are not ambiguous.
- The analyst who saved a draft cannot publish it. Sign in as the data engineer for `发布 v1`.
- The retrieval order is not on the page. It is the `## metric:` headings in the user message the app posted to the stub, under `# 与需求相关的条目`.
- Do not save the parsed sentence or the generated YAML. A new `dsl_versions` row means the check clicked `校验并保存草稿`.
- On a checkout older than the shared ambiguity component, the builder parse has no `[data-ambiguity]` even when the word is ambiguous. YAML mode on that checkout still renders the block. The parse-path block is the behavior this recipe checks.
