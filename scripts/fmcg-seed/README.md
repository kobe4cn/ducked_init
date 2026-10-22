# fmcglab：快消（乳品）多渠道 CRM 测试数据与操作手册

模拟乳品品牌「禾川乳业」：13 个数据源（会员中心、小程序商城与周期购、一物一码扫码平台、奶站订奶、ERP、订单中台、天猫、京东、抖店、小程序埋点、地推试饮表、经销商商超销量、企业微信社群），覆盖身份打通与数据卫生、主键的四种意思（带来源区分、去重、覆盖、补齐）、积分、券、同意、扫码、周期购、非消费者数据分析、持续同步与对外服务。
设计、用例与结论在 `docs/test-plans/fmcglab-plan.md`，这里讲怎么做。

```
scripts/fmcg-seed/
  truth.sql        真值：人、各源记录、订单（含订单中台的两边版本）、明细、扫码与码、埋点、积分、券、同意、周期购、社群、试饮、商超销量，以及探针
  identity.sql     期望的身份打通（expected_identity）：占位号、代填号不算身份字段
  round2.sql       第二轮变更（T7）
  seed.ts          生成真值并写进 13 个数据源，建只读账号
  mappings/        42 个映射（文件名：数据源.表或视图.实体.yaml）
  views/           8 个源视图（拆平台、拆买家、换 SKU、清洗代填号、退群）
  definitions/     17 个指标、5 个标签
  check-mappings.ts 连上数据源取真实列类型，用平台的校验器离线检查映射与定义（--describe 打印每张源表的列）
  setup.ts         冒烟：不经界面，用同一批领域函数把租户配到出指标
  verify.ts        拿真值核对租户：身份打通、统一消费者属性与同意、标准层、合并组、积分断言、每个指标与标签、工作台分析题的参考答案
  out/             真值库、只读账号（credentials.txt）、冒烟状态；不提交
```

## 一、造数

```bash
# 默认数据终点是今天（UTC）：订单、扫码、行为都在这一天之前，探针的时间相对它取。手工测试最好当天做完 T5，探针的「距今天数」才与下表一致
node --env-file=.env --import tsx scripts/fmcg-seed/seed.ts --persons 50000
# 只重写某几个源：--only truth,member,mall,scan,station,erp,oms,tmall,jd,douyin,events,activity,wecom,sellout,accounts
# 第二轮变更（T7）：就地改源端，不重建
node --env-file=.env --import tsx scripts/fmcg-seed/seed.ts --round 2
```

5 万人档造数约 20 秒；可以重复跑（每个源先删后建，探针数值不随规模变化）。规模档：`--persons 10000000 --set 10m`（库、schema 加 `_10m`，S3 前缀多一级 `10m/`）。

## 二、冒烟（我已经跑过，你也可以随时用它确认环境）

```bash
node --env-file=.env --import tsx scripts/fmcg-seed/check-mappings.ts        # 42 个映射 + 22 个定义，全 ✔
node --env-file=.env --import tsx scripts/fmcg-seed/setup.ts --tenant fmcglab-smoke
node --env-file=.env --import tsx scripts/fmcg-seed/verify.ts fmcglab-smoke   # 期望：没有 ✘
```

`setup.ts` 另有两步：`--step sync`（重新同步全部数据源、合并、重算；第二轮造数之后用）、`--step recompute`（以今天为 asOf 重新计算全部指标、标签与模板）。改过 `mappings/` 里的文件再跑 `--step mappings`，会把改过的映射起草并发布新的一版。
冒烟租户 `fmcglab-smoke` 两轮都已通过（62 项 ✔）。

## 三、手工测试

每一步：你在页面上操作，跑一下检查命令，把结果（或截图）发给我，我对照期望告诉你下一步，对不上时一起看任务日志与数据。

检查命令（只读挂载租户的数据湖）：

```bash
node --env-file=.env --import tsx scripts/fmcg-seed/verify.ts fmcglab [--only identity,consumer,silver,metrics,analysis]
node --env-file=.env --import tsx scripts/lake-sql.ts fmcglab "SELECT count(*) FROM silver.\"order\""
```

`verify.ts` 任何时候都可以跑：还没映射的部分显示「未映射」，还没登记的数据源会提示「被拆开」。

### T0 准备

