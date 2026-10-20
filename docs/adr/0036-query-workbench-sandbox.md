# 数据查询工作台在 web 请求内对只读挂载的数据湖执行白名单 SQL，只能读标准层与结果层，每个租户同时一个、限时可取消、全部留审计

个人沙箱（CONTEXT.md「沙箱」）要让分析师、数据工程师在本租户的标准层与结果层上自由分析。#236 先做只读的部分：页面 `/workbench`（导航「查询」）里写一条 SQL、看结果表格。之后的子票再让成员把结果存成自己的沙箱表、分享出去。这一篇记下地基：查询在哪里执行、能读什么、怎么限时与限流、记什么审计。

**在 web 请求内执行，不经任务队列。** 交互查询要立即给出结果，排进任务队列（ADR-0002 的工作进程）会被正式任务挡住，也会占掉租户的任务名额。所以 `app/.server/workbench.ts` 的 `runQuery` 在请求所在的进程里 `openTenantLake(..., { readOnly: true })` 挂载本租户的数据湖，同源视图预览（ADR-0022）。会话照常锁定配置（`lockConfiguration`，ADR-0008）：只能访问本租户的存储前缀，不能再挂载、不能读别的路径。正式任务继续由调度器领取，不受交互查询影响。

**写入由只读挂载挡住，读的范围由解析器挡住。** 只读挂载挡不住读会话里别的库：本机库 `stage` 可写，DuckLake 的元数据库 `__ducklake_metadata_lake` 里有加密密钥（ADR-0020）。所以执行前先用 `json_serialize_sql` 拿到解析树（`pipeline/workbench-engine.ts` 的 `checkWorkbenchSql`，做法同 ADR-0022）：
- 只能有一条语句。`json_serialize_sql` 只认 SELECT，DESCRIBE / SHOW / SUMMARIZE 也解析成带 `SHOW_REF` 的 SELECT；EXPLAIN [ANALYZE] 先去掉前缀，检查后面的查询，执行时原样执行。INSERT、CREATE、COPY、ATTACH、SET、PRAGMA、CALL 等都报「只能执行一条 SELECT / WITH、DESCRIBE、SHOW、SUMMARIZE 或 EXPLAIN 语句」。
- 每个表引用（含子查询、表达式里的子查询、CTE）都检查：catalog 只能不写或写 `lake`，schema 只能是 `silver` 或 `gold`，不写 schema 的只能是所在作用域里的 CTE。CTE 的可见范围按 DuckDB 绑定时的规则算（`pipeline/sql-refs.ts` 的 `collectRefs`，与源视图共用）：定义体只看得到排在它前面的 CTE，递归 CTE 只在 UNION 右半边看得到自己。否则 `WITH duckdb_databases AS (SELECT * FROM duckdb_databases) …` 里的引用会被当成 CTE 放行，实际读的是同名系统视图。原始层 `bronze_*`、`stage`、元数据库、`information_schema` 与 DuckDB 的系统视图都读不到。原始层这一票不开放：那里有明文（ADR-0005），而 silver / gold 从起就只有哈希。
- 表函数（`read_parquet`、`postgres_query`、`duckdb_settings` 等）和读配置的标量函数（`getenv`、`current_setting`、`getvariable`）拒绝。`SHOW_REF` 只放行 DESCRIBE / SUMMARIZE 一张表或一个查询（里面的表照样检查）。
- `SHOW TABLES`、`SHOW ALL TABLES`、不带对象的 `DESCRIBE` 原样执行会列出 `stage` 与元数据库里的表，所以整条语句是它们时换成平台自己的查询，只列 `lake` 里 silver / gold 的表；`SHOW TABLES FROM silver|gold` 只列那一个 schema，其他 schema 拒绝。`SHOW DATABASES` 等其余 SHOW 拒绝，嵌在子查询里的 SHOW TABLES 也拒绝。

**最多 1 万行，不导出。** 结果用流式读取取前 `WORKBENCH_ROWS + 1` 行（`streamAndReadUntil`），多出一行即标记截断，页面提示「结果超过 1 万行」。没有在 SQL 外面再套 `LIMIT`：EXPLAIN 套不进子查询，流式读取对所有语句一样，管道式的查询读够了就不再往下算。取值转成 JSON 能表示的形式（BIGINT、DECIMAL 是文本）。

**限时 60 秒，客户端中止即取消。** `runQuery` 起一个 `setTimeout(timeoutMs)`，到时 `connection.interrupt()`，报「查询超过 60 秒，已中断」；同时监听 `request.signal`，客户端中止请求（页面上的「取消」发起新导航）就 `interrupt()`，报「查询已取消」。查询只在接收请求的那个进程里执行，所以多节点部署也不需要登记查询 ID：中止信号总是到达执行它的进程。

