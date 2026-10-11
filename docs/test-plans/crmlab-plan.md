# crmlab：多渠道 CRM 端到端手工测试计划

> 造数脚本 `scripts/crm-seed/` 沿用 `scripts/rfm-seed/` 的结构：真值库 + 写入各数据源 + 核对脚本。**操作步骤以 `scripts/crm-seed/README.md` 为准**，这里讲设计与用例。
> 5 万人档已在冒烟租户 `crmlab-smoke` 上端到端跑通（`setup.ts` + `verify.ts`）：身份打通、标准层、11 个指标与 4 个标签逐行与真值一致，第二轮变更后同样一致。
> 用例「状态」：✅ 现在可测　⚠️ 可测，但结果暴露已知缺口（期望写的是**当前行为**，附缺口 issue）　⏳ 依赖未完成的 issue

---

## 0. 结论：多数据源的主键问题解决到哪一步

同一个主键出现在多个映射里，平台分三种情况（ADR-0024）：

| 情况 | 例子 | 平台现在怎么处理 | 是否解决 |
|---|---|---|---|
| 编号各自独立（应**带来源区分**） | POS 与商城订单号都从 1 开始 | 默认**独占**：撞键的映射合并失败并列出冲突键；声明 `key_space` 后主键写成 `pos:1` / `mall:1`，引用字段同样声明，发布时检查一致 | ✅ |
| 同一批对象两路进来（应**去重合并**） | 天猫订单既从 S3 导出、又经订单中台进来 | 独占拦住，冲突体检建议去掉一边 | ❌ #144 |
| 共用的主数据（应**只留一份**） | 商城维护 SKU，POS 只引用 | 约定一个数据源维护、其他只引用 | ✅ 单源维护可行；多源各维护部分字段 ❌ #144 |
| 消费者 | 两个源都有 `customer_id = 1` | 按 `(_source, customer_id)` 区分，身份打通归并 | ✅ |
| 主键含 `customer_id` 的实体 | 同一人两个渠道的营销同意 | 按数据源内唯一，两行都留 | ⚠️ 消费者层无取舍 #145 |
| 同一映射内的重复 | Mongo 同一订单两个版本文档 | 去重键 + 取最新 | ✅ |
| 同一人多源属性不一致 | 商城上海、POS 杭州 | 无黄金记录，按城市做维度时此人算两行 | ❌ #145 |
| 引用别的数据源的消费者 | 埋点的 `user_id` 是商城用户 ID | 只在本数据源内解析：埋点源要有自己的用户档案表才能并人 | ❌ #150 |
| 撤下发布错的映射 | K2 映射了重复的订单中台 | 映射发布后不能停用，只能发 `where: "false"` 的新版本 | ❌ #156 |

**覆盖**（同键后到者悄悄覆盖）平台故意不做；**带来源区分**已完整；**去重**只在单个映射内完整。

---

## 1. 剩余 issue 的执行顺序

| 阶段 | issue | 理由 |
|---|---|---|
| A 数据可信 | #13 断言与隔离区（含 #148 积分对账）→ #22 结构变化 → #45 新列提醒 → #116（先设计） | 定期同步的前提是坏数据不进结果层 |
| B 结果持续更新 | **#143** 定时重算 | 不做的话指标、标签、服务库永远停在发布那天 |
| C 合并与消费者 | **#145** 黄金记录 → **#147** ID 稳定性 → **#144** 跨映射合并 | #145、#147 是 #14 点查的前提；#144 按需 |
| D 分析能力 | **#146** DSL 表达力 → #16 其余模板（user_360 依赖 #145） | |
| E 数据接入 | **#149** 文件上传 | 线下活动、导购名单 |
| F 对外服务 | #14 服务库 → #15 人群导出 → #24 删除请求 | |
| G 研发效率 | #23、#36、#25 | |
| H 模型辅助 | #18 → #19 → #20、#21 | |

千万级规模测试（第 5 节 T10）建议在阶段 B 之前先跑一轮：#143 的刷新策略、#145 的计算方式都要按实测成本定。

---

## 2. 场景：「简衣」服饰美妆品牌

### 2.1 租户与成员

