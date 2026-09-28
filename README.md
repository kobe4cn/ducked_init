# crm-lakehouse —— DuckDB + TypeScript 千万会员 / 亿级订单用户分析实战

用 **DuckDB + TypeScript** 搭一个 CRM 数据分析体系：多数据源入湖（PostgreSQL、对象存储、HTTP 接口、JSON / CSV 文件），
建客户 360 宽表，做复购、同期群、RFM、CLV、流失预警、忠诚度、营销归因、购物篮、向量推荐、实时指标，
并用 DuckLake 做带快照的湖仓表。

- 唯一的运行时依赖：`@duckdb/node-api`
- 数据规模可调：`SCALE=1` 为 **1000 万会员 / 1.31 亿订单 / 2.75 亿订单明细 / 1.01 亿埋点 / 5000 万营销触达**
- 所有数据由脚本确定性生成，同样的 `SCALE` 每次结果一致，可重复压测

---

## 1. 准备环境

| 组件       | 要求         | 说明                                                                                     |
| ---------- | ------------ | ---------------------------------------------------------------------------------------- |
| Node.js    | ≥ 20.6       | 用到 `node --env-file`                                                                   |
| PostgreSQL | 13 及以上    | 你已有的本地容器即可，需要从宿主机能连上（端口映射）                                     |
| 对象存储   | 任意 S3 兼容 | 推荐 SeaweedFS，`docker-compose.yml` 已配好；也可 RustFS / Garage / 云上 S3 / 阿里云 OSS |
| Docker     | 可选         | 用来启动对象存储                                                                         |

DuckDB 扩展（`httpfs`、`postgres`、`ducklake`）首次使用时会从 `extensions.duckdb.org` 自动下载，不需要 npm 安装。
内网环境见第 7 节“离线安装扩展”。

### 1.1 PostgreSQL（已有容器）

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

### 1.2 对象存储

```bash
docker compose up -d          # 启动 SeaweedFS，并自动创建存储桶 crm-lake
# 或者用 RustFS：
docker compose --profile rustfs up -d rustfs rustfs-bucket
# 然后把 .env 里的 S3_ENDPOINT 改成 localhost:9000
```

不想用对象存储时，把 `.env` 里的 `LAKE_URI` 改成本地目录（如 `./data/lake`），其他代码不用改。

### 1.3 安装与自检

```bash
npm install
cp .env.example .env          # 按你的 PG / S3 修改
npm run check                 # 检查 DuckDB、PostgreSQL、对象存储、DuckLake 扩展
```

---

## 2. 运行

```bash
npm run all        # 按顺序跑完下面全部步骤
npm run report     # 汇总每一步的耗时（记录在 reports/bench.jsonl）
```

