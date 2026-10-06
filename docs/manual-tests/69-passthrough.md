# #69 一键直通整体手工测试（rfmlab 租户）

覆盖 #69 及其拆分出的 #103（按规则生成支持自定义实体）、#104（从源表生成两份草稿）、#105（一起双人发布并合并），全部通过页面操作，终端只用来核对数据。

## 0. 测试前的现状（2026-10-06 查询）

**账号**（三个互不相干的浏览器窗口同时登录）：

| 窗口 | 账号 | 角色 | 能做什么 |
|---|---|---|---|
| A | `sa@rfmlab.com` | 分析师 | 只读，不能生成、不能发布 |
| B | `da@rfmlab.com` | 数据工程师 | 生成草稿、发布 |
| C | `admin@rfmlab.com` | 管理员 | 全部 |

rfmlab 只有 da@ 和 admin@ 两个人有发布权限，所以本计划里**一律由 da@ 生成、admin@ 发布**，个别用例反过来。

**已有的东西**：5 个数据源、10 张表都已采集，10 个到标准实体的映射已发布；自定义实体 `custom_member_card`（会员卡，主键 `member_id`，v3 已发布），`pos_mysql.members → custom_member_card` 映射已发布。

**一处遗留数据（是一个缺陷，见第 13 节 #1）**：今天 05:31 admin@ 在 `shop_pg.customers` 上做过一键直通，05:32 在实体页丢弃了登记草稿，实体被删掉了，但映射草稿 `shop_pg.customers → custom_customers`（v1 草稿）还留着。用例 T3 就从这里开始，**不要提前清理它**。

**各表一键直通的预期结果**（用应用代码只读预演得出，`node --env-file=.env --import tsx .scratch/pt-preview.ts` 可重跑；带 `*` 的是标为敏感的字段）：

| 数据源.表 | 生成的实体 | 主键 | 行数 | 字段 |
|---|---|---|---|---|
| live_duckdb.viewers | `custom_viewers` | viewer_id | 40,029 | viewer_id:integer phone:string* level joined_at:timestamp modified_at |
| live_duckdb.live_orders | `custom_live_orders` | order_code | 150,074 | order_code viewer_id state amount_cents ordered_at paid_at modified_at |
| shop_pg.customers | `custom_customers` | customer_id | 142,071 | customer_id nick_name* mobile* email* unionid gender city created_at updated_at |
| shop_pg.orders | `custom_orders` | order_id | 721,235 | order_id customer_id status pay_amount:decimal … |
| mini_mongo.orders | `custom_orders`（与上一行同名） | id（源 `_id`） | 240,502 | id pay buyer pay_amount buyer_member_no … |
| mini_mongo.users | `custom_users` | id（源 `_id`） | 59,733 | contact_email* nickname* contact_mobile* contact:string* created_at:date … |
| pos_mysql.members | `custom_members` | member_id | 70,173 | member_name* phone* email* … |
| pos_mysql.sales | `custom_sales` | sale_id | 284,429 | … |
| tmall_s3.buyers | **拒绝**：没有主键也没有业务主键 | — | 50,203 | buyer_id buyer_nick unionid receiver_mobile* created_ms |
| tmall_s3.trades | **拒绝**：同上 | — | 192,582 | |

## 1. 环境准备

- 终端 1：`pnpm dev`（登录链接打印在这里）。终端 2：`pnpm dispatcher`，**全程别关**，合并任务靠它跑。终端 3 用来核对，先定义简写（fish）：
  ```fish
  alias lake 'node --env-file=.env --import tsx scripts/lake-sql.ts rfmlab'
  alias pg   'container exec -it postgres-server psql -U crm crm_platform'
  ```
- 三个窗口分别到 `/login` 登录 A、B、C 三个账号（Chrome 普通窗口、Chrome 无痕窗口、Safari）。
- 记录一个基线，最后用来确认没碰到 RFM 的数据：
  ```fish
  lake 'SELECT count(*) FROM silver.customer' 'SELECT count(*) FROM silver."order"'
  ```

每个用例写的是「操作 → 应该看到」，没写到的地方以页面为准。看到和预期不一样的，记下用例号、截图、当时的网址。

## 2. T1 入口与权限（#104）

1. **A（sa@ 分析师）** 打开 `/entities`。
   - 应该看到：实体列表里有「会员卡」，**没有**「从源表一键生成」按钮。
   - 直接打开 `/entities?passthrough=1`：不显示生成表单，或者提交时得到 403。
