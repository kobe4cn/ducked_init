# 完整测试耗时报告

> 测量于 2026-11-01，提交 1b86271（加上本票的插桩），本机 16 核、128 GB，`pnpm test:timing`。114 个文件、1200 个测试全部通过，墙钟 9,974 s（约 2 小时 46 分）。
> 复现：`pnpm test:timing > /tmp/crm-test-full.log 2>&1`（`run_in_background`，跑完前不要再起别的 vitest），再 `pnpm test:report`，第 1 节就是 `/tmp/crm-test-report.md` 的内容。做法见 `test/README.md` 的「测量耗时」。

口径：

- vitest JSON reporter 每个测试的 `duration` **含 beforeEach / afterEach**（单文件验证：`relation-stats.test.ts` 两个测试的 duration 之和 47,887 ms 等于文件的 `endTime − startTime`，其中包括 beforeEach 里的 `resetDb`），**不含 beforeAll / afterAll**（`workbench-ai.test.ts` 的 beforeAll 里 `publishedIdentitySources` 用了 32 s，文件 `endTime − startTime` 只有 6 s）。所以报告里一个文件的耗时取「上一个文件结束 → 本文件结束」，各文件之和等于墙钟时间。
- 夹具耗时是测试侧 `timed()` 包住的外层耗时，有嵌套（`publishedIdentitySources` 里含 `newTenant` 与多次 `publish`），各行不能相加。
- 任务耗时取 `platform.tasks` 的 `finished_at − started_at`（从领取到结束，含 fork 工作进程），只有调用 `resetDb` 的文件才会被记到，最后一个文件的任务没记。调度器同时跑多个任务（`maxWorkers` 4 或 2），任务耗时之和会比实际占用的墙钟时间多，只能看相对大小。
- 有两个任务的时间戳是用例自己改写的（模拟失联、过期），报告里排除了。
- **DuckLake 初始化没有直接测到**：它发生在 `app/` 里（任务的工作进程与页面的 loader），插桩不能进 `app/`。报告里用微基准（建实例与 INSTALL/LOAD）和几乎不做事的任务的底价倒推 ATTACH catalog 的耗时，是估算。

## 1. 实测数据

### 总览

| 项 | 值 |
|---|---|
| 文件数 | 114 |
| 测试数（通过 / 失败 / 跳过） | 1200（1200 / 0 / 0） |
| 墙钟时间（各文件耗时之和，含 global-setup） | 9974.2 s |
| 各测试 duration 之和（含 beforeEach / afterEach，不含 beforeAll / afterAll） | 9732.0 s |

### 按接缝

| 接缝 | 文件 | 测试 | 耗时 | 占比 | 平均每文件 |
|---|---|---|---|---|---|
| test/pipeline | 50 | 495 | 7576.4 s | 76.0% | 151.5 s |
| test/http | 24 | 274 | 2384.6 s | 23.9% | 99.4 s |
| 其他 | 40 | 431 | 13.2 s | 0.1% | 0.3 s |

### 最慢的 15 个文件

耗时含 worker 启动、导入、beforeAll 与各测试；「测试 duration 之和」不含 beforeAll。

| # | 文件 | 测试 | 耗时 | 占比 | 测试 duration 之和 |
|---|---|---|---|---|---|
| 1 | `test/pipeline/mapping.test.ts` | 58 | 948.8 s | 9.5% | 947.3 s |
| 2 | `test/pipeline/identity.test.ts` | 33 | 741.1 s | 7.4% | 740.3 s |
| 3 | `test/http/lineage.test.ts` | 18 | 503.6 s | 5.0% | 501.7 s |
| 4 | `test/pipeline/sync.test.ts` | 26 | 439.4 s | 4.4% | 438.6 s |
| 5 | `test/pipeline/serving.test.ts` | 12 | 387.0 s | 3.9% | 386.3 s |
| 6 | `test/pipeline/assertions.test.ts` | 10 | 385.5 s | 3.9% | 384.9 s |
| 7 | `test/pipeline/dsl-definitions.test.ts` | 18 | 366.8 s | 3.7% | 366.1 s |
| 8 | `test/pipeline/merge-group-merge.test.ts` | 9 | 366.2 s | 3.7% | 365.5 s |
| 9 | `test/pipeline/catalog.test.ts` | 14 | 353.6 s | 3.5% | 352.9 s |
| 10 | `test/http/api.test.ts` | 15 | 340.4 s | 3.4% | 338.3 s |
| 11 | `test/pipeline/templates.test.ts` | 12 | 306.9 s | 3.1% | 306.2 s |
| 12 | `test/pipeline/snapshots.test.ts` | 9 | 305.6 s | 3.1% | 304.9 s |
| 13 | `test/http/analytics.test.ts` | 15 | 289.9 s | 2.9% | 287.9 s |
| 14 | `test/pipeline/dsl-recompute.test.ts` | 5 | 234.8 s | 2.4% | 234.1 s |
| 15 | `test/pipeline/dsl-model-draft.test.ts` | 10 | 200.9 s | 2.0% | 200.2 s |