| # | 操作 | 期望 |
|---|---|---|
| T0.1 | 已经造好（数据终点 2026-10-20，第一轮），可以直接用。隔天测也行：`verify.ts` 按每张快照自己的 asOf 核对，只是 T5 与第四节里的「距今天数」要加上相隔的天数。想重来就重跑造数（见第一节），冒烟租户随后要 `pnpm lake:reset --tenant fmcglab-smoke --yes` 再 `setup.ts --tenant fmcglab-smoke --step sync` | `out/credentials.txt` 有只读账号 |
| T0.2 | `pnpm tenant:create --slug fmcglab --name 禾川乳业 --admin-email admin@fmcglab.test` | 打印租户 ID 与管理员登录方式 |
| T0.3 | `/ops` 把 fmcglab 的配额调成 16 线程、65536 MB、并发 4 | 默认 2 线程 / 2 GB 也能跑，只是慢 |
| T0.4 | 三个终端：`pnpm dev`（登录链接打印在这里）、`pnpm dispatcher`（全程别关；本机已经有一个在跑就不用再开）、一个跑检查命令 | |
| T0.5 | admin 登录 →「成员」邀请 `eng@fmcglab.test`（数据工程师）、`an@fmcglab.test`（分析师）、`view@fmcglab.test`（查看者） | 三个互不相干的浏览器窗口分别登录 admin、eng、an |

分工：映射、源视图、合并组、自定义实体 **eng 起草、admin 发布**；指标与标签 **an 起草、eng 发布**。

### T1 数据源（eng）

「数据源」→ 新建，名字必须照下表（verify.ts 认名字），账号见 `out/credentials.txt`，每个都点「测试连接」：

| 登记名 | 类型 | 连接 | 表数 |
|---|---|---|---|
| `member_pg` | PostgreSQL | localhost:5432，库 `crm`，schema `fmcg_member` | 8 |
| `mall_pg` | PostgreSQL | 同上，schema `fmcg_mall` | 3 |
| `scan_mysql` | MySQL | localhost:3306，库 `fmcg_scan` | 4 |
| `station_mysql` | MySQL | 同上，库 `fmcg_station` | 3 |
| `erp_mysql` | MySQL | 同上，库 `fmcg_erp` | 2 |
| `oms_mongo` | MongoDB | localhost:27017，库 `fmcg_oms`，认证库 `admin` | 1 |
| `tmall_s3` | S3 | `s3://crm-source/fmcg/tmall/`，Parquet | 3 |
| `jd_s3` | S3 | `s3://crm-source/fmcg/jd/`，CSV | 3 |
| `douyin_s3` | S3 | `s3://crm-source/fmcg/douyin/`，CSV | 1 |
| `events_s3` | S3 | `s3://crm-source/fmcg/events/`，JSON | 1 |
| `activity_s3` | S3 | `s3://crm-source/fmcg/activity/`，CSV | 1 |
| `sellout_s3` | S3 | `s3://crm-source/fmcg/sellout/`，CSV | 2 |
| `wecom_duckdb` | DuckDB 文件 | `s3://crm-source/fmcg/wecom/wecom.duckdb` | 4 |

S3 都是：端点、区域、Access Key 见 `credentials.txt`，路径风格 path，不用 SSL。

| # | 操作 | 期望 |
|---|---|---|
| T1.1 | 每个数据源「测试连接」 | 都通过（只读权限探测通过） |
| T1.2 | 每个数据源选上全部表，等采集完 | 共 36 张表，表数如上 |
| T1.3 | 确认水位线：有 `updated_at` / `update_time` / `modified` 的选它；扫码流水 `scans`、码表 `codes`、积分流水 `points_ledger` 只追加，选 `created_at`；`order_items`、`stations`、`regions` 没有候选（全量比对） | |
| T1.4 | 文件类的表（S3、DuckDB）没有主键，声明业务主键（下表） | 声明后排一个全表检查任务，通过才生效 |
| T1.5 | 每个数据源点「同步」 | 原始层行数等于下表；敏感列（手机、unionid、姓名）在原始层是密文 |
| T1.6 | 湖中核对 | 覆盖率 100% |

业务主键：tmall `buyers`→`ouid`、`trades`→`tid`、`trade_items`→`oid`；jd `jd_orders`→`订单号`、`jd_items`→`订单号`+`京东SKU`、`sku_map`→`京东SKU`；douyin `dy_orders`→`子订单编号`；events `events`→`event_id`；activity `signups`→`报名编号`；sellout `ka_stores`→`门店编码`、`sellout`→`周`+`门店编码`+`商家编码`；wecom `contacts`→`external_userid`、`groups`→`group_id`、`group_members`→`group_id`+`external_userid`、`mass_sends`→`send_id`。

源表行数（第一轮，5 万人档）：

