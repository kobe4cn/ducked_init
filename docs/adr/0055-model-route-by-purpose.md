# 按用途分档：fast 与 reasoning 两档，平台档位走环境变量

模型服务客户端（ADR-0035）按「租户整套 > 平台默认（环境变量 `LLM_*`）」选出唯一一套端点，所有用途共用同一个模型。但不同用途要的智力不一样：起草映射、指标、标签要推理，断言草稿、工作台解读、一句话解析只要快。总票 #508 决定按用途路由。决定：

**只有两档，用途对应写死在代码里。** `llm.ts` 的 `PURPOSE_TIER: Record<LlmPurpose, 'fast' | 'reasoning' | null>` 是唯一的对照表，不进库、不加配置项。reasoning 档：`assistant`、`mapping_draft`、`metric_draft`、`tag_draft`、`workbench_draft`；fast 档：`assertion_draft`、`workbench_interpret`、`knowledge_proposal`、`knowledge_import`、`metric_parse`；`connectivity`（模型服务页的连通测试）、`tool_probe`（ADR-0042 的工具调用探测）、`embedding`（ADR-0049）不分档，永远用解析出的那一套。新增用途时在这里补一行，TypeScript 会提醒。

**平台档位用环境变量。** `LLM_FAST_MODEL` / `LLM_FAST_BASE_URL` / `LLM_FAST_API_KEY` 与 `LLM_REASONING_*`。只填 `MODEL` 就把该档的模型名换掉，端点与 Key 复用平台默认（`LLM_*`）的；要换端点时 `BASE_URL` 与 `API_KEY` 必须一起填。**只填其中一个按没配置该档位处理**（用默认那一套，`console.warn`）：不能把平台默认的 Key 发到另一个端点。空串算没填。

**租户整套自配时平台档位不生效。** ADR-0035 的整套覆盖、不混用不变：`providerSource` 是 `tenant` 时不看 `LLM_<TIER>_*`，租户用什么模型就是什么模型。租户给自己的档位绑模型是 #530 的事；在那之前租户的调用都记 `fallback_reason = 'unbound'`。平台默认三项不全（`providerSource` 为 null）时就算档位变量填全了也不能用，照旧报「未配置模型服务」。

**没绑定就回落，不报错。** `resolveRoute(tenantId, purpose)` 在选出的那一套上按 `PURPOSE_TIER` 换模型：档位绑定了用绑定的（`fallback_reason` 为 null），没绑定用默认那一套并记 `fallback_reason = 'unbound'`。路由只发生在 `logged` 里，各个调用方不感知；`resolveProvider`、`providerSource`、`platformProvider` 原样保留（模型服务页与 `assistant/loop.ts` 等用它判断「配没配」）。

**失败不换模型、不升级。** 调用失败、429、超时都按原来的 `LlmError.transient` 语义抛给调用方：不发第二次请求、不降级到 fast、不升级到 reasoning、不重试到默认模型。路由只决定「这次调谁」，不参与错误处理。

**日志记实际调用的模型名。** `llm_calls.model` 一直是实际发到端点的模型名（绑定后是档位的模型）；`route` 记这次调用所属的档位（没绑定也记，因为它描述用途属于哪档），`fallback_reason` 记回落原因（#528 加的列）。不分档的用途两列都是 null。

与 ADR-0049 的关系：embedding 有自己的一套配置（`LLM_EMBEDDING_*` / 租户 embedding 三项），不进档位表，`route` 恒为 null。

## Consequences

- 平台想让某档换模型只改环境变量，不用发版；想全关掉就清掉 `LLM_<TIER>_MODEL`，所有用途回落默认。
- 以后要加第三档或按租户配权重，先修订这张 ADR：`PURPOSE_TIER` 的值域、环境变量命名（`LLM_<TIER>_*`）与「Key 不外流」的约束要一起过一遍。
- 评测脚本（`callModel` / `callEmbeddings`）不走路由，仍由脚本自己传 provider。
