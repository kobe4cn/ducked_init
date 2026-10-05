# 测试

写测试前先看这里：夹具提供什么、新测试怎么起头。不需要通读 `harness.ts`、`fixtures.ts`、`source-fixtures.ts` 的源码；要看某个 helper 的细节时 `grep -n` 定位后只读那一段。

## 运行

```bash
pnpm test                                    # 全部（串行，较慢；输出写进文件再 grep）
npx vitest run test/pipeline/mapping.test.ts # 单个文件
```

- `vitest.config.ts` 设好了测试环境：平台 PG `crm_platform_test`、源库 `crm_source_test`（都在 `localhost:5432`，账号 `crm/crm`）、本地临时目录作数据湖、固定的主密钥、`MAILER=console`、`SOURCE_LARGE_TABLE_ROWS=1000`。
- 本地的 `.env.test`（模板 `.env.test.example`）提供可选的外部依赖；没配置时相应的 `describe.skipIf(...)` 自动跳过：
  - `TEST_S3_LAKE_URI`：对象存储上的隔离测试与文件数据源
  - `TEST_MYSQL_URL`：MySQL 数据源
  - `TEST_MONGO_URL`：MongoDB 数据源
- `test/global-setup.ts` 在开跑前建库并迁移到最新结构。所有测试共用一个库，**文件串行执行**（`fileParallelism: false`）。

## 两种接缝，选哪个

| 接缝 | 目录 | 驱动方式 | 用在 |
|---|---|---|---|
| 流水线 | `test/pipeline/` | 直接调用 `app/.server` 的领域函数，用调度器把任务队列跑空 | 业务规则、任务、数据湖里的结果 |
| HTTP | `test/http/` | 进程内启动 React Router 服务端，用带 cookie 的 `Client` 发请求 | 页面与表单、登录、权限矩阵、跨租户 404 |
| 纯函数 | `test/*.test.ts` | 直接调用 | 不碰数据库的逻辑（如 `mapping-spec.test.ts`） |

能用纯函数测的就不起数据库；能用流水线接缝测的就不起 HTTP。HTTP 测试只覆盖“界面上能做到、权限挡得住”。

## 夹具

### `test/pipeline/fixtures.ts`

| helper | 作用 |
|---|---|
| `newTenant(slug)` | 开通租户（含管理员 `admin@<slug>.com`），返回租户 ID |
| `memberOf(tenantId, email, role = 'data_engineer')` | 返回该成员的 `CurrentMember`，不存在则以给定角色加入；用作领域函数的第一个参数 |
| `runTask(tenantId, kind, params?)` | 入队一个任务并让调度器跑空，返回任务最终状态 |
| `selectAllTables(member, sourceId)` | 把数据源里可读的表全部选入同步范围（会入队采集，之后要跑空调度器） |
| `publish(author, reviewer, sourceId, yaml)` | 起草映射并由另一位成员发布，跑空调度器（合并完成），返回映射 ID |
| `silver(tenantId, entity, orderBy)` | 读出标准层某个实体的表（时间按 UTC 文本、金额按文本，去掉 `_merged_at`） |

跑空调度器：`createDispatcher({ maxWorkers: 2 }).runUntilIdle()`（来自 `app/.server/pipeline/dispatcher`），测试里通常包成 `const drain = () => ...`。

### `test/pipeline/source-fixtures.ts`