2. **B（da@）** 打开 `/entities`。
   - 应该看到：右上角有「从源表一键生成」（闪电图标）。
   - 点它，网址变成 `/entities?passthrough=1`，出现「从源表一键生成」面板，有说明文字、数据源下拉和表下拉。
3. **B** 在数据源下拉里逐个切换。
   - 应该看到：表下拉只列这个数据源已采集的表（每个源 2 张，表名见第 0 节）。

## 3. T2 拒绝场景：两份草稿都不写（#104 验收 3）

每一步之后到 `/entities` 和 `/mappings` 确认**没有多出**实体或映射。

1. **没有主键**：B 选 `tmall_s3` / `buyers` 提交。
   - 应该看到：表单上方红色提示「表 buyers 没有主键，也没有声明业务主键：请先在数据源页声明业务主键」，下拉保留刚才的选择。
2. **同名实体**：B 选 `shop_pg` / `orders` 提交。
   - 应该看到：跳到 `custom_orders` 的实体详情页。
   - 回到 `/entities?passthrough=1`，选 `mini_mongo` / `orders`，「实体名」留空提交。应该看到红框标题「没有生成」，内容「已有名为 custom_orders 的自定义实体：请换一个实体名，如 custom_mini_mongo_orders」。
   - `/mappings` 里只有一个到 `custom_orders` 的映射，来自 shop_pg。
   - 「实体名」填 `custom_mini_mongo_orders` 再提交，跳到这个实体的详情页（#106）。再试一次填 `orders`（不带 custom_），报「实体名要以 custom_ 开头…」。
3. **收尾，同时验证丢弃联动（#107）**：在实体页丢弃 `custom_orders` 的登记草稿。
   - 确认框写着「…将被删除，目标是它的映射草稿一并丢弃：「shop_pg」orders」。
   - 回到实体列表，`custom_orders` 不再出现；`/mappings` 里 `shop_pg.orders → custom_orders` 也没了。
   - 用同样的方法丢弃 `custom_mini_mongo_orders`。

列名规范化后不合规或重名、表名做不成实体名这两种拒绝，rfmlab 的数据里造不出来，由自动化测试覆盖（`test/pipeline/passthrough.test.ts`）。

## 4. T3 映射写不进时回滚登记（#104 设计的兜底路径）

这时 `shop_pg.customers → custom_customers` 的遗留映射草稿还在（它是 #107 修复之前丢弃登记留下的孤儿，修复后丢弃登记不会再产生这种映射）。

1. **B** 在一键生成里选 `shop_pg` / `customers` 提交。
   - 应该看到：红色报错，大意是「「shop_pg」的 customers 已有到 custom_customers 的映射，请在那个映射上修改」。
   - `/entities` 里**没有** `custom_customers`，说明刚建的登记已经删掉。
2. 终端核对审计，应该看到同一秒里先 `custom_entity.drafted`、后 `custom_entity.deleted`：
   ```sql
   SELECT a.created_at, a.action, a.actor_email FROM platform.audit_logs a JOIN platform.tenants t ON t.id = a.tenant_id
   WHERE t.slug = 'rfmlab' AND a.detail::text LIKE '%custom_customers%' ORDER BY 1 DESC LIMIT 4;
   ```
3. **B** 到 `/mappings`，打开 `shop_pg.customers → custom_customers` 这份遗留草稿。
   - 应该看到：「实体待补登」之类的提示。
   - 点「丢弃草稿」，这个映射消失。
4. **B** 再一键生成 `shop_pg` / `customers`。
   - 应该看到：这次成功，跳到 `custom_customers` 详情页。这两份草稿留给 T7 用。

## 5. T4 生成结果核对（#104 验收 1、2）

用 **B** 一键生成 `live_duckdb` / `viewers`，它是之后走通主流程的表。

1. 跳到 `/entities/<ID>`，标题是 `custom_viewers`。编辑页显示 v1 草稿：
   - 中文名 `viewers`，类型「维度」，主键 `viewer_id`；
   - 字段依次是 viewer_id、phone、level、joined_at、modified_at，类型与第 0 节一致；
   - **只有 phone 勾了敏感**。