**每个租户同时一个交互查询。** `runQuery` 在一个平台 PG 事务里先 `pg_try_advisory_xact_lock(hashtext('workbench:' || 租户 ID))`，拿不到就 429「本租户已有查询在运行」，拿到后事务一直持有到查询结束、审计写完。这把锁与任务领取（`tasks.ts` 的 `pg_advisory_xact_lock`）无关，不占正式任务名额。会话的计算资源固定为 1 GiB 内存、2 线程，不按租户配额：交互查询要扫整张表、做连接，比预览与空跑（512 MiB、1 线程）重，又有 60 秒上限与每租户一个兜住总量。

**每次查询都记审计，不记结果。** `workbench.query` 的详情是 `{ sql, durationMs, rows, truncated }`，失败（白名单拒绝、执行出错、超时、取消）时再加 `error`，与查询同一事务写入。报错先经过 `redactLakeSecrets` 抹掉本租户的凭据。查询结果不进审计。并发被拒（429）的请求没有执行，不记。后续沙箱子票要用的 `sandbox.save`、`sandbox.share`、`sandbox.unshare` 一并登记在 `audit.ts` 的 `ACTIONS` 里。

**权限。** 页面与 `runQuery` 都要 `sandbox` 权限（分析师、数据工程师、管理员），查看者 403、导航里没有「查询」。

**只读凭据（#237）。** 真正挡住写入的是凭据，而不是白名单与 READ_ONLY 挂载。每个租户另有一对只读凭据，存在 `tenant_lakes` 的 `ro_db_role` / `ro_db_password` / `ro_s3_access_key` / `ro_s3_secret_key`，工作台只用它们挂载（`lake.ts` 的 `readOnlyLakeSpecOf`），即使白名单被绕过，写入也会被 PG 或存储服务拒绝：
- 只读数据库角色 `lake_<租户 ID>_ro`：能登录，不是超级用户，不属于任何角色（也就不继承租户角色）；对 catalog schema 只有 USAGE，对其中的表只有 SELECT。DuckLake 只读挂载要读全部 `ducklake_*` 元数据表（含加密密钥，ADR-0020），所以 SELECT 授给整个 schema。元数据表归租户角色所有、由 DuckLake 随时新建，所以以租户角色的身份（`asTenantRole`，同 ADR-0008 切换 `data_path` 的做法）`GRANT SELECT ON ALL TABLES` 并 `ALTER DEFAULT PRIVILEGES … GRANT SELECT ON TABLES`，之后建的表也自动可读。不要求平台账号是超级用户。
- 只读对象存储账号 `lake-<租户 ID>-ro`：策略只有本租户前缀下的 `s3:GetObject` 与以该前缀 `s3:ListBucket`（`s3-accounts.ts` 的 `issueTenantReadOnlyS3Account`）。迁移存储改前缀时 `setTenantS3Prefixes` 两个账号一起改；`deleteTenantS3Account` / `dropTenantS3Account`（迁离对象存储、收回账号）两个账号一起删、密钥一起清。
- 开通时只读角色随租户角色在同一事务里建好（`CREATE ROLE … LOGIN`，不写 `NOSUPERUSER`：默认就不是，而 PG 16 起写了这个属性的 `ALTER ROLE` 只有超级用户能执行）；`initTenantCatalog` 再调 `ensureReadOnlyLakeAccess` 补齐对象存储账号与表权限。本功能上线前开通的租户在第一次执行工作台查询时由 `runQuery` 在拿到并发锁之后、挂载之前调 `ensureReadOnlyLakeAccess` 补建（补建失败同样记 `workbench.query` 审计）：缺什么建什么，锁住数据湖行，可重复执行；角色已存在而凭据没记下时只重设密码。重置数据湖（`lake:reset`）重建 catalog schema 时重新授予只读角色。
- 之后的沙箱写入（存成沙箱表）仍走可写凭据：写入的 SQL 由平台拼出，成员只提供通过白名单的 SELECT。

## 已接受的取舍

- 白名单漏掉的读法（DuckDB 新增的读配置标量函数）仍受锁定配置与只读凭据的隔离兜底（ADR-0008）；只读凭据挡写不挡读，读得到的仍是本租户的全部 catalog（含加密密钥）与存储前缀，读的范围靠白名单。
- 只读角色与只读账号的密码、密钥与读写凭据一样明文存在 `tenant_lakes`（ADR-0008 的取舍）。
- 建只读角色、只读账号不单独记审计（读写账号记 `tenant.s3_account_created`）：它们只能读本租户已经能读的东西，补建发生在哪次查询看 `workbench.query` 即可。
- 数据湖从本地目录迁往对象存储时不建只读账号，切换后第一次工作台查询再补建；迁移期间工作台仍按迁移前的前缀挂载。
- 一次查询占住一个平台 PG 连接（advisory lock 的事务）最长 60 秒。
- 能读 silver / gold 的全部列，包括敏感字段的哈希；哈希不是明文（ADR-0005）。
- 结果不导出、不缓存（响应 `Cache-Control: no-store`），刷新页面就没了；存成沙箱表是后续子票。
- `EXPLAIN ANALYZE` 会真的执行查询，照样受超时约束。