| 数据源 | 表：行数 |
|---|---|
| member_pg | members 34,345 · memberships 34,345 · points_ledger 467,848 · redemptions 6,079 · coupon_templates 20 · coupons 51,242 · consents 41,133 · preferences 12,271 |
| mall_pg | orders 260,846 · order_items 518,768 · subscriptions 3,398 |
| scan_mysql | scan_users 22,493 · scans 382,832 · codes 364,608 · sku_points 63 |
| station_mysql | members 2,591 · bills 31,741 · stations 29 |
| erp_mysql | products 60 · regions 7 |
| oms_mongo | orders 99,234 |
| tmall_s3 | buyers 9,907 · trades 82,265 · trade_items 164,891 |
| jd_s3 | jd_orders 58,603 · jd_items 115,795 · sku_map 60 |
| douyin_s3 | dy_orders 36,978 |
| events_s3 | events 1,243,045 |
| activity_s3 | signups 2,179 |
| sellout_s3 | ka_stores 126 · sellout 65,520 |
| wecom_duckdb | contacts 8,687 · groups 42 · group_members 12,944 · mass_sends 18,833 |

观察点：抖店 CSV 的「买家手机号」被读成整数，映射里要 `string()`；京东 CSV 的订单号是整数；活动表的「报名时间」形如 `2026/9/1 14:05`，被推断成时间；Mongo 的嵌套字段被展开成 `buyer_id`、`pay_total`、`logistics_company`。

### 每个映射怎么建

「映射」→ 新建 → 选数据源、表（或源视图）、实体 → 把 `mappings/` 里对应文件的内容粘进 YAML 编辑器（也可以用表单照着填）→ 保存 → 让 admin 发布。文件开头的注释写了这张表的源端特点和对应的用例。源视图在数据源页「源视图」里新建，SQL 粘 `views/` 里的文件，发布后才能被映射选到。

### T2 消费者与身份打通（eng 起草、admin 发布）

| # | 操作 | 期望 |
|---|---|---|
| T2.1 | 映射 `member_pg.members.customer.yaml`。eng 保存后试着自己发布 | eng 看不到发布按钮或被拒：起草人不能发布自己的草稿；admin 发布后合并成功 |
| T2.2 | 映射 `scan_mysql.scan_users`、`tmall_s3.buyers`、`wecom_duckdb.contacts` 的消费者映射 | `verify.ts --only identity`：P01 已经把会员、扫码、天猫、企微连成一个 |
| T2.3 | jd_s3 建源视图 `jd_buyers`、douyin_s3 建源视图 `dy_buyers`（`views/`），发布后映射 `jd_s3.jd_buyers.customer.yaml`、`douyin_s3.dy_buyers.customer.yaml` | 每个买家一条消费者记录（K9）；映射不写 `view_key`，试着加上 `view_key: [openid]`，空跑与合并会报 view_key 不唯一（#253） |
| T2.4 | **P04 占位号**：先把 `station_mysql.members.customer.yaml` 里的 `phone: nullif(phone, '13800000000')` 改成 `phone: phone` 发布 | `verify.ts --only identity`：「误合并 1」，误合并最多的统一消费者有 **267 个真实的人、267 条记录**（都是奶站）；统一消费者比期望少 266。平台没有任何提示（#254） |
| T2.5 | 改回 `nullif(…)` 发布第 2 版 | 误合并 0。记下：这 266 人分到了新的统一消费者 ID，旧 ID 的别名还指着留下原 ID 的那个人（#252，T9.4 用到） |
| T2.6 | **P05 代填号**：activity_s3 先**直接**映射 `signups` 表为消费者（字段照 `activity_s3.signups_clean.customer.yaml`，只把 `view: signups_clean`、`view_key` 换成 `table: signups`）发布 | 误合并 4 个统一消费者，每个是 1 位导购 + 10 个路人（11 个真实的人） |
| T2.7 | 停用 T2.6 的映射：eng 在映射页「提议停用」，admin「确认停用」（ADR-0031） | 两人分别操作；确认后入队合并，撤下它在标准层的行 |
| T2.8 | 建源视图 `signups_clean`（`views/activity_s3.signups_clean.sql`），发布后映射 `activity_s3.signups_clean.customer.yaml` | `verify.ts --only identity`：缺失、被拆开、误合并、多出都是 0；**统一消费者 69,335** |
| T2.9 | **K8**：`verify.ts --only consumer`（发完 T4 的其余映射再看同意） | 城市不符 0，K8 = 上海（会员中心 `survivorship.priority: 1`）。可选：把会员映射的 `survivorship` 删掉发一版，K8 变杭州（扫码平台最新），再改回来 |

### T3 主键的四种意思（eng 起草、admin 发布）

