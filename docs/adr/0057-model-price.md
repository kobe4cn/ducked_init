# 模型单价：按查看时的当前单价折算，不保留价格历史

模型调用日志（ADR-0035）已经记下每次调用的 `prompt_tokens` / `completion_tokens` 与实际模型名。要算这些调用花了多少钱，得知道模型的单价。单价由平台与提供方的商务决定，会变，也不该让租户填：它是平台的元数据，运营者在运营后台维护（ADR-0007），本租户的金额显示（#745）与跨租户汇总（#746）都按这张表折算。

**单价是平台元数据，运营者维护。** `platform.model_prices` 一行一个模型：`model`（`llm_calls.model` 的原值，去首尾空白、非空、最长 100 字，唯一）、`input_per_m_tok` / `output_per_m_tok`（每百万 token 的单价，`numeric(12,4)`，非负，最多 4 位小数）、`cached_input_per_m_tok`（缓存输入单价，#1256：可选，运营页可填，校验规则与输入单价相同；留空存 null，表示缓存 token 按输入单价折算，列表显示「同输入单价」）、`currency`（只认 `CNY` / `USD`，库上有 check）、`updated_at` / `updated_by`。可增改，也可删除（表格每行一个「删除」按钮，浏览器确认后提交）：删除后该模型的调用按「未配置单价」处理，不折算成 0；删除写审计 `model_price.deleted`，detail 带删除前的单价与币种，可照着重新填回；要删的模型已不存在转成 400。运营后台的「模型单价」页（`/ops/model-prices`）一个表单：填已有模型名就是修改，同值保存是 no-op、不写审计；并发新增同名模型由 `model` 列的唯一约束兜底，转成 400。校验与折算在 `app/.server/model-prices.ts`：pg 把 `numeric` 返回成字符串，读出后统一 `Number()`。

**金额按查看时的当前单价折算，不保留价格历史。** 金额 = 窗口内的 token 数 × 查看时 `model_prices` 里的单价。不在 `llm_calls` 上存调用时的单价，也不保留单价的历史版本：改了单价，历史调用的金额跟着变。这样一张表就够，代价是「当时的成本」不可复现——每次改动的前后值都记在平台级审计（`model_price.created` / `model_price.updated` / `model_price.deleted`，detail 带修改前后或删除前的单价与币种）里，以后真要按调用时单价折算，可以从审计重建价格历史，再另立口径。

**公式与空值。** `costOf(promptTokens, completionTokens, cachedTokens, price)`：金额 = `(prompt_tokens − cached_tokens) × 输入单价 + cached_tokens × 缓存输入单价 + completion_tokens × 输出单价`，再除以 1,000,000，纯函数；缓存输入单价即 `cached_input_per_m_tok`，没配时用输入单价。`prompt_tokens` 本身已经包含缓存 token（#1253 记的 `cached_tokens` 是 prompt 的一部分），所以要先减掉再按各自单价算，否则缓存部分先按输入单价、再按缓存单价收两次钱；token 为 null（embedding 调用没记、或调用失败没拿到 usage；`cached_tokens` 为 null 的旧行）按 0 算。没配单价的模型不折算，按「未配置」展示，而不是当成 0 假装便宜。

> 修订（#1255）：缓存 token 从 `prompt_tokens` 里拆出来按缓存输入单价折算，`cached_input_per_m_tok` 可空，没配时按输入单价算（结果与旧公式相同）；表单维护在 #1256。

**不同币种的金额不换算、不相加。** 每个模型有自己的币种；跨模型、跨租户汇总时按币种分开列，不做汇率换算（汇率每天在变，存哪一天的都不对；真要折算另立配置）。显示规则（如保留几位小数、未配置怎么标）在 #745 定，不在本 ADR。

## Consequences

- 改单价立即改变全部历史金额的显示，运营者页面上写明这一点（「金额按当前单价折算」）。
- 以后要按调用时单价折算，从 `model_price.*` 审计的 from / to 重建价格历史即可，`llm_calls` 不用回填。
- 新增币种要同时改 `model-prices.ts` 的白名单与 `model_prices_currency` check（迁移），两边都在本 ADR 记着。
