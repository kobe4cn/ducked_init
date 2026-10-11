# crmlab：多渠道 CRM 测试数据与操作手册

模拟服装品牌「简衣」的会员数据：9 个数据源（POS、自营商城、会员中心、订单中台、天猫、抖店、App 埋点、线下活动报名表、企业微信），覆盖身份打通、主键冲突、积分、券、营销同意、行为、导购、时区、软删除与增量。测试计划和每个用例的设计在 `docs/test-plans/crmlab-plan.md`，这里讲怎么做。

```
scripts/crm-seed/
  truth.sql        真值：人、各源记录、订单、积分、券、同意、行为、企微、活动报名，以及 25 个探针人物
  identity.sql     期望的身份打通（expected_identity）
  round2.sql       第二轮变更（T6）
  seed.ts          生成真值并写进 9 个数据源，建只读账号
  mappings/        33 个映射（文件名：数据源.表或视图.实体[.说明].yaml）
  views/           3 个源视图（抖音买家、活动到场、企微删好友）
  definitions/     11 个指标、4 个标签
  check-mappings.ts 连上数据源取真实列类型，用平台的校验器离线检查映射与定义
  setup.ts         冒烟：不经界面，用同一批领域函数把租户配到出指标（T1–T4）
  verify.ts        拿真值核对租户：身份打通、设备归属、标准层、每个指标与标签的最新快照
  out/             真值库、只读账号（credentials.txt）、规模档数据（out/10m/）；不提交
```

## 一、两档数据

| 档 | 造数命令 | 真实的人 | 源库 / S3 前缀 | 用途 |
|---|---|---|---|---|
| 正确性档 | `seed.ts --persons 50000` | 5 万 + 25 个探针 | `crm_pos`、`crm_mall`、`crm_loyalty`、`crm_oms`、`s3://crm-source/crm/` | 手工测试，界面上翻得过来，一轮几分钟 |
| 规模档 | `seed.ts --persons 10000000 --set 10m` | 1000 万 + 同一批探针 | 名字加后缀 `_10m`，S3 前缀 `s3://crm-source/crm/10m/` | T10 性能基线 |

两档互不覆盖，可以同时存在；只读账号和 S3 密钥共用（`out/credentials.txt`）。造数可以重复跑：每个源先删后建，探针的数值不随规模变化。

```bash
# 默认数据终点是今天（UTC）：订单、行为都在这一天之前，探针的时间相对它取
node --env-file=.env --import tsx scripts/crm-seed/seed.ts --persons 50000
# 只重写某几个源：--only truth,mall,loyalty,pos,oms,tmall,douyin,events,activity,wecom,accounts
# 第二轮变更（T6）：就地改源端，不重建
node --env-file=.env --import tsx scripts/crm-seed/seed.ts --round 2
```

5 万人档造数约 10 秒。千万级的耗时记在 `docs/test-plans/crmlab-10m-baseline.md`。

## 二、冒烟（我先跑过一遍，你也可以随时用它确认环境没问题）

```bash
node --env-file=.env --import tsx scripts/crm-seed/check-mappings.ts        # 33 个映射 + 15 个定义，全 ✔
node --env-file=.env --import tsx scripts/crm-seed/setup.ts --tenant crmlab-smoke
node --env-file=.env --import tsx scripts/crm-seed/verify.ts crmlab-smoke     # 期望：没有 ✘
```

`setup.ts` 另有两步：`--step sync`（重新同步全部数据源，随后自动合并）和 `--step recompute`（以今天为 asOf 重算全部指标与标签，#143 之前的临时办法）。冒烟租户 `crmlab-smoke` 已经建好，5 万人档上 `verify.ts` 全部通过。

## 三、手工测试

### T0 准备