| # | 操作 | 期望 |
|---|---|---|
| T3.1 | **K1**：映射 `mall_pg.orders` 与 `station_mysql.bills`，**都先删掉 `key_space` 一行**再发布 | 后合并的那个失败，列出冲突的订单号（两边都从 1 开始）。留意报错文案只建议「加前缀或去掉一边」（#257）。映射页「主键冲突体检」→ 运行：order 下这对映射一致比例很低，建议键空间 |
| T3.2 | 加回 `key_space: mall` / `station` 各发一版 | 合并成功；`SELECT count(*) FROM silver."order"` = 260,846 + 31,729（奶站的 12 张测试账单被 `where` 去掉，K7；合并记录里显示过滤 12 行） |
| T3.3 | **K1b**：映射 `mall_pg.order_items`，先把 `order_id` 写成 `string(order_id)`（不带 `key_space`） | 发布被拒：引用字段要写同一数据源里目标实体声明的键空间。改回文件里的写法后通过 |
| T3.4 | **K2 去重**：映射 `tmall_s3.trades`、`jd_s3.jd_orders`、`douyin_s3.dy_orders` 的订单；oms_mongo 建 3 个源视图 `oms_tmall`、`oms_jd`、`oms_douyin`，发布后映射对应的 3 个订单映射 | 三个中台映射合并失败：主键跨映射重复（如京东「共 32117 个」）。再跑体检：建议「多半是重复接入，可以建合并组」 |
| T3.5 | **建合并组**：映射页 → 合并组 → 实体 order：组员按优先级填 1 tmall trades、2 jd_orders、3 dy_orders、4 oms_tmall、5 oms_jd、6 oms_douyin；存活规则「取最新」，字段 `updated_at`；eng 保存、admin 发布 | 发布后组员重建；订单映射的合并记录显示「合并组：重叠 97,328 行，不一致 status 13,487 行、updated_at 97,328 行」。`verify.ts --only silver`：订单合并组状态不符 0、胜出方不符 0、物流不符 0；中台胜出 87,700 行 |
| T3.6 | **K2a / K2b**（覆盖）：看 verify 的「订单合并组探针」 | k2a-tm：天猫已完成、中台已退款 → 已退款，胜出方 oms；k2b-jd：中台已发货、京东已完成 → 已完成，胜出方 jd（这一行没有物流公司：整行取较新的一边） |
| T3.7 | **K3 补齐**：映射 `erp_mysql.products` 与 `scan_mysql.sku_points` 的商品 | 第二个合并失败（独占）。建合并组：实体 product，1 ERP、2 扫码平台，规则「逐字段补齐」，发布 → 商品 63 行，品牌不符 0，没有品类 3（新品） |
| T3.8 | **K3b**：商品合并组改成「按优先级」发第 2 版 | `verify.ts --only silver`：商品合并组品牌不符 8（HC0053–HC0060 整行取 ERP，品牌为空）。比较完改回「逐字段补齐」发第 3 版 |
| T3.9 | **K4**：明细映射 `tmall_s3.trade_items`、`douyin_s3.dy_orders.order_item`；jd_s3 建源视图 `jd_lines` 后映射 `jd_s3.jd_lines.order_item.yaml` | `verify.ts --only silver` 订单明细四个源都 ✔；天猫约 5% 明细商品为空 |
| T3.10 | 再跑一次体检 | 合并组内的映射对不再报；mall 与 station 有键空间，也不报 |

### T4 其余事实与自定义实体

| # | 操作 | 期望 |
|---|---|---|
| T4.1 | member_pg 的其余 7 个映射（会员、积分流水、兑换单事件、券模板、券、同意、偏好）、`station_mysql.members.consent.yaml` | 同一张奶站会员表映射成消费者又映射成同意（不同实体各一个映射） |
| T4.2 | 行为事件：`events_s3.events`（`customer_source: member_pg`）、`scan_mysql.scans`（`where` 去掉测试码）、`wecom_duckdb.group_members`；建源视图 `group_quits` 后映射 `wecom_duckdb.group_quits.event.yaml`；`activity_s3.signups.event.yaml`；触达 `wecom_duckdb.mass_sends.touch.yaml` | `verify.ts --only identity`：设备归属不符 0；`--only silver` event 五个源都 ✔（扫码 382,792 = 382,832 − 40 次测试码） |
| T4.3 | 「自定义实体」→ 按顺序登记并发布：`custom_region`（region_id、region_name）、`custom_station`（station_id、station_name、city、region_id；关系 order.store_id → custom_station.station_id、custom_station.region_id → custom_region.region_id）、`custom_code`（code、sku、batch_no、sales_region、produced_at 时间；关系 event.x_code → custom_code.code、custom_code.sales_region → custom_region.region_id）、`custom_ka_store`（store_code、store_name、chain、city、region_id；关系 → custom_region）都是**维度**；`custom_subscription`（sub_id、customer_id、product_id、plan、periods 整数、delivered 整数、status、start_date 日期、updated_at 时间；关系 customer_id → customer.customer_id、product_id → product.product_id）、`custom_sellout`（week、week_start 日期、store_code、product_id、qty 整数、amount 小数；主键 week + store_code + product_id；关系 store_code → custom_ka_store、product_id → product）是**事实** | 关系要在订单、扫码事件的映射发布之后才能登记（要从已发布映射里取字段类型） |
| T4.4 | 映射 6 个自定义实体（`*.custom_*.yaml`） | `verify.ts --only silver` 全部 ✔；积分断言：points_balance 1 个会员、差额 799（L3），points_chain 0 |