| helper | 作用 |
|---|---|
| `pgSourceInput(READER \| WRITER, name = '电商库')` | **重建源库**并返回登记 PostgreSQL 数据源的表单字段，直接传给 `registerSource(member, input)` |
| `READER` / `WRITER` | 源库账号：只读；对 `shop.orders` 可 INSERT / UPDATE |
| `grantOnSource(sql)` | 以源库管理员执行 SQL：加表、改数据、授权（在 `pgSourceInput` 之后调用，否则会被重建清掉） |
| `seedPgSource()` | 只重建源库，返回连接信息（`pgSourceInput` 内部已调用） |
| `duckdbSourceFile(tenantId, file?)` | 在租户源文件目录下生成 DuckDB 文件，返回路径 |
| `s3SourceFiles(tenantId)` | 对象存储上的 parquet 源文件与三个受限账号（需 `TEST_S3_LAKE_URI`） |
| `seedIdentitySources(member)` | 重建源库并建 `crm.customers`、`loyalty.members`、`tracking.users` + `tracking.events` 三个 schema，各登记为一个数据源（CRM、会员、埋点）、选表、确认水位线（`updated_at`）、同步完，返回 `{ crm, loyalty, tracking }`；两边同一个人的手机写法不同、只有邮箱相同、外部 ID 相同、手机-邮箱成链，另有空手机 / 空邮箱的记录；埋点用户与 CRM 重叠，事件含 login 与匿名事件，一台设备先后被两个人登录、一台同一时刻被两人登录（详见函数注释）。`{ orders: true }` 时 CRM 与会员源各多一张订单表（`crm.orders`、`loyalty.orders`，列名与状态写法不同，含一笔打通不到消费者的订单与一笔晚于 2024-07-01 的订单）一并同步 |
| `seedMysqlSource()` | MySQL 源库，`orders` 带自增主键与 `updated_at`（需 `TEST_MYSQL_URL`） |
| `seedMongoSource()` / `MONGO_USERS` | MongoDB 源库与几种权限的账号（需 `TEST_MONGO_URL`） |

### `test/pipeline/identity-fixtures.ts`

| helper | 作用 |
|---|---|
| `publishedIdentitySources({ orders? })` | 开通租户 `acme`，`de@acme.com` 登记同步三个身份打通数据源、`de2@acme.com` 审核发布三个 customer 映射与埋点事件映射（`orders` 为真时再发布两个订单映射），合并与打通跑完；返回 `{ acme, author, reviewer, sources, mappings, names }` |
| `CRM` / `LOYALTY` / `TRACKING_USERS` / `TRACKING_EVENTS` / `CRM_ORDERS` / `LOYALTY_ORDERS` | 上面发布的映射 YAML，改规则后重新发布时在其后追加内容 |

PostgreSQL 源库 `shop` schema 的内容（确定性造数）：

| 表 | 行数 | 主键 / 水位线候选 | 说明 |
|---|---|---|---|
| `customers` | 40 | `customer_id` serial；`updated_at` | `name`、`email`（每 4 行一个 NULL）、`phone`、`city`（北京/上海/广州/深圳）、`created_at` |
| `orders` | 100 | `order_id` identity；无更新时间 | `customer_id`、`amount`、`status`（paid/refunded 交替）、`created_at` |
| `events` | 1500 | 无主键、无水位线 | 超过大表阈值 1000，全量比对、默认每天同步 |
| `regions` | 2 | 无主键、无水位线 | 小表，全量比对 |

需要别的形状的源表时，在测试里写一段 SQL 用 `grantOnSource` 建表并 `GRANT SELECT ... TO ${READER.user}`（参考 `mapping.test.ts` 里的 `ORDER_LOG`、`POINT_LOGS`、`CONSENTS`、`PREFERENCES`、`COUPON_TEMPLATES`、`COUPONS`）。

### `test/http/harness.ts`

| helper | 作用 |
|---|---|
| `startApp()` | 启动服务端，返回 `TestApp`：`client()` 新浏览器、`outbox` 已发邮件、`drain()` 等后台发信完成、`close()` |
| `Client` | `get(path)`、`post(path, form)`（数组值提交多次）、`request(path, init)`、`cookie(name)`；不自动跟随重定向 |
| `loginAs(app, email)` | 走完 Magic Link 登录，返回已登录的 `Client`（成员须已存在，可先 `memberOf` 加入） |
| `loginAsOperator(app, email)` | 运营者登录（Magic Link + TOTP），返回 `{ browser, secret }` |
| `createTenant(slug, name, adminEmail)` / `createOperator(email)` | 走运营命令行开通租户 / 创建运营者 |
| `runCli(script, args, { input, env })` | 执行任意运营脚本 |
| `resetDb()` | 清空平台元数据与租户数据湖。**流水线测试也用它** |
| `extractLink(mail)` / `extractOpsLink(mail)` | 从邮件里取出登录链接 |

## 新建一个流水线测试