### 最慢的 20 个测试

| # | 文件 | 测试 | 耗时 |
|---|---|---|---|
| 1 | `test/pipeline/sync.test.ts` | 全量比对超出内存上限 有主键的大表全量比对、重建主键状态时按主键的哈希分桶，不超出溢写配额 | 105.7 s |
| 2 | `test/pipeline/template-versions.test.ts` | 模板升级 模板新版本发布后，锁定第 1 版的定义起草发布、重新计算、定时刷新的结果都不变；开关打开后才自动启用 RFM 的租户锁定第 2 版，分群带 v2: | 81.4 s |
| 3 | `test/pipeline/sync.test.ts` | 全量比对超出内存上限 源表远大于溢写配额时也能比对：读到的行暂存在本机文件里，按整行哈希分桶比对 | 79.7 s |
| 4 | `test/pipeline/dsl-definitions.test.ts` | 字段路径（ADR-0038） filter 写路径的指标能发布，结果与手写 SQL 一致；只合并门店后定时刷新入队它、不入队只依赖订单的指标；停用门店映射时影响里列出它 | 59.0 s |
| 5 | `test/pipeline/templates.test.ts` | 分析模板定义 定时刷新 依赖的实体有新合并后以生效版本的参数入队当天的 gold.rfm（来源 scheduled）；依赖没变、已在排队或运行、当天已有当前版本的快照时不入队 | 54.4 s |
| 6 | `test/pipeline/dsl-recompute.test.ts` | 定时刷新 依赖的实体有新合并后入队当天的指标与下游标签（来源 scheduled）；依赖没变、已在排队、当天已有当前版本的快照、租户有合并在排队时不入队 | 54.3 s |
| 7 | `test/pipeline/merge-group-merge.test.ts` | 按合并组合并 停用组员后由其余组员按规则给出同一订单号；只剩一个组员时组失效、各自一行；恢复后整组重建 | 50.9 s |
| 8 | `test/pipeline/rfm.test.ts` | gold.rfm：基于打通后的消费者计算 RFM 两个数据源的订单经打通合到同一消费者，分值与人群与手算一致；快照表只有 consumer_id 与分值，打通不到的订单单独计数 | 49.9 s |
| 9 | `test/pipeline/dsl-recompute.test.ts` | 多指标标签的下游重算 发布被多指标标签引用的任一指标，同一事务里都入队这个标签 | 48.1 s |
| 10 | `test/pipeline/assertions.test.ts` | error 断言阻断快照并告警 标准层出现负金额：gold.rfm 失败，结果带断言名、实体与不合格行数；不登记新快照，旧快照仍可读 | 47.0 s |
| 11 | `test/pipeline/serving.test.ts` | 生成服务库 把各快照表写进 _serving/v<版本>.duckdb：标签、指标（维度进 dims）、RFM、退役 ID 对照与 meta，都按 consumer_id 排序，结果给出各表行数 | 46.9 s |
| 12 | `test/pipeline/assertions.test.ts` | 隔离区 订单关联消费者告警时写孤儿订单；行数骤降不写行；没有失败的任务不写 | 45.9 s |
| 13 | `test/pipeline/dsl-recompute.test.ts` | 发布指标新版本后下游重算 同一事务里入队指标与引用它的标签（标签内联第 2 版指标），跑完后下游标签有按第 2 版算的新快照，旧快照不变，tag_key 不变；回刷后旧统计日也有第 2 版快照 | 45.8 s |
| 14 | `test/pipeline/serving.test.ts` | 自动重建服务库 error 级断言失败、没有登记快照时不重建，服务库仍是上一版 | 45.3 s |
| 15 | `test/pipeline/user360.test.ts` | gold.user360：以统一消费者为粒度汇总订单与同意 两个数据源的订单与同意经打通合到同一消费者，与手算一致；没下过单的也在；快照表没有明文与 __source 列，登记为 user360，不重建服务库 | 45.1 s |
| 16 | `test/pipeline/snapshots.test.ts` | 源端结构变化 源端删掉订单表引用的列（没有行变化）：同步后只有这个映射合并失败，客户照常合并；旧快照仍可读，新快照标数据不完整；能改映射的成员收到邮件并记审计 | 44.8 s |
| 17 | `test/pipeline/template-versions.test.ts` | 升级预览与确认 预览只出分群迁移人数、湖与任务不变；确认后起草锁定第 2 版的草稿，发布前仍按第 1 版计算，另一位成员发布后按第 2 版；丢弃草稿回到第 1 版 | 44.6 s |
| 18 | `test/pipeline/dsl-recompute.test.ts` | 定时刷新 标签引用的指标已按新合并算过、标签自己还没算时，单独入队这个标签 | 44.3 s |
| 19 | `test/pipeline/assertions.test.ts` | warn 断言只记录不阻断 订单关联消费者的比例低于 80%：记一条 warn（带比例与孤儿数），任务成功、登记快照，运行记录里也有 | 43.9 s |
| 20 | `test/http/api.test.ts` | 点查的隔离 A、B 两个租户有同名数据源、同一个源端 ID 时各自只查到本租户的人；A 的 Key 用只在 B 存在的数据源名 404 | 43.6 s |