1. 造数：`seed.ts --persons 50000`（已经造好，可以直接用）。
2. 建租户：`pnpm tenant:create --slug crmlab --name 简衣 --admin-email admin@crmlab.test`。到 `/ops` 把它的配额调成 16 线程、65536 MB（默认 2 线程、2 GB 也能跑，只是慢）。**并发任务数先保持 1**（大于 1 时会碰上 #155）。
3. 三个终端：`pnpm dev`（登录链接打印在这里）、`pnpm dispatcher`（全程别关）、一个跑检查命令。
4. 用 `admin@crmlab.test` 登录，到「成员」邀请：`eng@crmlab.test`（数据工程师）、`an@crmlab.test`（分析师）、`view@crmlab.test`（查看者）。映射与定义都要两个人才能发布：下面统一由 **eng 起草、admin 发布**（映射）、**an 起草、eng 发布**（指标与标签）。
5. 三个互不相干的浏览器窗口（普通、无痕、另一个浏览器）分别登录 admin、eng、an。

检查命令都长这样（只读挂载租户的数据湖）：

```bash
node --env-file=.env --import tsx scripts/lake-sql.ts crmlab "SELECT count(*) FROM silver.\"order\""
node --env-file=.env --import tsx scripts/crm-seed/verify.ts crmlab            # 任何时候都可以跑，没映射的部分显示「未映射」
```

### T1 数据源（eng）

「数据源」→ 登记下面 9 个（账号见 `out/credentials.txt`），每个都点「测试连接」：

| 登记名（必须用这个名字，verify.ts 认它） | 类型 | 连接 |
|---|---|---|
| `pos_mysql` | MySQL | localhost:3306，库 `crm_pos` |
| `mall_pg` | PostgreSQL | localhost:5432，库 `crm`，schema `crm_mall` |
| `loyalty_pg` | PostgreSQL | 同上，schema `crm_loyalty` |
| `oms_mongo` | MongoDB | localhost:27017，库 `crm_oms`，认证库 `admin`（只在 K2 用） |
| `tmall_s3` | S3 | 前缀 `s3://crm-source/crm/tmall/`，Parquet |
| `douyin_s3` | S3 | 前缀 `s3://crm-source/crm/douyin/`，CSV |
| `events_s3` | S3 | 前缀 `s3://crm-source/crm/events/`，JSON（规模档是 Parquet） |
| `activity_s3` | S3 | 前缀 `s3://crm-source/crm/activity/`，CSV |
| `wecom_duckdb` | DuckDB 文件 | `s3://crm-source/crm/wecom/wecom.duckdb` |

S3 都是：端点 `localhost:8333`，区域 `us-east-1`，路径风格 path，不用 SSL。

| # | 操作 | 期望 |
|---|---|---|
| T1.1 | 每个数据源选上全部表，等采集完 | 表数：pos 6、mall 4、loyalty 7、oms 1、tmall 2、douyin 1、events 2、activity 1、wecom 3 |
| T1.2 | 确认水位线：有 `updated_at` / `update_time` 的选它；`points_ledger` 没有候选（全量比对） | 文件类的表（S3、DuckDB）没有主键：声明业务主键，见下表 |
| T1.3 | pos `sales` 确认软删除字段 `is_void` | |
| T1.4 | 每个数据源点「同步」 | 原始层行数与 `verify.ts` 的「标准层」期望行数一致（映射前看 `bronze_<数据源ID>` 的表）；敏感列是密文 |

业务主键：tmall `buyers`→`buyer_id`、`trades`→`tid`；douyin `dy_orders`→`订单编号`；events `events`→`event_id`、`users`→`user_id`；activity `signups`→`报名编号`；wecom `contacts`→`external_userid`、`chats`→`chat_id`、`mass_sends`→`send_id`。

观察点：抖店 CSV 的「买家手机号」被读成整数（DuckDB 自动推断），映射里要 `string()` 转回文本；活动表的「报名时间」是 `2026/9/1 14:05` 这种写法，被推断成了时间。

### T2 映射与主键（eng 起草、admin 发布）

每个映射：「映射」→ 新建 → 选数据源、表、实体 → 把 `mappings/` 里对应文件的内容粘进编辑器 → 保存 → 让 admin 发布。文件开头的注释说明了这张表的源端特点和对应的用例。

