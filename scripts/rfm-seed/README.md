# RFM 整体测试数据（#12：#85–#89）

为 RFM 的整体测试造的一套多数据源数据。**真值已知**：每条源记录属于哪个真实的人、每笔订单的标准状态和 UTC 时间都记在 `out/truth.duckdb` 里。
`verify.ts` 用真值独立算出期望结果，再和平台产出的快照逐个消费者比对，所以不用手算。

用一个**新租户**（下面用 `rfmlab`）来测，不和 lm 混在一起。lm 的标准层有 1.3 亿单 crm 订单，测试数据放进去会被淹没，跑一次也要很久。

## 一、数据是什么

总共 20 万个真实的人（其中约 5% 没有订单），36 万条消费者记录，158 万笔订单，订单时间从 2023-10-05 到 2026-10-03（UTC）。每个人随机出现在 1 到 5 个数据源里。

| 登记名（必须用这个名字） | 类型 | 位置 | 消费者表 | 订单表 | 源端特点（映射要处理的） |
|---|---|---|---|---|---|
| `shop_pg` | Postgres | 库 `crm`，schema `rfm_shop` | customers 14.2 万 | orders 72.1 万 | timestamptz；待支付叫 `pending`；手机、邮箱、unionid 都有 |
| `pos_mysql` | MySQL | 库 `rfm_pos` | members 7.0 万 | sales 28.4 万 | 中文状态；北京时间 DATETIME；手机是 `+86 139-xxxx-xxxx`，邮箱大写带空格；3000 笔散客单 `member_id` 为空 |
| `mini_mongo` | MongoDB | 库 `rfm_mini` | users 6.0 万 | orders 23.6 万单（24.05 万个文档） | 嵌套字段（`contact.email`、`buyer.member_no`、`pay.amount`、`pay.paid_at`）；Date 是 UTC；约 2% 的订单有一个旧版本文档；1500 笔孤儿单（会员号以 M9 开头） |
| `tmall_s3` | S3 Parquet | `s3://crm-source/rfm/tmall/` | buyers 5.0 万 | trades 19.3 万 | 天猫交易状态；时间是 Unix 毫秒；只有 unionid，不在主站的买家才有手机号 |
| `live_duckdb` | DuckDB 文件 | `s3://crm-source/rfm/live/live.duckdb` | viewers 4.0 万 | live_orders 15.0 万 | 单字母状态；金额以分为单位；北京时间；只有手机号（中间带空格） |

**身份打通的设计**：手机号、邮箱、unionid 每个人各不相同，同一个人的记录总能按默认规则（手机 > 邮箱 > 外部 ID）连起来，不同的人不会连起来。所以正确的结果是**统一消费者数 = 真实的人数**。
pg 和 my 的消费者 ID、订单号都是从 1 开始的整数，同号属于不同的人，用来验证标准层按数据源区分 ID。

**探针**（pid 9000xx，每个对应一种要验证的效果）：

| pid | 效果 | 正确结果 |
|---|---|---|
| 900001 / 900002 | S1 换号：邮箱相同、手机号不同（手机优先级更高，有冲突） | **不合并**，两个消费者 |
| 900003 / 900004 | S2 一家人共用一个邮箱，手机号不同 | **不合并** |
| 900005 | S3 传递闭包：s3(unionid) – pg(unionid+邮箱) – mg(邮箱+手机) – dk(手机) | 四个源合成**一个**消费者，F=4 |
| 900006 | S4 天猫买家没有任何身份字段 | 单独成为一个消费者 |
| 900010 | S5 窗口与时区边界，五个源各有订单 | asOf=2026-09-30、回看 365 天时 **R=0 F=4 M=630.00**（按北京时间算会得到别的结果） |
| 900011–900015 | S6 状态探针（pg/my/mg/s3/dk 各一个）：金额 1/2/4/8/16/32 分别对应 created/paid/shipped/completed/cancelled/refunded | 默认状态 M=14.00 F=3；加上 refunded 后 M=46.00 F=4。M 的值能直接看出算进了哪些状态 |
| 900016 | S7 Mongo 同一订单号两个文档：旧版本 UNPAID 999，新版本 PAID 50 | F=1 M=50.00 |

