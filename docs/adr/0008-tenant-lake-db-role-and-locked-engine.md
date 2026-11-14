# 租户数据湖的隔离靠独占的数据库角色、对象存储上每租户独占的桶与租户账号、锁定配置的 DuckDB，而不是只靠挂载哪个 catalog

ADR-0001 要求每个任务只挂载本租户的数据。实测发现只“挂载本租户的 catalog”并不够：DuckLake 把 catalog 所在的 PostgreSQL 以内部库（`__ducklake_metadata_<别名>`）挂进 DuckDB，若用平台 PG 的连接串挂载，任务里的 SQL 能经它读到整个平台库，包括其他租户的 catalog 与 `platform` schema 里的会话、成员等元数据；DuckDB 本身也能直接读写任意路径的文件。

因此每个租户在开通时得到：
- 对象存储上独占的桶 `s3://lake-<租户 ID>/`：`data_path` 就是这个桶的根，建租户时创建（幂等，桶已存在也算成功）。租户 ID 是 PG `uuid`，小写 36 位，桶名共 41 位，符合 S3 桶命名规则，也与账号名 `lake-<租户 ID>` 一致。本地目录存储时仍是 `<PLATFORM_LAKE_URI>/tenants/<租户 ID>/` 独立目录（开通时的根；平台切换存储后经「迁移存储」改到新位置）。
- 平台 PG 中独占的 catalog schema 与数据库角色（同名 `lake_<租户 ID>`）。schema 归平台所有，只向该角色授予 USAGE 与 CREATE；其他租户的角色连表名都看不到，也无权访问 `platform` schema。
- 存储根在对象存储上时，存储服务上独占的账号 `lake-<租户 ID>`：平台账号经存储服务的 IAM API（SeaweedFS 内置在 S3 端口上）创建，绑定只作用于本租户桶的策略——对象权限 `arn:aws:s3:::lake-<租户 ID>/*`，`s3:ListBucket` 限 `arn:aws:s3:::lake-<租户 ID>`，**不带任何 Conditions**。隔离由桶边界执行，不再依赖网关评估 `s3:prefix` 条件（换用其他对象存储时也只需桶级别的账号隔离能力）。与 catalog 用每租户 PG 角色一样，对象存储上的隔离由存储服务执行，不依赖工作进程内的检查。

- 数据查询工作台用的一对只读凭据（ADR-0036）：只读数据库角色 `lake_<租户 ID>_ro`（catalog 的表只有 SELECT，不继承租户角色）与对象存储上的只读账号 `lake-<租户 ID>-ro`（本租户桶只有 GetObject 与 ListBucket，同样不带 Conditions）。改桶 / 改前缀、删除账号时与读写账号一起处理。

工作进程只拿到这个角色与这个账号的凭据（经 IPC 传入，环境变量里没有平台 PG 连接串与对象存储的平台账号）。挂载后立即设置 `allowed_directories` 为本租户桶（本地目录租户为目录根）、关闭 `enable_external_access`，再用 `lock_configuration` 锁住，此后不能再挂载其他库、读取其他路径或改回这些设置。

## 已接受的取舍

