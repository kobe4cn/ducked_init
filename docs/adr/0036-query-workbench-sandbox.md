# 数据查询工作台在 web 请求内对只读挂载的数据湖执行白名单 SQL，只能读标准层与结果层，每个租户同时一个、限时可取消、全部留审计

个人沙箱（CONTEXT.md「沙箱」）要让分析师、数据工程师在本租户的标准层与结果层上自由分析。#236 先做只读的部分：页面 `/workbench`（导航「查询」）里写一条 SQL、看结果表格。之后的子票再让成员把结果存成自己的沙箱表、分享出去。这一篇记下地基：查询在哪里执行、能读什么、怎么限时与限流、记什么审计。

**在 web 请求内执行，不经任务队列。** 交互查询要立即给出结果，排进任务队列（ADR-0002 的工作进程）会被正式任务挡住，也会占掉租户的任务名额。所以 `app/.server/workbench.ts` 的 `runQuery` 在请求所在的进程里 `openTenantLake(..., { readOnly: true })` 挂载本租户的数据湖，同源视图预览（ADR-0022）。会话照常锁定配置（`lockConfiguration`，ADR-0008）：只能访问本租户的存储前缀，不能再挂载、不能读别的路径。正式任务继续由调度器领取，不受交互查询影响。

**写入由只读挂载挡住，读的范围由解析器挡住。** 只读挂载挡不住读会话里别的库：本机库 `stage` 可写，DuckLake 的元数据库 `__ducklake_metadata_lake` 里有加密密钥（ADR-0020）。所以执行前先用 `json_serialize_sql` 拿到解析树（`pipeline/workbench-engine.ts` 的 `checkWorkbenchSql`，做法同 ADR-0022）：
- 只能有一条语句。`json_serialize_sql` 只认 SELECT，DESCRIBE / SHOW / SUMMARIZE 也解析成带 `SHOW_REF` 的 SELECT；EXPLAIN [ANALYZE] 先去掉前缀，检查后面的查询，执行时原样执行。INSERT、CREATE、COPY、ATTACH、SET、PRAGMA、CALL 等都报「只能执行一条 SELECT / WITH、DESCRIBE、SHOW、SUMMARIZE 或 EXPLAIN 语句」。
- 每个表引用（含子查询、表达式里的子查询、CTE）都检查：catalog 只能不写或写 `lake`，schema 只能是 `silver` 或 `gold`，不写 schema 的只能是所在作用域里的 CTE。CTE 的可见范围按 DuckDB 绑定时的规则算（`pipeline/sql-refs.ts` 的 `collectRefs`，与源视图共用）：定义体只看得到排在它前面的 CTE，递归 CTE 只在 UNION 右半边看得到自己。否则 `WITH duckdb_databases AS (SELECT * FROM duckdb_databases) …` 里的引用会被当成 CTE 放行，实际读的是同名系统视图。原始层 `bronze_*`、`stage`、元数据库、`information_schema` 与 DuckDB 的系统视图都读不到。原始层 `bronze_*` 一直不开放：那里有明文（ADR-0005），而 silver / gold 从起就只有哈希；原始层只以哈希过的当前状态视图给出（见「原始层视图」一节）。
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
- 沙箱写入（存成沙箱表，见下一节）仍走可写凭据：写入的 SQL 由平台拼出，成员只提供通过白名单的 SELECT。