### T5 指标与标签（an 起草、eng 发布）

「分析」→ 新建定义 → 指标，键用文件名，内容粘 `definitions/metric/<键>.yaml`。发布后调度器算出快照；每发布几个就跑一次 `verify.ts fmcglab --only metrics`。

| 键 | 探针的期望（asOf = 数据终点日） |
|---|---|
| `revenue_365d` | P01 650（商城 200 + 奶站 150 + 天猫 120 + 京东 100 + 抖音 80）；S1 每个源 14.00；K2a 不出现（中台记了退款）；SUB 1350 |
| `order_count_365d` | P01 5；S1 每源 3 |
| `channel_count` | P01 5 |
| `avg_order_value_365d` | P01 130；S1 4.67 |
| `revenue_by_region` | P01：华东 150（奶站）、未关联 500（线上没有门店） |
| `revenue_by_city` | 城市取统一消费者的：P01 上海 650；K8 上海 120；P07 未入会 未关联 70（天猫没有城市） |
| `days_since_last_order` | P01 11；E2 6；S1 9 |
| `scan_count_30d` | E1 5；P01 2；K10 先扫的 1、后扫的不出现 |
| `scan_by_sales_region_90d` | E1 华东 5；L1 华东 3 |
| `days_since_last_scan` | E1 5；P03 45 |
| `points_balance` | L1 60；L2 0；L3 200（卡上写的 999）；P01 15 |
| `points_from_scan_90d` | L1 30；P01 15 |
| `active_subscriptions` | SUB 1 |
| `coupon_redeem_rate` | C1 0.333 |
| `views_7d` | P06 12（匿名浏览经设备归属计入） |
| `trial_received` | T1 1 |
| `group_joins` | W1 2；P01 2 |

标签（`definitions/tag/`）：`value_tier`（营收 ≥ 2000 高、≥ 500 中，P01 中、SUB 中）、`scan_active`（E1 高频扫码、P01 偶尔扫码）、`lifecycle`（P01 活跃、P04 B 预警、从没下单的未购买）、`scan_no_buy`（只有 E1 这类：近 30 天扫码 ≥ 3 且近 365 天没订单）、`subscriber`（SUB 在订）。标签的人群是全部统一消费者。

| # | 操作 | 期望 |
|---|---|---|
| T5.1 | 发布全部 17 个指标、5 个标签 | `verify.ts --only metrics` 22 项全 ✔ |
| T5.2 | 删除 `order_count_365d` | 被拒，列出 `scan_no_buy` |
| T5.3 | 起草 `revenue_365d` 第 2 版（状态过滤去掉 `shipped`），看发布前的影响预览 | 列出 `value_tier` 与换档人数；发布后指标与标签同时入队，`verify.ts` 对它显示「与 definitions/ 不同，跳过」 |
| T5.4 | 定义页「重新计算」 | 当天的快照重算（来源 manual） |
| T5.5 | 试写一个指标 `base: custom_sellout` | 校验报「基础实体要有指向 customer.customer_id 的 customer_id」：没有消费者的数据不能做指标（T6 在工作台分析） |
| T5.6 | 写「近 365 天各品类消费金额」「近 365 天奶粉消费金额」两个指标、引用后者的「奶粉人群」标签（YAML 见 T6 的 SQL 之后），发布 | 都能发布（ADR-0038：`order_item` 经 `order_id` 一跳关联消费者，不写 `consumer_via`）；在 `order` 上按品类过滤仍写不出（订单对明细是一对多）；奶粉人群的人数 = 奶粉消费金额结果的行数 |

### T6 工作台分析（an，「查询」）

参考答案：`verify.ts fmcglab --only analysis`。