### 夹具的固定开销

测试侧包装（test/timing.ts）量到的外层耗时。有嵌套：`publishedIdentitySources` 含 `newTenant` 与 `publish`，`mergeUnchecked` 含 `runTask:silver.merge`，各行不能相加。

| 名字 | 次数 | 涉及文件 | 总耗时 | 平均 | 中位数 | 占总耗时 |
|---|---|---|---|---|---|---|
| `publishedIdentitySources` | 205 | 37 | 5485.5 s | 26759 ms | 30061 ms | 55.0% |
| `publish` | 1291 | 49 | 3814.2 s | 2954 ms | 2282 ms | 38.2% |
| `newTenant` | 721 | 69 | 599.5 s | 831 ms | 687 ms | 6.0% |
| `resetDb` | 721 | 73 | 371.2 s | 515 ms | 357 ms | 3.7% |
| `runTask:gold.rfm` | 69 | 7 | 127.9 s | 1853 ms | 2040 ms | 1.3% |
| `runCli:create-tenant.ts` | 52 | 4 | 78.8 s | 1516 ms | 1532 ms | 0.8% |
| `runTask:demo.seed` | 34 | 5 | 33.3 s | 979 ms | 945 ms | 0.3% |
| `startApp` | 24 | 24 | 32.8 s | 1368 ms | 1292 ms | 0.3% |
| `runCli:create-operator.ts` | 37 | 3 | 27.8 s | 751 ms | 747 ms | 0.3% |
| `runTask:lake.inventory` | 35 | 4 | 21.1 s | 604 ms | 578 ms | 0.2% |
| `runTask:gold.dsl` | 13 | 3 | 19.0 s | 1458 ms | 1665 ms | 0.2% |
| `runTask:silver.merge` | 16 | 6 | 18.0 s | 1126 ms | 1141 ms | 0.2% |
| `runTask:serving.build` | 19 | 2 | 14.1 s | 743 ms | 660 ms | 0.1% |
| `mergeUnchecked` | 8 | 5 | 10.4 s | 1300 ms | 1151 ms | 0.1% |
| `runCli:reset-lake.ts` | 6 | 1 | 6.4 s | 1060 ms | 707 ms | 0.1% |
| `runTask:gold.user360` | 6 | 2 | 5.9 s | 987 ms | 859 ms | 0.1% |
| `runTask:sandbox.expire` | 11 | 1 | 5.4 s | 495 ms | 490 ms | 0.1% |
| `runCli:reset-operator-totp.ts` | 6 | 1 | 4.6 s | 771 ms | 737 ms | 0.0% |
| `runTask:gold.churn` | 4 | 1 | 3.3 s | 829 ms | 526 ms | 0.0% |
| `runTask:gold.expire` | 2 | 2 | 3.1 s | 1561 ms | 1350 ms | 0.0% |
| `runCli:migrate-lake.ts` | 4 | 1 | 2.9 s | 724 ms | 707 ms | 0.0% |
| `runTask:gold.repurchase` | 4 | 1 | 2.8 s | 708 ms | 486 ms | 0.0% |
| `runCli:ensure-lake-schemas.ts` | 2 | 1 | 2.7 s | 1375 ms | 1202 ms | 0.0% |
| `runTask:gold.clv` | 3 | 1 | 2.1 s | 708 ms | 499 ms | 0.0% |
| `runTask:gold.cohort` | 3 | 1 | 1.9 s | 649 ms | 513 ms | 0.0% |
| `runTask:lake.inspect` | 3 | 1 | 1.7 s | 555 ms | 555 ms | 0.0% |
| `runTask:source.drop` | 2 | 1 | 1.0 s | 514 ms | 437 ms | 0.0% |

### 各种任务的耗时

由 resetDb 清表前从 platform.tasks 读出（finished_at − started_at，应用内部的耗时）。只覆盖调用 resetDb 的文件；beforeAll 里清库的文件，最后一批任务记在下一个文件名下，所以只按种类整体统计。