| # | 操作 | 期望 |
|---|---|---|
| T2.1 | 消费者：pos `members`、mall `users`、loyalty `members`、tmall `buyers`、wecom `contacts`、events `users`、activity `signups`。抖音先到 douyin 数据源页建源视图 `douyin_buyers`（`views/douyin_s3.douyin_buyers.sql`），发布后映射 `douyin_s3.douyin_buyers.customer.yaml` | eng 不能发布自己的草稿；`verify.ts --only identity`：缺失、被拆开、误合并都是 0，统一消费者 59,161 |
| T2.2 | **K1**：先把 pos `sales` 与 mall `orders` 的映射里的 `key_space` 删掉再发布 | 后合并的那个失败，列出冲突的订单号（两边都从 1 开始）。映射页「键体检」提示一致比例低、建议键空间 |
| T2.3 | 加回 `key_space: pos` / `mall` 重新发布 | 合并成功；`SELECT count(*) FROM silver."order"` = pos + mall 之和 |
| T2.4 | **K1b**：pos `sale_items` 的 `order_id` 先不写 `key_space` | 发布被拒：「引用字段要写上目标实体在同一数据源里声明的键空间」。补上后通过 |
| T2.5 | **K7**：pos `sales` 的 `where: store_code <> 'T999' and is_void = 0` | 标准层没有 T999 的单；合并记录里过滤掉 37 行 |
| T2.6 | 订单的其余两个源（tmall `trades`、douyin `dy_orders`）、明细（mall）、商品（只有 mall，K3） | `verify.ts --only silver` 订单、明细都是 ✔ |
| T2.7 | **K2 / K6**：映射 `oms_mongo.orders.order.k2.yaml` 并发布 | 合并失败：订单号与天猫重复（同一批订单两路接入）。按 `tid` 去重后 P01 天猫单是 150 不是 999（K6，看空跑结果）。⚠️ 映射发布后撤不下来（#156）：发一个加了 `where: "false"` 的新版本让它不出行，合并恢复正常 |
| T2.8 | 自定义实体：「实体」→ 登记 `custom_region`（region_id、region_name）、`custom_store`（store_id、store_name、region_id；关系 `order.store_id → custom_store.store_id`、`custom_store.region_id → custom_region.region_id`）、`custom_guide`（guide_id、guide_name 敏感、store_id；关系 `customer.x_guide_id → custom_guide.guide_id`、`custom_guide.store_id → custom_store.store_id`），都是「维度」，主键是各自的 ID。再映射 pos 的 regions、stores、guides | 关系要在订单、企微联系人的映射发布之后才能登记（要从已发布映射里取字段类型） |
| T2.9 | 其余：loyalty 的会员、积分流水、券模板、券、同意、偏好；pos `members` 的短信同意；events `events`；wecom `chats`、`contacts` 的事件、`mass_sends`；activity `signups` 的事件。删好友与活动到场要先建源视图 `contact_deletes`、`attendances`（`views/`），再映射 | **同一张源表到同一个实体只能有一个映射**：一张表要出两类事件时用源视图拆。`verify.ts --only silver` 全部 ✔；设备归属不符 0 |

批量同步之后，如果有映射的「最近合并」比别的早：这是平台的既定行为（一次合并正在跑时，其他同步结束不再入队合并，等定时检查补上），点「立即合并」即可。

### T3 指标（an 起草、eng 发布）

「分析」→ 新建定义 → 指标，键用文件名，内容粘 `definitions/metric/<键>.yaml`。发布后 `pnpm dispatcher` 会算出快照。每发布一个都可以跑 `verify.ts crmlab --only metrics`。

| 键 | 探针的期望（第一轮） |
|---|---|
| `revenue_365d` | S1 每个源 14.00（只算 paid / shipped / completed）；P01 750.00；E2 88.00 |
| `order_count_365d` | P01 4；S1 每源 3 |
| `channel_count` | P01 4（store、miniapp、web、tmall） |
| `revenue_by_region` | P01：华东 300（门店 S001）、未关联 450（线上没有门店） |
| `revenue_by_city` | ⚠️ P01 分成三行：上海 300（商城）、杭州 300（POS）、未关联 150（天猫没城市）（K8，#145） |
| `points_balance` | L1（P01）15；L2 0；L3 200（源端余额写的 999，对不上，#148） |
| `points_earned_90d` | P01 100；L2 80 |
| `views_7d` | E1 10；⚠️ P06 的 12 次匿名浏览不算（#154），verify 另外列出能归属到人的匿名浏览数 |
| `coupons_redeemed` | C1 1 |
| `wecom_chats_30d` | P12 在导购 G0001 下 4 次 |
| `activity_attended` | E3 1；P05、P11 各 1 |