- 租户数据库角色的密码明文存在平台 PG（`tenant_lakes`），与 ADR-0007 中 TOTP 密钥同属“平台库访问权限即信任的根”。
- 租户对象存储账号的密钥同样明文存在 `tenant_lakes`，与数据库角色的密码同等对待。账号是长期有效的，没有按任务签发的临时凭据（STS `GetFederationToken` 带会话策略同样实测可用，但要给 SeaweedFS 另配 STS 签名密钥）；凭据获取收在 `app/.server/s3-accounts.ts` 一处，以后可以替换。
- 对象存储须支持 IAM API 与桶级别的用户策略。SeaweedFS 上账号必须由它自己保存在 filer 中（不能来自静态 `-s3.config` 文件），并开启 `-s3.iam.readOnly=false`；换用其他对象存储时要确认同等能力。本地（`db_script/docker-compose.yml`）与 CI（`.github/workflows/ci.yml`）固定同一 SeaweedFS 版本（4.50），升级时两处一起改。
  每租户一桶在 SeaweedFS 4.50 上实测有条件可行（`docs/test-plans/bucket-per-tenant-scale.md`，两后端各 1000 个桶）：跨租户读 / 写 / 列的隔离抽查 45 次全部 403、无一例放行；IAM 写入后网关重载生效在 1 ms 量级，写入期间存量租户读写没有被拒绝（#560/#569 的窗口在 4.50 未复现）。代价有二：每次 `PutUserPolicy` 整份重写 `policies.json`（1000 桶时约 524 KB），单租户建桶 p50 从 29.5 ms 涨到 177.5 ms；每个桶第一次写入约占 7 个卷（实测实例 64 MB/卷、满配 1274 个），照此推算每个桶都写入时约到第 180 个桶卷位耗尽（`No writable volumes`）——上线前必须调卷配置（卷大小、预分配卷数、磁盘或卷服务器），并按「桶数 × 每桶卷数」做容量规划。RustFS 1.0.5 不兼容 AWS IAM API（`unknown service 'iam' in credential scope`），账号只能走它自己的 mc 管理接口，换用它得另写一套账号适配，不在本方案的支持范围内。
  历史背景：本方案之前用「共享桶 + 策略里的 `s3:prefix` 条件」隔离。#560 发现 SeaweedFS 4.47 的 S3 网关每次 IAM 写都整份重载内存中的 IAM 配置，重载的毫秒级窗口内 ListBucket 的前缀条件失效，已有租户的凭据能列出其他租户前缀下的对象名（read / write 不受影响）；#569 在同款沙箱临时实例上对照压测（`CRM_TEST_IAM_STRESS=1`，8 路并发建删一次性账号）：4.47 上 3/3 次复现，4.50 上 10/10 次不再复现、把 IAM 配置臃肿到 #621 之前的规模后再压 3 次也不复现——窗口是 4.47 的缺陷，但前缀隔离整体仍依赖网关每次正确评估条件，同类缺陷再出现时租户之间只有这一层名单式防线，#663 因此换成每租户一桶、由桶边界执行隔离。
  每租户一桶后，只在共享桶里才有意义的两道防线随之退场：`<本租户前缀>../<其他租户 ID>/…` 路径穿越（DuckDB 不规范化 S3 路径里的 `..`）不再可能碰到别的租户——桶名是请求的第一段，key 里的 `..` 顶多落在本桶的命名空间（SeaweedFS 对带 `..` 的 key 仍一律返回 400）；策略里不再有 ListBucket 的前缀条件。DuckDB 的 `allowed_directories` 照旧保留。IAM 写入后要等网关重载才生效（#560）的既有约束不变。
  删账号必须先删策略：`DeleteUser` 只删身份文件、不清 `policies.json` 里该账号的内联策略，`DeleteUserPolicy` 对已不存在的账号只回 `NoSuchEntity`，「账号没了、策略还在」就成了 IAM API 删不掉的孤儿；SeaweedFS 每次 IAM 改动又整份重写这个文件，孤儿条目把它和 filer 元数据日志一起撑大（2026-11-10 实测攒到 8022 条、文件 6 MB，#621）。`app/.server/s3-accounts.ts` 删号时对已消失的账号也补删一次策略，存量和增量残留由 `scripts/prune-seaweed-iam-policies.ts` 兜底（随 `pnpm sandcastle:prune-metalog` 每轮清理）。
- 平台 PG 需要 15 及以上版本（更早的版本默认允许所有角色在 `public` schema 建表，租户之间会多出一条互通的渠道），平台账号需要 CREATEROLE 权限。
- 迁移存储（`pnpm lake:migrate`，由调度器执行）期间，租户的对象存储账号策略同时放行旧前缀（或旧桶）与目标桶——两者都属于本租户，不引入跨租户访问；此时该租户不派发任务。存量租户从共享桶的前缀迁到独占的桶同样走 `runLakeMigration`，不另写迁移流程：迁移前建好目标桶，迁完收回旧前缀的放行，并等网关真正拒绝旧凭据再报告成功。旧共享桶里已迁走租户的对象不会自动删除，回收另案处理。迁离对象存储时删除账号；失败时回到只放行旧前缀（为本地目录租户新建的账号删除）。收回失败时迁移照常完成，并在审计日志里提示。
- 切换 `data_path` 时平台账号要改租户角色所有的 `ducklake_metadata`，给只读角色授予元数据表的 SELECT 也要以表的所有者执行：都经 `lake.ts` 的 `asTenantRole` 以 `SET LOCAL ROLE` 切到租户角色，平台账号不能 SET 到它时在同一事务里临时 `GRANT`、改完即 `REVOKE`（需要 CREATEROLE，前面已要求）。PG 16 起 CREATEROLE 账号对自己建的角色只有 ADMIN 成员关系、没有 SET 选项（`pg_has_role(..., 'MEMBER')` 为真也切不过去），所以按 `'SET'` 判断，临时 `GRANT … WITH SET TRUE, INHERIT FALSE`，之后只 `REVOKE SET OPTION FOR`，ADMIN 保留。
- 租户角色仍能查询 `pg_catalog`，看得到其他 schema 的名称（即其他租户的 ID），看不到其中的内容。

## Considered Options

- 用平台 PG 账号挂载各租户的 catalog，靠 `METADATA_SCHEMA` 区分：实现最省，但经内部库可读到全部租户，否决。
- 每个租户一个独立的 PG 数据库：隔离更强，但连接与迁移成本高，暂不采用。
- 共享桶 + 策略里的 `s3:prefix` 条件：原方案，隔离依赖网关每次正确评估前缀条件，#560/#569 证明存在整份重载的失效窗口，被每租户一桶替换（#663）。
- 显式 Deny 其他租户的前缀：Deny 同样靠前缀条件判断，泄露的那一步它可能同样失效，否决（#663）。
