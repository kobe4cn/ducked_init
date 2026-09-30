# CRM 数据分析平台
## 主要功能演进
### 平台（多租户，开发中）

`app/` 是多租户 CRM 数据分析平台的 React Router 应用（术语见 `CONTEXT.md`，架构决策见 `docs/adr/`）。平台元数据存放在平台 PostgreSQL 的 `platform` schema：

```bash
# .env 里加上平台元数据库（建议与演示数据分开建库）
PLATFORM_DATABASE_URL=postgres://crm:crm@localhost:5432/crm_platform
# 登录邮件里链接使用的站点地址：生产环境必填，开发环境未配置时取请求地址
# APP_ORIGIN=https://crm.example.com
# 可选：Magic Link 申请限流（同一邮箱每个窗口内的次数），默认 15 分钟 5 次
# MAGIC_LINK_RATE_LIMIT=5
# MAGIC_LINK_RATE_WINDOW_MINUTES=15
# 可选：运营后台 /ops 的 IP 白名单（逗号分隔的 CIDR）；客户端地址取 OPS_CLIENT_IP_HEADER（默认 X-Forwarded-For）的最后一项
# OPS_ALLOWED_CIDRS=10.0.0.0/8,192.168.0.0/16
# OPS_CLIENT_IP_HEADER=x-forwarded-for
# 租户数据湖的根：本地目录或对象存储（s3://bucket/prefix，平台账号取上面的 S3_*），默认 ./data/platform-lake
# PLATFORM_LAKE_URI=s3://crm-lake/platform
# 调度器所在机器同时运行的工作进程上限，默认 4
# PLATFORM_MAX_WORKERS=4
# 凭据信封加密的主密钥（登记数据源必需）：openssl rand -base64 32，平台与调度器用同一个值
PLATFORM_MASTER_KEY=
# 可选：本机 DuckDB 文件类数据源的目录（每个租户只能用 <目录>/<租户 ID>/ 下的文件）
# PLATFORM_SOURCE_FILES_DIR=./data/source-files

pnpm db:migrate                                   # 建表 / 升级
pnpm tenant:create --slug acme --name 示例商贸 --admin-email admin@acme.com  # 开通租户（带默认空间）与首个管理员
pnpm operator:create --email ops@example.com      # 新增运营者（只能用这条命令）
pnpm operator:reset-totp --email ops@example.com  # 运营者丢失认证器时重置 TOTP
pnpm dispatcher                                   # 常驻调度器：派发任务队列（另开一个终端）
pnpm task:enqueue --tenant acme --kind demo.seed --params '{"customers":1000}'  # 为租户生成演示数据
pnpm lake:migrate --all --to s3://crm-lake/platform  # 平台切换存储后，把已开通租户的数据湖搬到新的根下（见下文）
pnpm lake:reset --tenant acme                     # 开发 / 演示：清空租户的数据湖重来（见下文）
pnpm dev                                          # 打开 /login，用管理员邮箱申请 Magic Link
```