## 二、已经准备好的东西（可重复执行）

```sh
# 重新造数（真值 + 写进五个数据源 + 只读账号）；可以只跑某几步：truth,pg,my,mg,s3,dk,accounts
node --env-file=.env --import tsx scripts/rfm-seed/seed.ts 200000
```

- 只读账号和 S3 密钥在 `out/credentials.txt`。Postgres 用 `rfm_reader`，MySQL 用 `rfm_reader`，Mongo 用 `rfm_ro`，S3 用 `src-rfm-ro`（只能读 `crm-source/rfm/`）。已经验证过这些账号能读、不能写。
- `mappings/*.yaml` 是 10 个映射，已用平台的 `checkMapping` 校验通过。重新校验：`node --import tsx scripts/rfm-seed/check-mappings.ts`。
- `verify.ts` 是核对脚本，用法见第四节。

**重新造数后需要重做第三节的同步、合并。** 要保持真值和源端一致，种子固定，结果每次都一样。

## 三、接入：建租户、加数据源、做映射（一次性）

### 3.1 建租户和成员
```sh
pnpm tenant:create --slug rfmlab --name "RFM 测试" --admin-email admin@rfmlab.test
```
- 用 `admin@rfmlab.test` 登录（magic link 打印在 dev server 的控制台）。到成员页邀请 `eng@rfmlab.test`（**数据工程师**）和 `an@rfmlab.test`（**分析师**）。映射和模板都要两个人才能发布。
- 可选：到 `/ops` 把这个租户的配额调到 4 线程、4096 MB（默认 2 线程、2048 MB 也能跑，只是慢一些）。

### 3.2 登记五个数据源（数据源页 → 新建）
名字**必须**和下表一致，`verify.ts` 靠名字找数据源。

| 名字 | 类型 | 填写 |
|---|---|---|
| `shop_pg` | PostgreSQL | 主机 `localhost`，端口 5432，数据库 `crm`，schema `rfm_shop`，用户 `rfm_reader`，密码 `rfm-reader-secret` |
| `pos_mysql` | MySQL | 主机 `localhost`，端口 3306，数据库 `rfm_pos`，用户 `rfm_reader`，密码 `rfm-reader-secret` |
| `mini_mongo` | MongoDB | 主机 `localhost`，端口 27017，不勾 SRV / TLS，数据库 `rfm_mini`，认证库 `admin`，用户 `rfm_ro`，密码 `rfm-ro-secret` |
| `tmall_s3` | S3 | 文件前缀 `s3://crm-source/rfm/tmall/`，格式 Parquet，端点 `localhost:8333`，区域 `us-east-1`，路径风格 path，不用 SSL，Access Key 和 Secret 见 `out/credentials.txt` |
| `live_duckdb` | DuckDB | 路径 `s3://crm-source/rfm/live/live.duckdb`，对象存储参数同上，用同一把 S3 密钥 |

每个数据源登记后先点「测试连接」，再列出表。应该看到这些表：rfm_shop 的 customers、orders；rfm_pos 的 members、sales；rfm_mini 的 users、orders；tmall 的 buyers、trades；live 的 viewers、live_orders。

### 3.3 同步范围和同步
- 把上面 10 张表都加进同步范围，按页面的候选确认主键和水位线。建议：
  - pg、my、dk 的表：主键用 id 列，水位线用 `updated_at` 或 `modified_at`。
  - Mongo 两个集合：主键用 `_id`。**orders 不能用 `order_no` 作主键**，有些订单号对应两个文档。
  - S3 的两张表：没有水位线，按全量比对。
- 触发同步，等任务都成功。原始层的行数应该和第一节的表一致（Mongo orders 是 240,502 个文档）。

### 3.4 映射（10 个，双人发布）
数据工程师 `eng@` 为每张表新建映射：实体选「消费者」或「订单」，切到「高级」标签，**把 `mappings/<数据源>.<表>.yaml` 的内容整段贴进去**，保存草稿。再由 `admin@` 发布。

