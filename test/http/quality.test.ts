// test/http/quality.test.ts —— 数据质量页的 HTTP 接缝：往源库注入负金额订单 → 同步合并 → gold.rfm 断言失败，不合格行写进隔离区；
// 有 sources:read 的成员在 /quality 看到本租户最近的断言结果（失败标出）与隔离区样本，页面上没有明文；没有该权限的成员 403，其他租户的成员看不到；
// 最近一次成功打通的 hot（一个值连了太多源记录）在 /quality 列出哈希、记录数与数据源名，customer 映射的合并记录页顶部给出提示；
// 有 sources:write 的成员把 hot 里的值标为不参与匹配或撤销：登记进平台表、审计只有哈希与记录数，入队带排除列表、强制重算打通的合并
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, dslDefinitions, identityExcludedValues, mappings, tasks } from '../../app/.server/db/schema';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { publishMapping, saveDraft } from '../../app/.server/mappings';
import { syncSource } from '../../app/.server/source-sync';
import { defaultSpaceOf, memberOf, newTenant, runTask } from '../pipeline/fixtures';
import { CRM_ORDERS, publishedIdentitySources } from '../pipeline/identity-fixtures';
import { fakeHot } from '../pipeline/identity-helpers';
import { grantOnSource } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

// 源表里的姓名、手机、邮箱、外部 ID，页面上一个都不能出现
const PLAINTEXT = ['张三', '钱七', '13800000002', '138 0000 0001', 'zhang@crm.test', 'qian7@example.com', 'wx_union_8'];

/** 打通好的 acme 先成功算一次 RFM（ok），再注入一单负金额订单 A7 并重算：断言失败（task） */
async function failedRfm() {
  const fixture = await publishedIdentitySources({ orders: true });
  const { acme, sources } = fixture;
  const ok = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
  await grantOnSource(`INSERT INTO crm.orders VALUES ('A7', 1, 'paid', -10, '2024-06-29 10:00', '2024-06-29 10:00', now())`);
  await syncSource(await memberOf(acme, 'de@acme.com'), sources.crm);
  await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
  const task = await runTask(acme, 'gold.rfm', { asOf: '2024-07-01' });
  expect(task).toMatchObject({ status: 'failed' });
  return { ...fixture, ok: ok!, task: task! };
}

/** 本租户的合并任务，新的在前 */
const mergeTasks = (tenantId: string) => getDb().select().from(tasks)
  .where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'silver.merge'))).orderBy(desc(tasks.createdAt), desc(tasks.id));