登录、邀请等邮件经 [Resend](https://resend.com) 发送：在 `.env` 配置 `RESEND_API_KEY`，发件人用 `MAIL_FROM`（须是 Resend 上已验证的域名；不填时用 `onboarding@resend.dev`，只能发给 Resend 账号本人的邮箱）。开发环境下邮件（含链接）同时输出到 `pnpm dev` 的控制台；未配置 `RESEND_API_KEY` 时只输出到控制台、不真正发信（也可用 `MAILER=console` 强制如此）。生产构建下不输出到控制台。发信实现在 `app/.server/mailer.ts`，接入其他邮件服务时在那里新增一个实现。Magic Link 15 分钟内有效、只能使用一次，重新申请后旧链接作废；同一邮箱申请过于频繁会被限流（HTTP 429）。未登记的邮箱收不到链接，平台不开放注册；签发与发信在后台进行，已登记与未登记邮箱的答复内容与响应时间一致。

界面使用 [shadcn/ui](https://ui.shadcn.com)（Radix + Tailwind CSS 4，`nova` 预设），组件源码在 `app/components/ui/`，配置见 `components.json`。新增组件：`pnpm dlx shadcn@latest add <组件名>`；`app/components/ui/` 下是生成的代码，保持 shadcn 原样以便升级，业务样式写在页面里。

#### 本地登录（获取 Magic Link）

1. `pnpm dev`，浏览器打开 `http://localhost:5173/login`，输入已登记的邮箱，点“发送登录链接”。
2. 到邮箱里收信（配置了 `RESEND_API_KEY` 时），或回到运行 `pnpm dev` 的终端，找到下面这段输出，复制其中的链接到浏览器打开，点“登录”：
   ```
   ======== 邮件（开发环境，输出到控制台）========
   收件人：admin@acme.com
   ...
   示例商贸：http://localhost:5173/auth/verify?token=xxxxxxxx
   ```
3. 登录后首页显示当前租户、空间、角色，以及该角色可做与不可做的操作（不可用的注明需要哪个角色）。

注意：

- 终端里有多条链接时用**最后一条**：重新申请后旧链接作废；链接 15 分钟内有效、只能用一次。
- 同一邮箱每 15 分钟最多申请 5 次，本地调试可在 `.env` 调大 `MAGIC_LINK_RATE_LIMIT`。
- 未登记的邮箱不会输出链接（页面答复与已登记邮箱相同）。要新增可登录的邮箱，由租户管理员在“成员”页邀请（邀请邮件同样输出到控制台）。
- 同一邮箱隶属多个租户时，一封邮件里每个租户各有一条链接，选哪条就进入哪个租户。
- `pnpm start`（生产构建）下须配置 `RESEND_API_KEY` 与 `APP_ORIGIN`；未配置发信时不允许把链接输出到日志，会直接报错，确需如此时设置 `MAILER=console`。

#### 成员与权限

- 管理员在 `/members` 邀请成员（指定角色：管理员、数据工程师、分析师、查看者）、修改角色、移除成员。角色修改对已登录的会话立即生效；被移除成员的会话立即失效。租户至少保留一名管理员。
- 权限矩阵在 `app/.server/access.ts`，每个 loader/action 入口用 `requirePermission` 执行；无权限返回 403 并说明需要的角色。
- 管理员在 `/audit` 查看审计日志：开通租户、邀请、修改角色、移除成员。

#### 运营后台

运营者是独立于成员的身份（ADR-0007）：独立的 `operators` 表、登录入口 `/ops/login`、会话 cookie `crm_ops_session`（8 小时）。成员会话不能访问 `/ops`，运营者会话也不能访问成员页面。

- 运营者只能在服务器上用 `pnpm operator:create --email ...` 创建；后台没有新增或停用运营者的入口。
- 登录：`/ops/login` 申请 Magic Link（邮件同样输出到控制台，链接为 `/ops/auth/verify?token=...`）→ 输入 TOTP 验证码。首次登录时绑定 TOTP：页面展示二维码（服务端生成，用认证器 App 扫描）与可手动输入的密钥，确认一次验证码即完成绑定。同一个验证码只能用一次；连续输错 5 次需重新申请登录链接。
- 运营者丢失认证器时，在服务器上执行 `pnpm operator:reset-totp --email ...`：清除其 TOTP 绑定，作废其全部会话（含待验证的）与未使用的登录链接，并在 `/ops/audit` 记一条“重置 TOTP”。该运营者下次登录时重新走首次绑定。**重置后、本人完成绑定前，谁拿到下一封登录链接谁就能完成绑定**（ADR-0007），执行后应尽快通知运营者本人登录并完成绑定。
- `/ops` 列出租户（名称、标识、开通时间、状态、成员数、管理员邮箱）并开通租户；进入租户可改名、指定管理员（提升已有成员或新增管理员邮箱，用于管理员邮箱失效时的恢复；停用期间不可指定）、停用与恢复。运营者看不到成员名单与业务数据，也没有进入租户的入口。
- 停用租户必须填写原因：该租户成员的会话与未使用的登录链接立即作废，之后申请登录也不会签发该租户的链接（页面答复不变；同一邮箱属于其他正常租户时，邮件里只有那些租户的链接）。数据完整保留，运行中的任务被终止、排队的任务暂停派发；恢复同样必须填写原因，恢复后成员重新登录即可。外部系统接口的停用处理随对应切片补充。
- 运营者对租户的操作写入该租户的审计日志，操作者显示为“运营者 ops@…”；运营者登录、绑定 TOTP、重置 TOTP、新增运营者等平台级事件不属于任何租户，只在 `/ops/audit` 可见。
- 租户页展示数据湖（存储前缀、catalog schema、是否已初始化；初始化失败时可重试）与配额：单任务内存上限（MiB）、线程数、并发任务数，修改记入租户的审计日志。
- 配置 `OPS_ALLOWED_CIDRS` 后只允许白名单内的地址访问 `/ops`。客户端地址取自反向代理写入的请求头，必须部署在会追加或覆盖该请求头的反向代理之后，否则可被伪造。取最后一项只适用于一层反向代理；多层代理（如 CDN + 负载均衡）时应让最内层代理把真实地址写入单独的请求头（如 `X-Real-IP`），并把 `OPS_CLIENT_IP_HEADER` 指向它。

#### 数据湖与任务

- 开通租户时自动建好数据湖（ADR-0001、0002、0008）：存储前缀 `<PLATFORM_LAKE_URI>/tenants/<租户 ID>/`，平台 PG 中独占的 catalog schema 与数据库角色 `lake_<租户 ID>`（平台 PG 需要 15 及以上版本，平台账号需要 CREATEROLE 权限）。本功能上线前开通的租户没有数据湖，由运营者在租户页点“初始化数据湖”补建。
- 数据湖根在对象存储上时，开通租户还会经存储服务的 IAM API（SeaweedFS 内置在 S3 端口上）建好租户账号 `lake-<租户 ID>`，绑定只允许读写、删除、列出本租户前缀的策略；工作进程只拿到这个账号的密钥，拿不到 `S3_*` 平台账号。建账号失败时租户照常开通、不派发任务，运营者在租户页点“初始化数据湖”重试；早于此功能开通、还没有账号的租户同样由此补建，补建记入审计日志。本地目录模式不建账号。
- SeaweedFS 部署要求：账号由 SeaweedFS 自己保存在 filer 中（**不能**用静态 `-s3.config` 文件，否则 IAM API 无法写入），开启 `-s3.iam.readOnly=false`，平台账号经 `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 注入（见 `db_script/docker-compose.yml`，与 `.env` 里的 `S3_ACCESS_KEY` / `S3_SECRET_KEY` 一致）。原先用 `-s3.config` 启动的实例改为上述方式重启即可，存储桶与数据不受影响。
- 任务队列在平台 PG（`platform.tasks`）。`pnpm dispatcher` 领取任务，每个任务启动一个独立的工作进程：只拿到本租户角色的凭据，挂载后锁定 DuckDB 配置（只能访问本租户前缀、不能再挂载其他库），内存与线程按租户配额限制。
- 调度按租户公平：先派发运行中任务最少、再派发最久没被派发过的租户，同一租户内先进先出；租户运行中的任务达到并发上限时其余排队。停用租户时其运行中的任务被终止，排队的任务留在队列里、恢复后继续；停用期间不能提交任务。调度器失联超过 1 分钟的任务判为失败，调度器退出时它启动的工作进程随之退出。任务的错误信息对租户全体成员可见，其中的凭据会被抹掉。
- 租户的存储前缀在开通时写入平台库，修改 `PLATFORM_LAKE_URI` 只影响之后开通的租户；已开通租户的数据用 `pnpm lake:migrate` 搬过去（见下节）。
- 任务类型在 `app/.server/pipeline/handlers.ts`：`lake.inventory`（盘点本租户数据湖的表与行数）、`demo.seed`（造数夹具，确定性生成消费者与订单）、`source.profile`（采集数据源，见下节）。成员在 `/tasks` 查看本租户的任务与状态，成功的任务可展开查看结果（各表行数与运行时生效的内存、线程）。
- 开发 / 演示时清空某个租户的数据湖重来：`pnpm lake:reset --tenant acme`。命令先打印租户名称、catalog 与存储前缀，要求再输入一次租户标识确认（脚本里用 `--yes` 跳过）；然后删除并重建 catalog schema（租户的数据库角色、密码与 S3 账号不变）、删除存储前缀下的全部文件（本地目录与对象存储都支持）、重新初始化，并在租户审计日志记一条“重置数据湖”。该租户有运行中的任务时拒绝执行，迁移存储中时也拒绝；重置期间数据湖标为未初始化、不派发该租户的任务，排队的任务在重置完成后照常执行。中途出错时数据湖停在未初始化，重新执行同一条命令即可。`NODE_ENV=production` 时拒绝执行，除非加 `--force`；生产环境清除租户数据应走删除请求与租户退出，运营后台不提供重置按钮（ADR-0007）。

#### 数据源

- 数据工程师与管理员在 `/sources` 登记数据源（分析师只读，查看者不可见）：PostgreSQL、MySQL、MongoDB（库里每个集合是一张表，嵌套字段展开成列）、对象存储上的 Parquet / CSV / JSON 文件（前缀下每个子目录或顶层文件是一张表）、DuckDB 文件（对象存储上，或本机 `PLATFORM_SOURCE_FILES_DIR/<租户 ID>/` 下）。
- 登记与修改前平台连接数据源并探测账号的写权限，**可写即拒绝**并列出可写的对象：PostgreSQL 查超级用户、建库 / 建 schema 权限与各表的 INSERT / UPDATE / DELETE / TRUNCATE；MySQL 查各级写类权限；MongoDB 用 `connectionStatus` 查账号在各库、各集合上的写类操作（没有开启访问控制的服务一律视为可写）；对象存储发起一次分段上传并立即取消（不写入任何数据）。本机 DuckDB 文件没有账号，只读挂载。采集任务运行时再探测一次，登记后才被授予写权限的账号同样被拒绝。
- 凭据（密码、对象存储密钥）用租户数据密钥加密保存（AES-256-GCM），数据密钥用 `PLATFORM_MASTER_KEY` 包裹后存在 `platform.tenant_keys`；页面与接口都不回显，修改时留空表示沿用，连接目标变了时须重新填写。任务派发时由调度器解密、经 IPC 交给工作进程，以临时 secret 注入内存中的 DuckDB，不落盘。
- 源端以只读方式挂载后锁定 DuckDB 配置（不能再挂载其他库、读其他路径）；PostgreSQL 的只读挂载把一切语句放在只读事务里。发往源端的只有平台写死的只读查询，成员与模型都不能向源端发送 SQL。
- 登记后自动提交采集任务（`source.profile`）：每张表的行数，基于前 10 万行样本的列统计（类型、空值率、基数、数值与时间列的取值范围；文本列只给长度范围与格式特征，不给取值），以及水位线候选（按命名是更新时间的时间列、由自增序列生成的主键）；没有主键的表另给出业务主键候选（样本中非空、取值唯一的列）。成员从候选中确认水位线与业务主键；没有候选的表需要全量比对，其中行数达到 `SOURCE_LARGE_TABLE_ROWS`（默认 1000 万）的大表默认每天同步一次（ADR-0010）。全量比对尚未上线（#7），这类表目前不会进湖；数据源页逐表标出是否已进湖，没进湖的说明原因（待确认水位线、全量比对尚未上线、同步失败、账号没有读权限等）。
- 已确认水位线的表每小时增量同步一次（`source.sync`，周期由 `SOURCE_SYNC_INTERVAL_MINUTES` 设定，由常驻调度器入队），首次同步为全量；数据工程师也可以在数据源页手动触发。变化作为变更批次（操作类型、源端提交时间、批次号）追加到本租户数据湖的原始层 `bronze_<数据源 ID>` schema，批次日志 `_batches` 随之写入；PostgreSQL 与 MySQL 的水位线条件在源端执行。从水位线往回多读一个回看窗口（`SOURCE_SYNC_LOOKBACK_MINUTES` / `SOURCE_SYNC_LOOKBACK_IDS`），补上长事务晚提交的行；有主键（或成员确认了业务主键）的表每天（`SOURCE_RECONCILE_HOURS`）再比对一次主键全集，源端删除的主键记为删除、漏掉的行补为新增。数据源页列出每张表的同步历史（批次、方式、行数、耗时、水位线）（ADR-0012）。

#### 平台切换存储（本地目录 ⇄ 对象存储、换桶）

已开通租户的数据要**搬过去**，而不是清空重建。DuckLake catalog 里 schema、表与数据文件的路径都相对于 `data_path`，迁移时复制存储前缀下的全部文件，再在一个事务里把 catalog（`ducklake_metadata`）与 `tenant_lakes` 的 `data_path` 一起切到新位置。

1. 修改 `.env` 的 `PLATFORM_LAKE_URI` 为新的数据湖根（对象存储时同时配好 `S3_*` 平台账号，SeaweedFS 按上文开启 IAM），重启平台与调度器：之后开通的租户直接落在新位置。
2. 申请迁移已开通的租户（新位置为 `<新根>/tenants/<租户 ID>/`）：
   ```bash
   pnpm lake:migrate --tenant acme --to s3://crm-lake/platform   # 单个租户
   pnpm lake:migrate --all --to s3://crm-lake/platform           # 所有不在新根下的租户；已在的跳过，可以重复执行
   ```
   命令只申请迁移并把数据湖标记为「迁移中」，由 `pnpm dispatcher` 执行（文件多时耗时长）。迁移中不派发该租户的任务，成员仍可提交、任务排队；调度器等该租户运行中的任务结束后才开始复制。其他租户不受影响。
3. 调度器依次：复制文件（用平台账号；迁往对象存储时先确保租户有 S3 账号，前缀策略在迁移期间同时覆盖新旧前缀）→ 核对新位置的文件清单与大小 → 一个事务里切换两处 `data_path` → 用新位置盘点各表行数，与迁移前比对（不一致时切回旧位置并记为失败）→ 收回租户 S3 账号对旧前缀的访问、取消「迁移中」。之后工作进程的 `allowed_directories` 与 S3 账号都只能访问新前缀。
4. 在运营后台的租户页查看「迁移存储」状态；开始、完成、失败都记入该租户的审计日志。
   - **完成**：结果里给出旧位置。旧位置的文件**不会自动删除**，确认租户数据正常后手动清理（如 `rm -rf <旧前缀>`，或在对象存储上删除该前缀）。
   - **失败**：数据湖仍指向旧位置、数据完整，排队的任务照常执行。排除原因后重新执行同一条命令即可重试，新位置上残留的文件会被覆盖。调度器在迁移途中退出时，其他调度器会在 1 分钟后接手、从头再做。
5. 迁移只在当前配置的一个对象存储服务内进行（换桶、换前缀）。要换对象存储服务，先迁到本地目录，改好 `S3_*` 后再迁到新服务上。

`pnpm test` 运行 HTTP 接缝测试（进程内启动 React Router 服务端）与租户流水线接缝测试（直接调用领域函数与调度器，用 `demo.seed` 造数），背后是测试用平台 PG（默认 `postgres://crm:crm@localhost:5432/crm_platform_test`，可用 `TEST_PLATFORM_DATABASE_URL` 覆盖；库不存在会自动创建，每个用例前清表并删除租户的 catalog schema 与角色）。租户数据湖放在系统临时目录下的 `crm_platform_test_lake`。设置 `TEST_S3_LAKE_URI=s3://crm-lake/platform-test` 后，租户隔离测试会在对象存储上再跑一遍，平台账号取 `S3_*`，默认用本地 SeaweedFS 的开发账号 `crm` / `crm-secret`（SeaweedFS 须按上面的要求开启 IAM）；租户账号由测试开通租户时创建，每个用例前删除。CI 会起 SeaweedFS 跑这组测试。数据源测试在同一个 PG 上建源库 `crm_source_test` 与两个测试账号（`TEST_SOURCE_DATABASE_URL` 可覆盖）；设置 `TEST_MYSQL_URL`（如 `mysql://root:密码@127.0.0.1:3306/crm_source_test`）后再测 MySQL 数据源，设置 `TEST_MONGO_URL`（如 `mongodb://crm:crm-secret@localhost:27017/crm_source_test?authSource=admin`）后再测 MongoDB 数据源，CI 会起 MySQL 与 MongoDB 跑。对象存储上的测试数据不会自动清理。首次运行需要联网下载 DuckDB 的 ducklake、postgres 扩展（测 MongoDB 时还有社区扩展 mongo）。

---
## 技术栈

- **Framework:** [React Router](https://reactrouter.com/) v8 with SSR
- **Language:** TypeScript 7.x
- **Database:** PostgreSQL 17 via [Drizzle ORM](https://orm.drizzle.team/) + DuckDB 1.5
- **Styling:** Tailwind CSS 4 + [shadcn/ui](https://ui.shadcn.com/)
- **Testing:** [Vitest](https://vitest.dev/)
- **Build:** [Vite](https://vite.dev/) 7
- **Real-time:** [Ably](https://ably.com/) for live presence


---

## 基于 duckdb 数据分析能力的测试样例(供参考)
### crm-lakehouse —— DuckDB + TypeScript 千万会员 / 亿级订单用户分析实战

用 **DuckDB + TypeScript** 搭一个 CRM 数据分析体系：多数据源入湖（PostgreSQL、对象存储、HTTP 接口、JSON / CSV 文件），
建客户 360 宽表，做复购、同期群、RFM、CLV、流失预警、忠诚度、营销归因、购物篮、向量推荐、实时指标，
并用 DuckLake 做带快照的湖仓表。

- 唯一的运行时依赖：`@duckdb/node-api`
- 数据规模可调：`SCALE=1` 为 **1000 万会员 / 1.31 亿订单 / 2.75 亿订单明细 / 1.01 亿埋点 / 5000 万营销触达**
- 所有数据由脚本确定性生成，同样的 `SCALE` 每次结果一致，可重复压测

---

#### 1. 准备环境

| 组件 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 20.6 | 用到 `node --env-file` |
| PostgreSQL | 13 及以上 | 你已有的本地容器即可，需要从宿主机能连上（端口映射） |
| 对象存储 | 任意 S3 兼容 | 推荐 SeaweedFS，`docker-compose.yml` 已配好；也可 RustFS / Garage / 云上 S3 / 阿里云 OSS |
| Docker | 可选 | 用来启动对象存储 |

DuckDB 扩展（`httpfs`、`postgres`、`ducklake`）首次使用时会从 `extensions.duckdb.org` 自动下载，不需要 npm 安装。
内网环境见第 7 节“离线安装扩展”。

#### 1.1 PostgreSQL（已有容器）

在你的 PG 里建库和用户（名字可以随意，和 `.env` 对应即可）：

```sql
CREATE USER crm WITH PASSWORD 'crm';
CREATE DATABASE crm OWNER crm;
```

亿级数据写入前，建议临时调大这些参数（开发 / 压测环境，改完重启容器）：

```
shared_buffers = 2GB
max_wal_size = 16GB
checkpoint_timeout = 30min
synchronous_commit = off
maintenance_work_mem = 2GB
```

容器启动时可以直接加在命令后面：`postgres -c max_wal_size=16GB -c synchronous_commit=off …`（`docker-compose.yml` 里的 `postgres` 服务有完整示例，已有容器可以忽略该服务）。

#### 1.2 对象存储

```bash
docker compose up -d          # 启动 SeaweedFS，并自动创建存储桶 crm-lake
# 或者用 RustFS：
docker compose --profile rustfs up -d rustfs rustfs-bucket
# 然后把 .env 里的 S3_ENDPOINT 改成 localhost:9000
```

需要 MongoDB 数据源做开发或测试时：`docker compose --profile mongo up -d mongodb`（开启访问控制，root 账号 `crm` / `crm-secret`）；用 Apple container 时：

```bash
container run -d --name mongodb -c 4 -m 4g -p 27017:27017 -v mongodb-data:/data/db \
  -e MONGO_INITDB_ROOT_USERNAME=crm -e MONGO_INITDB_ROOT_PASSWORD=crm-secret docker.io/library/mongo:8
```

不想用对象存储时，把 `.env` 里的 `LAKE_URI` 改成本地目录（如 `./data/lake`），其他代码不用改。

#### 1.3 安装与自检

```bash
pnpm install
cp .env.example .env          # 按你的 PG / S3 修改
pnpm check                    # 检查 DuckDB、PostgreSQL、对象存储、DuckLake 扩展
```

---

## 2. 运行

```bash
pnpm all        # 按顺序跑完下面全部步骤
pnpm report     # 汇总每一步的耗时（记录在 reports/bench.jsonl）
```

| 命令 | 脚本 | 做什么 |
|---|---|---|
| `pnpm check` | `00_check.ts` | 环境自检 |
| `pnpm seed` | `01_seed.ts` | 生成数据：客户 / 订单 / 明细写入 PG；埋点 JSONL.gz、营销 CSV.gz、商品 Parquet 写入湖的 landing 区；会员 SaaS 后台库 |
| `pnpm ingest` | `02_ingest.ts` | 全量入湖：PG → silver 表 + bronze Parquet（按月分区）；会员接口并发分页拉取；文件 → 分区 Parquet；并在 PG 里制造一批变更 |
| `pnpm ingest:incr` | `02_ingest.ts incremental` | 增量同步：`updated_at` 水位线，条件下推到 PG → `MERGE INTO` + CDC 批次落湖 |
| `pnpm model` | `03_model.ts` | 订单清洗、设备 → 用户身份打通、30 分钟会话切分、7 源关联的 `gold.user_360` |
| `pnpm crm` | `04_crm.ts` | 复购、多次消费贡献、同期群留存、RFM、CLV、流失预警、忠诚度评分、季度档位迁移、邀请裂变 |
| `pnpm journey` | `05_journey.ts` | 会话漏斗、ASOF 营销归因、购物篮提升度、向量相似推荐、五表关联 Top-N |
| `pnpm realtime` | `06_realtime.ts` | 微批写入 + 增量合并、并发查询、客户 360 点查、流式导出、全量重算 |
| `pnpm federation` | `07_federation_ducklake.ts` | 联邦查询（PG × 湖 × 分析库）、`postgres_query` 下推、DuckLake（元数据在 PG、数据在 S3、快照 / 时间旅行 / 变更流） |
| `pnpm v2` | `08_v2_features.ts` | DuckDB 2.0 新能力（VARIANT、触发器、`$变量`、DML CTE、NEAREST、USING KEY）；需要 2.0 版 Node 驱动 |
| `pnpm advanced` | `09_advanced_sql.ts` | 进阶 SQL：ROLLUP / CUBE / GROUPING SETS、RANGE 时间窗口、`arg_max(x, y, n)`、指标宏、ENUM、客户模糊匹配、行为路径、抽样 |
| `pnpm engineering` | `10_engineering.ts` | 上线必备：多进程只读 + 蓝绿切换、查询超时 / 取消 / 进度、加密与脱敏、数据质量、SCD2、性能诊断 |
| `pnpm extensions` | `11_extensions.ts` | 扩展：vss 向量索引、fts 中文全文检索、spatial 门店覆盖、excel、delta / iceberg、JS 自定义函数 |
| `pnpm wasm:data` / `wasm:build` / `wasm:serve` | `wasm/` | 浏览器里的 DuckDB：直接查询 Parquet 的客户人群看板 |
| `pnpm dbt` | `dbt/` | 用 dbt-duckdb 管理 SQL 模型：依赖、测试、增量、直接输出 Parquet |

第 09–11 个脚本可以只跑其中一节：`pnpm advanced 6`（只跑客户模糊匹配）。
依赖关系：`engineering` 第 11 节、`extensions` 第 20 节要用到 `advanced` 第 6 节生成的 `silver.contacts_a`；
`extensions` 第 19 节要先 `pip install deltalake pyarrow "pyiceberg[sql-sqlite]" && pnpm lakeformats:make`；
`pnpm dbt` 需要 `pip install dbt-duckdb`。

### 规模怎么选

| SCALE | 会员 | 订单 | 明细 | 埋点 | 建议机器 | PG 占用（估） | 湖 + 分析库（估） |
|---|---|---|---|---|---|---|---|
| 0.01 | 10 万 | 131 万 | 277 万 | 101 万 | 任意 | 0.5 GB | 0.5 GB |
| 0.1 | 100 万 | 1310 万 | 2750 万 | 1010 万 | 4 核 8 GB | 4 GB | 3 GB |
| 1 | 1000 万 | 1.31 亿 | 2.75 亿 | 1.01 亿 | 8 核 16 GB 起 | 35–40 GB | 25–30 GB |

`SEED_TARGET=lake` 可以跳过 PG，直接生成“已从 PG 导出”的 Parquet，适合只压测湖上分析、PG 磁盘不够的情况。


## 3. 实测结果

### 3.1 SCALE=1（1000 万会员 / 亿级），2 核 · 7 GB 内存 · `DUCKDB_MEMORY=3800MB`

测试机很弱（2 核），这组数字是“下限”；8 核机器大多能快 3–4 倍。用 `SEED_TARGET=lake`（PG 磁盘不够），湖在本地磁盘。

| 阶段 | 步骤 | 数据量 | 耗时 |
|---|---|---|---|
| 生成 | 订单 + 明细（10 块） | 1.31 亿 + 2.75 亿 | 每块 4.5 s + 22 s，共约 4.5 分钟 |
| 生成 | 埋点 JSONL.gz（118 天） | 1.01 亿 | 598 s（gzip 单线程压缩为瓶颈） |
| 入库 | 订单 Parquet → silver | 1.31 亿 | 39.8 s |
| 入库 | 明细 Parquet → silver | 2.75 亿 | 58.9 s |
| 入湖 | 埋点 JSONL.gz → 分区 Parquet（一次性 PARTITION_BY；当前代码已改为逐天写） | 1.01 亿 | 75.4 s |
| 入湖 | 营销 CSV.gz → 分区 Parquet | 5000 万 | 29.3 s |
| 入湖 | 会员接口 1000 万行（逐行 Appender） | 504 页 | 823.7 s ❌ |
| 入湖 | 会员接口 1000 万行（NDJSON 暂存 + read_json，当前写法） | 504 页 | 77.2 s + 2.8 s ✅ |
| 建模 | 订单清洗 | 1.31 亿 | 37.2 s |
| 建模 | 身份打通 + 30 分钟会话切分 | 1.01 亿事件 → 2144 万会话 | 217.7 s |
| 建模 | 品类偏好（明细 × 订单 × 商品） | 2.75 亿 × 1.31 亿 | 63.4 s |
| 建模 | 7 源关联 → `user_360` | 1000 万行 | 23.2 s（宽表全部步骤合计约 110 s） |
| 分析 | 复购分析 | 1.18 亿已付订单 | 13.3 s |
| 分析 | 同期群留存 | | 14.2 s |
| 分析 | RFM / CLV / 流失预警 | 850 万下单客户 | 10.8 s / 5.3 s / 8.8 s |
| 分析 | 忠诚度评分（7 个 percent_rank） | 850 万 | 21.4 s |
| 分析 | 季度档位迁移矩阵 | | 11.9 s |
| 分析 | 邀请裂变（递归 5 层） | 1000 万客户 | 3.9 s |
| 旅程 | 会话漏斗 | 2144 万会话 | 8.3 s |
| 旅程 | ASOF 营销归因 | 5000 万触达 × 1.18 亿订单 | 61.0 s |
| 旅程 | 购物篮提升度（近 180 天） | 明细自连接 | 50.2 s |
| 旅程 | 向量推荐（2000 人 × 5000 候选） | 1000 万次余弦 | 17.4 s |
| 旅程 | 五表关联 + 分组 Top-N | | 18.6 s |
| 实时 | 每批 5000 条写入 / 增量合并 / 大屏查询 | | 15 ms / 12 ms / 3 ms |
| 实时 | 客户 360 点查（5 表关联）p50 / p95 / p99 | 1000 万客户 | 24 / 33 / 40 ms |
| 实时 | 流式导出挽回名单 | 137 万行 | 4.2 s，Node 堆内存 20 MB |
| 实时 | 全量重算 RFM | 1.18 亿已付订单 | 7.8 s |

完整日志在 `reports/logs/`。

### 3.2 SCALE=0.1（100 万会员 / 1310 万订单），PostgreSQL 18 + S3 完整链路，同一台 2 核机器

| 环节 | 数据量 | 耗时 | 吞吐 |
|---|---|---|---|
| DuckDB 生成 → 写入 PG（`INSERT INTO pg.…`） 订单 | 1310 万 | 16.8 s | 约 78 万行/秒 |
| 同上 订单明细 | 2750 万 | 29.6 s | 约 93 万行/秒 |
| PG 建主键、索引、ANALYZE | | 35.3 s | |
| PG → silver（postgres 扩展并行扫描） 订单 / 明细 | 1310 万 / 2750 万 | 10.9 s / 10.5 s | 120–260 万行/秒 |
| silver → S3 bronze 订单快照（按月分区） | 1310 万 | 7.1 s | |
| 会员接口（并发分页 → NDJSON → read_json） | 100 万 | 4.4 s + 0.5 s | |
| S3 上的埋点 JSONL.gz → bronze（逐天） | 1010 万 | 16.5 s | |
| 增量同步：拉取变更（条件下推 PG，走索引）+ MERGE | 5050 行 | 58 ms + 14 ms | |
| `user_360` 全部步骤 | 100 万客户 | 约 9 s | |
| CRM 分析各项 | | 0.2–1.9 s | |
| 联邦查询（PG × 湖 × 分析库） | | 0.4–1.5 s | |
| DuckLake：写入 1240 万订单 / 追加 9 月订单 | | 5.4 s / 0.5 s | |
| DuckLake：`UPDATE` 改 0.1% 的行 | 1.3 万行 | 99.9 s ⚠️ | |

按这个吞吐估算，`SCALE=1` 写入 PG 大约需要：订单 3 分钟、明细 5 分钟、建索引 6 分钟左右（与磁盘性能强相关）。
DuckLake 的 `UPDATE` 会重写受影响的数据文件，在大表上批量改少量行代价高；湖仓表尽量以追加、按分区覆盖为主，
点状修改留在 PG / 分析库里做。（本次测试的对象存储是本地 S3 模拟服务，真实 SeaweedFS / S3 上会快一些。）

完整日志：`reports/logs/scale01_pg_s3.log`。

### 3.3 千万级、亿级下踩过的坑（代码里已处理）

1. **整体型聚合会 OOM**：`mode()`、`median()`、`count(DISTINCT …)` 在千万分组下要为每组保存明细，
   内存不受 `memory_limit` 约束，2 核 7 GB 机器上直接被系统杀掉（exit 137）。
   改成“先按（客户, 值）计数，再 `arg_max` / `count(*)`”，全局统计用 `approx_count_distinct`、`approx_quantile`。
2. **大宽表分步物化**：7 个来源先各自聚合成“一人一行”的中间表，再一次性 JOIN，峰值内存远低于一条带 6 个 CTE 的大 SQL。
3. **`memory_limit` 留余量**：设为物理内存的 55–60%，Node 进程、PG、对象存储都要吃内存。
4. **接口数据不要逐字段 Appender**：1000 万行用逐行 `appendXxx()` 要 824 s；写 NDJSON 暂存再 `read_json` 只要 80 s。Appender 适合持续流入的小批量。
5. **并发连接不会加速重查询**：单个查询已用满所有核（串行 50.9 s，4 连接并发 50.9 s）。并发的价值是短查询不被长查询卡住。
6. **分区写入要控制同时打开的分区数**：`PARTITION_BY` 一次写 118 个日分区时，每个分区都在内存里攒行组；写到对象存储时更明显（SCALE=0.1、3.5 GB 内存下 OOM）。
   改为逐天读写（也正好是生产上的日增量方式），内存与总天数无关。失败的写入可能在对象存储上留下残缺文件，
   视图用固定文件名（`dt=*/events.parquet`）读取，可以避开它们。
7. **磁盘**：亿级规模下 DuckDB 会把中间结果溢写到 `DUCKDB_TEMP_DIR`，高峰占用可达 6–7 GB，放在大盘上。

---

### 3.4 进阶能力实测（SCALE=0.1：100 万会员 / 1313 万订单 / 2751 万明细 / 1012 万埋点）

| 能力 | 场景 | 结果 |
|---|---|---|
| GROUPING SETS | 看板 4 个切面 | 4 条 SQL 627 ms → 1 条 349 ms |
| RANGE 时间窗口 | 1170 万订单的近 30 天 / 365 天滚动消费 | 7.1 s |
| `arg_max(x, y, n)` | 每客户 Top 3 SKU（2446 万行） | 窗口函数 6.8 s → 3.0 s |
| ENUM | 1274 万行订单宽表 | 分组 188 → 67 ms，排序 7.6 → 2.0 s |
| 客户模糊匹配 | 6 万 × 20 万会员合并 | 召回率 50% → 98.3%，准确率 100% |
| 行为路径 | 1012 万事件 → 212 万会话路径 | 18.7 s |
| 抽样 | 人均订单（全量 14.07） | 按行抽样 1.33 ❌，按客户抽样 13.67 ✅ |
| 多进程只读 | 4 进程客户画像点查 | p50 约 5.4 ms，合计约 604 QPS |
| 查询超时 | 1 秒超时 | 1002 ms 取消，连接可继续使用 |
| SCD2 | 按下单时等级 vs 当前等级 | 黑金 GMV 被高估 9700 万 |
| Parquet 排序写入 | 查一个客户 | 需读行组 104 → 1，22.3 → 4.5 ms，文件小 17% |
| HNSW 向量索引 | 30 万 / 100 万 × 32 维 | 暴力 14 / 35 ms → 索引约 2.2 ms；建索引 67 / 401 s，Recall 1.0 / 0.8 |
| 中文全文检索 | 20 万工单（二元切分） | 建索引 5.1 s，查询约 0.2 s |
| 就近门店 | 20 万客户 × 同城门店 | 0.64 s |
| JS 自定义函数 | 20 万行 | 124 ms（同逻辑 SQL 宏 20 ms） |
| DuckDB-Wasm | 83 万客户，浏览器内切换城市重新聚合 | 0.3 s（测试环境读 CSV，见说明） |
| dbt | 4 模型 + 7 测试 | 全量 4.2 s，增量 3.3 s |

完整日志：`reports/logs/scale01_advanced_engineering_extensions.log`。

---

## 4. 对象存储选型（MinIO 社区版已停止维护）

MinIO 社区版 2025 年 5 月移除了管理控制台，2025 年 12 月进入维护模式，2026 年 4 月仓库归档为只读。
本地开发和自建环境可以用下面这些替代：

| 方案 | 许可证 | 特点 | 适合 |
|---|---|---|---|
| **SeaweedFS**（默认） | Apache-2.0 | 成熟、分布式、小文件多时表现好；Kubeflow 已把默认对象存储换成它 | 本地开发 → 生产都可以 |
| **RustFS** | Apache-2.0 | 用法和控制台最接近 MinIO，迁移成本低；项目较新 | 从 MinIO 迁过来、想要控制台 |
| **Garage** | AGPL-3.0 | 很轻量，适合多地点小集群；首次需要配置布局（layout） | 边缘、多机房小规模部署 |
| 云上 S3 / 阿里云 OSS | 商业 | 免运维 | 生产 |

切换只需要改 `.env`：

```ini
# SeaweedFS
S3_ENDPOINT=localhost:8333
S3_URL_STYLE=path
S3_USE_SSL=false
# RustFS
S3_ENDPOINT=localhost:9000
# 阿里云 OSS
S3_ENDPOINT=oss-cn-hangzhou.aliyuncs.com
S3_URL_STYLE=vhost
S3_USE_SSL=true
```

---

## 5. 数据湖布局

```
s3://crm-lake/lake/
├── landing/                     原始到达区（每批原样保存）
│   ├── events/dt=2026-06-01/events.jsonl.gz
│   ├── marketing/touches_000.csv.gz
│   └── products/products.parquet
├── bronze/                      标准化为 Parquet（可回放）
│   ├── pg_orders/order_month=2025-10/…      PG 全量快照，按月分区
│   ├── pg_orders_cdc/sync_date=…/batch_*.parquet   增量批次
│   ├── pg_customers/ · pg_order_items/ · loyalty/
│   ├── events/dt=…/                          埋点，按天分区
│   └── touches/month=…/                      营销，按月分区
└── ducklake/                    DuckLake 表的数据文件（元数据在 PG 的 ducklake_meta schema）
```

`silver` / `gold` 表存在 `DB_FILE`（DuckDB 分析库）里；湖上的 `silver.v_events`、`silver.v_touches` 是视图，
分区条件会自动下推。

---

## 6. 代码结构

```
src/
├── lib/
│   ├── config.ts        读取 .env，规模参数
│   ├── duck.ts          DuckDB 实例、扩展 / 密钥 / PG 挂载（实例级只初始化一次）、计时与记录
│   ├── mock-api.ts      模拟会员 SaaS 的分页接口（游标分页，不用 OFFSET）
│   └── reader-worker.ts 只读查询子进程（多进程并发示例）
├── 00_check.ts … 08_v2_features.ts
├── 09_advanced_sql.ts / 10_engineering.ts / 11_extensions.ts
└── report.ts            汇总 reports/bench.jsonl
scripts/make_delta_iceberg.py  生成 Delta / Iceberg 测试表
wasm/                    DuckDB-Wasm 浏览器看板（src/app.ts、serve.mjs、test.mjs）
dbt/                     dbt-duckdb 项目（profiles.yml、models/、macros/）
docker-compose.yml       SeaweedFS（默认）/ RustFS / PostgreSQL（可选）
.env.example             全部配置项
```

---

## 7. 常见问题

**DuckDB-Wasm 页面在内网打不开 Parquet**：浏览器里读 Parquet 需要 parquet 扩展，默认从 extensions.duckdb.org 下载。
内网部署时把对应版本的 `*.duckdb_extension.wasm` 放到自己的静态服务器上，访问页面时加 `?ext_repo=https://你的地址`。
没有扩展时也可以先用 CSV 验证：`?file=customers_web.csv`。

**HNSW 索引持久化**：`vss` 扩展把索引写进磁盘库目前是实验功能（需要 `SET hnsw_enable_experimental_persistence = true`）。
示例把索引放在内存库里，服务启动时重建；百万级以内优先考虑暴力计算。


**扩展下载失败 / 内网环境**：DuckDB 扩展也发布在 PyPI 上，可以在能联网的机器下载后拷贝：

```bash
pip download --no-deps --only-binary=:all: --platform manylinux2014_x86_64 \
  duckdb-extension-httpfs==1.5.5 duckdb-extension-postgres-scanner==1.5.5 duckdb-extension-ducklake==1.5.5
# 解压 whl，把 *.duckdb_extension 放到：
#   ~/.duckdb/extensions/v1.5.5/linux_amd64/        （macOS Apple 芯片为 osx_arm64，平台名换成 macosx_11_0_arm64 下载）
```

**连不上容器里的 PG**：确认容器做了端口映射（`-p 5432:5432`），`PG_HOST` 用 `localhost`；
如果 Node 也跑在容器里，`PG_HOST` 改成 PG 容器名并放在同一个 Docker 网络。

**被系统杀掉（exit 137）**：调小 `DUCKDB_MEMORY`（物理内存的 50–60%），或减少 `DUCKDB_THREADS`。

**升级到 DuckDB 2.0**：`@duckdb/node-api` 发布 2.0 后 `pnpm add @duckdb/node-api@latest`。
旧库文件需要先升级存储格式才能用 VARIANT / 触发器：

```sql
ATTACH './data/crm_v2.duckdb' AS crm_v2 (STORAGE_VERSION 'v2.0.0');
COPY FROM DATABASE crm TO crm_v2;
```