```sh
pnpm tenant:create --slug crmlab --name "简衣 CRM 测试" --admin-email admin@crmlab.test
```
邀请 `eng@crmlab.test`（数据工程师）、`an@crmlab.test`（分析师）、`view@crmlab.test`（查看者）。
规模档在 `/ops` 把配额调到 16 线程、65536 MB（本机 16 核 128 GB）。

重来一轮：`pnpm lake:reset --tenant crmlab --yes` 只清数据湖（数据源、映射、定义保留，重新同步即可）；连配置一起重来就换 slug。正确性档与规模档用两个租户：`crmlab`、`crmlab-10m`（租户标识只允许小写字母、数字与连字符）。两档的源数据也各自独立（`seed.ts --set 10m`），可以并存。

### 2.2 九个数据源

| 登记名 | 类型 | 表 | 业务 | 源端特点（映射要处理的） |
|---|---|---|---|---|
| `pos_mysql` | MySQL `crm_pos` | stores、regions、guides、members、sales、sale_items | 门店收银 | 中文状态；北京时间；手机 `+86 139-xxxx-xxxx`；散客单 `member_id` 空；**订单号从 1 开始**；测试门店 `T999`；`is_void` 软删除 |
| `mall_pg` | Postgres `crm_mall` | users、orders、order_items、products | 自营商城 + 小程序 | timestamptz；channel = web / miniapp；**订单号也从 1 开始**；商品主数据只在这里 |
| `tmall_s3` | S3 Parquet | buyers、trades | 天猫旗舰店 | Unix 毫秒；只有 unionid 与掩码手机；无水位线（全量比对） |
| `douyin_s3` | S3 CSV | dy_orders | 抖店 | 每单一行、买家信息内嵌在订单里（同一买家多行，要用源视图拆出买家）；只有抖音 openid，约 40% 授权了明文手机；金额以分计；状态码数字 |
| `oms_mongo` | MongoDB `crm_oms` | orders | 订单中台 | **全部天猫订单的第二份拷贝**（K2）；嵌套字段；约 2% 订单有旧版本文档 |
| `loyalty_pg` | Postgres `crm_loyalty` | memberships、points_ledger、coupon_templates、coupons、consents、preferences | 会员中心 | 积分 earn / spend / redeem / expire / adjust，带 `balance_after`；同意按渠道 |
| `wecom_duckdb` | DuckDB 文件（S3） | contacts、chats、mass_sends | 企业微信导购 | 外部联系人有 unionid；导购添加 / 删除好友（`add_time` / `del_time`）、聊天 → 行为事件；群发 → 营销触达（渠道 `wechat`） |
| `events_s3` | S3 JSON（规模档 Parquet） | events、users | App / 小程序埋点 | view、add_to_cart、login；匿名事件只有 `device_id`；`user_id` 是商城用户 ID，`users` 是埋点平台的用户档案（手机、邮箱），靠它并人（#150） |
| `activity_s3` | S3 CSV | signups | 线下活动报名表 | 手填：姓名、手机（格式杂、有错号）、活动、报名时间、是否到场；有报名编号（声明为业务主键）。页面直接上传待 #149 |

### 2.3 数据如何进入各层

```
源表 ──同步──▶ 原始层 bronze_<数据源ID>.<表>（变更批次 _op/_batch/_commit_ts，敏感字段加密）
     ──映射合并──▶ 标准层 silver.<实体>（敏感字段加盐哈希，_source/_mapping/_key_space）
                    ├─ silver._identities     源记录 → 统一消费者
                    └─ silver._device_owner   设备 → 统一消费者
     ──指标 / 标签 / 模板──▶ 结果层 gold.*（每次一张快照，记 asOf 与定义版本）
```

