# 测试

写测试前先看这里：夹具提供什么、新测试怎么起头。不需要通读 `harness.ts`、`fixtures.ts`、`source-fixtures.ts` 的源码；要看某个 helper 的细节时 `grep -n` 定位后只读那一段。

## 运行

```bash
pnpm test                                    # 全部（默认 8 个 worker 按文件并行，本机约 14 分钟；输出写进文件再 grep）
CRM_TEST_WORKERS=1 pnpm test                 # 只用一个 worker（串行）
npx vitest run test/pipeline/mapping-merge.test.ts # 单个文件
```

- `vitest.config.ts` 设好了测试环境的基准值：平台 PG `crm_platform_test`、源库 `crm_source_test`（都在 `localhost:5432`，账号 `crm/crm`）、本地临时目录作数据湖、固定的主密钥、`MAILER=console`、`SOURCE_LARGE_TABLE_ROWS=1000`。不固定 `LC_ALL`：`app/` 的排序一律经 `app/lib/compare.ts` 显式给出 locale（ADR-0045），由 `test/compare.test.ts` 的守卫把关。
- 本地的 `.env.test`（模板 `.env.test.example`）提供可选的外部依赖；没配置时相应的 `describe.skipIf(...)` 自动跳过：
  - `TEST_S3_LAKE_URI`：对象存储上的隔离测试与文件数据源
  - `TEST_MYSQL_URL`：MySQL 数据源
  - `TEST_MONGO_URL`：MongoDB 数据源
- `CRM_TEST_IAM_STRESS=1` 才跑 `test/pipeline/pipeline.test.ts` 的并发 IAM 改写用例（#560 的复现）：8 路并发建删一次性账号，压测期间已有租户的 ListBucket 前缀隔离应仍生效。默认关闭，因为压测打乱的是全局 IAM，会把同一存储服务上其他 worker 的 S3 用例一起搞成偶发失败；根因结论见 #569
- **按 worker 分库，文件并行**：worker 数由 `CRM_TEST_WORKERS` 控制（默认 8，CI 设成 4，要求 PG 的 `max_connections` ≥ 300，见 `db_script/docker-compose.yml`；PG 还是默认的 100 时用 `CRM_TEST_WORKERS=4`，约 19 分钟）。`vitest.config.ts` 把基准值另存到 `CRM_TEST_BASE_*`，`test/setup-env.ts`（setupFiles）按 `VITEST_POOL_ID`（1…N）给每个 worker 加后缀 `_w<i>`：
  - 平台库 `crm_platform_test_w<i>`、源库 `crm_source_test_w<i>`、MySQL / MongoDB 库（`TEST_MYSQL_URL` / `TEST_MONGO_URL` 的库名加后缀）
  - 数据湖目录 `$TMPDIR/crm_platform_test_lake_w<i>`、源文件目录 `$TMPDIR/crm_platform_test_sources_w<i>`、对象存储前缀 `TEST_S3_LAKE_URI` 加后缀
  - 集群级的源端账号 `crm_src_reader_w<i>` 等（`source-fixtures.ts`；Sandcastle 沙箱里再按票加运行后缀 `_i<n>`，即 `crm_src_reader_i<n>_w<i>`，由 `CRM_TEST_RUN_SUFFIX` 控制，见 `scripts/test-resource-names.ts`）、vite 缓存目录 `node_modules/.vite-test_w<i>`（`harness.ts`）、迁移用例的目标目录 `crm_platform_test_lake_moved_w<i>`
  - 建、改账号时按账号名加 advisory lock（`ensurePgAccounts`），防止跨运行的同名角色并发 ALTER 报 `tuple concurrently updated`（#439）
  - 测试里要用到这些名字时从环境变量取，或用 `test/setup-env.ts` 导出的 `WORKER_SUFFIX`，不要写死。临时改 `PLATFORM_LAKE_URI` 的文件在 afterAll 里恢复成改之前的值（本 worker 的值）
  - 不在 vitest 里（scripts 引用夹具）时没有 `VITEST_POOL_ID`，不加后缀
