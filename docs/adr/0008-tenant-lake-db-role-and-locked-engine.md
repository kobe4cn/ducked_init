# 租户数据湖的隔离靠独占的数据库角色与锁定配置的 DuckDB，而不是只靠挂载哪个 catalog

ADR-0001 要求每个任务只挂载本租户的数据。实测发现只“挂载本租户的 catalog”并不够：DuckLake 把 catalog 所在的 PostgreSQL 以内部库（`__ducklake_metadata_<别名>`）挂进 DuckDB，若用平台 PG 的连接串挂载，任务里的 SQL 能经它读到整个平台库，包括其他租户的 catalog 与 `platform` schema 里的会话、成员等元数据；DuckDB 本身也能直接读写任意路径的文件。

因此每个租户在开通时得到：
- 存储前缀：`<PLATFORM_LAKE_URI>/tenants/<租户 ID>/`。
- 平台 PG 中独占的 catalog schema 与数据库角色（同名 `lake_<租户 ID>`）。schema 归平台所有，只向该角色授予 USAGE 与 CREATE；其他租户的角色连表名都看不到，也无权访问 `platform` schema。

工作进程只拿到这个角色的凭据（经 IPC 传入，环境变量里没有平台 PG 连接串）。挂载后立即设置 `allowed_directories` 为本租户前缀、关闭 `enable_external_access`，再用 `lock_configuration` 锁住，此后不能再挂载其他库、读取其他路径或改回这些设置。

## 已接受的取舍

- 租户数据库角色的密码明文存在平台 PG（`tenant_lakes`），与 ADR-0007 中 TOTP 密钥同属“平台库访问权限即信任的根”。
- 对象存储上的前缀隔离目前只靠 DuckDB 的 `allowed_directories`：工作进程拿到的是平台共用的 S3 密钥。改为按租户签发的受限凭据（如 STS / 前缀策略）是后续加固项。
- 平台 PG 需要 15 及以上版本（更早的版本默认允许所有角色在 `public` schema 建表，租户之间会多出一条互通的渠道），平台账号需要 CREATEROLE 权限。
- 租户角色仍能查询 `pg_catalog`，看得到其他 schema 的名称（即其他租户的 ID），看不到其中的内容。

## Considered Options

- 用平台 PG 账号挂载各租户的 catalog，靠 `METADATA_SCHEMA` 区分：实现最省，但经内部库可读到全部租户，否决。
- 每个租户一个独立的 PG 数据库：隔离更强，但连接与迁移成本高，暂不采用。