| 任务 | 次数 | 失败 | 总耗时 | 平均 | 中位数 | 占总耗时 |
|---|---|---|---|---|---|---|
| `silver.merge` | 1465 | 35 | 2837.3 s | 1937 ms | 2042 ms | 28.4% |
| `source.sync` | 910 | 4 | 2282.1 s | 2508 ms | 2077 ms | 22.9% |
| `source.profile` | 941 | 2 | 711.0 s | 756 ms | 756 ms | 7.1% |
| `serving.build` | 357 | 18 | 317.4 s | 889 ms | 919 ms | 3.2% |
| `gold.rfm` | 250 | 13 | 262.5 s | 1050 ms | 1076 ms | 2.6% |
| `gold.user360` | 168 | 3 | 183.0 s | 1090 ms | 1102 ms | 1.8% |
| `gold.cohort` | 166 | 2 | 170.1 s | 1025 ms | 1040 ms | 1.7% |
| `gold.repurchase` | 168 | 2 | 166.4 s | 991 ms | 1019 ms | 1.7% |
| `gold.churn` | 167 | 2 | 166.4 s | 996 ms | 1021 ms | 1.7% |
| `gold.clv` | 165 | 2 | 163.9 s | 993 ms | 1025 ms | 1.6% |
| `gold.dsl` | 132 | 6 | 123.9 s | 939 ms | 964 ms | 1.2% |
| `source.verify` | 25 | 0 | 48.3 s | 1931 ms | 1816 ms | 0.5% |
| `demo.seed` | 34 | 2 | 32.5 s | 956 ms | 923 ms | 0.3% |
| `lake.inventory` | 61 | 2 | 25.9 s | 425 ms | 525 ms | 0.3% |
| `source.keycheck` | 16 | 0 | 12.1 s | 758 ms | 740 ms | 0.1% |
| `sandbox.expire` | 12 | 9 | 5.9 s | 490 ms | 480 ms | 0.1% |
| `export.tags` | 10 | 1 | 5.2 s | 524 ms | 516 ms | 0.1% |
| `gold.expire` | 4 | 0 | 2.9 s | 723 ms | 587 ms | 0.0% |
| `source.drop` | 4 | 1 | 2.7 s | 682 ms | 575 ms | 0.0% |
| `lake.inspect` | 4 | 0 | 2.1 s | 531 ms | 509 ms | 0.0% |
| `silver.keycheck` | 3 | 0 | 2.0 s | 655 ms | 681 ms | 0.0% |

另有 2 个任务的耗时为负或超过 10 分钟（用例改写了时间戳），未计入。

### 固定开销按接缝

| 接缝 | 名字 | 次数 | 总耗时 | 占该接缝耗时 |
|---|---|---|---|---|
| test/http | `publishedIdentitySources` | 59 | 1573.3 s | 66.0% |
| test/http | `publish` | 338 | 998.1 s | 41.9% |
| test/http | `newTenant` | 223 | 148.6 s | 6.2% |
| test/http | `resetDb` | 265 | 94.3 s | 4.0% |
| test/http | `runCli:create-tenant.ts` | 52 | 78.8 s | 3.3% |
| test/http | `runTask:gold.rfm` | 21 | 38.8 s | 1.6% |
| test/http | `startApp` | 24 | 32.8 s | 1.4% |
| test/http | `runCli:create-operator.ts` | 37 | 27.8 s | 1.2% |
| test/http | `runCli:reset-operator-totp.ts` | 6 | 4.6 s | 0.2% |
| test/http | `runTask:lake.inventory` | 5 | 2.9 s | 0.1% |
| test/http | `runTask:serving.build` | 3 | 1.8 s | 0.1% |
| test/http | `runTask:demo.seed` | 2 | 1.4 s | 0.1% |
| test/http | `runTask:gold.user360` | 1 | 1.3 s | 0.1% |
| test/http | `mergeUnchecked` | 1 | 1.2 s | 0.0% |
| test/http | `runTask:silver.merge` | 1 | 1.1 s | 0.0% |
| test/pipeline | `publishedIdentitySources` | 146 | 3912.2 s | 51.6% |
| test/pipeline | `publish` | 953 | 2816.0 s | 37.2% |
| test/pipeline | `newTenant` | 498 | 450.9 s | 6.0% |
| test/pipeline | `resetDb` | 456 | 276.9 s | 3.7% |
| test/pipeline | `runTask:gold.rfm` | 48 | 89.1 s | 1.2% |
| test/pipeline | `runTask:demo.seed` | 32 | 31.9 s | 0.4% |
| test/pipeline | `runTask:gold.dsl` | 13 | 19.0 s | 0.3% |
| test/pipeline | `runTask:lake.inventory` | 30 | 18.2 s | 0.2% |
| test/pipeline | `runTask:silver.merge` | 15 | 16.9 s | 0.2% |
| test/pipeline | `runTask:serving.build` | 16 | 12.3 s | 0.2% |
| test/pipeline | `mergeUnchecked` | 7 | 9.2 s | 0.1% |
| test/pipeline | `runCli:reset-lake.ts` | 6 | 6.4 s | 0.1% |
| test/pipeline | `runTask:sandbox.expire` | 11 | 5.4 s | 0.1% |
| test/pipeline | `runTask:gold.user360` | 5 | 4.6 s | 0.1% |
| test/pipeline | `runTask:gold.churn` | 4 | 3.3 s | 0.0% |
| test/pipeline | `runTask:gold.expire` | 2 | 3.1 s | 0.0% |
| test/pipeline | `runCli:migrate-lake.ts` | 4 | 2.9 s | 0.0% |
| test/pipeline | `runTask:gold.repurchase` | 4 | 2.8 s | 0.0% |
| test/pipeline | `runCli:ensure-lake-schemas.ts` | 2 | 2.7 s | 0.0% |
| test/pipeline | `runTask:gold.clv` | 3 | 2.1 s | 0.0% |
| test/pipeline | `runTask:gold.cohort` | 3 | 1.9 s | 0.0% |
| test/pipeline | `runTask:lake.inspect` | 3 | 1.7 s | 0.0% |
| test/pipeline | `runTask:source.drop` | 2 | 1.0 s | 0.0% |