| # | 题 | 期望 |
|---|---|---|
| T6.1 | **A1 扫码率**：最近 26 周各大区成功扫码数 / 商超销量（SQL 见下） | 与 verify 的「扫码率参考值」逐行相同（华东约 0.0257 …） |
| T6.2 | **A2 窜货**：成功扫码里 `custom_code.sales_region` ≠ 事件的 `x_scan_region` 的次数，按销售大区 | 与「窜货参考值」相同 |
| T6.3 | **A3 品类渗透**（SQL 见下，日期换成数据终点日）；再拿 T5.6 的「各品类消费金额」同一统计日的快照按 `category` 汇总（对照 SQL 见下）对一遍 | 与「品类渗透参考值」相同；未关联约 2,371 人（天猫没填商家编码）；指标汇总后与 A3 逐行相同 |
| T6.4 | A3 的结果「保存为沙箱表」，分享给 `eng@` | eng 在「分享给我的」里看到、能查；外部接口与服务库里没有它 |
| T6.5 | 试查原始层 `lake.bronze_…` | 被拒；原始层只能经数据源名的视图读，敏感列是哈希 |

```sql
-- A1 扫码率（时间按 UTC 日期，与 sellout 的周对齐）
WITH w AS (SELECT min(week_start) AS a, max(week_start) + 7 AS b FROM silver.custom_sellout),
s AS (SELECT c.sales_region AS region_id, count(*) AS scans
      FROM silver.event e JOIN silver.custom_code c ON c.code = e.x_code CROSS JOIN w
      WHERE e.event_type = 'scan' AND timezone('UTC', e.occurred_at)::DATE >= w.a AND timezone('UTC', e.occurred_at)::DATE < w.b GROUP BY 1),
k AS (SELECT st.region_id, sum(o.qty) AS qty FROM silver.custom_sellout o JOIN silver.custom_ka_store st USING (store_code) GROUP BY 1)
SELECT r.region_name AS 大区, s.scans AS 扫码数, k.qty AS 商超销量, round(s.scans / k.qty, 4) AS 扫码率
FROM silver.custom_region r LEFT JOIN s USING (region_id) LEFT JOIN k USING (region_id) ORDER BY r.region_id;

-- A3 品类渗透（把 2026-10-20 换成数据终点日）
SELECT coalesce(p.category, '未关联') AS 品类, count(DISTINCT i.consumer_id) AS 购买人数, sum(oi.amount) AS 金额
FROM silver.order_item oi JOIN silver."order" o ON o.order_id = oi.order_id
JOIN silver._identities i ON i._source = o._customer_source AND i.customer_id = o.customer_id
LEFT JOIN silver.product p ON p.product_id = oi.product_id
WHERE o.status IN ('paid', 'shipped', 'completed')
  AND timezone('UTC', o.created_at)::DATE > DATE '2026-10-20' - 365 AND timezone('UTC', o.created_at)::DATE <= DATE '2026-10-20'
GROUP BY 1 ORDER BY 2 DESC;

-- A3 改用指标后的对照：gold 里「各品类消费金额」统计日为数据终点日的结果，每人每品类一行
SELECT category AS 品类, count(*) AS 购买人数, sum(value) AS 金额
FROM gold."metric__<任务 ID>" GROUP BY 1 ORDER BY 2 DESC;  -- 任务 ID 在定义页的快照列表里
```

T5.6 的定义（品类的取值按商品表里实际写的）：

```yaml
# category_revenue_365d：近 365 天各品类消费金额
base: order_item
measure: { agg: sum, field: amount }
filter:
  - { field: order_item.order_id -> order.status, op: in, value: [paid, shipped, completed] }
window: { field: order_item.order_id -> order.created_at, days: 365 }
dimensions:
  - { name: category, path: order_item.product_id -> product.category }
```

```yaml
# milk_revenue_365d：近 365 天奶粉消费金额（没有维度，标签能引用）
base: order_item
measure: { agg: sum, field: amount }
filter:
  - { field: order_item.order_id -> order.status, op: in, value: [paid, shipped, completed] }
  - { field: order_item.product_id -> product.category, op: eq, value: 奶粉 }
window: { field: order_item.order_id -> order.created_at, days: 365 }
```

```yaml
# milk_fans：奶粉人群
metric: milk_revenue_365d
rules:
  - value: 奶粉人群
    when: { gt: 0 }
default: 其他
```

`count` 数的是明细行；要数订单写 `{ agg: count_distinct, field: order_id }`。

### T7 持续同步（第二轮变更）

```bash
node --env-file=.env --import tsx scripts/fmcg-seed/seed.ts --round 2
```