- **测试超时倍数 `CRM_TEST_TIMEOUT_SCALE`**（本地默认 1，即 `vitest.config.ts` 的 90 s / 60 s）：`testTimeout` 与 `hookTimeout` 都乘上它（非数字或 ≤0 按 1）。Sandcastle 沙箱设 2（180 s / 120 s）：沙箱负载比本地约慢一倍（#439），`publishedIdentitySources` 平均 26.8 s，90 s 会被整体逼近、超过（#357 / #440 / #459 三张偶发失败票）。用例第三参的单个放宽不受倍数影响、照常生效。
- `test/global-setup.ts` 在开跑前对 i = 1…N 逐个建库（不存在时）并迁移到最新结构；旧库不删（库里租户的 catalog 角色是集群级的，删库会留下孤儿角色）。它还加了一把锁，已有 vitest 在跑时，再启动的 vitest 会直接报错退出。

### 测量耗时

```bash
pnpm test:timing > /tmp/crm-test-full.log 2>&1   # 完整测试，同时记下每个文件、每个测试与夹具的耗时
pnpm test:report                                 # 汇总成 Markdown，写到 /tmp/crm-test-report.md（最慢的文件与测试、夹具与任务的固定开销、按接缝）
```

- `test:timing` 设置 `TEST_TIMING=/tmp/crm-test-timing.jsonl`，并用 vitest 的 JSON reporter 把结果写到 `/tmp/crm-test-results.json`。测试的 `duration` 含 beforeEach / afterEach。默认 8 个 worker 下本机约 14 分钟（2026-11-01 实测 803 s）。
- 报告的口径（文件并行）：墙钟取开跑到最后一个文件结束；文件耗时取 reporter 的 `startTime` 与本文件最早一条夹具计时（含 beforeAll 里的）中较早者 → `endTime`，不含导入与 worker 启动；各文件之和是 worker 时间，「占比」以它为分母。
- `test/timing.ts` 的 `timed(name, fn)` 包住了 `startApp`、`resetDb`、`runCli`、`newTenant`、`runTask`、`publish`、`mergeUnchecked`、`publishedIdentitySources`，每次调用追加一行 `{ name, ms, at, file, test }`（`at` 是开始时刻）；`resetDb` 清表前还把 `platform.tasks` 里每个任务的耗时记成 `task:<kind>`。不设 `TEST_TIMING` 时不计时，行为不变。
- 单个文件也能用：`TEST_TIMING=/tmp/t.jsonl npx vitest run <文件> --reporter=json --outputFile.json=/tmp/t.json`，再 `node --import tsx scripts/test-duration-report.ts /tmp/t.json /tmp/t.jsonl`。
- 上一次的实测与优化方向见 `docs/test-plans/test-duration-report.md`。

## 两种接缝，选哪个

| 接缝 | 目录 | 驱动方式 | 用在 |
|---|---|---|---|
| 流水线 | `test/pipeline/` | 直接调用 `app/.server` 的领域函数，用调度器把任务队列跑空 | 业务规则、任务、数据湖里的结果 |
| HTTP | `test/http/` | 进程内启动 React Router 服务端，用带 cookie 的 `Client` 发请求 | 页面与表单、登录、权限矩阵、跨租户 404 |
| 纯函数 | `test/*.test.ts` | 直接调用 | 不碰数据库的逻辑（如 `mapping-spec.test.ts`） |

能用纯函数测的就不起数据库；能用流水线接缝测的就不起 HTTP。HTTP 测试只覆盖“界面上能做到、权限挡得住”。

## 夹具

### `test/pipeline/fixtures.ts`

| helper | 作用 |
|---|---|
| `newTenant(slug)` | 开通租户（含管理员 `admin@<slug>.com`），返回租户 ID |
| `memberOf(tenantId, email, role = 'data_engineer')` | 返回该成员的 `CurrentMember`，不存在则以给定角色加入；用作领域函数的第一个参数 |
| `memberInNewSpace(tenantId, email, role = 'data_engineer', name = '事业部B')` | 新建一个非默认空间，返回以它为当前空间的成员（同 `memberOf`，只换 `space`） |
| `defaultSpaceOf(tenantId)` | 租户默认空间的 ID |
| `runTask(tenantId, kind, params?)` | 入队一个任务并让调度器跑空，返回任务最终状态 |
| `drain()` | 跑空调度器（`maxWorkers: 2`）：同步、合并等任务入队后调用 |
| `selectAllTables(member, sourceId)` | 把数据源里可读的表全部选入同步范围（会入队采集，之后要跑空调度器） |
| `publish(author, reviewer, sourceId, yaml)` | 起草映射并由另一位成员发布，跑空调度器（合并完成），返回映射 ID |
| `mergeUnchecked(tenantId, mappingIds)` | 不查跨映射主键，把这些已发布映射合并一次（去掉 `uniqueKey` / `uniqueBySource`），模拟独占检查上线前已存在的重叠；返回合并任务最终状态 |
| `silver(tenantId, entity, orderBy)` | 读出标准层某个实体的表（时间按 UTC 文本、金额按文本，去掉 `_merged_at`） |
| `onLake(tenantId, sql)` | 在本租户数据湖里执行 SQL（可写），返回结果行；结果层表名要加引号：`gold."rfm__<任务 ID>"` |