### 补充测量

本机的几项微基准（各跑 3 次，用来拆一个任务的固定开销）：

| 项 | 耗时 |
|---|---|
| `node -e 1` | 80 ms |
| `node --import tsx -e 1` | 100–110 ms |
| 在 tsx 下导入 `app/.server/pipeline/worker.ts` 的模块图 | 145–157 ms |
| `DuckDBInstance.create(':memory:')` + connect | 5 ms |
| `INSTALL/LOAD ducklake, postgres, httpfs`（扩展已在本机缓存） | 29–45 ms |

`publishedIdentitySources` 内部按调用顺序归属（同一用例里、它之前的 `publish` / `newTenant` 记在它名下）拆开：205 次共 5,486 s，其中 `publish` 1,106 次 3,389 s（每次约 5.4 次发布、每次 3.1 s），`newTenant` 137 s，余下约 1,960 s（每次约 9.6 s）是 `seedIdentitySources`：重建源库里三个 schema、登记三个数据源、选表并同步、采集。

## 2. 结论：时间花在哪里

1. **没有单点卡住，时间几乎全部花在「造数据」上。** 夹具 `publishedIdentitySources` 一项就占墙钟的 55%（205 次，每次约 27 s，37 个文件用到，除 6 个文件外都在每个用例里重新造）；它之外的 `publish` 再占约 4%，`newTenant` 约 4.5%，`resetDb` 3.7%。被测的业务断言本身很快。
2. **造数据慢在任务。** 每次 `publish` 都要跑一次合并（`silver.merge` 中位数 2.0 s），之后还有下游任务；`seedIdentitySources` 是三次同步（`source.sync` 中位数 2.1 s）加采集（0.76 s）。整轮共跑了 5,062 个任务。
3. **每个任务有约 0.45 s 的固定开销。** 几乎什么都不做的任务（`lake.inventory` 平均 425 ms、`sandbox.expire` 490 ms、`export.tags` 524 ms）就是底价：fork 工作进程 + tsx + 导入 worker 模块图约 250 ms（微基准），DuckDB 建实例与 INSTALL/LOAD 约 40 ms，余下约 150–200 ms 是 ATTACH DuckLake catalog（经 PG 读元数据）与领取、结束任务的记账。5,062 个任务 × 0.45 s ≈ 2,300 s，但调度器同时跑多个任务，实际占墙钟要少一些。合并 5 行要 2 s，多出的部分是 DuckLake 每次提交在 PG catalog 上的往返。
4. **HTTP 接缝的固定开销不大。** `startApp` 24 次共 33 s；`runCli` 起子进程共约 124 s（开租户 52 次 79 s、建运营者 37 次 28 s），合计不到 2%。HTTP 文件慢同样是因为在用例里调流水线夹具（`lineage.test.ts` 17 次 `publishedIdentitySources` 占了它 503 s 里的 488 s）。
5. **串行是放大器。** 本机 16 核，整轮只用到一个测试进程（加上它 fork 的最多 4 个工作进程）。
6. 最慢的文件 `mapping.test.ts`（949 s，58 个测试）只用了一次 `publishedIdentitySources`，它的时间在大量单独的 `publish` 与 `runTask` 上；做文件级并行时它会成为下限，需要拆分。

## 3. 优化方向与收益估算（#301 的输入）

收益按本次墙钟 9,974 s 估，各项有重叠，不能简单相加。

| # | 方向 | 预计省下 | 风险 | 建议 |
|---|---|---|---|---|
| 1 | 文件内共享夹具（resetDb 与造数据挪到 beforeAll） | 2,000–2,500 s（20–25%） | 中 | 先做头部 10 个文件 |
| 2 | HTTP 测试用 `newTenant` 代替 `runCli` 开租户 | 约 60 s（0.6%） | 低 | 顺手做 |
| 3 | 复用 `openTenantLake` / 预热工作进程 | 进程内复用 < 200 s；预先 fork 工作进程 600–1,000 s | 中（要改 app/） | 放到并行之后再看 |
| 4 | 按 `VITEST_POOL_ID` 分库，打开文件级并行 | 4 个 worker 约省 6,500 s（降到 50–60 分钟） | 中 | 收益最大，优先 |
| 5 | `isolate: false` | 约 13 s | 低（模块状态在文件间残留） | 不做 |
| 6 | 夹具快照（造一次，之后恢复） | 最多约 4,500 s | 高 | 1 与 4 之后仍不够再考虑 |

