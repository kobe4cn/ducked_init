# 模型服务：平台默认走环境变量，租户可整套覆盖，调用只留日志不留内容

ADR-0003 定下大语言模型只在设计时产出草稿。要落地（#18，起草映射 #19 等）先要一个统一的模型客户端：调哪个端点、用谁的 Key、返回怎么校验、留下什么记录。

**OpenAI 兼容接口。** 只接 `POST <端点>/chat/completions`（通义千问、DeepSeek、自建 vLLM 等都兼容），请求带 `response_format: { type: 'json_object' }` 与 `temperature: 0`，60 秒超时。返回取 `choices[0].message.content` 解析成 JSON，按调用方给的 JSON Schema 用 ajv 校验；不是 JSON 或不合 Schema 都算失败、抛 `LlmError`，不把半成品交给调用方。校验之后的语义检查（映射校验、空跑、双人发布）照旧由各功能负责。入口是 `app/.server/llm.ts` 的 `chatJson`。

**配置：租户整套覆盖平台默认，不混用。** 平台默认由环境变量 `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` 提供，三项都有才生效。租户在 `platform.model_providers` 填了端点就整套用租户的（端点、模型、Key），不会出现租户的端点配平台的 Key——那样会把平台的 Key 发给租户指定的主机。都没有时报「未配置模型服务」，不发请求；租户填了端点却没填模型名时报「配置不完整」，也不退回平台默认。

**Key 用租户信封加密。** 租户的 API Key 与数据源凭据同等对待（ADR-0009）：用租户数据密钥加密，context 为 `model_provider`，换到别的租户解不开。「模型服务」页只显示 Key 是否已设置，保存时留空沿用原来的 Key，但改了端点必须重新填写（与数据源改连接目标须重填凭据相同），否则拿到管理员会话就能把已存的 Key 发到自己的主机。错误消息里出现 Key 时换成 `***`；HTTP 错误只带状态码与前 200 字的响应体。

**调用日志只记元数据。** 每次调用（成功、HTTP 失败、返回不合 Schema）在 `platform.llm_calls` 记一行：用途（`connectivity`、`mapping_draft`…）、模型、prompt / completion 令牌数、耗时、Schema 校验结果（没拿到可解析的 JSON 时为空）与错误摘要。不存提示词与返回原文：里面会有表结构、列统计，开关打开后还有样本行。日志直接写平台库，不进调用方的事务，调用方回滚也留得下。没配置模型服务时没有发出请求，不记。

**租户填写的端点不做 SSRF 白名单。** 与 ADR-0009 数据源主机同样的取舍：租户本来就要让平台连接它指定的主机，请求由 web 进程发出、只带租户自己的 Key 与提示词，返回只当作草稿经过校验；内网隔离靠部署时的出站网络策略。

**发给模型的内容。** 默认只发表结构与列统计（列名、类型、空值率、取值范围、低基数不敏感列的常见取值，ADR-0016）；租户在「模型服务」页打开 `allow_samples` 后，才另发样本行，其中敏感列已按租户盐哈希（ADR-0005），不发明文。表上下文由 `tableContextFor`（model-provider.ts）统一组织：列统计来自最近一次采集；样本是原始层每张表最近提交的 5 行（按 `_commit_ts` 倒序），与源视图预览同一套加盐哈希（ADR-0022），不另写掩码，去掉平台列（`_op` / `_batch` / `_commit_ts` / `_synced_at`）；数据湖没初始化或表还没同步时照常只发结构与统计，取样本的报错不带给模型。开关默认关，改动记审计（值没变不记） `model_provider.updated`（`detail.allowSamples`），恢复平台默认时保留。具体的提示词由各功能的子票落地。

**映射草稿生成。** 映射新建页的「用模型生成草稿」（`modelDraftFor`，mappings.ts）按「复用已发布映射（ADR-0034）> 模型 > 按规则（ADR-0017）」的顺序：结构指纹命中时直接复用、不调用模型；没配置模型服务（`resolveProvider` 为空，不靠捕获报错判断）时给规则草稿并提示「未配置模型服务，已按规则生成」；否则把表上下文与规则草稿发给模型（`purpose = mapping_draft`）。模型按固定的 `MODEL_DRAFT_SCHEMA`（pipeline/model-draft.ts）返回字段对应（表达式、值字典数组、兜底值、敏感标记）、去重键、身份打通规则，每项带 0..1 的置信度与不超过 200 字的理由，各层不许多余的键。转 YAML（`modelOutputToYaml`）以规则草稿为底：保留 `table` / `entity` / `extensions` 等其他顶层键，`fields` / `dedupe` / `identity` 整体换成模型给的（没给就删掉），值字典数组转成对象，理由写成该行的行尾注释（表单显示为「依据」）。转出的 YAML 必须过 `checkMappingDraft`，过了才填进编辑框；不保存，保存、空跑与双人发布照旧。每次成功生成在 `platform.mapping_generations` 记一行：来源（`reuse` / `rules` / `model`）、映射内容本身、每项的置信度与理由（非模型来源为空数组）、生成人，`mapping_id` 留给之后保存成映射时回填。模型输出不合 Schema（`llm_calls.schema_valid = false`）、请求失败，或转出的 YAML 不过校验（此时 `schema_valid` 仍为 true）时拒绝（422），编辑框保持原内容、不写生成记录，记审计 `mapping.model_draft_failed`：只有源表、实体、阶段（`model` / `mapping`）、错误摘要（已抹掉 Key 的前 200 字）或问题数与前 10 个问题位置，不含提示词、模型原文与值字典的取值。模型调用不放进 `draftFor` / `defaultDraft`：列表页每次打开都会跑后者。

**生成依据与详情页重新生成。** 生成后编辑框上方的「生成依据」面板（`DraftConfidence`）把模型给的每项按置信度从低到高列出（路径、百分比、理由；同分按路径），低于 0.5 红色、低于 0.8 琥珀色、其余绿色，颜色都配图标与文字；复用时只写来源并链接到来源映射（`modelDraftFor` 返回 `reusedFrom`），按规则时只写来源与提示。置信度来自模型、不可信，展示前夹到 0..1，理由当纯文本转义；面板只是展示，保存不依赖它。映射详情页的「用模型重新生成」（`modelDraftForMapping`）取映射的源表与实体走同一套 `modelDraftFor`，生成记录的 `mapping_id` 直接填上；读源视图的映射与按规则重新生成一样拒绝（没有列统计）。

## 已接受的取舍

- 只支持 OpenAI 兼容接口，不为各家的原生 SDK 做适配；不兼容 `response_format` 的服务不能用。
- 不在平台层做重试与限流：草稿由成员手动触发，失败后重新点一次即可，日志里能看到失败原因。