注意：
- **不要加 `identity:` 段**，用平台默认规则：手机 > 邮箱 > 外部 ID。lm 的映射写的是 `match: [phone, email]`，没有外部 ID，照抄的话 S3 的买家只有 unionid，就打通不了了。
- Mongo 的时间是 UTC。如果自动生成的草稿写成 `from_timezone(created_at, 'Asia/Shanghai')`，标准层会差 8 小时，探针 S5 和 S7 会对不上。这本身就是一个可以观察的点。
- Mongo orders 映射里的 `dedupe: { key: [order_id], latest: updated_at }` 不能省。
- 发布后平台会入队合并任务，合并后会重算身份打通。

### 3.5 接入完成的检查
```sh
L="node --env-file=.env --import tsx scripts/lake-sql.ts rfmlab"
$L "SELECT _mapping, count(*) FROM silver.customer GROUP BY 1" \
   "SELECT status, count(*) FROM silver.\"order\" GROUP BY 1 ORDER BY 2 DESC" \
   "SELECT count(*) AS 记录, count(DISTINCT consumer_id) AS 消费者 FROM silver._identities"
```
期望：
- silver.customer 的行数和各源消费者数一致，共 362,209 条。
- silver.order 共 1,584,318 笔。Mongo 去重后是 235,998 笔；6 种状态都有，没有空状态。如果有空值，说明值字典漏了。
- `_identities` 里应该是 362,209 条记录、200,013 个消费者。

然后跑一次核对（还没有快照，用 `--params` 只核对打通）：
```sh
node --env-file=.env --import tsx scripts/rfm-seed/verify.ts rfmlab --params '{"asOf":"2026-09-30"}'
```
「身份打通」那张表里，缺失、被拆开的人、误合并的消费者都应该是 0。「探针的打通结果」里 900001 到 900004 各自是一个消费者，900005 和 900010 各自跨了多个源但只有一个消费者。

## 四、按第 1 到 6 步测试（在 rfmlab 上，逐个界面操作）

### 准备：三个终端、三个浏览器窗口
- 终端 1：`pnpm dev`（登录链接打印在这里）。终端 2：`pnpm dispatcher`（跑任务，也负责快照过期检查，**全程别关**）。终端 3：敲下面的命令。
- 三个账号要同时登录，而同一个浏览器的窗口共用登录状态，所以用三个互不相干的窗口：
  - 窗口 A（Chrome 普通窗口）登录 `an@rfmlab.test`，角色是**分析师**：能起草，不能发布。
  - 窗口 B（Chrome 无痕窗口）登录 `eng@rfmlab.test`，角色是**数据工程师**：能起草，也能发布。
  - 窗口 C（Safari 或另一个浏览器）登录 `admin@rfmlab.test`，角色是**管理员**：什么都能做。
- 登录方法：打开 `pnpm dev` 打印的地址（一般是 `http://localhost:5173`）下的 `/login`，输入邮箱，点「发送登录链接」，到终端 1 复制打印出来的链接，在**同一个窗口**里打开。
- 终端 3 里先定义两个简写（fish 语法）：
  ```fish
  alias verify 'node --env-file=.env --import tsx scripts/rfm-seed/verify.ts'
  alias lake   'node --env-file=.env --import tsx scripts/lake-sql.ts rfmlab'
  alias psqlc  'container exec -it postgres-server psql -U crm crm'
  ```

`verify rfmlab [快照ID或任务ID]` 用来核对快照，不带 ID 时取最新一份未过期的快照。快照 ID 就是快照详情页网址 `/analytics/snapshots/<ID>` 的最后一段。正常输出是「快照比对」里各项差异都是 0，最后打印「全部一致 ✔」，再列出探针的期望值和实际值。

### 第 1 步：起草参数，由另一个人发布（#88、#89）
目标：验证分析师只能起草、自己最后保存的草稿不能自己发布、参数不合法时保存不了、发布后自动计算一次。