跑空调度器：用 `fixtures.ts` 的 `drain()`。

### `test/pipeline/source-fixtures.ts`

| helper | 作用 |
|---|---|
| `pgSourceInput(READER \| WRITER, name = '电商库')` | **重建源库**并返回登记 PostgreSQL 数据源的表单字段，直接传给 `registerSource(member, input)` |
| `READER` / `WRITER` | 源库账号：只读；对 `shop.orders` 可 INSERT / UPDATE。账号名带运行后缀（沙箱里 `_i<n>`，`CRM_TEST_RUN_SUFFIX`）与 worker 后缀（`crm_src_reader_i<n>_w<i>`，本地不设运行后缀时是 `crm_src_reader_w<i>`；`MONGO_USERS` 的 reader / writer 用同一名字，partial / stranger 只带 worker 后缀），断言里用 `READER.user`，不要写死。建、改账号时按账号名加 advisory lock（`ensurePgAccounts`），防止跨运行的同名角色并发 ALTER |
| `grantOnSource(sql)` | 以源库管理员执行 SQL：加表、改数据、授权（在 `pgSourceInput` 之后调用，否则会被重建清掉） |
| `seedPgSource()` | 只重建源库，返回连接信息（`pgSourceInput` 内部已调用） |
| `duckdbSourceFile(tenantId, file?)` | 在租户源文件目录下生成 DuckDB 文件，返回路径 |
| `s3SourceFiles(tenantId)` | 对象存储上的 parquet 源文件与三个受限账号（需 `TEST_S3_LAKE_URI`） |
| `seedIdentitySources(member)` | 重建源库并建 `crm.customers`、`loyalty.members`、`tracking.users` + `tracking.events` 三个 schema，各登记为一个数据源（CRM、会员、埋点）、选表、确认水位线（`updated_at`）、同步完，返回 `{ crm, loyalty, tracking }`；两边同一个人的手机写法不同、只有邮箱相同、外部 ID 相同、手机-邮箱成链，另有空手机 / 空邮箱的记录；埋点用户与 CRM 重叠，事件含 login 与匿名事件，一台设备先后被两个人登录、一台同一时刻被两人登录（详见函数注释）。`{ orders: true }` 时 CRM 与会员源各多一张订单表（`crm.orders`、`loyalty.orders`，列名与状态写法不同，含一笔打通不到消费者的订单与一笔晚于 2024-07-01 的订单）一并同步。采集 / 同步任务失败时会重新入队，最多 3 次，仍失败就抛出任务错误 |
| `drainUntilSucceeded(name, task, retry)` | 跑空调度器后查任务状态，failed 时调 `retry` 重新入队，最多 3 次，仍失败就抛出任务原始错误（错误里带 `name`、任务 kind、状态、重试次数）；`task` 为 null 时直接抛错。采集任务重试用 `relistSource`（表已在同步范围内时 `setSyncScope` 返回 `task: null`），同步任务重试再调 `syncSource` |
| `seedMysqlSource()` | MySQL 源库，`orders` 带自增主键与 `updated_at`，表与 `order_id` 列带注释（`amount`、`updated_at` 没有，用于测空串视为没有注释）；`{ withView: true }` 另建视图 `orders_v`（`SELECT order_id FROM orders`，用于测视图不存表注释、列注释继承基表）（需 `TEST_MYSQL_URL`） |
| `seedMongoSource()` / `MONGO_USERS` | MongoDB 源库与几种权限的账号（需 `TEST_MONGO_URL`） |

### `test/pipeline/mapping-fixtures.ts`

映射与合并测试（`mapping-merge`、`mapping-rules`、`mapping-disable`）共用；不依赖 vitest。