### 3.1 文件内共享夹具：beforeEach → beforeAll

- **现状**：67 个文件在 beforeEach 里 `resetDb`，6 个在 beforeAll（`workbench`、`mcp-query`、`cohort-repurchase`、`clv-churn`、`workbench-ai` 与 `test/http/workbench`，它们都只造一次数据，每个文件 3–80 s）。只把 `resetDb` 挪到 beforeAll 本身只省 `resetDb` 的 371 s 里的大部分（约 300 s，3%）；真正的收益是挪了之后同一文件的用例能共用一个租户和一份 `publishedIdentitySources`。
- **上限**：`publishedIdentitySources` 205 次、37 个文件，每个文件只造一次就少 168 次 × 26.8 s ≈ 4,500 s。另有 516 次单独的 `newTenant`（约 430 s）。
- **现实估计**：只读的用例才能共用。粗扫头部文件（按用例里有没有 `publish(`、`.post(`、`runTask(`、`UPDATE`/`INSERT` 等写操作）：`test/http/lineage.test.ts` 18 个用例里 13 个不写，`test/pipeline/catalog.test.ts` 14 个里约 9 个不写；`identity.test.ts` 33 个里写的较多。按头部文件约一半的用例能共用估：2,000–2,500 s。
- **候选**（按 `publishedIdentitySources` 次数）：`identity`（33）、`http/lineage`（17）、`catalog`（12）、`assertions`、`dsl-definitions`（各 10）、`serving`、`merge-group-merge`、`http/analytics`（各 9）、`http/api`、`snapshots`、`http/business-notes`（各 8）、`templates`（7）。
- **做法**：只读用例放进一个 `describe`，在它的 beforeAll 里清库并造数据；写数据的用例留在 beforeEach，或各自的 describe 用不同的 slug。
- **风险**：用例之间出现顺序依赖，单独跑一个用例（`-t`）时要照样能过；有的“只读”用例会写审计或任务（如打开页面入队检查），断言计数时会互相影响。
- **要改的文件**：上面列出的测试文件；夹具不用改。

### 3.2 HTTP 测试用 `newTenant` 代替 `runCli` 开租户

- **现状**：`test/http/login.test.ts`（14 处）、`members.test.ts`（10）、`suspension.test.ts`（8）、`ops.test.ts`（25 处，含建运营者与重置 TOTP），共约 57 处（工单写的是 42 处，这里按 grep 出的调用行数）。实测 `runCli:create-tenant.ts` 52 次、平均 1.52 s；`newTenant` 平均 0.83 s。`runCli:create-operator.ts` 37 次、0.75 s，进程内建运营者应在 0.1 s 以内。
- **收益**：开租户 52 × 0.69 s ≈ 36 s，建运营者约 24 s，合计约 60 s。
- **风险**：低。HTTP 测试的应用代码在 vite 的模块图里，测试侧直接调 `createTenant` 用的是另一份模块实例，两边只共享数据库，这没问题（`publishedIdentitySources` 在 HTTP 测试里已经这样用）。命令行入口本身要留一两个用例覆盖（`login.test.ts` 的「运营命令创建租户与首个管理员…」「运营命令拒绝重复的租户标识」）。
- **要改的文件**：上面四个测试文件；`test/http/harness.ts` 的 `createTenant` / `createOperator` 可加进程内版本。

### 3.3 复用 `openTenantLake`

- **现状**：`app/.server/pipeline/lake-engine.ts:66-118` 每次新建 DuckDB 实例、INSTALL/LOAD 三个扩展、ATTACH stage 与 DuckLake catalog，再锁定配置。任务里每个工作进程只开一次（ADR-0001：每个任务一个独立进程），所以进程内没有可复用的东西。
- **可量化的部分**：建实例 + INSTALL/LOAD 实测约 40 ms，5,062 个任务合计约 200 s（任务之和，不全在墙钟上）。ATTACH catalog 不能省：首次挂载要带 `ENCRYPTED`、之后不带（ADR-0020），而且锁定配置后不能再 ATTACH，实例只能给一个租户用。测试进程里直接调 `openTenantLake` 的（`silver()`、页面的 loader）没有单独测，按调用次数看量很小。
- **更值得做的是工作进程的启动**：fork + tsx + 导入 worker 模块图约 250 ms，5,062 个任务合计约 1,270 s。调度器预先 fork 好一个空闲进程（仍然一个任务用一次就退出，不违背 ADR-0001），或把 worker 预先编译成 JS 去掉 tsx 转译，估计能从墙钟上省 600–1,000 s。
- **风险**：中。要改 `app/.server/pipeline/dispatcher.ts`（fork 在第 70 行）和 worker 入口，影响生产的调度器；预热进程拿不到任务时要回收。
- **建议**：放在并行之后。并行以后 CPU 更紧，再量一次任务底价再决定。

### 3.4 按 `VITEST_POOL_ID` 分库，打开文件级并行