**沙箱表（#238）。** 成员可以把一条 SELECT 的结果存成自己的沙箱表，之后在查询里接着用：
- 存储与命名：表在本租户数据湖里，每个成员一个 schema `sandbox_<成员 ID 去掉横线>`（`workbench-engine.ts` 的 `sandboxSchema`；UUID 的横线不能出现在不加引号的标识符里）。表名只允许 `[a-z][a-z0-9_]{0,62}`，同名表覆盖。平台库 `sandbox_tables` 登记 `(租户, 成员, 表名)` 唯一的一行：行数、保存时间与过期时间（保存后 7 天，`SANDBOX_TTL_DAYS`），覆盖时三者一起重置；过期清理后记下 `expired_at`。页面「我的沙箱表」只列自己的、未过期的表。重置数据湖（`lake:reset`）删掉 catalog 时一并删掉本租户的登记。
- 平台拼 DDL：`saveAsSandbox(actor, name, sql)` 与查询共用同一把每租户并发锁、同样的超时与取消（`workbench.ts` 的 `inWorkbench`），但用可写凭据挂载（`lakeSpecOf`）。在同一会话里先 `checkWorkbenchSql`（与查询同一份白名单），校验结果必须是一条 SELECT / WITH（EXPLAIN、DESCRIBE、SHOW、SUMMARIZE 不能存），再由 `saveSandboxTable` 拼出 `CREATE OR REPLACE TABLE lake."sandbox_<成员>"."<表名>" AS <校验过的 SQL>`：schema 由成员 ID 算出，表名先过正则再加引号，除此之外不拼进任何成员给的东西；执行前再用 `extractStatements` 确认拼出的仍是一条语句。schema 不存在时先 `CREATE SCHEMA IF NOT EXISTS`。所以写入只会落在成员自己的沙箱里，往 silver / gold / 别人的沙箱写一律做不到。
- 读：查询白名单的可读 schema 是参数，`runQuery` 加上成员自己的 `sandbox_<成员>`（`SHOW TABLES` 也列出它）；别人没分享的沙箱、其他租户（数据湖本来就隔离）都读不到。只读角色的 `ALTER DEFAULT PRIVILEGES` 覆盖 DuckLake 元数据表，沙箱表只是其中的几行，不需要另外授权。
- 审计：`sandbox.save` 的详情是 `{ name, sql, durationMs, rows }`，失败时加 `error`，成败都记，与登记同一事务写入。
- 过期（#239）：调度器每次检查时由 `sandbox.ts` 的 `enqueueDueSandboxExpiries` 为有到期沙箱表（`expires_at` 已到、`expired_at` 为空）的租户入队一个 `sandbox.expire`，参数是表在湖里的全名 `sandbox_<成员>.<表名>`；本租户已有排队或运行中的 `sandbox.expire` 时不再入队，锁住租户行再查一次，多个调度器同时检查也不重复；再查时 `FOR UPDATE SKIP LOCKED` 锁住到期的登记行，跳过成员正在同名保存的行。工作进程用可写凭据挂载，handler 只认 `^sandbox_[0-9a-f]{32}\.[a-z][a-z0-9_]{0,62}$`（防注入的最后一道），`DROP TABLE IF EXISTS` 后与 `gold.expire` 共用同一段过期 DuckLake 快照、清理旧文件（ADR-0020），已删的表跳过，重复执行不报错。成功后调度器调 `markSandboxExpired` 记 `expired_at`，只标记入队时已到期的登记；工作台列表不再列出，查询读不到（表已不在）。不触发服务库重建（沙箱表不进服务库）。
- 过期与同名保存：工作进程只按表名删表，不回查平台库，所以由保存一侧让开。`saveAsSandbox` 在湖里建表之前先 `lockForSave`：锁住这张表的登记行（持有到保存提交），本租户有排队或运行中的 `sandbox.expire` 参数里带这张表时拒绝保存（「这张沙箱表已到期、正在清理」），清理完再存或换个表名。先锁行再查任务：入队先拿到行锁时保存看得到这个任务；保存先拿到时入队跳过这一行，保存提交后过期时间已重置，不再到期；`markSandboxExpired` 的 UPDATE 等到保存提交后按重置的过期时间不再命中。
- 沙箱 schema 不进结果快照与服务库（ADR-0033 只收 `gold`），分析页只看 `snapshots` 登记的表；湖迁移的清单（`inventory`）照常带上它们，迁移不丢数据。