E2 是时区边界：POS 那笔单是北京时间 `--end` 前 4 天的 07:30，标准层的 `created_at` 是 UTC 前一天 23:30。在湖里看：`SELECT created_at FROM silver."order" WHERE amount = 88`。

### T4 标签（an 起草、eng 发布）

`definitions/tag/` 下 4 个：`value_tier`（营收 ≥ 5000 高、≥ 1000 中、其余低）、`omni_channel`（P01 全渠道）、`points_active`、`high_intent`（E1 命中）。`verify.ts` 会按平台上这一版的规则算出各取值的人数并逐人比对。⚠️ 标签只覆盖指标结果里有的消费者，从没下过单的人不会有 `value_tier = 低`（#146）。

### T5 发布、依赖与回刷

| # | 操作 | 期望 |
|---|---|---|
| T5.1 | 删除 `revenue_365d` | 被拒，列出 `value_tier` |
| T5.2 | 起草 `revenue_365d` 第 2 版：状态过滤去掉 `shipped`，看发布前的影响预览 | 列出 `value_tier` 与换档的人数 |
| T5.3 | 发布第 2 版 | 指标与 `value_tier` 同时入队；`tag_key` 不变，旧快照不动。`verify.ts` 对这个指标显示「与 definitions/ 不同，跳过」（改过的定义不核对） |
| T5.4 | 回刷 | 旧 asOf 出现第 2 版快照；再点提示「没有需要回刷的快照」 |

### T6 持续同步（第二轮变更）

```bash
node --env-file=.env --import tsx scripts/crm-seed/seed.ts --round 2
```

改了这些（真值同时更新，`verify.ts` 的期望按第二轮算）：

| 变更 | 源端 | 平台要怎么发现 |
|---|---|---|
| 新增约 0.5% 人的订单（商城与 POS，各 1 行明细） | PG / MySQL 插入，修改时间是现在 | 水位线增量 |
| P08 在商城补了手机号 | PG 更新 | 增量；P08 的两条记录合成一个消费者（⚠️ `consumer_id` 可能变，#147） |
| P01 的网页单（100.00）退款 | PG 更新 | 增量；P01 营收 750 → 650 |
| 天猫导出文件少了 5 笔 | Parquet 重写 | 全量比对发现删除 |
| POS 作废 3 笔 | `is_void = 1` | 软删除；映射的 `where` 也挡住 |
| 商品 SKU00001 改品类 | PG 更新 | 增量 |
| P11 重新报名，手机号填对了 | CSV 重写 | 全量比对；新报名记录并入商城那个人，错号那条仍单独 |

| # | 期望 |
|---|---|
| T6.1 | 到点自动同步、合并（或在数据源页手动同步）；`verify.ts --only identity,silver` 全部 ✔，统一消费者 59,161 → 59,160 |
| T6.2 | 记下 P08 的 `consumer_id` 前后是否变化（verify 的探针表有前缀） |
| T6.3 | ⚠️ 指标与标签的快照不会自己更新（#143）：`verify.ts --only metrics` 会显示不符。临时办法：`setup.ts --tenant crmlab --step recompute` |
| T6.4 | RFM 模板「重新计算」后反映新数据 |

### T7–T9

- T7 RFM：照 `scripts/rfm-seed/README.md` 的方式发布 RFM 模板（asOf 用 `--end` 前一天），改分箱发第 2 版比较。
- T8 对外与合规：断言、点查、人群导出、删除请求还没做（#13、#14、#15、#24、#148），先跳过。
- T9 权限（穿插做）：查看者看不到发布按钮；分析师不能发布映射；起草人不能发布自己的草稿；查看敏感明文要解密权限，并留审计。

### T10 千万级（`crmlab-10m`）