- **收益**：本机 16 核。4 个 worker 理想是 9,974 / 4 ≈ 2,500 s；每个测试进程还会 fork 最多 4 个工作进程跑 DuckDB，按 CPU 与 PG 争用打七折估，约 3,000–3,500 s（50–60 分钟），省约 6,500 s。8 个 worker 时受最慢文件限制（`mapping.test.ts` 949 s、`identity.test.ts` 741 s），不拆分它们就降不到 16 分钟以下。
- **要改的地方**：
  - `vitest.config.ts:12-27`：`PLATFORM_DATABASE_URL` 的库名、`PLATFORM_LAKE_URI`、`PLATFORM_SOURCE_FILES_DIR`、`TEST_SOURCE_DATABASE_URL` 按 worker 加后缀。config 在主进程里求值，拿不到 `VITEST_POOL_ID`，要挪到 `setupFiles` 里设置。
  - `test/global-setup.ts:10-42`：锁改成锁整组库；建库与迁移对每个 worker 的库各做一次（可以先迁移一个，再 `CREATE DATABASE … TEMPLATE` 复制）。
  - `test/pipeline/source-fixtures.ts:15-16`（`crm_src_reader` / `crm_src_writer`）与 `375-376`（`crm_src_partial` / `crm_src_stranger`）：数据库角色是集群级的，不同 worker 重建、改密码会互相影响，要按 worker 加后缀；`49-50`（`shop`）与 `126-127`（`crm`、`loyalty`、`tracking`）的 schema 在各自的源库里，源库按 worker 分开后就不用改名。
  - 租户的 catalog 角色以租户 ID 命名（`app/.server/lake.ts:32-38`），ID 不会撞；`resetDb` 只删本库 `tenant_lakes` 里登记的，按库分开后互不影响。
  - `test/http/harness.ts` 的 `cacheDir: 'node_modules/.vite-test'`：多个 worker 同时起 vite 会同时写，要按 worker 分目录。
  - MySQL、MongoDB、对象存储测试（`.env.test` 配了才跑）的库名与前缀同样要按 worker 分开。
- **风险**：中。机器内存（每个 worker 最多 4 个 DuckDB 工作进程）、PG 连接数（每个库有调度器与应用的连接池）；时间敏感的用例在负载高时可能超时（全局 `testTimeout` 90 s；最慢的两个用例是 `sync.test.ts` 的大表全量比对，106 s 与 80 s，它们自己设了 900 s，但其余 40–60 s 的用例在 CPU 争用下可能逼近 90 s）。

### 3.5 `isolate: false`

- vitest 运行结束时提示：114 个 worker、每个约 116 ms 启动，`isolate: false` 至少省 13 s（0.1%）。
- 风险：模块级状态在文件之间残留（如 `getDb()` 的连接池、`setMailer`、`setLlmFetch` 的替身、调度器的单例），可能出现与顺序有关的失败。收益太小，不建议做。

### 3.6 夹具快照（附加）

- `publishedIdentitySources` 的结果对同样的参数是一样的。造一次后把这个租户的平台表行、catalog schema、数据湖目录与源库 schema 保存下来，之后每次清库后恢复，估计每次 2–3 s，代替 27 s，最多省约 4,500 s。
- 风险高：租户 ID、数据库角色与密码、加密的数据密钥、DuckLake catalog 里的绝对路径都要原样恢复；`slug` 参数不同的调用要分别造；夹具一改就要让快照失效。3.1 与 3.4 做完仍不够快时再考虑。

## 4. 优化后（#309）

> 测量于 2026-11-01，#305–#308 合入后加上 #309（默认 8 个 worker、PG `max_connections=300`），本机 16 核、128 GB，`pnpm test:timing`。118 个文件、1200 个测试全部通过，**墙钟 803 s（约 13 分 23 秒）**，串行时是 9,974 s，约快 12.4 倍。同一份代码用 `CRM_TEST_WORKERS=4` 再跑一次：1200 个全过，墙钟 1,160 s。

口径（`scripts/test-duration-report.ts` 已按并行改过）：

- 文件并行后「上一个文件结束 → 本文件结束」不再是本文件的耗时。墙钟取 JSON reporter 的 `startTime` 到最后一个文件的 `endTime`。
- 文件耗时取 reporter 的 `startTime` 与本文件最早一条夹具计时（`test/timing.ts` 现在记下开始时刻 `at`，含 beforeAll 里的）中较早者 → `endTime`：含 beforeAll 里的夹具与各测试，不含导入与 worker 启动。
- 各文件耗时之和是 worker 时间（6,305 s），比墙钟大；下表的「占比」以它为分母。平均并行度 = worker 时间 / 墙钟 = 7.86。
- 第 1 节的数据保持原样，是串行时的口径。

### 各票的贡献