2. 同一页上应该有「配套的映射草稿」卡片：
   - 写着 `live_duckdb viewers → custom_viewers`，点进去是映射详情页；
   - 卡片里有提示「登记与映射一起发布后合并入标准层。发布后只能新增字段，主键和字段类型以后都不能改。」；
   - B 自己看到的是锁图标加「你最后改了这一版草稿，需由另一位数据工程师或管理员发布」，**没有**一起发布按钮。
3. 映射详情页：
   - 实体卡片标「自定义实体」，链接回实体页；
   - YAML 里 `entity: custom_viewers`，字段全部写在 `extensions` 下，`dedupe: { key: [viewer_id] }`，没有 `fields:` 段，也没有写 `sensitive`（继承登记）。
4. `/mappings` 列表：这个映射显示「实体待补登」，因为只有草稿的登记也算待补登。
5. 再打开 T3 第 4 步生成的 `custom_customers`，核对敏感标记：nick_name、mobile、email 标敏感，unionid、gender、city、created_at 不标。
6. **A（sa@）** 打开 `custom_viewers` 实体页。
   - 应该看到：只读，有配套映射卡片，卡片上显示没有发布权限的原因，没有按钮。

## 6. T5 主流程：一起双人发布并合并（#105 验收 1、2）

1. **C（admin@）** 打开 `custom_viewers` 实体页。
   - 应该看到：配套映射卡片右侧有「登记与映射一起发布」按钮。
   - 页面顶部草稿操作区的「发布 v1」也在，因为单独发布登记的按钮保留。
2. **C** 点「登记与映射一起发布」。
   - 应该看到：页面刷新，配套映射卡片消失；「版本」标签里 v1 是「已发布」，发布人是 admin@。
3. **C** 打开映射详情页的版本标签：v1「已发布」，发布人是 admin@。`/mappings` 列表里「实体待补登」提示消失。
4. **C** 打开 `/tasks`：有一条 `silver.merge` 任务，等它变成成功。dispatcher 要开着。
5. 终端核对标准层：
   ```fish
   lake 'SELECT count(*) AS 行数, count(DISTINCT viewer_id) AS 主键数, min(length(phone)) AS 最短, max(length(phone)) AS 最长, count(*) FILTER (WHERE phone ~ \'^[0-9a-f]{64}$\') AS 哈希 FROM silver."custom_viewers"'
   lake 'SELECT * FROM silver."custom_viewers" LIMIT 3'
   ```
   - 应该看到：行数 = 主键数 = 40,029，phone 全部是 64 位十六进制哈希，看不到明文手机号。
   - 其他列是明文，类型对（joined_at 是时间）。
6. `/audit`（C）：依次有 `custom_entity.published` 和 `mapping.published`，操作人都是 admin@，时间相同。

## 7. T6 一起发布被拒：两份都不发布（#105 验收 1、3）

### T6a 最后保存的人与分析师
已在 T4 第 2 步和第 6 步看过页面。再从 **B** 的浏览器开发者工具里直接 POST 一次，得到 403：

```js
// 在 custom_customers 实体页的控制台执行，mappingId 从配套映射卡片的链接里取
const f = new FormData(); f.set('intent', 'publishTogether'); f.set('version', '1'); f.set('mappingId', '<映射ID>'); f.set('mappingVersion', '1');
(await fetch(location.pathname, { method: 'POST', body: f })).status
```

在 **A** 的控制台执行同样的代码，也应该得到 403。

### T6b 其他租户 404
用 lm 租户的管理员登录第四个窗口，打开 `custom_customers` 的实体页网址，应该得到 404；用上面的 POST，也得到 404。没有 lm 账号可以跳过，自动化测试已覆盖。

### T6c 单独丢弃映射草稿后配对消失
1. **B** 一键生成 `live_duckdb` / `live_orders`。
2. **B** 到它的映射详情页丢弃映射草稿，回到 `custom_live_orders` 实体页。
   - 应该看到：配套映射卡片消失，只剩单独「发布 v1」。
3. 如果在丢弃前，C 已经打开了这个实体页，那么 C 此时点「一起发布」应该报错（映射已不存在），登记仍是草稿。
4. 收尾：丢弃 `custom_live_orders` 的登记草稿。

### T6d 改了登记，映射对不上
1. **B** 打开 `custom_customers` 编辑页，删掉 `city` 字段的那一行，保存草稿。B 仍是两份的最后保存人。
2. **C** 点「登记与映射一起发布」。
   - 应该看到：红色报错，列出映射的问题（`city` 不在登记里）。
   - 刷新后登记和映射都仍是 v1 草稿，`/tasks` 没有新的合并任务。
