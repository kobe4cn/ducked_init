# 模板参数存成租户的模板定义，带版本，按映射的规则双人发布

分析模板（RFM 等）是平台内置的（ADR-0004），每个模板在注册表（`app/.server/pipeline/templates/index.ts`）里带一套默认参数。租户要调参数（如 RFM 的分档边界），调过的参数会决定结果快照里每个消费者落在哪个人群，和映射一样会影响下游，不能一个人改完就生效。CONTEXT.md 原来写的是「成员填参数即得到一份指标或标签定义」，但指标 DSL 还没做，#88 先把模板参数单独存成模板定义。

**一个租户一个模板一份。** 定义存在 `template_definitions`，`(tenant_id, template)` 唯一；参数存在它的版本 `template_versions`（`params`）里。定义行在第一次保存草稿时建立（`saveDraft` 用 `onConflictDoNothing`），不预先建。没有已发布版本时，模板页显示的生效参数是注册表里的默认参数（`getTemplate`：`published?.params ?? TEMPLATES[t].defaults`）；任务参数里没写的项也由模板解析时补上默认值（如 `parseRfmParams`）。平台不会在没有已发布版本时自动入队模板任务；映射合并成功后平台会以默认参数自动发布第 1 版（见下文的例外，#230）。从没发布过的定义丢弃草稿时，整个定义行连同版本一起删掉，之后又回到默认参数。

**双人发布，规则同映射。** 每个定义同时只有一份草稿（部分唯一索引 `template_versions_one_draft_uq`），改过草稿的成员记为作者（`authors`），另记最后保存草稿的成员（`last_editor`）。发布需要 `publish` 权限，且发布者不能是最后保存草稿的人（ADR-0015）。映射和模板共用同一个判断 `publishBlocker`（`app/.server/publish-rules.ts`），两边的规则不会各改各的。发布后版本锁定，再改就是新的一版草稿。

**起草和丢弃用 `definitions:draft`，不是 `sources:write`。** 映射的起草和丢弃要 `sources:write`（ADR-0015），只有管理员、数据工程师有。模板定义和指标、标签定义一样属于分析，起草和丢弃复用 `definitions:draft`，所以分析师也能起草、丢弃，但不能发布（分析师没有 `publish`）。

**定义里不含运行参数。** 定义只存长期不变的参数，不存每次运行时给定的参数（如 RFM 的 `asOf`）。发布后在同一个事务里以当天（UTC）为 `asOf` 入队一次模板任务，任务参数是定义的参数加上 `asOf`、`definitionVersion` 和来源 `trigger`（ADR-0028）。任务 handler 先剥掉 `definitionVersion` 与 `trigger` 再按模板解析参数；快照登记时把它记进 `snapshots.definition_version`，看快照就知道是按哪一版定义算的。直接给参数入队、不带 `definitionVersion` 的任务也照样能跑，这时快照的 `definition_version` 为空。

**发布只锁定义行。** 发布映射先锁租户行，再锁映射行：入队合并时会把要合并的映射并进排队中的合并任务，发布要与入队合并、定时检查互斥。模板任务不合并进排队中的任务，没有要互斥的入队检查，所以发布模板只锁定义行（`for update`），与保存草稿、丢弃互斥，保证发布的正是检查过的那份草稿；锁到以后再核对一次草稿没被改过（`isStale`）。

**按生效版本重新计算（#91）。** 有 `publish` 权限的成员可以按当前生效的已发布版本再入队一次模板任务（`recomputeTemplate`），参数是这一版的参数加上 `asOf` 和这一版的 `definitionVersion`，来源记 `manual`，不产生新版本。`asOf` 选填，默认 UTC 当天，不能晚于今天。重新计算先锁租户行，再读生效的版本（同时发布的入队要等它提交，读到的就是当前生效的版本），再查本租户同一模板有没有任务在排队或运行，有就拒绝，与 `enqueueDueExpiries` 的去重写法相同。还没有已发布版本时不能重新计算，页面也不显示按钮：快照总能对上一个定义版本，第一次计算由发布入队。发布仍然只锁定义行、不去重：发布了新参数总要按它算一次，不能因为旧参数的任务还在排队就拒绝发布。

**参数页与快照页按注册表通用（#227）。** 每个已登记的模板在分析页有一个参数入口（`/analytics/templates/<模板 ID>`），未登记的 ID 返回 404。RFM 保留专用表单（分箱与分群规则表）和专用快照视图；其他模板按注册表里的 `form` 渲染通用表单：`int` 是带 min / max 的整数输入，`statuses` 是订单状态多选（选项取标准模型 order.status 的枚举），`enum` 是下拉框（同期群的 `granularity` 按月 / 按周）。提交时只取 `form` 里列出的键交给 `saveDraft`，校验仍由 `parseDefinition` 负责。起草、双人发布、丢弃与重新计算的流程与 RFM 相同；用户 360、同期群、复购、CLV、流失预警五个模板都走通用表单（#229）。其他模板的快照页按 `consumer_id` 排序分页，列取快照表的全部列，BOOLEAN 显示为「是 / 否」、列表用顿号连接；页面头部有模板名与 `asOf`，参数里有 `lookbackDays` 时也显示。