造数：`seed.ts --persons 10000000 --set 10m`。数据源登记时用 `_10m` 的库与 schema、`crm/10m/` 的 S3 前缀（`setup.ts --set 10m` 会自动这样登记）。每一步的耗时与峰值内存记进 `docs/test-plans/crmlab-10m-baseline.md`；核对用 `verify.ts crmlab-10m --set 10m`。

## 四、探针速查

| pid | 用例 | 构造 | 期望 |
|---|---|---|---|
| 99000001 | P01 全渠道 / L1 / K5 / K8 | pos、mall、tmall、wecom、loyalty；4 笔订单；积分 earn 100、spend −30、redeem −50、expire −10、adjust +5 | 一个消费者；4 个渠道；营收 750；余额 15；两条短信同意（会员中心同意、POS 撤回）都在标准层 |
| 99000002 / 03 | P02 换号 | 邮箱相同、手机不同 | 两个消费者（手机冲突，邮箱不连） |
| 99000004 / 05 | P03 家人共用邮箱 | 同上 | 两个 |
| 99000006 | P04 天猫无身份 | 没有 unionid 和手机 | 单独一个 |
| 99000007 | P05 手机格式 | `+86 139-…`、`139…`、`139 0000 0007` | 一个 |
| 99000008 | P06 匿名后登录 | 设备匿名浏览 12 次后登录 | 设备归属到他；⚠️ 指标里不计（#154） |
| 99000009 / 10 | P07 共享设备 | A 先登录、B 后登录 | 设备归 B |
| 99000011 | P08 后来才连上 | 商城只有邮箱、POS 只有手机 | 第一轮两个，第二轮一个 |
| 99000012 | P09 抖音未授权 | 只有 openid 与脱敏手机 | 单独一个（真实限制） |
| 99000013 | P10 抖音授权 | openid + 明文手机 = 商城手机 | 并入商城 |
| 99000014 | P11 活动错号 | 手机少一位 | 第一轮两个（错号一个、商城一个），第二轮重新报名后仍是两个（新报名并入商城） |
| 99000015 | P12 企微导购 | unionid 同天猫，被 G0001 添加 | 并入天猫；导购 G0001 下 4 次聊天 |
| 99000016 | L2 退款冲回 | 商城单 80 退款，积分 +80 后 −80 | 余额 0；不计营收 |
| 99000017 | L3 余额不一致 | 流水 200，`membership.points` 999 | ⚠️ 发现不了（#148） |
| 99000018 | E1 浏览未购 | 近 7 天浏览 10、加购 2、无订单 | `views_7d` = 10；⚠️「浏览未购」写不出（#146） |
| 99000019 | E2 时区边界 | 北京时间 07:30 的 POS 单 | 标准层是 UTC 前一天 23:30 |
| 99000020 | E3 活动到场 | 报名 2 场、到场 1 场 | 到场 1 |
| 99000021 | C1 券 | 3 张：核销、过期、未用各 1 | 核销 1；⚠️ 核销率写不出（#146） |
| 99000031–34 | S1 状态 | 每个下单源 6 笔，金额 1/2/4/8/16/32 对应 6 种状态 | 营收 14.00 |

## 五、已知缺口

| issue | 现象 | 在哪一步看到 |
|---|---|---|
| #143 | 标准层更新后，指标、标签、模板不自动重算 | T6.3 |
| #144 | 同一批订单两路接入只能二选一，不能合并互补字段 | T2.7 |
| #145 | 同一个人多源的属性、同意没有取舍 | K5、K8 |
| #146 | 标签只能引用一个指标、只覆盖有指标结果的人；没有比率 | T4、E1、C1 |
| #147 | 后来连上的人，统一消费者 ID 可能变 | T6.2 |
| #148 | 积分余额与流水对不上发现不了 | L3 |
| #149 | 活动报名表不能直接在页面上传 | T1 |
| #150 | 埋点里的用户 ID 属于商城，平台只在本数据源内解析：现在靠埋点源的用户档案表 `users` 并人 | T2.1 |
| #154 | 匿名事件不计入设备主人 | P06 |
| #155 | 并发任务数大于 1 时，空的结果层上同时跑多个计算会冲突 | T0（并发先保持 1） |
| #156 | 发布的映射撤不下来 | T2.7 |