3. **B** 把 `city` 加回去（字段名 `city`、类型 string、不敏感），保存草稿，留给 T7。

### T6e 等锁期间草稿被改（「请刷新后重新检查」）
这一步要在终端里人为制造并发，用 `custom_customers`。

1. 终端 3 打开 `pg`，执行：
   ```sql
   BEGIN;
   SELECT e.id FROM platform.custom_entities e JOIN platform.tenants t ON t.id = e.tenant_id
   WHERE t.slug = 'rfmlab' AND e.name = 'custom_customers' FOR UPDATE;
   ```
2. **C** 点「登记与映射一起发布」。
   - 应该看到：页面一直在提交中，因为请求卡在实体行的锁上。
3. 回到 psql：
   ```sql
   UPDATE platform.custom_entity_versions SET updated_at = now()
   WHERE entity_id = (SELECT e.id FROM platform.custom_entities e JOIN platform.tenants t ON t.id = e.tenant_id WHERE t.slug = 'rfmlab' AND e.name = 'custom_customers');
   COMMIT;
   ```
   - 应该看到：C 的页面立即返回红色提示「草稿在你发布前被修改、发布或丢弃，请刷新后重新检查」，登记和映射都仍是草稿。
4. 想测映射这一半：把第 1 步的锁换成 `platform.mappings` 那一行（`WHERE id = '<映射ID>' FOR UPDATE`），第 3 步改 `platform.mapping_versions.updated_at`。
   - 应该看到：同样的提示，而且**登记也没有发布**（同一个事务回滚）。

## 8. T7 两位发布人互相锁死，改走分开发布（#105 的边界）

1. **C** 在 `custom_customers` 编辑页把中文名改成「商城客户」，保存草稿。现在 admin@ 是登记的最后保存人，da@ 是映射的最后保存人。
   - **C** 看配套映射卡片：显示「你最后改了这一版草稿……」，说的是登记。
   - **B** 看：同样的提示，这次说的是映射。
   - 两人都不能一起发布。rfmlab 没有第三位发布人，这是预期行为；文案没说是哪一份，见第 13 节 #3。
2. 分开发布：
   - **B** 在实体页点顶部的「发布 v1」，单独发布登记。应该看到：登记已发布，配套映射卡片消失，因为登记已经发布过了。
   - **C** 到映射详情页发布映射。应该看到：发布成功，`/tasks` 出现合并任务。
3. 合并成功后核对：
   ```fish
   lake 'SELECT count(*), count(*) FILTER (WHERE mobile ~ \'^[0-9a-f]{64}$\' OR mobile IS NULL) AS 哈希或空, count(*) FILTER (WHERE email ~ \'^[0-9a-f]{64}$\' OR email IS NULL) FROM silver."custom_customers"'
   ```
   - 应该看到：142,071 行；mobile、email 不是哈希就是空，没有明文。

## 9. T8 发布后的约束（ADR-0018，按钮旁的提示是否属实）

在 **B** 打开 `custom_viewers` 编辑页，分别试下面三项，每次保存一次：

| 操作 | 应该看到 |
|---|---|
| 把主键改成 `phone` | 被拒，原因「不能改主键（viewer_id）」 |
| 把 level 的类型改成 integer | 被拒，原因「不能改字段 level 的类型」 |
| 新增字段 `note`（string） | 保存成 v2 草稿，C 能单独发布 |

再试删除实体：**C** 在 `custom_viewers` 实体页应该看到锁图标和「被已发布的映射引用，不能删除：live_duckdb viewers」，没有删除按钮。

最后丢弃那份 v2 草稿：实体页「丢弃草稿」，回到 v1。

## 10. T9 按规则生成映射草稿支持自定义实体（#103，#69 验收 3）

以下都在 **B** 的 `/mappings` 新建映射表单里操作，只生成、校验，**不发布**。

1. **正例**：数据源 `pos_mysql`，表 `sales`，目标实体选「会员卡」（custom_member_card），点「按规则生成草稿」。
   - 应该看到：YAML 只有 `extensions`；`member_id` 写成 `string(...)`（源是 integer、登记是 string）；`dedupe.key` 是 `[member_id]`；没有 `sensitive`。
   - 点保存，应该能直接保存成草稿，没有校验错误。随后在映射详情页丢弃它（这个映射语义上不对，只是测规则）。
