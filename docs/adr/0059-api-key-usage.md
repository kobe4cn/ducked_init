# API Key 调用计数：按天聚合的 `platform.api_key_usage`

外部系统用 API Key 调点查接口（ADR-0033 的 `GET /api/v1/consumers/:consumerId` 与 `GET /api/v1/consumers/by-source/:source/:customerId`），管理员需要知道每把 Key 被用了多少次。#912 的人工评论在三个存法里拍板了 A：平台库一张按天聚合的计数表，本票（#920）先做记录，页面展示在后续票。

**存法 A（选定）：按天聚合。** `platform.api_key_usage` 一行是 `(tenant_id, api_key_id, endpoint, day)` 上的唯一键加一个 `calls` 计数：点查成功时 `INSERT … ON CONFLICT … SET calls = calls + 1`（upsert 是原子的，并发调用不会丢数或撞唯一约束）。行数有上限——租户数 × Key 数 × endpoint 数 × 天数，不需要清理任务。代价：同一个 Key 的并发调用会争同一行的行锁（点查频率下可忽略），时间只精确到天，拿不到每次调用的时刻。

没选的另外两个：

- **B，每次调用写一行**（像 `llm_calls` 那样）：能拿到每次的时刻，但行数无上限，得配清理任务，计数时再聚合一遍；点查频率远高于模型调用，不合算。
- **C，进程内攒一批再刷库**：省一些写，但进程重启丢数、多节点要各自刷，复杂度不值——按天聚合后本来一天最多写一次新行。

`day` 是 UTC 日期，在 SQL 里算（`(now() at time zone 'UTC')::date`），不用各节点的本地时区。行随删租户级联删掉；Key 只吊销不删行（ADR 的吊销语义），所以 `api_key_id` 的外键也是 `cascade`，只有删租户会带走它。

**计数口径。** 只记成功的点查：两个点查路由的 loader 拿到结果之后、返回之前各记一笔，`endpoint` 分别是 `consumers.byId` 与 `consumers.bySource`。不记：401（没有 Key、Key 错误、Key 已吊销、租户已暂停——在 `requireApiKey` 就抛出了，走不到记录）、404（查无此人）、503（还没有服务库）、带 `?snapshot=` 的请求（包括 by-source 的 400）——这些不是「用 Key 读到了消费者」。计数不放进 `requireApiKey`：catalog、exports 接口（ADR-0040）也走它，那些不在本口径里；`last_used_at` 照旧由 `requireApiKey` 同一把 Key 每分钟最多更新一次，与计数无关。记录写不进去（比如表暂时不可写）只打日志，接口照常返回，也不和读放在同一个事务里。写入与隔离：`tenant_id` 用 `caller.tenantId`（Key 所属租户），库里没有 RLS，隔离全靠写入值与查询条件。

**隐私边界。** 只存 keyId 与 endpoint，不存 consumerId、IP、token，也不存每次调用的时刻；后续的展示页面只显示 Key 的名字与次数，看不出谁被查了。计数本身不进审计。

相关：ADR-0033（点查接口与服务库）、ADR-0040（Bearer Key 的其他外部接口）、ADR-0025 的补充（#830）末尾指向本 ADR。

## Consequences

- 展示页（后续票）按 `(keyId, endpoint, day)` 汇总即可，不用再聚合原始行。
- 以后要更细的口径（按小时、按消费者维度的调用量）得另立存法，本表的粒度就是天。
- 新增要点查的外部接口时，在它的成功路径上记一笔、给 `ApiUsageEndpoint` 加一个值，口径照旧只记成功。