| helper | 作用 |
|---|---|
| `syncedSource(extra?)` | 开通租户 `acme`，`de@acme.com` 起草、`de2@acme.com` 发布；源库在 `shop` 里另建 `ORDER_LOG`、`POINT_LOGS`、`CONSENTS`、`PREFERENCES`、`COUPON_TEMPLATES`、`COUPONS`（`extra` 是再加的建表 SQL，如 `ORDER_ITEMS`、`CONSENTS_COPY`），登记数据源后 `syncAllTables`；返回 `{ acme, author, reviewer, id, input }` |
| `syncAllTables(author, id)` | 选入数据源的全部表、确认各表水位线、同步一次并跑空调度器 |
| `CUSTOMERS` / `ORDERS` / `ORDER_LOG_MAPPING` / `POINT_LOGS_MAPPING` / `CONSENTS_MAPPING` / `PREFERENCES_MAPPING` / `COUPON_TEMPLATES_MAPPING` / `COUPONS_MAPPING` | 上面各源表的映射 YAML |
| `events(table, column, extra?)` | 写入 `event` 的映射 YAML：`event_id` 取 `table` 的 `column`，`extra` 追加在后 |
| `mergedMappings(task)` | 合并任务参数里的映射 ID（排序） |
| `withEnv(vars, fn)` | `fn` 执行期间设置环境变量（调度器派发的工作进程继承），结束后还原 |

### `test/pipeline/identity-fixtures.ts`

| helper | 作用 |
|---|---|
| `publishedIdentitySources({ orders?, consents?, slug? })` | 开通租户 `acme`（`slug` 给定时开通那个租户，成员邮箱随之改为 `@<slug>.com`；源库的三个 schema 会重建），`de@acme.com` 登记同步三个身份打通数据源、`de2@acme.com` 审核发布三个 customer 映射与埋点事件映射（`orders` 为真时再发布两个订单映射，`consents` 为真时再发布 CRM 与会员的同意映射：crm 1 短信早同意、loyalty 1 晚撤回，crm 2 与 loyalty 2 同一时刻一个同意一个撤回），合并与打通跑完；返回 `{ acme, author, reviewer, sources, mappings, orderMappings, consentMappings, names }` |
| `CRM` / `LOYALTY` / `TRACKING_USERS` / `TRACKING_EVENTS` / `CRM_ORDERS` / `LOYALTY_ORDERS` / `CRM_CONSENTS` / `LOYALTY_CONSENTS` | 上面发布的映射 YAML，改规则后重新发布时在其后追加内容 |

PostgreSQL 源库 `shop` schema 的内容（确定性造数）：

| 表 | 行数 | 主键 / 水位线候选 | 说明 |
|---|---|---|---|
| `customers` | 40 | `customer_id` serial；`updated_at` | `name`、`email`（每 4 行一个 NULL）、`phone`、`city`（北京/上海/广州/深圳）、`created_at` |
| `orders` | 100 | `order_id` identity；无更新时间 | `customer_id`、`amount`、`status`（paid/refunded 交替）、`created_at` |
| `events` | 1500 | 无主键、无水位线 | 超过大表阈值 1000，全量比对、默认每天同步 |
| `regions` | 2 | 无主键、无水位线 | 小表，全量比对 |

需要别的形状的源表时，在测试里写一段 SQL 用 `grantOnSource` 建表并 `GRANT SELECT ... TO ${READER.user}`（参考 `mapping-fixtures.ts` 里的 `ORDER_LOG`、`POINT_LOGS`、`CONSENTS`、`PREFERENCES`、`COUPON_TEMPLATES`、`COUPONS`）。

### `test/pipeline/identity-helpers.ts`

身份打通测试（`identity-merge`、`identity-recompute`、`identity-stable-id`）共用的读取与操作；不依赖 vitest。

| helper | 作用 |
|---|---|
| `identities(tenantId)` | `silver._identities` 的全部行（按 `_source, customer_id` 排序）、整表的 JSON 文本与 `silver._device_owner` 的全部行：`{ rows, text, devices }` |
| `anonymousEvents(tenantId)` | 匿名事件经设备归属到的统一消费者（没归属时为 null） |
| `consumerConsent(con, sourceId, customerId)` | 某条源记录所属统一消费者在 `silver._consumer_consent` 里的各渠道状态与来源 |
| `groupsOf(rows, names)` | 按统一消费者分组成「数据源名:customer_id」列表，便于整体比较 |
| `lastMerge(tenantId)` | 本租户最近一次 `silver.merge` 任务 |
| `republish(author, reviewer, mappingId, yaml)` | 存一版新草稿、另一位成员发布并跑空调度器 |
| `SEEDED` / `Identity` / `DeviceOwner` | 种子里的明文（断言表里没有明文）、行类型 |