```ts
// test/pipeline/<主题>.test.ts —— <主题>的流水线接缝：<入口> → <调度器派发> → <在哪里看到结果>
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, selectAllTables } from './fixtures';
import { pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 开通租户、登记电商库、选入全部表并采集完 */
async function tenantWithSource() {
  const tenantId = await newTenant('acme');
  const engineer = await memberOf(tenantId, 'de@acme.com');
  const { id } = await registerSource(engineer, await pgSourceInput(READER));
  await selectAllTables(engineer, id);
  await drain();
  return { tenantId, engineer, sourceId: id };
}

describe('<功能>', () => {
  it('<一句话说明可观察的行为>', async () => {
    const { tenantId, engineer, sourceId } = await tenantWithSource();
    // 调用领域函数 → drain() → 断言任务结果或数据湖里的数据
  });
});
```

需要原始层有数据时，在 `tenantWithSource` 之后确认水位线并同步：`confirmWatermark(member, sourceId, 'customers', 'updated_at')`、`syncSource(member, sourceId)`，再 `drain()`（完整例子见 `mapping.test.ts` 的 `syncedSource`）。读标准层用 `silver`；读数据湖里别的表用 `openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 })`，用完 `session.close()`（例子见 `fixtures.ts` 的 `silver`、`pii.test.ts` 的 `silverDump`）。

## 新建一个 HTTP 测试

```ts
// test/http/<主题>.test.ts —— <主题>的 HTTP 接缝：<谁在界面上做什么>；<权限边界>
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

describe('<功能>', () => {
  it('<角色>能<做什么>，其他租户 404', async () => {
    const tenantId = await newTenant('acme');
    await memberOf(tenantId, 'de@acme.com', 'data_engineer');
    const browser = await loginAs(app, 'de@acme.com');
    const res = await browser.post('/<路径>', { field: 'value' });
    expect(res.status).toBe(302);
  });
});
```

数据准备优先用领域函数（`newTenant`、`memberOf`、`registerSource`），只把要测的那一步走 HTTP。

## 约定

- 文件第一行注释写清这条接缝：从哪个入口进、经过什么、在哪里看结果。
- `beforeEach` 里 `resetDb()`，`afterAll` 里 `closeDb()`；每个用例从空库开始，不依赖其他用例。
- 用例名用中文写一句可观察的行为，不写实现细节。
- 断言看结果（任务结果、数据湖里的行、响应状态与页面内容），不 mock 模块。需要时间流逝用 `vi.useFakeTimers({ toFake: ['Date'] })`，需要改配置用 `vi.stubEnv`；发信用 `app.outbox` 或 `app.setMailer` 替换。

## 现有测试一览

找类似的例子时先看这里，再 `grep -n "it('"` 定位到用例。