| 标准实体 | 来自 | 关键配置 |
|---|---|---|
| customer | pos.members、mall.users、loyalty.members、tmall.buyers、douyin 买家（源视图）、wecom.contacts、events.users、activity.signups | 默认身份规则：手机 > 邮箱 > 外部 ID（unionid → `external_id`；抖音 openid 只当 `customer_id`，不当外部 ID） |
| order | pos.sales（`key_space: pos`，`where: store_id <> 'T999'`）、mall.orders（`key_space: mall`）、tmall.trades、douyin.dy_orders | **不映射 oms.orders**（K2 先映射再撤下） |
| order_item | pos.sale_items（引用 `key_space: pos`）、mall.order_items（`key_space: mall`） | `product_id` 跨源引用 mall 的商品 |
| product | 只有 mall.products | 主数据单一来源（K3） |
| membership / points_transaction / coupon / coupon_template / consent / preference | loyalty_pg | `points_change` 带正负 |
| event | events.events、wecom.contacts（添加）/ 源视图 contact_deletes（删除）/ chats、activity.signups（报名）/ 源视图 attendances（到场） | 匿名事件 `customer_id` 为空；**同一张源表到同一个实体只能有一个映射**，第二类事件用源视图拆 |
| touch | wecom 群发 | 渠道 `wechat` |
| 自定义实体 `store`、`region`、`guide` | pos.stores / regions / guides | 关系 `order.store_id → store → region`；`x_guide_id` → guide |

---

## 3. 两档数据量

| 档 | 真实的人 | 用途 | 核对方式 |
|---|---|---|---|
| 正确性档 `crmlab` | 50,000 + 探针 | 每条功能用例，界面上可翻看，一轮几分钟 | 真值逐人比对 |
| 规模档 `crmlab_10m` | 10,000,000 + 同一批探针 | 性能、内存、增量；同样的探针保证规模下结果仍对 | 探针逐人 + 全量汇总（人数、金额、分布）与真值比对 |

规模档的数据量估计（每人随机出现在 1–5 个源）：

| 表 | 行数 | 落在 |
|---|---|---|
| 各源消费者记录 | ≈ 2,600 万 | MySQL / PG / Parquet / CSV / DuckDB |
| 订单（POS 1,800 万、商城 2,000 万、天猫 1,500 万、抖音 600 万） | ≈ 5,900 万 | 同上 |
| oms 天猫拷贝 | 1,500 万 | Mongo |
| 订单明细 | ≈ 1 亿 | MySQL / PG |
| 积分流水 | ≈ 8,000 万 | PG |
| 券 | ≈ 3,000 万 | PG |
| 行为事件 | ≈ 3 亿 | S3 Parquet（按月分文件） |
| 企微联系人 / 聊天 | 400 万 / 2,000 万 | DuckDB |
| 活动报名 | 50 万 | CSV |

源端约 150 GB，本机剩余 1.3 TB 够用。造数先在本机 DuckDB 生成真值与 Parquet，再用 `LOAD DATA` / `COPY` / `mongoimport` 批量写入，预计 2–4 小时。

---

## 4. 探针（每个对应一眼能看出对错的效果）

### 身份打通（P）

| 探针 | 构造 | 正确结果 |
|---|---|---|
| P01 全渠道 | pos（手机）、mall（手机+邮箱+unionid）、tmall（unionid）、wecom（unionid）、loyalty 会员 | 一个消费者；订单渠道 4 个；城市：mall 上海、pos 杭州（K8） |
| P02 换号 | mall 与 pos 邮箱相同、手机不同 | 两个消费者 |
| P03 家人共用邮箱 | 邮箱相同、手机不同 | 两个消费者 |
| P04 天猫无身份 | 无 unionid、无手机 | 单独一个 |
| P05 手机格式 | pos `+86 139-0000-0005`，mall `13900000005`，活动表 `139 0000 0005` | 一个 |
| P06 匿名后登录 | 设备 D6 匿名浏览 12 次，后在该设备登录 | 设备归属到 P06；⚠️ 指标不计匿名事件（#154） |
| P07 共享设备 | D7 先被 A、后被 B 登录 | 匿名事件全部归 B |
| P08 后来才连上 | 第一轮 mall 与 pos 无共同字段；第二轮 pos 补了手机 | 第二轮合并；⚠️ `consumer_id` 可能变（#147） |
| P09 抖音未授权 | 只有 openid | 单独一个；⚠️ 与同一人的商城记录连不上（真实限制，非缺陷） |
| P10 抖音授权 | openid + 明文手机，与商城手机相同 | 并入商城那个人 |
| P11 活动错号 | 报名表手机少一位 | 单独一个；规范化不能「猜」号 |
| P12 企微导购 | wecom 联系人 unionid 与天猫相同，被导购 G01 添加 | 并入；导购维度能算到 G01 |

