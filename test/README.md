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

在 [`test/CATALOG.md`](CATALOG.md)。找类似的例子时 `grep -n` 它，不要整份读。新增测试文件时在那里加一行。