**分享（#240）。** 表的主人可以把一张沙箱表只读分享给本租户的成员，也可以撤销：
- 登记：平台库 `sandbox_shares(table_id → sandbox_tables, member_id → members, created_at)`，`(table_id, member_id)` 唯一。`shareSandboxTable(actor, name, email)` / `unshareSandboxTable` 只认成员自己、未过期的表（锁住登记行，与过期标记互斥），对方按邮箱在本租户里找：其他租户的成员、不存在的人、查看者（没有 `sandbox` 权限）、自己都 400；表已到期（还没清理）不能再分享。成功的分享 / 撤销与登记同一事务记审计 `sandbox.share` / `sandbox.unshare`，详情 `{ name, member }`；被拒的不记。页面「我的沙箱表」每行列出分享给了谁并可撤销，「分享给我的」列出主人、`sandbox_<主人>.<表名>` 与过期时间。
- 读：白名单的允许集合在 schema 级之外加上表级的 `shared: [{ schema, table }]`。`runQuery` 与 `saveAsSandbox` 每次都在并发锁的事务里现查分享给自己、表未过期（`expired_at` 为空）、主人仍是本租户成员的表，不缓存；被分享人降为查看者时连工作台都进不了（403），被移出租户时分享随成员行级联删除。`SHOW TABLES` 一并列出分享来的表。引用别的 `sandbox_*` schema 里没分享的表时，表在与不在都报「表 … 不存在或没有权限」，不泄露别人有哪些表。
- 写：被分享人只能读。查询本来就只放行只读语句、用只读凭据挂载；`saveAsSandbox` 的目标 schema 永远由当前成员 ID 算出，同名另存只会存进自己的沙箱，盖不到主人的表。
- 过期：`markSandboxExpired` 标记过期时同一事务删掉这些表的分享，主人之后同名再保存是一张新表，不沿用旧分享。
- 外部系统：`/api/v1/*` 没有通往沙箱的路径，服务库只收 `gold` 快照（ADR-0033），分享与否都一样。

**目录树（#241）。** 页面左侧按 标准层 silver / 结果层 gold / 我的沙箱 / 分享给我的 列出成员此刻能读的表，每张表下列字段与类型：
- 来源：`workbench.ts` 的 `listCatalog(actor)` 用查询同一套只读凭据挂载，`workbench-engine.ts` 的 `listReadableTables` 查 `duckdb_tables()` join `duckdb_columns()`，限定 `database_name = 'lake'`，schema / 表的过滤条件与 `checkWorkbenchSql` 共用（silver、gold、自己的沙箱 schema、此刻分享给自己的表），所以 `bronze_*`、`stage`、元数据库、别人没分享的沙箱都不出现。这条 SQL 由平台写，不经成员的白名单。
- 行数用 `duckdb_tables().estimated_size`（DuckLake 登记的行数统计），不 `count(*)`；位置给两样：插进 SQL 的引用 `lake.<schema>."<表>"`（表名总加引号，结果层表名带 UUID 的横线），以及数据文件的目录 `<存储前缀><schema>/<表>/`（DuckLake 的默认布局；小表内联在 catalog 里时目录下没有文件）。
- 点表名在 SQL 框的光标处插入引用（客户端 `setRangeText`），展开看字段。
- 每次打开页面（含提交后的重新加载）挂载一次，不拿并发锁、不记审计：不执行成员写的 SQL，与运行中的查询互不阻塞。读取出错时目录处显示原因，页面其余部分照常。