### 主键（K）

| 用例 | 构造 | 正确结果 |
|---|---|---|
| K1 编号独立 | pos 与 mall 订单号都从 1 开始 | 不声明键空间：后合并的映射失败并列出冲突键；体检「一致比例低 → 键空间」；声明后订单数 = 两边之和 |
| K1b 引用忘了键空间 | sale_items.order_id 不写 `key_space` | 发布被拒，列出字段 |
| K2 重复接入 | oms.orders 与 tmall.trades 同一批 tid | 映射 oms 后合并失败；体检判为重复接入；撤下后天猫金额不翻倍；⚠️ 不能合并互补字段（#144） |
| K3 共用主数据 | POS 明细引用 mall 的 SKU | 按 `order_item.product_id → product.category` 分组时 POS 明细也有品类 |
| K4 消费者同号 | pos 与 mall 都有 `customer_id = 1`（不同人） | 两个消费者 |
| K5 同意冲突 | P01 在会员中心同意短信（早），POS 撤回（晚） | ⚠️ 两行都在，无「当前是否同意」（#145） |
| K6 旧版本文档 | oms 里 P01 的天猫单另有旧版本文档（WAIT_BUYER_PAY 999 → TRADE_FINISHED 150） | 去重后 1 笔 150.00 |
| K7 行过滤 | pos 测试门店 T999 有 37 笔 | 标准层没有；合并记录显示过滤 37 行 |
| K8 属性冲突 | P01 城市上海 / 杭州 | ⚠️ 按城市的指标里 P01 两行（#145） |
| K9 抖音买家拆分 | dy_orders 每单一行，买家内嵌 | 源视图按 openid 拆出买家：每个买家 1 条消费者记录；没下过单的抖音用户不在导出里 |

### 交易、积分、行为、券（L、E、C、S）

| 用例 | 构造 | 正确结果（时间相对造数的 `--end`；探针 pid 见 README「探针速查」） |
|---|---|---|
| L1 积分全周期 | P01：earn +100、spend −30、redeem −50、expire −10、adjust +5 | 余额 15；近 90 天获得 100；`membership.points` = 15 |
| L2 退款冲回 | 商城单 80 退款，积分 +80 后 adjust −80 | 余额 0；refunded 不计营收 |
| L3 余额不一致 | `membership.points = 999`，流水求和 200 | ⚠️ 发现不了（#148） |
| E1 浏览未购 | 近 7 天浏览 10、加购 2、无订单 | 浏览指标 10；⚠️「浏览未购」写不出（#146） |
| E2 时区边界 | `--end` 前 4 天北京时间 07:30 的 POS 订单 | 标准层 `created_at` 是 UTC 前一天 23:30，按 UTC 日期计入窗口 |
| E3 活动到场 | 报名 2 场、到场 1 场 | 到场数 1 |
| C1 券 | 领 3 张：核销 1、过期 1、未用 1 | 核销数 1；⚠️ 核销率写不出（#146） |
| S1 状态探针 | 每个订单源各一人，金额 1/2/4/8/16/32 对应 6 种状态 | 默认营收只含 paid/shipped/completed = 14.00 |

---

## 5. 测试计划

每个阶段我陪你做：你在界面操作，我给出要看的页面、检查 SQL（`node --env-file=.env --import tsx scripts/lake-sql.ts crmlab "<SQL>"`）和期望值；对不上时一起看任务日志。

### T0 准备
- 造数：`node --env-file=.env --import tsx scripts/crm-seed/seed.ts --persons 50000`（规模档 `--persons 10000000 --set 10m`）。只读账号在 `out/credentials.txt`。
- 三个终端：dev server、`pnpm dispatcher`、检查 SQL；三个无痕窗口登录 admin@、eng@、an@。

