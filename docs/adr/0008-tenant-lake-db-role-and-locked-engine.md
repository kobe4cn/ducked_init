# 租户数据湖的隔离靠独占的数据库角色、存储服务上的租户账号与锁定配置的 DuckDB，而不是只靠挂载哪个 catalog

ADR-0001 要求每个任务只挂载本租户的数据。实测发现只“挂载本租户的 catalog”并不够：DuckLake 把 catalog 所在的 PostgreSQL 以内部库（`__ducklake_metadata_<别名>`）挂进 DuckDB，若用平台 PG 的连接串挂载，任务里的 SQL 能经它读到整个平台库，包括其他租户的 catalog 与 `platform` schema 里的会话、成员等元数据；DuckDB 本身也能直接读写任意路径的文件。

因此每个租户在开通时得到：
- 存储前缀：`<PLATFORM_LAKE_URI>/tenants/<租户 ID>/`（开通时的根；平台切换存储后经「迁移存储」改到新根下的同一相对位置）。
- 平台 PG 中独占的 catalog schema 与数据库角色（同名 `lake_<租户 ID>`）。schema 归平台所有，只向该角色授予 USAGE 与 CREATE；其他租户的角色连表名都看不到，也无权访问 `platform` schema。
- 存储前缀在对象存储上时，存储服务上独占的账号 `lake-<租户 ID>`：平台账号经存储服务的 IAM API（SeaweedFS 内置在 S3 端口上）创建，绑定只允许读写、删除本租户前缀下的对象、只能以本租户前缀列目录的策略。与 catalog 用每租户 PG 角色一样，对象存储上的隔离由存储服务执行，不依赖工作进程内的检查。

工作进程只拿到这个角色与这个账号的凭据（经 IPC 传入，环境变量里没有平台 PG 连接串与对象存储的平台账号）。挂载后立即设置 `allowed_directories` 为本租户前缀、关闭 `enable_external_access`，再用 `lock_configuration` 锁住，此后不能再挂载其他库、读取其他路径或改回这些设置。

## 已接受的取舍

- 租户数据库角色的密码明文存在平台 PG（`tenant_lakes`），与 ADR-0007 中 TOTP 密钥同属“平台库访问权限即信任的根”。
- 租户对象存储账号的密钥同样明文存在 `tenant_lakes`，与数据库角色的密码同等对待。账号是长期有效的，没有按任务签发的临时凭据（STS `GetFederationToken` 带会话策略同样实测可用，但要给 SeaweedFS 另配 STS 签名密钥）；凭据获取收在 `app/.server/s3-accounts.ts` 一处，以后可以替换。
- 对象存储须支持 IAM API 与按前缀的用户策略。SeaweedFS 上账号必须由它自己保存在 filer 中（不能来自静态 `-s3.config` 文件），并开启 `-s3.iam.readOnly=false`；换用其他对象存储时要确认同等能力。
  在 SeaweedFS 4.47 上实测（`test/pipeline/pipeline.test.ts`）：不锁 DuckDB 配置、只用租户账号时，其他租户前缀的读 / 写 / 列目录、列整个桶都被前缀策略拒绝（AccessDenied）。
  `<本租户前缀>../<其他租户 ID>/…` 路径穿越（DuckDB 不规范化 S3 路径里的 `..`，`allowed_directories` 挡不住它）同样被存储服务拒绝，但靠的不是前缀策略：SeaweedFS 对路径里带 `..` 的请求一律返回 400（签名正确、用平台账号也一样），DuckDB 发出的这类请求则因签名对不上返回 403。换用其他对象存储时，要确认它规范化路径后再按策略判断，或同样拒绝 `..`。
- 平台 PG 需要 15 及以上版本（更早的版本默认允许所有角色在 `public` schema 建表，租户之间会多出一条互通的渠道），平台账号需要 CREATEROLE 权限。
- 迁移存储（`pnpm lake:migrate`，由调度器执行）期间，租户的对象存储账号策略同时放行新旧两个前缀——两者都属于本租户，不引入跨租户访问；此时该租户不派发任务。完成后策略只留新前缀（迁离对象存储时删除账号），失败时回到只放行旧前缀（为本地目录租户新建的账号删除）。收回失败时迁移照常完成，并在审计日志里提示。
- 切换 `data_path` 时平台账号要改租户角色所有的 `ducklake_metadata`：以 `SET LOCAL ROLE` 切到租户角色执行，平台账号不是其成员时在同一事务里临时 `GRANT`、改完即 `REVOKE`（需要 CREATEROLE，前面已要求）。
- 租户角色仍能查询 `pg_catalog`，看得到其他 schema 的名称（即其他租户的 ID），看不到其中的内容。

## Considered Options

- 用平台 PG 账号挂载各租户的 catalog，靠 `METADATA_SCHEMA` 区分：实现最省，但经内部库可读到全部租户，否决。
- 每个租户一个独立的 PG 数据库：隔离更强，但连接与迁移成本高，暂不采用。