**原始层视图（#242）。** 决定：原始层对所有有 `sandbox` 权限的角色（分析师、数据工程师、管理员）开放，前提是只给哈希视图，不给明文；`lake.bronze_*`、`bronze_*_keys`、`bronze_*_mirror` 照旧拒绝。
- 形状：每个已登记的数据源在会话里是一个内存 catalog（`ATTACH ':memory:' AS "<数据源名>"`），每张表一个视图，按 `crm.customers`、`"客户 库".customers` 或 `crm.main.customers` 读（catalog 名不区分大小写）。视图是回放后的当前状态（`sync-engine.ts` 的 `currentStateSql` / `currentStateOf`，只给 SELECT 文本）：有主键的表取 `<schema>_keys` 里每个主键最新的一版非删除记录（主键列取自 `_keys` 表的列去掉 `_hash`，存在与否以主键状态为准，与 `ensureMirror` 由主键状态接续一样），没有主键的表取 `<schema>_mirror` 的整行（重复行各一行）；都不含 `_op` / `_batch` / `_commit_ts` / `_synced_at` 与整行哈希。原始层的变更历史不开放。
- 哈希：与源视图预览同一套规则（`source-view-engine.ts` 的 `createMaskedViews`，ADR-0022）：采集时像敏感信息的列（列统计里列名或取值像邮箱、手机号，`looksSensitive`）与列名像敏感信息的列换成 `sha256(盐 ‖ 取值)`，盐是本租户的 `tenantPiiSalt`，同一个原值在源视图预览与这里的哈希一样（标准层先规范化再哈希，不一定相同）。只给同步范围内、采集过的表建视图：没采集过的表不知道哪些列取值敏感。
- 盐不写进视图定义：过滤条件下推时 `EXPLAIN` 的计划会展开视图的表达式，字面量的盐会原样出现。盐放在默认库 `memory` 的一张表 `memory.main._pii_salt` 里，视图用标量子查询读它；成员的 SQL 只能引用 `lake` 与原始层 catalog，读不到它。执行出错的原因先抹掉凭据再把盐换成 `***`。
- 引用原始层视图的 `EXPLAIN ANALYZE` 拒绝：DuckDB 1.5.5 把连接下推到表扫描的动态过滤条件（如 `phone<=13900000049`）打印在执行计划里，有主键的视图要与 `_keys` 半连接，优化器换边时会带出主键原值。普通 `EXPLAIN` 不执行查询，计划里只有视图定义里的表达式，照常放行。
- 白名单：`checkWorkbenchSql` 的允许集合加上本次挂上的 catalog 名（`raw`）：`<数据源名>.<表>`（解析成 schema）或 `<数据源名>.main.<表>` 放行，原始层 catalog 里的 `information_schema` 等别的 schema 拒绝。`SHOW TABLES` 仍只列 `lake` 里能读的表，原始层视图看目录树。
- 名字：每次查询（`runQuery`、`saveAsSandbox`）与每次打开目录树都按此刻 `sources.name` 现建，数据源改名后新名字可查、旧名字不行。不写 catalog 的 `<名>.<表>` 会先按 `lake` 里的 schema 解析，重名就会读到 `lake` 里的表，所以与保留名（`lake`、`stage`、`memory`、`system`、`temp`、`main`、`silver`、`gold`、`serving`、`information_schema`、`pg_catalog`）、保留前缀（`sandbox_`、`bronze_`、`__ducklake_metadata_`）、此刻 `lake` 里已有的 schema 冲突的数据源，以及与另一个数据源只差大小写的，都不挂载（`workbench-engine.ts` 的 `rawNameConflict`），目录树「原始层」一节在该数据源下给出原因。一个数据源建视图出错时只跳过它（目录里给出抹掉凭据与盐的原因），别的数据源与标准层的查询照常。
- 视图建在内存 catalog 里，不进数据湖（查询是只读挂载，保存沙箱表时也只写成员自己的 schema）；会话关闭即消失。存沙箱表时可以读原始层视图，存下的是哈希。
- 目录树：`listCatalog` 同样挂上原始层，`listRawTables` 查 `duckdb_columns()` 列出各数据源的视图与字段，引用是 `"<数据源名>"."<表>"`；不给行数与位置（视图没有统计，数据文件是变更历史）。