### `test/pipeline/llm-fixtures.ts`

假模型服务与平台默认配置，流水线测试与 HTTP 测试共用。注入函数由调用方传入：流水线测试传 `setLlmFetch`，HTTP 测试传 `f => app.setLlmFetch(f)`（harness 用 `ssrLoadModule` 加载的是另一个 llm 模块实例）。夹具不碰 `afterEach`，`setLlmFetch(undefined)` / `app.setLlmFetch(undefined)` 与 `vi.unstubAllEnvs()` 仍由各文件自己写。

| helper | 作用 |
|---|---|
| `platformDefault(baseUrl?)` | `vi.stubEnv` 设平台默认模型服务：`LLM_BASE_URL`（默认 `https://platform.example.com/v1`）、`LLM_MODEL=qwen-plus`、`LLM_API_KEY=sk-platform-secret`；只配一部分或空串表示未配置时照旧内联 `vi.stubEnv` |
| `fakeLlm(set, respond)` | 构造假 fetch（`vi.fn`）并立刻 `set(f)`；第 n 次请求（从 1 数）先记进 `received`（`{ url, headers, body }`，`body` 已解析）再返回 `respond(n, body)`；返回 `{ f, received }` |
| `text(content, usage?)` | 模型的文字答复 |
| `json(content, usage?)` | 模型的 JSON 文本答复（`content` 经 `JSON.stringify`） |
| `toolCalls(calls, usage?)` | 模型要调用工具：`{ name, args, id? }` 或其数组，`id` 默认 `call_1`、`call_2`…；`args` 是字符串时原样作为 `arguments`（造不是 JSON 的参数），否则 `JSON.stringify` |
| `platformEmbedding(baseUrl?)` | `vi.stubEnv` 设平台默认 embedding 端点（ADR-0049，与 chat 的互不影响）：`LLM_EMBEDDING_BASE_URL`（默认 `https://embed.example.com/v1`）、`LLM_EMBEDDING_MODEL=text-embedding-v3`、`LLM_EMBEDDING_API_KEY=sk-embed-secret`；只配一部分时照旧内联 `vi.stubEnv` |
| `platformTier(tier, model, opts?)` | `vi.stubEnv` 设平台档位（ADR-0055）：`LLM_FAST_*` / `LLM_REASONING_*` 的 `MODEL`，`opts` 里给到的 `baseUrl` / `apiKey` 才设对应变量（要一起给才生效，测「填了又算没填」传空串） |
| `embeddings(vectors, usage?)` | embedding 端点的答复：每个向量按出现顺序给 `{ index, embedding }`；要测乱序返回（index 1 在前）时在测试里自己构造 `Response`；`usage` 只带 `prompt_tokens`（/embeddings 没有 completion_tokens） |

`usage` 省略时返回里不带 usage 字段（`platform.llm_calls` 的 token 列为空）；要断言 token 数（或迁移前就带 usage）时显式传 `{ prompt_tokens, completion_tokens }`（`embeddings` 只需 `prompt_tokens`）。非 200 的返回直接写 `new Response(..., { status })`。

### 检索黄金集（`scripts/eval-requirements/golden` + `retrieval-catalog.ts`）

`test/retrieval-golden.test.ts` 的夹具，纯函数、不连库（#317，ADR-0047 的确定性层）。