| 命令                  | 脚本                        | 做什么                                                                                                                   |
| --------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run check`       | `00_check.ts`               | 环境自检                                                                                                                 |
| `npm run seed`        | `01_seed.ts`                | 生成数据：客户 / 订单 / 明细写入 PG；埋点 JSONL.gz、营销 CSV.gz、商品 Parquet 写入湖的 landing 区；会员 SaaS 后台库      |
| `npm run ingest`      | `02_ingest.ts`              | 全量入湖：PG → silver 表 + bronze Parquet（按月分区）；会员接口并发分页拉取；文件 → 分区 Parquet；并在 PG 里制造一批变更 |
| `npm run ingest:incr` | `02_ingest.ts incremental`  | 增量同步：`updated_at` 水位线，条件下推到 PG → `MERGE INTO` + CDC 批次落湖                                               |
| `npm run model`       | `03_model.ts`               | 订单清洗、设备 → 用户身份打通、30 分钟会话切分、7 源关联的 `gold.user_360`                                               |
| `npm run crm`         | `04_crm.ts`                 | 复购、多次消费贡献、同期群留存、RFM、CLV、流失预警、忠诚度评分、季度档位迁移、邀请裂变                                   |
| `npm run journey`     | `05_journey.ts`             | 会话漏斗、ASOF 营销归因、购物篮提升度、向量相似推荐、五表关联 Top-N                                                      |
| `npm run realtime`    | `06_realtime.ts`            | 微批写入 + 增量合并、并发查询、客户 360 点查、流式导出、全量重算                                                         |
| `npm run federation`  | `07_federation_ducklake.ts` | 联邦查询（PG × 湖 × 分析库）、`postgres_query` 下推、DuckLake（元数据在 PG、数据在 S3、快照 / 时间旅行 / 变更流）        |
| `npm run v2`          | `08_v2_features.ts`         | DuckDB 2.0 新能力（VARIANT、触发器、`$变量`、DML CTE、NEAREST、USING KEY）；需要 2.0 版 Node 驱动                        |

### 规模怎么选

| SCALE | 会员    | 订单    | 明细    | 埋点    | 建议机器      | PG 占用（估） | 湖 + 分析库（估） |
| ----- | ------- | ------- | ------- | ------- | ------------- | ------------- | ----------------- |
| 0.01  | 10 万   | 131 万  | 277 万  | 101 万  | 任意          | 0.5 GB        | 0.5 GB            |
| 0.1   | 100 万  | 1310 万 | 2750 万 | 1010 万 | 4 核 8 GB     | 4 GB          | 3 GB              |
| 1     | 1000 万 | 1.31 亿 | 2.75 亿 | 1.01 亿 | 8 核 16 GB 起 | 35–40 GB      | 25–30 GB          |

`SEED_TARGET=lake` 可以跳过 PG，直接生成“已从 PG 导出”的 Parquet，适合只压测湖上分析、PG 磁盘不够的情况。

---

## 3. 实测结果

### 3.1 SCALE=1（1000 万会员 / 亿级），2 核 · 7 GB 内存 · `DUCKDB_MEMORY=3800MB`

测试机很弱（2 核），这组数字是“下限”；8 核机器大多能快 3–4 倍。用 `SEED_TARGET=lake`（PG 磁盘不够），湖在本地磁盘。

| 阶段 | 步骤                                                                      | 数据量                    | 耗时                               |
| ---- | ------------------------------------------------------------------------- | ------------------------- | ---------------------------------- |
| 生成 | 订单 + 明细（10 块）                                                      | 1.31 亿 + 2.75 亿         | 每块 4.5 s + 22 s，共约 4.5 分钟   |
| 生成 | 埋点 JSONL.gz（118 天）                                                   | 1.01 亿                   | 598 s（gzip 单线程压缩为瓶颈）     |
| 入库 | 订单 Parquet → silver                                                     | 1.31 亿                   | 39.8 s                             |
| 入库 | 明细 Parquet → silver                                                     | 2.75 亿                   | 58.9 s                             |
| 入湖 | 埋点 JSONL.gz → 分区 Parquet（一次性 PARTITION_BY；当前代码已改为逐天写） | 1.01 亿                   | 75.4 s                             |
| 入湖 | 营销 CSV.gz → 分区 Parquet                                                | 5000 万                   | 29.3 s                             |
| 入湖 | 会员接口 1000 万行（逐行 Appender）                                       | 504 页                    | 823.7 s ❌                         |
| 入湖 | 会员接口 1000 万行（NDJSON 暂存 + read_json，当前写法）                   | 504 页                    | 77.2 s + 2.8 s ✅                  |
| 建模 | 订单清洗                                                                  | 1.31 亿                   | 37.2 s                             |
| 建模 | 身份打通 + 30 分钟会话切分                                                | 1.01 亿事件 → 2144 万会话 | 217.7 s                            |
| 建模 | 品类偏好（明细 × 订单 × 商品）                                            | 2.75 亿 × 1.31 亿         | 63.4 s                             |
| 建模 | 7 源关联 → `user_360`                                                     | 1000 万行                 | 23.2 s（宽表全部步骤合计约 110 s） |
| 分析 | 复购分析                                                                  | 1.18 亿已付订单           | 13.3 s                             |
| 分析 | 同期群留存                                                                |                           | 14.2 s                             |
| 分析 | RFM / CLV / 流失预警                                                      | 850 万下单客户            | 10.8 s / 5.3 s / 8.8 s             |
| 分析 | 忠诚度评分（7 个 percent_rank）                                           | 850 万                    | 21.4 s                             |
| 分析 | 季度档位迁移矩阵                                                          |                           | 11.9 s                             |
| 分析 | 邀请裂变（递归 5 层）                                                     | 1000 万客户               | 3.9 s                              |
| 旅程 | 会话漏斗                                                                  | 2144 万会话               | 8.3 s                              |
| 旅程 | ASOF 营销归因                                                             | 5000 万触达 × 1.18 亿订单 | 61.0 s                             |
| 旅程 | 购物篮提升度（近 180 天）                                                 | 明细自连接                | 50.2 s                             |
| 旅程 | 向量推荐（2000 人 × 5000 候选）                                           | 1000 万次余弦             | 17.4 s                             |
| 旅程 | 五表关联 + 分组 Top-N                                                     |                           | 18.6 s                             |
| 实时 | 每批 5000 条写入 / 增量合并 / 大屏查询                                    |                           | 15 ms / 12 ms / 3 ms               |
| 实时 | 客户 360 点查（5 表关联）p50 / p95 / p99                                  | 1000 万客户               | 24 / 33 / 40 ms                    |
| 实时 | 流式导出挽回名单                                                          | 137 万行                  | 4.2 s，Node 堆内存 20 MB           |
| 实时 | 全量重算 RFM                                                              | 1.18 亿已付订单           | 7.8 s                              |

完整日志在 `reports/logs/`。

### 3.2 SCALE=0.1（100 万会员 / 1310 万订单），PostgreSQL 18 + S3 完整链路，同一台 2 核机器

| 环节                                             | 数据量            | 耗时            | 吞吐            |
| ------------------------------------------------ | ----------------- | --------------- | --------------- |
| DuckDB 生成 → 写入 PG（`INSERT INTO pg.…`） 订单 | 1310 万           | 16.8 s          | 约 78 万行/秒   |
| 同上 订单明细                                    | 2750 万           | 29.6 s          | 约 93 万行/秒   |
| PG 建主键、索引、ANALYZE                         |                   | 35.3 s          |                 |
| PG → silver（postgres 扩展并行扫描） 订单 / 明细 | 1310 万 / 2750 万 | 10.9 s / 10.5 s | 120–260 万行/秒 |
| silver → S3 bronze 订单快照（按月分区）          | 1310 万           | 7.1 s           |                 |
| 会员接口（并发分页 → NDJSON → read_json）        | 100 万            | 4.4 s + 0.5 s   |                 |
| S3 上的埋点 JSONL.gz → bronze（逐天）            | 1010 万           | 16.5 s          |                 |
| 增量同步：拉取变更（条件下推 PG，走索引）+ MERGE | 5050 行           | 58 ms + 14 ms   |                 |
| `user_360` 全部步骤                              | 100 万客户        | 约 9 s          |                 |
| CRM 分析各项                                     |                   | 0.2–1.9 s       |                 |
| 联邦查询（PG × 湖 × 分析库）                     |                   | 0.4–1.5 s       |                 |
| DuckLake：写入 1240 万订单 / 追加 9 月订单       |                   | 5.4 s / 0.5 s   |                 |
| DuckLake：`UPDATE` 改 0.1% 的行                  | 1.3 万行          | 99.9 s ⚠️       |                 |

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

## 4. 对象存储选型（MinIO 社区版已停止维护）

MinIO 社区版 2025 年 5 月移除了管理控制台，2025 年 12 月进入维护模式，2026 年 4 月仓库归档为只读。
本地开发和自建环境可以用下面这些替代：

| 方案                  | 许可证     | 特点                                                            | 适合                        |
| --------------------- | ---------- | --------------------------------------------------------------- | --------------------------- |
| **SeaweedFS**（默认） | Apache-2.0 | 成熟、分布式、小文件多时表现好；Kubeflow 已把默认对象存储换成它 | 本地开发 → 生产都可以       |
| **RustFS**            | Apache-2.0 | 用法和控制台最接近 MinIO，迁移成本低；项目较新                  | 从 MinIO 迁过来、想要控制台 |
| **Garage**            | AGPL-3.0   | 很轻量，适合多地点小集群；首次需要配置布局（layout）            | 边缘、多机房小规模部署      |
| 云上 S3 / 阿里云 OSS  | 商业       | 免运维                                                          | 生产                        |

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
│   └── mock-api.ts      模拟会员 SaaS 的分页接口（游标分页，不用 OFFSET）
├── 00_check.ts … 08_v2_features.ts
└── report.ts            汇总 reports/bench.jsonl
docker-compose.yml       SeaweedFS（默认）/ RustFS / PostgreSQL（可选）
docker/seaweedfs/s3.json SeaweedFS 的访问密钥配置
.env.example             全部配置项
```

---

## 7. 常见问题

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

**升级到 DuckDB 2.0**：`@duckdb/node-api` 发布 2.0 后 `npm i @duckdb/node-api@latest`。
旧库文件需要先升级存储格式才能用 VARIANT / 触发器：

```sql
ATTACH './data/crm_v2.duckdb' AS crm_v2 (STORAGE_VERSION 'v2.0.0');
COPY FROM DATABASE crm TO crm_v2;
```

## 8. 技术栈

- **Framework:** [React Router](https://reactrouter.com/) v8 with SSR
- **Language:** TypeScript 7.x
- **Database:** PostgreSQL 17 via [Drizzle ORM](https://orm.drizzle.team/) + DuckDB 1.5
- **Styling:** Tailwind CSS 4 + [shadcn/ui](https://ui.shadcn.com/)
- **Testing:** [Vitest](https://vitest.dev/)
- **Build:** [Vite](https://vite.dev/) 7
- **Real-time:** [Ably](https://ably.com/) for live presence