1. **窗口 A（an@）**：点顶栏「分析」，再点右上角「RFM 模板参数」，进入 `/analytics/templates/rfm`。
   - 应该看到：标题「RFM 分层 · 模板参数」，副标题「当前生效：默认参数」，页面底部写着「还没有保存过参数……」。
   - 表单里是默认参数：回看天数 365；勾选了 completed、paid、shipped；分箱方式是五分位；分群规则表里有 8 条。
2. **测试校验（窗口 A）**：把「分箱方式」改成「固定阈值」，会出现 R、F、M 三个输入框。R 只填 `30, 90, 180`（三个数），点「校验并保存草稿」。
   - 应该看到：页面顶部出现红色错误提示，版本表里没有新增任何一行。
   - 刷新页面，把表单恢复成默认参数。
3. **窗口 A**：不做任何修改，直接点「校验并保存草稿」。
   - 应该看到：「版本」表里出现一行，版本 v1、状态「草稿」、作者 an@、最后保存 an@。这一行最右边**没有**「发布 v1」按钮，原来的位置显示「仅管理员、数据工程师可以……」（分析师没有发布权限）。
4. **窗口 B（eng@）**：打开同一页，能看到 v1 草稿，并且有「发布 v1」按钮。**先别点**。把「回看天数」改成 365（等于不改），点「校验并保存草稿」。
   - 应该看到：作者变成「an@、eng@」，最后保存的人是 eng@。eng@ 的「发布 v1」按钮消失，改成提示「你最后改了这一版草稿，需由另一位数据工程师或管理员发布」。
5. **窗口 C（admin@）**：打开同一页，点「发布 v1」。
   - 应该看到：顶部出现绿色提示「已按新参数入队一次计算，完成后快照出现在分析页」；副标题变成「当前生效：第 1 版」；v1 的状态变成「已发布」，发布列显示 admin@ 和发布时间。
6. （可选）测试丢弃：任意一个窗口再保存一次草稿，出现 v2 草稿；点「丢弃草稿」并确认，v2 消失，生效的仍然是第 1 版。
7. 终端 3 核对数据库：
   ```fish
   psqlc -c "SELECT v.version, v.status, v.authors, v.last_editor, v.published_by_email FROM platform.template_definitions d JOIN platform.template_versions v ON v.definition_id = d.id JOIN platform.tenants t ON t.id = d.tenant_id WHERE t.slug = 'rfmlab' ORDER BY v.version"
   ```
   应该看到：v1 的状态是 published，authors 是 {an@…, eng@…}，last_editor 是 eng@，published_by_email 是 admin@。

### 第 2 步：发布后的那次计算是否正确（#85）
1. **任意窗口**：点顶栏「任务」，列表第一行是「RFM 分层」，状态从「排队中」变到「运行中」再到「成功」，需要手动刷新页面。20 万人的数据大约需要几十秒。
2. 终端 3：`verify rfmlab`。
   - 应该看到「全部一致 ✔」，并且「期望打通不到」等于「任务结果打通不到」。打通不到的单只有两类：my 的散客单和 mg 的孤儿单。
   - 在探针表里看这几个人：
     - 900001 到 900004 是四个不同的 consumer_id。换了手机号、和家人共用邮箱，都不应该被合并。
     - 900005 只有一个 consumer_id，它的 F 包含了四个源的订单。
     - 900011 到 900015 的 M 都是 14.00，F 都是 3。说明五个源各自的状态都被映射到了正确的标准状态。
     - 900016 的 M 是 50.00。说明 Mongo 的旧版本文档没有被算进去。
   - 这次计算的参考日期 asOf 是今天（UTC），所以具体数字和后面表格里 2026-09-30 的数字不一样，以脚本算出来的为准。

### 第 3 步：「分析」页和快照详情（#86）
1. **任意窗口**：点顶栏「分析」。快照列表第一行应该是：
   - 模板：RFM 分层
   - 参考日期：今天
   - 参数：「定义第 1 版」
   - 消费者：约 20 万
   - 过期时间：创建时间加 90 天
   - 状态：「可查看」