- `GOLDEN_ALL`（`golden.ts`）：全部 40 条，每份 YAML 除 `request` 外有 `failure_type: a|b|c|d`（召回失败 / 选错口径 / 知识缺失 / 超出能力）、`role: analyst|viewer`（缺省 analyst）、可选的 `covers: [same-name, alias, role]`、`retrieval: { query?, candidates, forbidden, ambiguous }`（`query` 缺省用 `request`，id 是目录条目标识）与 `clarify`（期望的追问，不需要写 `null`，键必须在）。`kind` / `expected` 可选：拿不出合法 DSL、要先追问或与别的条目重复的不写。`GOLDEN` 只含有 `kind` 与 `expected` 的条目，给 `pnpm eval:requirements` 与 `eval-requirements.test.ts`。
- `failure_type` 标的是这条主要考哪类失败，不是现有 `search()` 的结果；`clarify` 与 `ambiguous` 各管各的：候选只有一个但缺阈值等信息时也可以有追问。查看者条目另断言前 20 里没有数据源与源表（`source:` / `table:`）。
- `RETRIEVAL_CATALOG`（`retrieval-catalog.ts`）：在 `CATALOG_INPUT` 上加几组近义指标（营收按下单 / 支付时间、含不含退款、订单 / 明细金额；客单价、活跃次数、下单次数各两种口径）、一个标签、两个数据源（商城、门店POS）与四张源表。新加的定义放 `EXTRA_DEFINITIONS`，要能对着 `CONTEXT` 过校验（测试里断言）；不要改 `PUBLISHED_METRICS`，否则模型评测的上下文会变。查看者条目在 `retrieval.ts` 的 `viewerView` 上搜。
- `retrieval.ts`：`viewerView`（照抄 `catalogFor`）、`retrieve(g)`（前 20，先去掉能力说明）、`recallAt`、`retrievalRows` 与 `groupByType`，`retrieval-golden.test.ts` 与 `pnpm eval:requirements` 共用，两边的 Recall@20 是同一算法。追问按服务端的歧义判定算，「该追问」= `clarify` 不为 null。
- 调参集 / 验收集：`golden.ts` 的 `HOLDOUT`（每类 2 条，不写进 YAML）标出验收集，条目上是 `holdout: true`。调参只看调参集，验收集只在验收时看；`pnpm eval:requirements` 两张表分开列，基线在 `docs/test-plans/requirements-eval-baseline.md`。`BASELINE` / `KNOWN_GAPS` 是回归下限，仍覆盖全部条目。
- 约定：现有 `search()` 做不到的条目记在测试的 `KNOWN_GAPS`（`it.fails`），汇总用例断言总 Recall@20 ≥ `BASELINE`（实测值向下取两位小数）。改好一条后它会变红：从 `KNOWN_GAPS` 删掉，并按汇总用例打出的新值抬高 `BASELINE`（`--silent=false` 才看得到 `console.table`）。新增条目时守住分布：a、b、c、d 每类 ≥ 4 条，`covers` 每种 ≥ 5 条。

### `test/http/harness.ts`

| helper | 作用 |
|---|---|
| `startApp()` | 启动服务端（vite 缓存目录按 worker 分开：`node_modules/.vite-test_w<i>`），返回 `TestApp`：`client()` 新浏览器、`outbox` 已发邮件、`drain()` 等后台发信完成、`close()` |
| `Client` | `get(path)`、`post(path, form)`（数组值提交多次）、`request(path, init)`、`cookie(name)`；不自动跟随重定向 |
| `loginAs(app, email)` | 走完 Magic Link 登录，返回已登录的 `Client`（成员须已存在，可先 `memberOf` 加入） |
| `loginAsOperator(app, email)` | 运营者登录（Magic Link + TOTP），返回 `{ browser, secret }` |
| `createTenant(slug, name, adminEmail)` / `createOperator(email)` / `resetOperatorTotp(email)` | 进程内调用运营命令背后的领域函数（不起子进程）：开通租户（返回 `{ tenant, space, admin, lakeReady }`）/ 创建运营者 / 重置 TOTP；出错时抛错（如 `TenantError`），用 `rejects` 断言。用的是测试进程自己的连接池，文件的 `afterAll` 要 `closeDb()` |
| `runCli(script, args, { input, env })` | 起子进程执行运营脚本，返回 `{ stdout, stderr, code }`（每次约 1.5 s）。只给测命令行本身（输出、退出码）的用例用，如 `login.test.ts` 的「运营命令创建租户…」「运营命令拒绝重复的租户标识」 |
| `resetDb()` | 清空平台元数据与租户数据湖（只清本 worker 的库与湖目录，只删本库登记的租户角色）。**流水线测试也用它** |
| `extractLink(mail)` / `extractOpsLink(mail)` | 从邮件里取出登录链接 |

## 新建一个流水线测试