2. **主键没有对应列**：数据源 `live_duckdb`，表 `viewers`，目标「会员卡」，点「按规则生成草稿」。
   - 应该看到：报错「源表没有与主键字段 member_id 对应的列」，编辑框不变。
3. **只有草稿的登记不能选**：先一键生成 `pos_mysql` / `sales`，得到 `custom_sales` 草稿。
   - 回到新建映射，目标实体下拉里**没有** `custom_sales`；已发布的 `custom_viewers`、`custom_customers` 在下拉里。
   - 收尾：先丢映射，再丢 `custom_sales` 登记。
4. **重复映射**：`pos_mysql` / `members` → 会员卡，生成后保存。
   - 应该看到：「「pos_mysql」的 members 已有到 会员卡 的映射」之类的提示，因为已有已发布的映射。

## 11. 收尾与回归

- 确认 RFM 的标准层没被碰过，和第 1 节的基线一致：
  ```fish
  lake 'SELECT count(*) FROM silver.customer' 'SELECT count(*) FROM silver."order"'
  ```
- 本计划留下的东西：已发布的 `custom_viewers`、`custom_customers` 及其映射。已发布的实体被映射引用，不能删除；要清掉只能丢弃前先别发布，或者重建租户。不想留就跳过 T5、T7，改为只观察到发布前一步。
- `/entities` 和 `/mappings` 里不应留有本计划生成的草稿。

## 12. 验收覆盖

| 验收项 | 用例 |
|---|---|
| #69-1 一键生成两份草稿，一起双人发布，合并进 `silver."custom_xxx"` | T4、T5 |
| #69-2 像敏感信息的列默认标敏感 | T4-1、T4-5、T5-5、T7-3 |
| #69-3 已登记自定义实体按规则生成的草稿直接通过校验 | T9-1 |
| #103 主键无对应列、实体未登记时明确报错 | T9-2、T9-3 |
| #104-1 两份都能在页面看到，映射目标是这份登记 | T4-1～T4-4 |
| #104-2 name/email/phone 敏感且 string，city/created_at 不标 | T4-5 |
| #104-3 没主键、同名、列名不合规时拒绝且都不写 | T2（列名由自动化测试覆盖）、T3 |
| #105-1 详情页显示配套映射、一起发布、任一份不满足都不发布 | T4-2、T5、T6c、T6d、T7 |
| #105-2 两份都成为已发布，合并后全部行、敏感字段存哈希 | T5、T7-3 |
| #105-3 最后保存人 403、分析师 403、其他租户 404、等锁期间被改报刷新 | T6a、T6b、T6e |

## 13. 已知问题与要观察的点

1. ~~**缺陷：丢弃从没发布过的登记，配套的映射草稿会变成孤儿。**~~ 已由 #107 修复：丢弃登记时，目标是它、从没发布过的映射一并丢弃，确认框列出这些映射。T2 第 3 步验证。修复前留下的孤儿（如 `shop_pg.customers → custom_customers`）仍需在映射页手动丢弃，T3 用它验证回滚路径。
1b. ~~**同名源表撞名**~~：已由 #106 修复。实体名默认 `custom_<表名>`，可以另填；撞名时建议 `custom_<数据源名>_<表名>`。T2 第 2 步验证。
2. **报错的标题**：一键生成失败时的标题已改成「没有生成」（#106）。一起发布失败时，实体页红框标题仍是「未保存」，应该是「未发布」（T6d、T6e 可以顺便看）。
3. **互锁提示有歧义**：T7 里两人看到的都是「你最后改了这一版草稿」，没说是登记还是映射。
4. **敏感规则（ADR-0016）的边界**：`unionid`（外部 ID）没有标敏感；mini_mongo.users 的嵌套对象 `contact` 被当成 string 并标了敏感，整段会被哈希；`nickname`、`nick_name` 标了敏感。这些是否符合预期需要确认。
5. **Mongo 的主键**：源列 `_id` 规范化成字段 `id`；mini_mongo.orders 约 2% 的订单有旧版本文档，一键直通用 `_id` 去重，旧版本会作为独立行进入 `custom_orders`。这是恒等映射的预期行为，但和 `silver."order"` 的口径不同。
6. 实体类型一律是「维度」，订单类的表（orders、sales）也是。生成后可以在发布前手工改。