describe('数据质量页', () => {
  it('分析师在数据质量页看到最近的断言结果（失败标出）与隔离区样本，页面上没有明文；查看者 403、导航里没有入口', async () => {
    const { acme, task } = await failedRfm();
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const browser = await loginAs(app, 'analyst@acme.com');
    expect(await (await browser.get('/')).text()).toContain('href="/quality"');

    const res = await browser.get('/quality');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('数据质量');
    expect(html).toMatch(/data-assertion="amount_non_negative"[^>]*data-failed="true"/);
    expect(html).toContain('金额非负');
    expect(html).toContain(task.id);
    expect(html).toMatch(/data-quarantine-key="A7"/);
    expect(html).toContain('&quot;order_id&quot;:&quot;A7&quot;');
    for (const p of PLAINTEXT) expect(html).not.toContain(p);

    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const viewer = await loginAs(app, 'viewer@acme.com');
    expect(await (await viewer.get('/')).text()).not.toContain('href="/quality"');
    expect((await viewer.get('/quality')).status).toBe(403);
  });

  it('最近一次打通有 hot 时，数据质量页列出哈希前缀、记录数与数据源名，customer 映射的合并记录页顶部提示并链到 /quality；没有 hot 时是空状态、不提示', async () => {
    const { acme, sources, mappings, orderMappings } = await publishedIdentitySources({ orders: true });
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const browser = await loginAs(app, 'analyst@acme.com');
    const merges = async (id: string) => (await browser.get(`/mappings/${id}?tab=merges`)).text();

    const empty = await (await browser.get('/quality')).text();
    expect(empty).toContain('身份打通：一个值连了太多记录');
    expect(empty).toMatch(/没有发现一个值连了 (<!-- -->)?10(<!-- -->)? 条以上记录/);
    expect(empty).not.toContain('data-hot-hash');
    expect(await merges(mappings.crm)).not.toContain('data-hot-alert');

    const hash = 'ab12'.repeat(16);
    const other = 'cd34'.repeat(16);
    await fakeHot(acme, [
      { rule: 'phone', hash, records: 267, sources: [sources.crm, sources.loyalty] },
      { rule: 'email', hash: other, records: 11, sources: [sources.crm] },
    ]);

    const html = await (await browser.get('/quality')).text();
    expect(html).toContain(`data-hot-hash="${hash}"`);
    expect(html).toMatch(new RegExp(`title="${hash}">${hash.slice(0, 16)}(<!-- -->)?…`));
    expect(html).toContain('267');
    expect(html).toContain(`>CRM、会员</td>`);
    expect(html).not.toContain(sources.crm);
    expect(html).not.toContain('没有发现一个值连了');
    for (const p of PLAINTEXT) expect(html).not.toContain(p);

    const page = await merges(mappings.crm);
    expect(page).toContain('data-hot-alert');
    expect(page).toContain('2 个匹配值各连了 10 条以上记录');
    expect(page).toContain('href="/quality"');
    // 不是 customer 的映射不提示
    expect(await merges(orderMappings!.crm)).not.toContain('data-hot-alert');
    // 分析师没有 sources:write：看不到标记按钮
    expect(html).not.toContain('data-intent="exclude"');
  });

  it('数据工程师把 hot 里的值标为不参与匹配：登记、审计只有哈希与记录数、入队带排除列表的强制合并；撤销后列表为空、又入队一次；分析师看不到按钮、POST 403', async () => {
    const { acme, sources } = await publishedIdentitySources();
    const hash = 'ab12'.repeat(16);
    await fakeHot(acme, [{ rule: 'phone', hash, records: 267, sources: [sources.crm] }]);
    const de = await loginAs(app, 'de@acme.com');
    const before = await (await de.get('/quality')).text();
    expect(before).toContain('data-intent="exclude"');
    expect(before).toContain('还没有。在上面的告警里');

    // 不在 hot 里的哈希不收
    expect((await de.post('/quality', { intent: 'exclude', hash: 'ef56'.repeat(16) })).status).toBe(400);
    expect(await getDb().select().from(identityExcludedValues)).toEqual([]);

    const count = (await mergeTasks(acme)).length;
    const res = await de.post('/quality', { intent: 'exclude', hash });
    expect(res.status).toBe(200);
    expect(await getDb().select({ tenantId: identityExcludedValues.tenantId, hash: identityExcludedValues.hash, records: identityExcludedValues.records })
      .from(identityExcludedValues)).toEqual([{ tenantId: acme, hash, records: 267 }]);
    const [excluded] = await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'identity.value_excluded'));
    expect(excluded).toMatchObject({ tenantId: acme, actorEmail: 'de@acme.com', detail: { hash, records: 267 } });
    expect(Object.keys(excluded.detail).sort()).toEqual(['hash', 'records']);
    const [queued, ...rest] = await mergeTasks(acme);
    expect(rest).toHaveLength(count);
    expect(queued).toMatchObject({ status: 'queued', params: { identityExclude: [hash], identityForce: true } });

    const html = await (await de.get('/quality')).text();
    expect(html).toContain(`data-excluded-hash="${hash}"`);
    expect(html).toContain('de@acme.com');
    expect(html).toContain('已标为不参与匹配');
    expect(html).toContain('data-intent="include"');

    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    const seen = await (await analyst.get('/quality')).text();
    expect(seen).toContain(`data-excluded-hash="${hash}"`);
    expect(seen).not.toContain('data-intent=');
    expect((await analyst.post('/quality', { intent: 'include', hash })).status).toBe(403);
    expect((await analyst.post('/quality', { intent: 'exclude', hash })).status).toBe(403);

    // 重复标记、合并正在运行时撤销都不做任何事：不改表、不记审计
    expect((await de.post('/quality', { intent: 'exclude', hash })).status).toBe(409);
    await getDb().update(tasks).set({ status: 'running' }).where(eq(tasks.id, queued.id));
    const busy = await de.post('/quality', { intent: 'include', hash });
    expect(busy.status).toBe(409);
    expect(await busy.text()).toContain('已有一次合并在运行');
    expect(await getDb().select().from(identityExcludedValues)).toHaveLength(1);
    expect(await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'identity.value_included'))).toEqual([]);

    // 让带排除列表的合并算作已经打通过：撤销后排除列表与它的参数不同，再入队一次强制重算
    await getDb().update(tasks).set({ status: 'succeeded', result: { identities: { durationMs: 1, groups: 9, records: 16, devices: 2 } } }).where(eq(tasks.id, queued.id));
    expect((await de.post('/quality', { intent: 'include', hash })).status).toBe(200);
    expect(await getDb().select().from(identityExcludedValues)).toEqual([]);
    const [included] = await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'identity.value_included'));
    expect(included.detail).toEqual({ hash, records: 267 });
    const [again] = await mergeTasks(acme);
    expect(again.id).not.toBe(queued.id);
    expect(again).toMatchObject({ status: 'queued', params: { identityExclude: [], identityForce: true } });
    expect(await (await de.get('/quality')).text()).not.toContain('data-excluded-hash');
    expect((await de.post('/quality', { intent: 'include', hash })).status).toBe(404);
  });

  it('合并时映射的自定义断言显示中文名「自定义：<字段> <检查>」与不合格行数；「最近一次」统计仍是结果层任务的', async () => {
    // 先有一次因负金额 A7 阻断失败的 RFM，再给 CRM 订单映射加 warn 级 range 并发布，合并时 A7 不通过
    const { acme, author, reviewer, orderMappings, task } = await failedRfm();
    const version = await saveDraft(author, orderMappings!.crm, `${CRM_ORDERS}assertions:\n  - { field: amount, check: range, min: 0, level: warn }\n`);
    await publishMapping(reviewer, orderMappings!.crm, version);
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();

    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const html = await (await (await loginAs(app, 'analyst@acme.com')).get('/quality')).text();
    expect(html).toMatch(/data-assertion="custom:amount:range"[^>]*data-failed="true"/);
    expect(html).toContain('自定义：amount 取值范围');
    expect(html).toMatch(/>1(<!-- -->)? 行不合格</);
    expect(html).toMatch(/最近一次阻断失败<\/div><div class="[^"]*">1<\/div>/);
    // 合并任务的 warn 级自定义断言不计入「最近一次告警」；提示写覆盖的任务数并链到失败任务
    expect(html).toMatch(/最近一次告警<\/div><div class="[^"]*">0<\/div>/);
    expect(html).toMatch(/覆盖 (<!-- -->)?1(<!-- -->)? 个结果层任务/);
    expect(html).toContain(`href="/quality?task=${task.id}"`);
  });

  it('「最近一次」按每个结果层任务各自最近一次汇总：后完成的任务全部通过时，先完成任务的 warn / 阻断失败仍显示；定义重跑通过后不再计入', async () => {
    const acme = await newTenant('acme');
    // 直接造结果层任务的运行记录（latestResultCheck 只读 tasks 表，不跑任务）：断言结果的形状与 gold.dsl 契约一致
    const at = (min: number) => new Date(Date.now() + min * 60_000);
    const gold = async (kind: 'gold.dsl' | 'gold.rfm', definitionId: string | null, finishedAt: Date, assertions: unknown[]) =>
      (await getDb().insert(tasks).values({
        tenantId: acme, kind, status: 'succeeded', finishedAt,
        params: { kind: 'metric', sql: 'SELECT 1', entities: ['order'], ...(definitionId ? { definitionId } : {}) },
        result: { assertions },
      }).returning())[0];
    // gold.dsl 的任务键要对应本租户还存在的定义（已删除的定义不计入），先建真实定义
    const space = await defaultSpaceOf(acme);
    const definition = async (key: string) =>
      (await getDb().insert(dslDefinitions).values({ tenantId: acme, spaceId: space, kind: 'metric', key }).returning())[0].id;
    // 两个定义的 gold.dsl 先后完成：先完成的带 warn 与阻断失败，后完成的全部通过（旧实现只看最后完成的这个，两个数都显示 0）
    const d1 = await definition('m1');
    const first = await gold('gold.dsl', d1, at(0), [
      { name: 'points_balance', level: 'warn', entity: 'membership', failed: 1 },
      { name: 'amount_non_negative', level: 'error', entity: 'order', failed: 2 },
    ]);
    // 另一个读会员的定义更早完成、报了同一条断言：同一条断言被多个任务报到时只算一次（按 level、name、entity 去重）
    const d3 = await definition('m3');
    await gold('gold.dsl', d3, at(-1), [{ name: 'points_balance', level: 'warn', entity: 'membership', failed: 1 }]);
    await gold('gold.dsl', await definition('m2'), at(1), [{ name: 'points_balance', level: 'warn', entity: 'membership', failed: 0 }]);
    // 模板任务没有 definitionId，任务键只按 kind：更早一次的阻断失败被后来通过的运行顶掉，不再计入
    await gold('gold.rfm', null, at(2), [{ name: 'amount_non_negative', level: 'error', entity: 'order', failed: 1 }]);
    await gold('gold.rfm', null, at(3), [{ name: 'amount_non_negative', level: 'error', entity: 'order', failed: 0 }]);
    // 合并任务的自定义断言不计入「最近一次」
    await getDb().insert(tasks).values({
      tenantId: acme, kind: 'silver.merge', status: 'succeeded', finishedAt: at(4), params: {},
      result: { assertions: [{ name: 'custom:amount:range', level: 'warn', entity: 'order', failed: 3 }] },
    });

    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const browser = await loginAs(app, 'analyst@acme.com');
    const html = await (await browser.get('/quality')).text();
    expect(html).toMatch(/最近一次告警<\/div><div class="[^"]*">1<\/div>/);
    expect(html).toMatch(/最近一次阻断失败<\/div><div class="[^"]*">1<\/div>/);
    expect(html).toMatch(/覆盖 (<!-- -->)?4(<!-- -->)? 个结果层任务/);
    expect(html).toContain(`href="/quality?task=${first.id}"`);

    // first 与 d3 的定义重跑并通过：只看每个任务键的最近一次，它上一次的失败不再计入，提示不再带失败任务的链接
    await gold('gold.dsl', d1, at(5), [
      { name: 'points_balance', level: 'warn', entity: 'membership', failed: 0 },
      { name: 'amount_non_negative', level: 'error', entity: 'order', failed: 0 },
    ]);
    await gold('gold.dsl', d3, at(6), [{ name: 'points_balance', level: 'warn', entity: 'membership', failed: 0 }]);
    const rerun = await (await browser.get('/quality')).text();
    expect(rerun).toMatch(/最近一次告警<\/div><div class="[^"]*">0<\/div>/);
    expect(rerun).toMatch(/最近一次阻断失败<\/div><div class="[^"]*">0<\/div>/);
    expect(rerun).toMatch(/覆盖 (<!-- -->)?4(<!-- -->)? 个结果层任务/);
    expect(rerun).not.toContain('href="/quality?task=');
  });

  it('已删除的定义不计入「最近一次」：定义最后一次 gold.dsl 带 warn 失败，删掉定义后变回 0、提示不再带 ?task= 链接', async () => {
    const acme = await newTenant('acme');
    const [def] = await getDb().insert(dslDefinitions)
      .values({ tenantId: acme, spaceId: await defaultSpaceOf(acme), kind: 'metric', key: 'points_gap' }).returning();
    const [run] = await getDb().insert(tasks).values({
      tenantId: acme, kind: 'gold.dsl', status: 'succeeded', finishedAt: new Date(),
      params: { kind: 'metric', sql: 'SELECT 1', entities: ['membership'], definitionId: def.id },
      result: { assertions: [{ name: 'points_balance', level: 'warn', entity: 'membership', failed: 1 }] },
    }).returning();
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const browser = await loginAs(app, 'analyst@acme.com');
    const html = await (await browser.get('/quality')).text();
    expect(html).toMatch(/最近一次告警<\/div><div class="[^"]*">1<\/div>/);
    expect(html).toContain(`href="/quality?task=${run.id}"`);

    // deleteDefinition 是硬删除，删掉的定义不会再跑：它最后一次的失败不再计入
    await getDb().delete(dslDefinitions).where(eq(dslDefinitions.id, def.id));
    const after = await (await browser.get('/quality')).text();
    expect(after).toMatch(/最近一次告警<\/div><div class="[^"]*">0<\/div>/);
    expect(after).not.toContain('href="/quality?task=');
  });

  it('按任务筛选：?task= 只看该任务的断言与隔离区，隔离区行显示来源映射并链到映射详情页；映射删了只显 ID；参数不是 UUID 忽略；别的租户用同一 ID 是空', async () => {
    const { acme, orderMappings, ok, task } = await failedRfm();
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const browser = await loginAs(app, 'analyst@acme.com');

    // 失败任务：只显示这次的断言与隔离区，顶部提示筛选、给出「看全部」；隔离区行带映射名与链接
    const html = await (await browser.get(`/quality?task=${task.id}`)).text();
    expect(html).toContain('只看任务');
    expect(html).toContain(task.id);
    expect(html).not.toContain(ok.id);
    expect(html).toContain('href="/quality"');
    expect(html).toMatch(/data-quarantine-key="A7"/);
    expect(html).toContain(`data-quarantine-mapping="${orderMappings!.crm}"`);
    expect(html).toMatch(new RegExp(`href="/mappings/${orderMappings!.crm}"`));
    expect(html).toContain('CRM · orders → order');

    // 之前成功的那次：断言记录都在（这一列只显 ok），隔离区是空的（「最近一次」统计仍是全局的，不受筛选影响）
    const okHtml = await (await browser.get(`/quality?task=${ok.id}`)).text();
    expect(okHtml).toContain(ok.id);
    expect(okHtml).not.toContain('data-quarantine-key');
    expect(okHtml).not.toContain('A7');
    expect(okHtml).toContain('隔离区是空的');

    // 参数不是 UUID：忽略筛选，和不带参数一样
    const bad = await (await browser.get('/quality?task=not-a-uuid')).text();
    expect(bad).toMatch(/data-quarantine-key="A7"/);
    expect(bad).toContain(ok.id);
    expect(bad).not.toContain('只看任务');

    // 映射删除后查不到名字：只显示映射 ID，不出链接
    await getDb().delete(mappings).where(eq(mappings.id, orderMappings!.crm));
    const gone = await (await browser.get(`/quality?task=${task.id}`)).text();
    expect(gone).toContain(`data-quarantine-mapping="${orderMappings!.crm}"`);
    expect(gone).not.toMatch(new RegExp(`href="/mappings/${orderMappings!.crm}"`));
    expect(gone).not.toContain('CRM · orders → order');

    // 别的租户的成员用同一个任务 ID 打开：列表是空的，看不到本租户的数据
    const globex = await newTenant('globex');
    await memberOf(globex, 'analyst@globex.com', 'analyst');
    const other = await loginAs(app, 'analyst@globex.com');
    const cross = await (await other.get(`/quality?task=${task.id}`)).text();
    expect(cross).not.toContain('A7');
    expect(cross).not.toContain('data-quarantine');
    expect(cross).not.toContain('data-assertion=');
  });

  it('其他租户的成员只看到自己湖里的断言结果，看不到本租户的断言结果与隔离区', async () => {
    const { task } = await failedRfm();
    const globex = await newTenant('globex');
    const session = await openTenantLake(lakeSpecOf((await lakeRow(globex))!), { memoryLimitMb: 256, threads: 1 });
    try {
      await session.con.run(`INSERT INTO silver._assertion_runs VALUES ('globex-task', 'order', 3, '[{"name":"amount_non_negative","level":"error","entity":"order","failed":0}]', now())`);
    } finally {
      session.close();
    }
    await memberOf(globex, 'analyst@globex.com', 'analyst');
    const browser = await loginAs(app, 'analyst@globex.com');
    const res = await browser.get('/quality');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('globex-task');
    expect(html).not.toContain(task.id);
    expect(html).not.toContain('data-quarantine-key');
    expect(html).not.toContain('A7');
  });
});