## 已接受的取舍

- 白名单漏掉的读法（DuckDB 新增的读配置标量函数）仍受锁定配置与只读凭据的隔离兜底（ADR-0008）；只读凭据挡写不挡读，读得到的仍是本租户的全部 catalog（含加密密钥）与存储前缀，读的范围靠白名单。
- 只读角色与只读账号的密码、密钥与读写凭据一样明文存在 `tenant_lakes`（ADR-0008 的取舍）。
- 建只读角色、只读账号不单独记审计（读写账号记 `tenant.s3_account_created`）：它们只能读本租户已经能读的东西，补建发生在哪次查询看 `workbench.query` 即可。
- 数据湖从本地目录迁往对象存储时不建只读账号，切换后第一次工作台查询再补建；迁移期间工作台仍按迁移前的前缀挂载。
- 一次查询占住一个平台 PG 连接（advisory lock 的事务）最长 60 秒。
- 能读 silver / gold 的全部列，包括敏感字段的哈希；哈希不是明文（ADR-0005）。
- 结果不导出、不缓存（响应 `Cache-Control: no-store`），刷新页面就没了；要留下来就存成沙箱表。
- 存沙箱表用可写凭据，挡写入的是白名单与平台拼的 DDL，不是凭据；凭据层面一个成员能写整个湖。拆出每个成员的写角色要改 DuckLake 的 catalog 权限模型，不值得。
- 到期到清理之间（最长一个调度检查周期，再加任务排队）表仍可读、仍列在页面上。
- 到期表在清理完之前不能同名保存（最长一个调度周期加排队），成员要等一会或换个表名。
- 保存持有登记行的锁最长 60 秒：期间这张表不会入队过期，`markSandboxExpired` 等它提交。
- 过期清理不记审计：任务本身就是记录，与快照过期一致。
- 分享按表名记在登记行上：主人同名覆盖（未过期时同一行）后，被分享人读到的是新内容，分享不重新确认。
- 被分享人降为查看者再恢复角色后，之前的分享照样生效（读时按当前角色判断，降级时不删分享）；主人被降为查看者时分享出去的表仍可读，直到过期。
- 读分享来的表到期到清理之间仍可读，与主人自己一致；只是不能再分享。
- 只读分享挡不住复制：被分享人可以把 `SELECT * FROM` 分享来的表存进自己的沙箱再分享出去，撤销分享收不回已经复制走的数据。数据始终留在本租户内、照样 7 天过期，每一步都有 `sandbox.save` / `sandbox.share` 审计可查。
- 平台库登记在湖里建表之后、同一 PG 事务里写入；登记失败时湖里留下一张没登记的表，下次同名保存会覆盖它。
- `EXPLAIN ANALYZE` 会真的执行查询，照样受超时约束。
- 目录树的行数是估计值：合并、删除之后可能与 `count(*)` 不一致。
- 目录树的数据目录按当前存储前缀拼出，不读 DuckLake 元数据里每个文件的实际路径；湖迁移换过前缀后，老文件的实际位置以迁移记录为准。
- 每次打开工作台都多挂载一次数据湖（只读、只查元数据），不受每租户一个查询的限制。
- 原始层视图每次查询都按主键窗口回放整张原始层表，大表的查询比读 silver 慢；照样受 60 秒超时约束。
- 每次查询与打开目录树都现查数据源与列统计、现建视图，多几次平台库查询与 DuckDB 绑定。
- 敏感列的判定只用最近一次采集：采集之后才出现敏感取值的列在下次采集前不哈希（列名像敏感信息的列不受影响），与源视图预览相同。
- 移出同步范围或还没采集的表不出现在原始层视图里，即使原始层里还有它的数据。
- 与保留名冲突的数据源要改名才能查原始层；数据湖里将来新增的固定 schema 若与某个数据源同名，那个数据源随之不再挂载。