| 变更 | 源端 | 平台要怎么发现 | 期望 |
|---|---|---|---|
| 约 1% 会员在商城新下一单 | PG 插入 | 水位线增量 | 订单 +500；会员中心积分流水 +713（订单与扫码积分） |
| 5 笔天猫订单售后退款，只有中台记了 | Mongo 更新 `modified` | 水位线增量 → 合并组「取最新」 | 5 笔改为已退款，营收里去掉（**覆盖**）；合并记录：重叠 97,325，status 不一致 13,492 |
| 天猫导出少了 3 笔 | Parquet 重写 | 全量比对发现删除 | 订单数不变：这 3 笔改由中台那一行给出 |
| P03 领红包时绑了手机 | MySQL 更新 | 增量 | 统一消费者 69,335 → 69,334；会员那个 ID 留下，扫码那个记 `merge` |
| P01 在会员中心改城市为北京 | PG 更新 | 增量 | `_consumer` 里 P01 城市北京（会员中心优先） |
| ERP 给 HC0053 补品牌、HC0061 建档 | MySQL 更新、插入 | 增量 → 合并组「逐字段补齐」 | HC0053 品牌取 ERP 的「禾川臻选」；HC0061 有了品类与标价；合并记录：重叠 2，brand 不一致 1 |
| 约 2% 扫码用户今天又扫了码 | MySQL 插入 | 增量 | 扫码 +453 |
| P01 退订微信订阅消息 | PG 更新 | 增量 | P01 的 wechat 同意 revoked |
| SUB 的季卡暂停 | PG 更新 | 增量 | `active_subscriptions` SUB 1 → 不出现；`subscriber` 在订 → 未订 |

| # | 操作 | 期望 |
|---|---|---|
| T7.1 | 等调度器到点同步（默认每 60 分钟，`SOURCE_SYNC_INTERVAL_MINUTES`），或在每个数据源页手动「同步」 | 同步记录里能看到增量的行数与全量比对发现的删除；同步结束自动合并 |
| T7.2 | `verify.ts --only identity,consumer,silver` | 全部 ✔（期望已按第二轮算） |
| T7.3 | 指标与标签：调度器的定时刷新会入队重算，**但同一天已有快照的不再算**（ADR-0028）；当天要看结果就在定义页「重新计算」 | `verify.ts --only metrics` 全部 ✔ |
| T7.4 | 「数据地图」看各映射最近合并、合并组与身份打通的「合并 N 组、拆开 M 组」 | 有 P03 的 1 组合并 |

### T8 分析模板（an 看、eng 发布）

首次合并成功后，平台以默认参数自动启用了 RFM、用户 360、同期群、复购、CLV、流失预警（作者 platform）。「分析」→ 模板：

| # | 操作 | 期望 |
|---|---|---|
| T8.1 | 打开每个模板的快照 | 有快照；RFM 每个统一消费者一行（没下过单的不在里面） |
| T8.2 | 复购模板把复购窗口改成 30 天，eng 保存草稿、admin 发布 | 新快照的复购率变低；旧快照保留 |
| T8.3 | 流失预警看 P01、SUB | 近期下过单，不在预警里 |

### T9 对外服务（admin）

| # | 操作 | 期望 |
|---|---|---|
| T9.1 | 「API Key」→ 新建，复制 Key | 只显示一次 |
| T9.2 | `curl -H "Authorization: Bearer <Key>" http://localhost:5173/api/v1/catalog` | 列出可用的标签键与指标 |
| T9.3 | 取 P01 的统一消费者 ID（见下），`curl -H "Authorization: Bearer <Key>" http://localhost:5173/api/v1/consumers/<ID>` | 返回 P01 的 5 个标签、各指标与 RFM |
| T9.4 | **#252**：取 T2.4 时退役的一个旧 ID（见下），点查 | 现在会返回**另一位**订奶户的结果（缺陷）；修好后应返回本人或 404 |
| T9.5 | 用会员号 `M…` 点查 | 404：只认统一消费者 ID（#256） |

要用的 ID 由 `verify.ts fmcglab --only identity` 打印：「点查用的统一消费者 ID」（P01、K8、SUB 的完整 ID）与「先合后拆后仍指向被拆开的组的退役 ID」（T2.4–T2.5 留下的，附现在的主人是谁）。

### T10 数据质量与治理

| # | 操作 | 期望 |
|---|---|---|
| T10.1 | 「数据质量」 | 积分余额对账：1 个会员不一致、差额 799（L3，warn 级，任务照常成功） |
| T10.2 | 「数据地图」点开订单 | 8 个映射、合并组、到奶站 / 大区的关系 |
| T10.3 | 「审计日志」 | 映射发布、停用（T2.7）、合并组发布、API Key 创建都有记录 |
| T10.4 | 原始层看一条奶站会员的手机明文（需要解密权限） | admin 可以并留审计；an 看不到 |
| T10.5 | 权限：view@ 登录 | 看得到分析结果，没有任何发布、起草按钮；不能进「查询」 |