```ts
// test/pipeline/<主题>.test.ts —— <主题>的流水线接缝：<入口> → <调度器派发> → <在哪里看到结果>
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { drain, memberOf, newTenant, selectAllTables } from './fixtures';
import { pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

/** 开通租户、登记电商库、选入全部表并采集完 */
async function tenantWithSource() {
  const tenantId = await newTenant('acme');
  const engineer = await memberOf(tenantId, 'de@acme.com');
  const { id } = await registerSource(engineer, await pgSourceInput(READER));
  await selectAllTables(engineer, id);
  await drain();
  return { tenantId, engineer, sourceId: id };
}

describe('<功能>', () => {
  it('<一句话说明可观察的行为>', async () => {
    const { tenantId, engineer, sourceId } = await tenantWithSource();
    // 调用领域函数 → drain() → 断言任务结果或数据湖里的数据
  });
});
```

需要原始层有数据时，在 `tenantWithSource` 之后确认水位线并同步：`confirmWatermark(member, sourceId, 'customers', 'updated_at')`、`syncSource(member, sourceId)`，再 `drain()`（完整例子见 `mapping-fixtures.ts` 的 `syncedSource`）。读标准层用 `silver`；读写数据湖里别的表用 `onLake`，要在同一会话里多次读时用 `openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 })`，用完 `session.close()`（例子见 `fixtures.ts` 的 `silver`、`pii.test.ts` 的 `silverDump`）。

## 新建一个 HTTP 测试

```ts
// test/http/<主题>.test.ts —— <主题>的 HTTP 接缝：<谁在界面上做什么>；<权限边界>
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

describe('<功能>', () => {
  it('<角色>能<做什么>，其他租户 404', async () => {
    const tenantId = await newTenant('acme');
    await memberOf(tenantId, 'de@acme.com', 'data_engineer');
    const browser = await loginAs(app, 'de@acme.com');
    const res = await browser.post('/<路径>', { field: 'value' });
    expect(res.status).toBe(302);
  });
});
```

数据准备优先用领域函数（`newTenant`、`memberOf`、`registerSource`），只把要测的那一步走 HTTP。

### 只读用例共用夹具

造数据贵的时候（`publishedIdentitySources` 一次约 27 s），只读的用例可以在 describe 级 `beforeAll` 里清库、造一次数据并登录，同组用例共用。条件：

- 用例只 `get` 页面：不 `publish`、不 `.post(`、不 `runTask`、不改库（包括 `getDb().update` 改任务结果或快照）。要改的数据放进 `beforeAll` 的夹具里一次改好，例如 `sharedFixture(fallbackOnCrmOrders)`。
- 不断言「恰好 N 条」：打开页面可能入队检查任务或写审计，同组别的用例会影响计数。
- 不依赖执行顺序，用 `-t` 单独跑也能过。

顶层 `beforeEach` 会作用到所有 describe，所以这种文件不写顶层 `beforeEach`：每个按用例造数据的 describe 自己写 `beforeEach(fresh)`，共享组写 `beforeAll`。要保持用例名不变，可以并列写多个同名的 describe。参考 `test/http/lineage.test.ts`（`sharedFixture`）与 `test/http/analytics.test.ts`（`sharedSnapshot`）：

```ts
const fresh = async () => { await resetDb(); app.outbox.length = 0; };

describe('<功能>', () => {
  beforeEach(fresh);
  it('写数据或断言计数的用例', async () => { /* 自己造数据 */ });
});

describe('<功能>', () => {
  let shared: Awaited<ReturnType<typeof sharedFixture>>;
  beforeAll(async () => { shared = await sharedFixture(); }); // 内部先 fresh()，再造数据、登录
  it('只读用例', async () => { const { viewer } = shared; /* 只 get */ });
});
```

两种变体：

- **几个不同名的 describe 共用一份**：要保持各自的用例名，又只造一次数据时，把这几组并列写在文件末尾（中间不夹 `beforeEach(fresh)` 的组），用模块级的 `served ??= fresh().then(造数据)` 记住同一个 Promise，每组 `beforeAll` 里 await 它。参考 `test/http/api.test.ts`（`sharedServed`）。这几组的用例原则上也只读；票里点名要共用、又会改一行的（如改数据源名），在 `finally` 里改回去。
- **用例要改的只是少量可还原的行**：在 `beforeAll` 里记下夹具造好时的那些行，组内 `beforeEach` 把它们还原、删掉之后新增的行，这样用例可以 `runTask`、改任务结果。参考 `test/pipeline/snapshots.test.ts` 的「数据不完整」（每个用例前还原本租户的 `silver.merge` 任务）。