**例外：映射合并后平台以默认参数自动启用模板（#230）。** 每次 `silver.merge` 成功结束，调度器调用 `enableDefaultTemplates(tenantId)`（`app/.server/templates.ts`，幂等）：本租户还没有这个模板的 `template_definitions` 行、且 `TEMPLATES[模板].entities` 的每个实体都有已发布未停用映射的模板，在一个锁住租户行的事务里建定义和已发布的第 1 版（`params` 为注册表默认参数，`authors: ['platform']`，`last_editor` 与 `published_by_email` 为 `platform`），以当天（UTC）为 `asOf` 入队一次模板任务（来源 `publish`），记审计 `template.auto_enabled`（操作者是平台）。这一版不经双人发布：它只是注册表默认参数的落地，没有人调过参数；之后成员的修改是第 2 版起的草稿，仍走双人发布。成员起过草稿但从没发布的模板也算已有定义，跳过、不覆盖；依赖不全的模板这次跳过，之后的合并会再检查。租户已停用或还有合并在排队、运行时整次跳过，免得模板任务读到还没合并完的标准层。同时结束的两次合并由租户行锁互斥，定义的唯一键兜底。

**模板版本锁定（#232）。** 注册表里每个模板带模板版本 `version`，`TEMPLATES[模板]` 永远是当前版本，退役的旧版本放在 `TEMPLATE_HISTORY`；取当前版本一律经过 `latestTemplate(id)`，按版本取经过 `templateAt(id, v)`（没有这个版本时抛错）。定义的每一版在 `template_versions.template_version` 记下锁定的模板版本（这一列之前的老数据回填为 1）：新建定义（成员第一次起草、平台自动启用）锁定注册表的当前版本；已有定义的新草稿沿用最近一个已发布版本锁定的模板版本，不随注册表升级，没有已发布版本时取当前版本；改草稿不改它锁定的版本；参数按锁定的版本校验。发布、重新计算、定时刷新都经 `enqueueTemplate` 入队，它按（租户、模板、定义版本）查出锁定的模板版本，写进任务参数 `templateVersion`；任务在解析参数前剥掉它，按 `templateAt(模板, templateVersion)` 的 `parse` 与 `compile` 计算，参数里没有 `templateVersion` 的老任务按第 1 版，注册表里没有这个版本时任务失败并报「模板 <名> 没有第 <n> 版」。这样升级模板的编译逻辑不会悄悄改变已发布定义的结果；升级到新模板版本只能由成员显式操作（#234）。测试开关 `TEMPLATE_TEST_VERSIONS=1`（只给测试用，工作进程经白名单继承）打开时，`latestTemplate` 返回 `templates/test-versions.ts` 里的测试版本（RFM 第 2 版：参数与第 1 版相同，分群加 `v2:` 前缀），注册表里的版本仍可经 `templateAt` 取得；接缝测试用它证明模板升级后锁定旧版本的定义结果不变（#233）。不设开关时注册表不变。

**升级预览与确认（#234）。** 生效的已发布版本锁定的模板版本比 `latestTemplate(id).version` 旧时，`getTemplate` 给出 `upgradeAvailable`（与 `latestTemplateVersion`），参数页在版本卡片上方显示「有新的模板版本 v<n>（当前 v<m>）」。预览 `previewTemplateUpgrade(actor, id, asOf?)` 需要 `definitions:read`：以生效版本的参数加上 `asOf`（不填为当天，不能晚于今天，同重新计算），两边各自 `parse` 后分别按锁定版本与当前版本编译，在只读挂载的湖上（`onReadOnlyLake`，同 DSL 的样本与影响预览）按 `consumer_id` 对比，只给计数（写法同 ADR-0025 的影响预览）：RFM 把 `segment` 当作取值用 `compileTagDiff`，给「原分群 → 新分群」的人数；其他模板用 `compileMetricDiff`，给换了取值、新增、移出的人数；不出 `consumer_id`，不建表、不入队、不登记快照；当前版本不接受生效的参数时报「模板第 <n> 版不接受生效的参数：<原因>」。确认 `upgradeTemplateDraft(actor, id)` 需要 `definitions:draft`（分析师也能起草升级）：锁定义行，已有草稿时把它的 `template_version` 改成当前版本，没有时以生效参数新建一版锁定当前版本的草稿，参数都按当前版本的 `parseDefinition` 校验（不接受时说明是草稿还是生效的参数），草稿已锁定当前版本时报错、不重复升级，作者照常记下，审计 `template.upgrade_drafted`（`{ template, version, from, to }`）。之后照常双人发布；发布之前重新计算与定时刷新仍按生效版本锁定的旧版本；丢弃草稿就回到旧版本。没有新版本（或还没有已发布版本）时，预览与升级都报「已是最新模板版本」。测试开关下流失预警另有第 2 版（`at_risk` 取反、`minOrders` 不超过 10），用来测其他模板的计数与新版本拒绝旧参数。

## 已接受的取舍

- 分析师能起草和丢弃模板定义，和映射的起草权限不一致：模板参数属于分析，发布仍要有 `publish` 的另一个人看过。
- 丢弃从没发布过的定义会删掉定义行，草稿的审计记录留着，但定义的 ID 换了。
- 发布时的 `asOf` 取 UTC 当天，不按租户时区。
- 发布不去重，与重新计算同时提交时可能各入队一次，两份快照都按已发布的版本计算，结果正确，只是多算了一次。
- 不带 `definitionVersion` 的任务产出的快照，看不出参数来自哪一版定义，只能看快照里存的参数。
- 指标 DSL 做出来以后，模板是否改为生成指标或标签定义另行决定；本决定只管模板自己的参数。
- 通用快照明细直接展示快照表的列名和原样取值，没有中文表头和数字格式化。快照表只有 consumer_id 与汇总值，没有明文（ADR-0005）。
- 自动启用的第 1 版没有第二个人看过；默认参数随注册表变化时，已启用的租户留在当时的默认参数上，不会自动跟进。
- 成员丢弃从没发布过的草稿后，下一次合并会把这个模板按默认参数自动启用。
- 旧模板版本要一直留在 `TEMPLATE_HISTORY` 里，直到没有定义再锁定它；删掉后锁定它的定义的任务会失败。