| 文件 | 覆盖 |
|---|---|
| `pipeline/pipeline.test.ts` | 开通租户 → 入队任务 → 独立工作进程 → 任务结果；租户隔离 |
| `pipeline/scheduling.test.ts` | 队列的领取顺序与名额（不启动工作进程） |
| `pipeline/sources.test.ts` | 登记数据源、只读探测、凭据加密、采集与水位线候选；MySQL / MongoDB / 对象存储文件源 |
| `pipeline/scope.test.ts` | 同步范围：逐张选表、只采集与同步范围内的表 |
| `pipeline/sync.test.ts` | 水位线增量与全量比对、变更批次、同步历史 |
| `pipeline/verify.test.ts` | 湖中数据核对（覆盖、位置、文件、结构、数据量） |
| `pipeline/mapping.test.ts` | 映射发布与标准层合并、去重键、值字典、双人发布（最后保存的人不能发布）、只有映射引用的表写入变更才在同步后合并（定时检查也不补）、合并只带受影响的映射、补进排队中的合并、运行期间的变更由定时检查补上、详情页只合并单个映射 |
| `pipeline/dry-run.test.ts` | 映射空跑：在只读挂载的数据湖上转换原始层最新的样本（最多 50 条），样例行里敏感字段是与标准层相同的加盐哈希；断言去重键非空与唯一（没有主键的表按整行区分记录）、必填字段（去重键与身份打通匹配字段）的空值、值字典外的取值（标明兜底或会失败）；空跑前后标准层与 `silver._merges` 不变；源表没同步时提示、没有的版本 404、分析师不能空跑 |
| `pipeline/source-views.test.ts` | 源视图：保存时在只读挂载的数据湖上校验并返回视图的列与前 20 行样本（像敏感信息的列是加盐哈希、没有明文）；写入、多条语句、标准层 / 结果层 / 其他数据源 / 本源 `_mirror`、带 `lake.` 前缀、表函数、SHOW、借内层 CTE 同名读系统视图、`getenv` / `current_setting`、原始层没有的表、缺平台列 `_op`/`_batch`/`_commit_ts`、执行出错、语法错误、不合规的视图名都被拦下且不保存，带本源前缀的表名与 CTE 可以；双人发布（最后保存的人 403、已发布锁定 400）、再改是新草稿、丢弃回到已发布版本、从没发布过的丢弃即删除、分析师不能起草与发布；敏感列在读之前换成哈希（改名、拼接、别名成平台列、结构体、类型转换报错都没有明文） |
| `pipeline/pii.test.ts` | 标准层敏感字段：规范化后按租户加盐哈希（不同写法同一哈希、与字段名无关）、`silver.*` / `silver_records` / 任务结果里没有明文、哈希上线前的明文标准层重建、转换报错抹掉取值与盐、标成敏感的扩展字段同样只存哈希 |
| `pipeline/identity.test.ts` | 身份打通：CRM、会员、埋点三个源的消费者按手机号 / 邮箱 / 外部 ID 哈希取传递闭包合并（写法不同、只有邮箱相同、链、空值不合并）、`silver._identities` 没有明文且 `consumer_id` 不是敏感字段哈希、匿名设备按全局最近一次登录归属（并列取较小 `consumer_id`，匿名事件经设备归属）、任务结果的打通摘要、重复合并结果一致；映射里配置匹配字段（去掉邮箱后重新发布、组随之变化）、更高优先级字段冲突时不按低优先级字段合并、两个 `customer` 映射规则不一致时拒绝发布 |
| `pipeline/rfm.test.ts` | `gold.rfm` 任务：两个数据源的订单经打通合到同一消费者、分值与人群与手算一致、快照表只有 `consumer_id` 与分值、打通不到的订单单独计数；同一 `as_of` 重复运行结果一致；没有 `silver.order` 或参数不合法时任务失败 |
| `pipeline/snapshots.test.ts` | 结果快照登记：`gold.rfm` 成功后登记模板、完整参数、表名、行数、90 天后过期，失败不登记，只在本租户可见；只读读出 RFM 快照的人群人数与金额（按定义顺序）与分页的消费者明细；到期快照经 `enqueueDueExpiries` → `gold.expire` 删表、清掉 parquet 文件与内联在 catalog 的行、标记 `expiredAt`，未到期的不受影响，不重复入队、重复执行不报错 |
| `pipeline/templates.test.ts` | 分析模板定义：没有已发布版本时用默认参数、保存草稿（参数不合法时报错、查看者不能起草、再次保存记下作者与最后保存的人）、最后保存的人与分析师不能发布、另一位数据工程师发布后以新参数入队 `gold.rfm` 且快照记下 `definitionVersion`、发布后再改是新一版草稿、丢弃草稿回到已发布版本或默认参数；按生效版本重新计算（没有已发布版本或同模板任务排队中时拒绝、分析师 403、未来或不合法的参考日期被拒、指定参考日期的快照记下 `asOf` 与定义第 1 版、版本不增加） |
| `pipeline/migration.test.ts` | 数据湖迁移存储 |
| `pipeline/encryption.test.ts` | 数据湖加密存储：新租户原始层 / `_keys` / `_mirror` 的文件不带密钥读不出、不含明文；加密前的未加密湖重新初始化照常同步 |
| `pipeline/reset.test.ts` | 开发用重置数据湖 |
| `http/login.test.ts` | 租户与 Magic Link 登录 |
| `http/members.test.ts` | 成员邀请与角色、权限矩阵、审计日志、跨租户拒绝 |
| `http/pii.test.ts` | 解密敏感信息：管理员按映射与源表主键看到明文、明文不进任务表与审计、审计 `pii.revealed`、不填原因或找不到记录不解密也不记审计、其他角色 403、其他租户 404 |
| `http/analytics.test.ts` | 分析页：查看者看到本租户的快照列表、打开 RFM 结果（人群人数与金额、消费者明细），页面没有明文；其他租户的快照 404；已过期的快照标灰、没有链接、打开 404；RFM 模板参数页的权限矩阵（查看者只读、分析师能起草不能发布、最后保存的人不能发布、数据工程师与管理员能发布并入队 `gold.rfm`、丢弃草稿）、参数不合法时报错；重新计算（没有已发布版本时不显示、重复入队与未来日期返回 400、分析师看到无权限说明且提交 403、成功后跳回带提示、入队参数带 `asOf` 与 `definitionVersion`、版本表不变） |
| `http/ops.test.ts` | 运营者身份、TOTP、租户管理、审计、IP 白名单 |
| `http/suspension.test.ts` | 停用与恢复租户 |
| `http/tasks.test.ts` | 任务页、首页的任务指标卡、租户配额、数据湖迁移查看 |
| `http/sources.test.ts` | 数据源界面：登记、轮换凭据、选表、列统计、确认水位线 |
| `http/mappings.test.ts` | 标准模型浏览、映射编辑与发布的界面与权限（最后保存的人不能发布、丢弃草稿、只有自己能发布时的提示）、对照面板（列统计、标准字段、写法速查、函数）、报错附改法、按规则生成草稿（生成 → 保存）、详情页立即合并的显示与权限、表单 / YAML 标签页（没有脚本时退回 YAML 框；用 `readForm` / `writeField` 填表单后保存并发布；表单填的值对照与兜底能保存；勾选源列加的扩展字段能保存）、合并记录里「落入兜底」一键加进值对照的链接、编辑页空跑（样例行与断言、不保存、没同步时的提示、分析师 403、其他租户 404）、查看草稿时与最新已发布版本的差异（首个版本、只改注释时没有差异） |
| `http/source-views.test.ts` | 源视图界面：数据源页「源视图」标签页的空状态（直接给出新建表单）、新建后跳到预览（列与样本，邮箱列是哈希）、读标准层的 SQL 被拒绝并给出原因、最后保存的人不能发布而管理员在页面上发布、没有登录会话的发布去登录；分析师只读（新建 / 保存 / 发布 / 丢弃 403）、查看者 403、别的数据源路径与其他租户 404 |
| `mapping-spec.test.ts` | 映射 YAML 校验与定位、报错附带的改法（是不是想写、扩展字段写法、值字典、主键）、敏感字段（扩展字段的敏感标记只能是文本、内置敏感字段不能取消）、对照面板读出的 YAML 要点（纯函数） |
| `mapping-draft.test.ts` | 按规则生成映射草稿：列名同义词、格式校验、分 / 毫秒 / 时区转换、值字典骨架、去重键、没用到的列生成注释掉的扩展字段（像敏感信息的默认标成敏感）；手写贴合 MySQL 开发库的列统计（纯函数） |
| `mapping-form.test.ts` | 映射表单与 YAML 互转：读出每个标准字段的源列、常用转换、参数与依据，写回时只改那一行、保留注释与顺序，枚举字段的值对照与兜底（未对应的不写入、写出的 YAML 通过校验、对照表的待对应行与预填），表单不认识的写法只读；扩展字段（没用到的源列、默认名字与类型、读入 / 加上 / 改名 / 删除后通过校验、像敏感信息的源列默认标成敏感与勾选敏感）（纯函数） |
| `mapping-diff.test.ts` | 映射版本差异：列的新增 / 删除 / 改动（类型、表达式、值字典不看键顺序、兜底、敏感标记，不比标准枚举）、去重键 / 取最新字段 / 身份打通匹配字段（含优先级顺序）的前后值、首个版本（纯函数） |
| `rfm-template.test.ts` | RFM 模板：参数校验与默认值、同样参数编译出同样 SQL；在内存 DuckDB 里对手造的标准层算出已知答案（五分位与阈值分箱、自定义分群、状态 / 回看窗口 / as_of 过滤、并列按 `consumer_id`、打通不到的订单计数）（纯函数） |
| `publish-rules.test.ts` | 双人发布规则（映射、模板定义与源视图共用）：当前成员发布不了草稿的原因——不是草稿、没有发布权限、最后保存的是自己、租户里只有自己能发布（纯函数） |
| `nav.test.ts` | 顶栏导航高亮：子页面高亮所属导航项（如快照结果页高亮「分析」），按完整路径段匹配，运营后台审计日志不连带租户（纯函数） |
| `client-build.test.ts` | 真实客户端构建，兜底页面误引 `.server` 模块 |
| `mailer.test.ts` / `totp.test.ts` | 发信、TOTP（纯函数） |