| 票 | 改动 | 墙钟 | 说明 |
|---|---|---|---|
| — | 串行（#300 测量） | 9,974 s | 基线 |
| #305 | 按 worker 分库，4 个 worker 文件并行 | 1,439 s | −8,535 s，主要收益 |
| #306–#308 | 拆分 mapping / identity，只读用例共用夹具，HTTP 进程内开租户 | 1,160 s（4 个 worker） | −279 s；单文件耗时见各票（如 lineage 471 → 275 s、api 197 → 140 s）。worker 时间 4,565 s，串行时就是墙钟 9,974 s |
| #309 | 默认 8 个 worker、PG `max_connections=300` | 803 s | −357 s。worker 时间从 4,565 s 涨到 6,305 s（+38%）：16 核上 8 个测试进程再各自 fork 任务工作进程，CPU 与 PG 争用让每个文件变慢，所以 8 个 worker 只比 4 个快 1.45 倍 |

12 与 10 个 worker 没有试：8 个已在 30 分钟以内，票里只在超过时才要求试。

### 按接缝

| 接缝 | 文件 | 测试 | 耗时（worker 时间） | 占比 | 平均每文件 | 串行时 |
|---|---|---|---|---|---|---|
| test/pipeline | 54 | 495 | 4,951.6 s | 78.5% | 91.7 s | 7,576.4 s（50 个文件） |
| test/http | 24 | 274 | 1,349.4 s | 21.4% | 56.2 s | 2,384.6 s |
| 其他 | 40 | 431 | 4.1 s | 0.1% | 0.1 s | 13.2 s |

### 最慢的 10 个文件

| # | 文件 | 测试 | 耗时（8 个 worker） | 4 个 worker 时 | 串行时 |
|---|---|---|---|---|---|
| 1 | `test/pipeline/sync.test.ts` | 26 | 394.1 s | 301.5 s | 439.4 s |
| 2 | `test/pipeline/mapping-rules.test.ts` | 24 | 245.7 s | 153.0 s | （`mapping.test.ts` 949 s 拆出） |
| 3 | `test/pipeline/catalog.test.ts` | 14 | 240.7 s | 154.8 s | 353.6 s |
| 4 | `test/pipeline/serving.test.ts` | 12 | 222.3 s | 172.7 s | 387.0 s |
| 5 | `test/http/lineage.test.ts` | 18 | 211.2 s | 124.5 s | 503.6 s |
| 6 | `test/pipeline/dsl-definitions.test.ts` | 18 | 203.1 s | 162.6 s | 366.8 s |
| 7 | `test/pipeline/mapping-merge.test.ts` | 20 | 201.8 s | 136.7 s | （`mapping.test.ts` 拆出） |
| 8 | `test/pipeline/assertions.test.ts` | 10 | 199.8 s | 158.1 s | 385.5 s |
| 9 | `test/pipeline/merge-group-merge.test.ts` | 9 | 187.9 s | 155.8 s | 366.2 s |
| 10 | `test/pipeline/identity-stable-id.test.ts` | 13 | 181.3 s | 115.9 s | （`identity.test.ts` 741 s 拆出） |

串行时的数取第 1 节（文件间隔口径），并行时的取本节口径，两者含的东西略有不同（串行口径还含导入与 worker 启动，几秒）。最慢的文件 `sync.test.ts`（394 s，其中两个大表全量比对用例 160 s 与 94 s）远小于墙钟，现在的墙钟不受单个文件限制，受 CPU 限制（整轮 `user + sys` 6,656 s，平均占用约 8.3 核）。

### 夹具的固定开销（8 个 worker）

| 名字 | 次数 | 涉及文件 | 总耗时 | 平均 | 占 worker 时间 |
|---|---|---|---|---|---|
| `publishedIdentitySources` | 193 | 39 | 3,135.1 s | 16.2 s | 49.7% |
| `publish` | 1,219 | 53 | 2,311.7 s | 1.9 s | 36.7% |
| `newTenant` | 709 | 73 | 417.6 s | 0.59 s | 6.6% |
| `resetDb` | 709 | 77 | 413.8 s | 0.58 s | 6.6% |
| `startApp` | 24 | 24 | 57.8 s | 2.4 s | 0.9% |

`publishedIdentitySources` 从 205 次降到 193 次（#307、#308 共用夹具），它仍占一半的 worker 时间。

### 顺带修的问题

第一轮 8 个 worker 时 `merge-groups.test.ts` 的「双人发布…」失败，单独跑也失败，与并行无关：`listMergeGroups` 用 `localeCompare` 给候选映射排序，结果取决于进程的 ICU 默认 locale（来自 `LC_ALL` / `LANG`）。shell 是 `zh_CN.UTF-8` 时「CRM」排在「会员」之后。`vitest.config.ts` 把测试的 `LC_ALL` 固定成 `en_US.UTF-8`，不改 `app/`。

### 下一步

已经降到 30 分钟以内，#301 的目标达成。还想更快时，按第 3 节：预热工作进程（3.3，CPU 是瓶颈，省掉每个任务约 250 ms 的 fork + tsx 最直接），或夹具快照（3.6，`publishedIdentitySources` 仍占 worker 时间的一半）。