## 浏览器验收（ego-browser）

（Sandcastle 沙箱里没有 ego-browser，改用 playwright-cli，见 `docs/agents/sandcastle.md`「浏览器验收」。）

HTTP 测试只看得到服务端渲染的 HTML。改了页面（`app/routes/*.tsx`、`app/components/`）的话，HTTP 测试通过后，再用 `ego-browser` skill 在真实浏览器里走一遍。它不进 `pnpm test`，也不能代替回归测试：能写成 HTTP 断言的就写成测试。浏览器只看测试看不到的东西：布局是否符合 `docs/agents/ui.md`、客户端交互（添加一行、Ctrl / ⌘ + Enter、展开目录等），以及页面或服务端有没有报错。

### 起 dev server

用户自己的 dev server 一般占着 5173，它的输出 agent 读不到。所以另起一个，用 `run_in_background` 运行，输出写进文件：

```bash
MAILER=console pnpm dev --port 5180 --strictPort > /tmp/crm-dev-5180.log 2>&1
```

- 它连的是 `.env` 里的开发库 `crm_platform`，不是测试库。里面是真实的开发数据：只操作验收用的租户，不删改别的数据。
- 必须设 `MAILER=console`：`.env` 里配了 `MAIL_HOST`，不设就会真的发信。
- 验收结束后停掉它：`lsof -tiTCP:5180 -sTCP:LISTEN | xargs kill`。

### 登录

租户成员只能用 Magic Link 登录：

1. 打开 `http://localhost:5180/login`，填邮箱，点「发送登录链接」。
2. 从日志里取链接：`grep -o 'http://localhost:5180/auth/verify?token=[A-Za-z0-9_-]*' /tmp/crm-dev-5180.log | tail -1`
3. 打开链接后，**还要点页面上的按钮**（POST）才会登录；然后等地址离开 `/auth`。

账号用 `crmlab-smoke` 租户的成员，按要验收的角色选：`admin@crmlab-smoke.test`（管理员）、`eng@crmlab-smoke.test`（数据工程师）、`an@crmlab-smoke.test`（分析师）。浏览器会记住登录状态，换角色前先退出登录。运营后台 `/ops` 还要过 TOTP，验收它时用 `task.handOff()` 请用户登录。

### 做什么

- 一次验收只用一个 TaskSpace。照 ticket 的 `## Implementation guide` 里 **Browser check** 那一行操作：打开哪页、做什么、应看到什么。
- 截图存到 `/tmp/` 并自己看一遍，再 `grep -n -i error /tmp/crm-dev-5180.log` 查服务端报错。发现问题就修，修完重新看。
- 浏览器里发现的 bug，修好后如果能用 HTTP 测试锁住，就补一条测试。
- 结束时调 `task.finish({ keep: [] })`，并停掉 dev server。截图作为 PR 里的证据。

## 约定

- 文件第一行注释写清这条接缝：从哪个入口进、经过什么、在哪里看结果。
- `beforeEach` 里 `resetDb()`，`afterAll` 里 `closeDb()`；每个用例从空库开始，不依赖其他用例。
- 用例名用中文写一句可观察的行为，不写实现细节。
- 断言看结果（任务结果、数据湖里的行、响应状态与页面内容），不 mock 模块。需要时间流逝用 `vi.useFakeTimers({ toFake: ['Date'] })`，需要改配置用 `vi.stubEnv`（`TEMPLATE_TEST_VERSIONS=1` 打开只给测试用的模板新版本，见 `app/.server/pipeline/templates/test-versions.ts`：`latestTemplate('rfm')` 变成分群带 `v2:` 前缀的第 2 版，`latestTemplate('churn')` 变成 `at_risk` 取反、`minOrders` 不超过 10 的第 2 版，工作进程也继承这个开关）；发信用 `app.outbox` 或 `app.setMailer` 替换；模型服务用 `app.setLlmFetch` 注入假 fetch（默认替身直接报错，HTTP 测试不会真的请求填写的端点；`afterEach` 里传 `undefined` 恢复），假 fetch、答复与平台默认配置用 `llm-fixtures`（见上）。

## 现有测试一览

在 [`test/CATALOG.md`](CATALOG.md)。找类似的例子时 `grep -n` 它，不要整份读。新增测试文件时在那里加一行。