### T1 数据源 ✅
| # | 操作 | 期望 |
|---|---|---|
| T1.1 | 登记 9 个数据源，各点「测试连接」 | 都通过 |
| T1.2 | 同步范围，确认主键 / 水位线 / 软删除（pos.sales `is_void`）；活动表声明业务主键 手机+活动 | Mongo 主键 `_id`；S3 表提示全量比对 |
| T1.3 | 同步 | 原始层行数与造数报告一致；敏感列为密文 |
| T1.4 | 湖中核对 | 覆盖率 100% |

### T2 映射与主键 ✅ / ⚠️
| # | 操作 | 期望 |
|---|---|---|
| T2.1 | 映射 6 个消费者来源（抖音先建源视图拆买家），双人发布 | 起草人不能发布自己的；`_identities` 消费者数 = 真实人数 |
| T2.2 | 映射 pos.sales 与 mall.orders，都不写键空间 | K1 |
| T2.3 | 加键空间；sale_items 先不写引用键空间 | K1b，补上后通过 |
| T2.4 | 映射 tmall.trades，再映射 oms.orders | K2、K6，然后撤下 oms |
| T2.5 | `where`、商品只从 mall、登记 store / region / guide 与关系 | K3、K7 |
| T2.6 | 映射积分、券、同意、偏好、事件、企微、活动 | K5；P06、P07、P12、E3 |

### T3 指标 ✅
| 键 | 要点 | 核对 |
|---|---|---|
| `revenue_365d` | order，sum amount，status in paid/shipped/completed，窗口 365 天 | S1 = 14.00；E2；K2 不翻倍 |
| `order_count_365d` | count | |
| `channel_count` | count_distinct channel | P01 = 4 |
| `revenue_by_region` | 维度 `order.store_id -> custom_store.region_id -> custom_region.region_name` | 线上订单「未关联」 |
| `points_balance` | points_transaction，sum points_change | L1（P01）= 15 |
| `points_earned_90d` | change_type = earn，90 天 | L1 = 100 |
| `views_7d` | event_type = view，7 天 | E1 = 10；⚠️ P06 的匿名浏览不计（#154） |
| `coupons_redeemed` | status = redeemed | C1 = 1 |
| `wecom_chats_30d` | event_type = wecom_chat，30 天，维度 `event.x_guide_id` | P12 在 G0001 下 4 |
| `activity_attended` | event_type = activity_attend | E3 = 1 |
| `revenue_by_city` | 维度 `order.customer_id -> customer.city` | ⚠️ K8：P01 三行（上海、杭州、未关联） |

### T4 标签 ✅ / ⚠️
| 键 | 规则 | 核对 |
|---|---|---|
| `value_tier` | revenue_365d ≥ 5000 高、≥ 1000 中，默认低 | 各档人数 = 真值 |
| `omni_channel` | channel_count ≥ 3 全渠道、≥ 2 双渠道，默认单渠道 | P01 全渠道 |
| `points_active` | points_earned_90d ≥ 100 活跃，默认沉默 | |
| `high_intent` | views_7d ≥ 5 | E1 命中；⚠️ 不能叠加「无订单」，从未有行为的人不在结果里（#146） |

### T5 发布、依赖与回刷 ✅
| # | 操作 | 期望 |
|---|---|---|
| T5.1 | 删除 `revenue_365d` | 被拒，列出 value_tier |
| T5.2 | 起草 v2（改状态过滤），看影响预览 | 列出 value_tier 与换档人数 |
| T5.3 | 发布 v2 | 指标与 value_tier 同时入队；tag_key 不变，旧快照不动 |
| T5.4 | 回刷 | 旧 asOf 出现 v2 快照；再点提示没有需要回刷的 |

### T6 持续同步 ⚠️（#143）
`seed.ts --round 2`：新增约 0.5% 人的订单、P08 补手机、P01 网页单退款、tmall 文件删 5 笔、pos 作废 3 笔、一个商品改品类、P11 重新报名填对手机。临时重算：`setup.ts --tenant crmlab --step recompute`。

| # | 期望 |
|---|---|
| T6.1 | 到点自动同步、合并：水位线增量、全量比对发现删除、软删除都正确 |
| T6.2 | P08、P11 合并；记下 `consumer_id` 是否变化（#147） |
| T6.3 | ⚠️ 指标与标签快照不变，直到发新版本（#143） |
| T6.4 | RFM 模板「重新计算」反映新数据 |