### T11 千万级（可选，`fmcglab-10m`）

造数 `seed.ts --persons 10000000 --set 10m`，配置 `setup.ts --tenant fmcglab-10m --set 10m`，核对 `verify.ts fmcglab-10m --set 10m`。重点看扫码事件（约 7,700 万）与埋点（约 2.5 亿）的同步与合并、订单合并组在 9,000 多万订单上的重建耗时；记到一张基线表（格式同 `docs/test-plans/crmlab-10m-baseline.md`）。

## 四、探针速查

| pid | 用例 | 构造 | 期望 |
|---|---|---|---|
| 99000001 | P01 全渠道 | 会员、扫码（unionid）、奶站、天猫入会、京东入会、抖音授权、企微；5 笔订单；扫码 2 次（绑定会员，得 15 分）；两个社群 | 一个消费者；渠道 5；营收 650；城市上海（第二轮北京） |
| 99000002 | P02 扫码无身份 | 只有扫码 openid | 单独一个 |
| 99000003 | P03 扫码后绑手机 | 会员 + 扫码（第一轮只有 openid，第二轮绑手机） | 第一轮两个，第二轮一个 |
| 99000004 / 05 | P04 奶站占位号 | 奶站录了 13800000000（A 另有会员） | A 两个（会员与奶站连不上）、B 一个；不去占位号时 267 人并成一个 |
| 99000060–63 | P05 地推导购 | 本人是会员，各替 10 个路人填了自己的手机号 | 导购各一个；路人各一个；不清洗时每位导购连着 10 个陌生人 |
| 99000007 | P06 匿名浏览后登录 | 设备匿名浏览 12 次后登录 | 近 7 天浏览 12 |
| 99000008 / 09 | P07 天猫入会 / 未入会 | 入会有明文手机 | 入会的并入会员；未入会的两个 |
| 99000010 | K2a | 天猫单 300：平台已完成、中台后来已退款 | 已退款，营收不计 |
| 99000011 | K2b | 京东单 90：中台已发货、京东后来已完成 | 已完成，营收 90 |
| 99000012 / 13 | K10 | 同一个码，先扫的成功、后扫的重复 | 扫码次数 1 / 0 |
| 99000014 | K8 | 会员上海（早）、奶站苏州、扫码杭州（最晚） | 统一消费者城市上海 |
| 99000015 | K5 | 会员中心同意短信、奶站后来撤回 | 短信 revoked |
| 99000016 | L1 | 商城单 120、扫码 3×10、签到 5、补偿 5、兑换 −100 | 余额 60；近 90 天扫码积分 30 |
| 99000017 | L2 | 商城单 80 退款，+80 后 −80 | 余额 0 |
| 99000018 | L3 | 流水 200，会员卡写 999 | 断言报 1 个会员、差额 799 |
| 99000019 | E1 | 近 30 天扫码 5 次、没下过单 | 高频扫码；扫码未购 |
| 99000020 | E2 | 奶站账单北京时间 07:30 出账 | UTC 前一天 23:30 |
| 99000021 | C1 | 3 张券：核销、过期、未用 | 核销率 1/3 |
| 99000022 | SUB | 季卡在订、月卡暂停（第二轮季卡也暂停） | 在订 1 → 0 |
| 99000023 | W1 | 进两个群、退一个 | 进群 2 |
| 99000024 | K4 | 天猫单两行，一行没填商家编码 | 一行明细商品为空 |
| 99000025 | T1 | 试饮报名两场、领取一场 | 领取 1 |
| 99000031–35 | S1 | 商城、奶站、天猫、京东、抖音各 6 笔，1/2/4/8/16/32 对应 6 种状态 | 营收 14.00；订单数 3 |

## 五、已知缺口

| issue | 现象 | 在哪一步看到 |
|---|---|---|
| #252 | 先合后拆以后退役 ID 的别名指向别人，点查返回别人的结果 | T2.5、T9.4 |
| #254 | 占位号、代填号把不相干的人并成一个，没有提示 | T2.4、T2.6 |
| #255 | 指标做不了按商品品类的口径 | T5.6、T6.3 |
| #256 | 点查只认统一消费者 ID | T9.5 |
| #257 | 独占冲突的报错没提键空间与合并组 | T3.1、T3.4 |
| #149 | 地推表、经销商销量不能在页面上传（要先放 S3） | T1 |
| #15、#24 | 人群导出、删除请求还没做 | T9 |