2. 点这一行里的「RFM 分层」链接，进入详情页。
   - 四个统计卡片：消费者人数应该等于 verify 输出的期望行数。人群那张卡片应该显示 8，「共 8 个分群规则」。
   - 「人群」标签：每个人群的人数和消费金额，要和 `verify` 打印的「期望的人群分布」逐行一致。
   - 「消费者明细」标签：底部显示「第 1 / N 页」，点「下一页 →」能翻页。页面上只有 consumer_id 和分值，没有手机号等明文。
3. 终端 3：`psqlc -c "SELECT id, definition_version, expires_at - created_at FROM platform.snapshots ORDER BY created_at DESC LIMIT 3"`。
   - 应该看到：definition_version 是 1，过期时间减创建时间是 90 days。

### 第 4 步：参考日期固定时，两次计算的结果完全相同
界面上只能通过「发布」触发计算，而且参考日期只能是当天。要指定参考日期，只能用命令入队：
```fish
set P '{"asOf":"2026-09-30","lookbackDays":365,"statuses":["completed","paid","shipped"],"binning":{"method":"quintile"},"definitionVersion":1}'
pnpm task:enqueue --tenant rfmlab --kind gold.rfm --params $P     # 打印「已提交任务 gold.rfm（id=…）」，记下 id
pnpm task:enqueue --tenant rfmlab --kind gold.rfm --params $P     # 再来一次，记下第二个任务 ID
```
1. 「任务」页：出现两行「RFM 分层」，都是「成功」。「分析」页：多出两份快照，参考日期都是 2026-09-30，参数都是「定义第 1 版」。
2. 终端 3：分别执行 `verify rfmlab <任务1>` 和 `verify rfmlab <任务2>`，都应该打印「全部一致 ✔」。探针 900010 应该是 **R=0 F=4 M=630.00**：时区、窗口两端、支付时间跨天这些边界都算对了，才会得到这组数。
3. 两张结果表按两个方向逐行比较，两次的结果都应该是 0：
   ```fish
   lake 'SELECT count(*) FROM (FROM gold."rfm__<任务1>" EXCEPT ALL FROM gold."rfm__<任务2>")'
   lake 'SELECT count(*) FROM (FROM gold."rfm__<任务2>" EXCEPT ALL FROM gold."rfm__<任务1>")'
   ```
   如果有差异，而且只差在 monetary 的小数末几位，说明浮点数求和的顺序不固定。把它记成一项发现。
4. 去掉 definitionVersion 再入队一次：
   ```fish
   pnpm task:enqueue --tenant rfmlab --kind gold.rfm --params '{"asOf":"2026-09-30"}'
   ```
   在「分析」页，这份快照的参数列应该显示「任务参数」，而不是「定义第 N 版」。

### 第 5 步：v2 改用固定阈值分箱和自定义人群
1. **窗口 A（an@）**：打开「RFM 模板参数」。副标题应该是「当前生效：第 1 版」。按下面填写表单：
   - 回看天数：`730`
   - 计入的订单状态：在已勾选的 completed、paid、shipped 之外，再勾上 `refunded`
   - 分箱方式：选「固定阈值」，然后填：
     - R：`30, 90, 180, 365`
     - F：`2, 4, 8, 15`
     - M：`200, 1000, 3000, 8000`
   - 分群规则表：点每行右边的 ✕，删掉原来的 8 条。再点「添加一条」加 5 行，按下表填，没写的格子留空：

     | 人群 | R 最低 | R 最高 | F 最低 | F 最高 | M 最低 | M 最高 |
     |---|---|---|---|---|---|---|
     | 高价值活跃 | 4 | | | | 4 | |
     | 高价值沉睡 | | 2 | | | 4 | |
     | 高频忠诚 | | | 4 | | | |
     | 近期新客 | 4 | | | 1 | | |
     | 其他 | | | | | | |

   - 点「校验并保存草稿」。应该看到「版本」表里出现 v2 草稿。