### T7 模板 ✅ RFM；⏳ 其余 #16
发布 RFM（asOf 2026-09-30），核对 R/F/M；改分箱发 v2 比较。

### T8 对外与合规 ⏳ #13、#14、#15、#24、#148
断言拦下 L3；按 consumer_id 点查 value_tier；导出 `omni_channel = 全渠道` 人群；对 P03 提交删除请求后各层查不到。

### T9 权限 ✅（穿插）
查看者无发布按钮；分析师不能发布映射；起草人不能发布自己的草稿；查看敏感明文需解密权限并留审计。

### T10 千万级规模（`crmlab_10m`）
同样走 T1–T7，记下每一步的耗时与峰值内存，填进基线表；探针与全量汇总都要对。

| # | 测什么 | 记录 | 关注的风险 |
|---|---|---|---|
| T10.1 | 首次全量同步（每个源） | 耗时、行 / 秒、原始层大小 | Mongo 1,500 万文档经社区扩展读取的速度 |
| T10.2 | 全量比对源（tmall、douyin、activity）的第二次同步 | 耗时 | 无水位线的表每次整表哈希比对（ADR-0010） |
| T10.3 | 首次合并 + 身份打通 | 耗时、峰值内存 | 身份打通每次合并后**整表重算**（2,600 万条记录的传递闭包） |
| T10.4 | 1% 增量同步 + 合并 | 耗时 | 增量合并是否只碰受影响的键；身份打通仍整表 |
| T10.5 | 每个指标、标签、RFM 的计算 | 耗时、快照大小 | 3 亿事件的窗口过滤；标签内联指标 SQL 重复计算 |
| T10.6 | 配额下限：同一任务在 2 线程 / 2 GB 下 | 是否溢出到磁盘、是否失败 | 默认配额对千万级是否够用 |
| T10.7 | 并发：同步与指标计算同时进行 | 两边耗时变化 | 调度器的 `maxWorkers` |
| T10.8 | 快照过期清理 | 耗时、存储回收量 | ADR-0020 的重写与清理 |
| T10.9 | 页面响应：映射列表、快照详情、发布前影响预览 | 秒数 | 影响预览在千万级上实时计算 |

基线表格式：`步骤 | 数据量 | 耗时 | 峰值内存 | 线程 | 结论`。超出可接受范围的（例如首次身份打通 > 30 分钟、增量合并 > 10 分钟）开性能 issue。

---

## 6. 交付物

1. ✅ `scripts/crm-seed/`：`seed.ts`（真值 + 9 个数据源 + 第二轮变更 `--round 2`，`--persons` 控制规模，`--set` 分档）、`mappings/*.yaml`（33 个）、`views/*.sql`（3 个源视图）、`definitions/`（11 个指标、4 个标签）、`check-mappings.ts`（离线校验）、`setup.ts`（冒烟配置）、`verify.ts`（身份打通、设备归属、标准层、每个指标与标签逐行比对）、`README.md`（操作手册）。
2. 规模档基线表 `docs/test-plans/crmlab-10m-baseline.md`。
3. 每个 ⚠️ 用例的实测数字补到对应 issue（#143–#148、#150、#154–#156）作为证据。

### 做造数与冒烟时新发现的缺口

| issue | 发现于 |
|---|---|
| #150 跨数据源引用消费者 | 埋点的 `user_id` 是商城的 ID，单独登记的埋点源里事件归属不到人 |
| #154 行为指标用上设备归属 | `silver._device_owner` 算出来了，但指标编译只用事件自己的 `customer_id` |
| #155 并发结果层任务首次建 gold schema 冲突 | 冒烟租户并发数 4，`lake:reset` 后同时重算 15 个定义，1 个失败 |
| #156 映射停用与删除 | K2 映射了重复的订单中台后撤不下来 |

另外两个平台行为写进了操作手册（不算缺陷）：同一张源表到同一个实体只能有一个映射（第二类事件用源视图拆）；一次合并正在运行时结束的同步不再入队合并，等定时检查补上（可手动「立即合并」）。