2. **窗口 B（eng@）**：在同一页点「发布 v2」。应该看到：当前生效变成第 2 版，并且自动入队了一次计算。
3. 等「任务」页显示成功后，在终端 3 执行 `verify rfmlab`，应该打印「全部一致 ✔」。
4. 回到「分析」页：
   - 新快照的参数列显示「定义第 2 版」，详情页里有 5 个人群。
   - 前面 v1 的快照仍然是「定义第 1 版」，打开后内容没变。可以用 `verify rfmlab <v1 快照ID>` 再核对一次。
5. （可选）和下面的表格逐个对数字：
   ```fish
   pnpm task:enqueue --tenant rfmlab --kind gold.rfm --params '{"asOf":"2026-09-30","definitionVersion":2,"lookbackDays":730,"statuses":["paid","shipped","completed","refunded"],"binning":{"method":"thresholds","recency":[30,90,180,365],"frequency":[2,4,8,15],"monetary":[200,1000,3000,8000]},"segments":[{"name":"高价值活跃","r":{"min":4},"m":{"min":4}},{"name":"高价值沉睡","r":{"max":2},"m":{"min":4}},{"name":"高频忠诚","f":{"min":4}},{"name":"近期新客","r":{"min":4},"f":{"max":1}},{"name":"其他"}]}'
   ```
   注意：下表**只适用于参考日期 2026-09-30 的这份快照**。第 2 步发布 v2 时自动触发的那次计算，参考日期是发布当天，人数会和下表不同，以 `verify` 打印的「期望的人群分布」为准。
   这份快照详情页「人群」标签里的数字，应该和下表一致：

| 人群 | 人数 | 探针 |
|---|---|---|
| 其他 | 85,028 | 900010：R=0 F=5 M=1630.00，分值 533。窗口变成 730 天后，my 的那笔 1000 也进了窗口 |
| 高价值活跃 | 28,064 | 900011–900015：F=4 M=46.00，分值 531。比第 2 步多了 refunded 的 32 |
| 高频忠诚 | 25,731 | 900005：F=4，但 F 分只有 3，所以不在这个人群里 |
| 近期新客 | 18,231 | 900002、900004、900016 |
| 高价值沉睡 | 16,665 | |

- 不连租户、不入队，也能先算出任意参数的期望值：`verify --preview '<参数 JSON，必须带 asOf>'`。例如在 statuses 里加上 created，900011–900015 的 M 应该多 1.00；加上 cancelled，应该多 16.00。

### 第 6 步：快照 90 天后自动过期（#87）
1. 从第 4 步的两份 2026-09-30 快照里挑一份，在「分析」页点开，从网址里复制快照 ID。把它改成已经到期：
   ```fish
   psqlc -c "UPDATE platform.snapshots SET expires_at = now() - interval '1 minute' WHERE id = '<快照ID>'"
   ```
2. 保持终端 2 的 dispatcher 运行，等大约 60 秒，然后检查：
   - 「任务」页：出现一行「快照过期」，状态为「成功」。
   - 「分析」页：这一行变灰，状态显示「已过期」，模板名不再是链接。直接打开原来的详情页网址，应该显示「快照不存在」。
   - 数据库：执行 `psqlc -c "SELECT expired_at FROM platform.snapshots WHERE id = '<快照ID>'"`，expired_at 应该有值。
   - 数据湖：执行 `lake "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'gold' AND table_name = 'rfm__<任务ID>'"`，结果应该是 0。
   - 其他快照：仍然能打开，用 `verify rfmlab <其他快照ID>` 核对，仍然打印「全部一致 ✔」。

## 五、文件
| 文件 | 作用 |
|---|---|
| `truth.sql`、`specials.sql` | 真值的生成规则和探针 |
| `seed.ts` | 生成真值，写进五个数据源，建只读账号 |
| `mappings/*.yaml`、`check-mappings.ts` | 10 个映射和离线校验 |
| `verify.ts` | 按真值核对快照，或用 `--preview` 预览期望值 |
| `out/` | truth.duckdb、live.duckdb、credentials.txt、seed.log（都是生成出来的） |
