// test/pipeline/catalog.test.ts —— 语义目录的加载（ADR-0041）：tenantCatalog 从平台库读出数据源、同步范围内的源表、已发布映射与自定义实体，
// 生成总览与条目；同步范围内还没映射的源表标「未映射」，范围外的不收，敏感字段与它们引用的源列不进目录；
// 源表带采集统计，实体带合并行数，字段带所映射源列的源端样本统计；发布的指标能展开、能按说明搜到，模板带产出列与最近一次快照；
// 实体字段与映射字段的业务说明保存后马上进目录、能搜到，清空后不再出现，敏感字段的说明不进目录；
// 映射发布、确认停用、定义发布与业务说明保存各记一版目录版本（原因是审计动作），目录没变的不记，可以取某版以来的差异；
// 自定义实体、合并组、源视图、同步范围、指标 / 标签 / 模板的发布也各记一版；源表加删列后重新采集记一版（source.profiled），只改统计的同步不记；
// 目录与最新一版不一致而没有事件记录时（能力说明变了），tenantCatalog 读取时补记一版，还没有版本的租户读取时记第 1 版，补记不与先锁租户行的事务死锁
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { expand, overview, search, toJson, toMarkdown } from '../../app/.server/catalog';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { catalogChangesSince, recordCatalogVersion } from '../../app/.server/catalog/versions';
import { saveBusinessNote } from '../../app/.server/business-notes';
import { createCustomEntity, deleteCustomEntity, publishCustomEntity } from '../../app/.server/custom-entities';
import { closeDb, getDb } from '../../app/.server/db/client';
import { catalogVersions } from '../../app/.server/db/schema';
import { createDefinition, discardDslDraft, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { confirmDisable, lockTenant, requestDisable } from '../../app/.server/mappings';
import { publishMergeGroup, saveMergeGroupDraft } from '../../app/.server/merge-groups';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { syncSource } from '../../app/.server/source-sync';
import { createSourceView, publishSourceView } from '../../app/.server/source-views';
import { relistSource, setSyncScope } from '../../app/.server/sources';
import { publishTemplate, saveDraft } from '../../app/.server/templates';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';
import { grantOnSource, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 本租户最新一版目录版本；还没有版本时为 undefined */
const latestVersion = async (tenantId: string) => (await getDb().select().from(catalogVersions)
  .where(eq(catalogVersions.tenantId, tenantId)).orderBy(desc(catalogVersions.version)).limit(1))[0];

/** 做一件事，断言目录版本 +1、原因是 reason，返回新的一版 */
async function expectBump(tenantId: string, reason: string, act: () => Promise<unknown>) {
  const before = (await latestVersion(tenantId))?.version ?? 0;
  await act();
  const after = await latestVersion(tenantId);
  expect(after, reason).toMatchObject({ version: before + 1, reason });
  return after!;
}

describe('语义目录的加载', () => {
  it('收进同步范围内的源表（没映射的标未映射），不收范围外的，敏感字段与它们引用的源列不出现', async () => {
    const { acme, author, sources } = await publishedIdentitySources({ orders: true });
    await grantOnSource(`
      CREATE TABLE crm.stores (store_id text PRIMARY KEY, region text, updated_at timestamp NOT NULL);
      CREATE TABLE crm.audit_log (id int PRIMARY KEY, note text);
      GRANT SELECT ON ALL TABLES IN SCHEMA crm TO ${READER.user};`);
    await relistSource(author, sources.crm);
    await drain();
    await setSyncScope(author, sources.crm, { add: ['stores'] });
    await drain();

    const c = await tenantCatalog(acme);
    expect(expand(c, 'source:CRM')).toMatchObject({ tables: ['table:CRM/customers', 'table:CRM/orders', 'table:CRM/stores'] });
    expect(expand(c, 'table:CRM/stores')).toMatchObject({
      kind: 'table', mapped: false, entities: [], description: '源表，未映射',
      columns: expect.arrayContaining([{ name: 'store_id', type: expect.any(String) }, { name: 'region', type: expect.any(String) }]),
    });
    expect(expand(c, 'table:CRM/orders')).toMatchObject({ mapped: true, entities: ['entity:order'] });
    expect(expand(c, 'table:CRM/audit_log')).toBeNull();
    expect(expand(c, 'field:order.status')).toMatchObject({ lineage: expect.arrayContaining([expect.objectContaining({ source: 'CRM', table: 'orders' })]) });
    expect(expand(c, 'entity:customer')).toMatchObject({ tables: ['table:CRM/customers', 'table:会员/members', 'table:埋点/users'] });

    const md = toMarkdown(overview(c));
    expect(md).toMatch(/table:CRM\/stores .*未映射/);
    expect(md).not.toContain('audit_log');

    const all = [md, toJson(overview(c)), ...c.entries.flatMap(e => [toMarkdown(e), toJson(e)]),
      ...['手机 phone', '邮箱 email', '姓名 name', 'unionid external'].flatMap(q => [toMarkdown(search(c, q)), toJson(search(c, q))])].join('\n');
    for (const field of ['name', 'phone', 'email', 'external_id']) expect(all, field).not.toContain(`field:customer.${field}`);
    const customer = expand(c, 'entity:customer');
    expect(customer && 'fields' in customer && customer.fields.map(f => f.name)).not.toEqual(expect.arrayContaining(['name']));
    // 源表 customers 的敏感列：映射成 external_id 的 unionid，名字像敏感信息的 name / mobile / email
    expect(expand(c, 'table:CRM/customers')).toMatchObject({ columns: [{ name: 'id' }, { name: 'updated_at' }] });
    for (const word of ['unionid', 'mobile', 'full_name', 'external_id']) expect(all, word).not.toContain(word);
  });

  it('源表带采集统计，实体带合并行数，字段带源端样本；敏感列没有取值与范围，统计不进总览', async () => {
    const { acme } = await publishedIdentitySources({ orders: true });
    await drain();
    const c = await tenantCatalog(acme);

    const orders = expand(c, 'table:CRM/orders');
    expect(orders).toMatchObject({ stats: { rows: 6, sampleRows: 6, at: expect.any(String) } });
    const cols = orders?.kind === 'table' ? orders.stats!.columns : [];
    expect(cols.find(col => col.name === 'status')).toMatchObject({ nullRate: 0, top: [{ value: 'paid', rows: 5 }, { value: 'refunded', rows: 1 }] });
    expect(cols.find(col => col.name === 'created_at')).toMatchObject({ range: { min: expect.stringContaining('2024-04-01'), max: expect.stringContaining('2024-06-30') } });
    expect(cols.find(col => col.name === 'order_no')).not.toHaveProperty('range');
    expect(toMarkdown(orders!)).toContain('（采集时间）');

    // CRM 6 行加会员 5 行
    expect(expand(c, 'entity:order')).toMatchObject({ stats: { rows: 11, at: expect.any(String) } });
    expect(toMarkdown(expand(c, 'entity:order')!)).toContain('（最近一次合并）');
    expect(expand(c, 'field:order.status')).toMatchObject({ lineage: expect.arrayContaining([
      expect.objectContaining({ source: 'CRM', table: 'orders', sample: [expect.objectContaining({ name: 'status', top: [{ value: 'paid', rows: 5 }, { value: 'refunded', rows: 1 }] })] }),
    ]) });
    expect(toMarkdown(expand(c, 'field:order.status')!)).toContain('源端样本 `status`');

    // 映射成 external_id 的 unionid（列名不像敏感信息，采集时照样存了取值）与像敏感信息的列不出现
    const customers = expand(c, 'table:CRM/customers');
    expect(customers?.kind === 'table' && customers.stats!.columns.map(col => col.name)).toEqual(['id', 'updated_at']);
    const all = [toMarkdown(overview(c)), toJson(overview(c)), ...c.entries.flatMap(e => [toMarkdown(e), toJson(e)])].join('\n');
    for (const word of ['wx_union_8', '张三', '13800000002', 'zhang@crm.test']) expect(all, word).not.toContain(word);
    expect(toJson(overview(c))).not.toMatch(/采集时间|最近一次合并|nullRate|sampleRows|"top"/);
  });

  it('发布的指标取最新发布版：能展开、能按说明搜到，草稿不算；自动启用的模板带产出列与快照', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    await createDefinition(author, 'metric', 'paid_revenue', 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 旧口径\n');
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 1);
    await saveDslDraft(author, 'metric', 'paid_revenue', 'base: order\nmeasure: { agg: sum, field: amount }\nfilter:\n  - { field: status, op: eq, value: paid }\ndescription: 已支付订单的实付金额\n');
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 2);
    await saveDslDraft(author, 'metric', 'paid_revenue', 'base: order\nmeasure: { agg: count }\ndescription: 草稿口径\n');
    await drain();

    const c = await tenantCatalog(acme);
    expect(expand(c, 'metric:paid_revenue')).toMatchObject({
      version: 2, description: '已支付订单的实付金额', measure: 'sum(amount)',
      dependencies: { entities: ['entity:order'], fields: ['field:order.amount', 'field:order.status'] },
    });
    expect(search(c, '已支付 实付金额')[0]?.id).toBe('metric:paid_revenue');
    expect(toMarkdown(overview(c))).toContain('- metric:paid_revenue paid_revenue — 已支付订单的实付金额');
    expect(toJson(c.entries)).not.toMatch(/旧口径|草稿口径/);
    // 映射合并后平台自动启用的模板：产出列与最近一次快照
    expect(expand(c, 'template:rfm')).toMatchObject({
      version: 1, entities: ['entity:order', 'entity:customer'], columns: expect.arrayContaining([expect.objectContaining({ name: 'segment' })]),
      snapshot: { table: expect.stringMatching(/^gold\.rfm__/), rows: expect.any(Number), at: expect.any(String) },
    });
    expect(toMarkdown(overview(c))).toContain('- template:rfm RFM 分层');
  });

  it('业务说明保存后不需要发布就进目录：实体字段说明在字段上，映射字段说明在各自的血缘下，能搜到；清空后不出现，敏感字段的说明不进目录', async () => {
    const { acme, author, mappings, orderMappings } = await publishedIdentitySources({ orders: true });
    await saveBusinessNote(author, { entity: 'order', field: 'status', note: '退款单也算一笔订单，状态记为 refunded' });
    await saveBusinessNote(author, { entity: 'order', field: 'status', mappingId: orderMappings!.loyalty, note: '会员系统的取消单不进同步' });
    await saveBusinessNote(author, { entity: 'customer', field: 'name', note: '机密口径甲乙丙' });
    await saveBusinessNote(author, { entity: 'customer', field: 'name', mappingId: mappings.crm, note: '机密口径丁戊己' });

    let c = await tenantCatalog(acme);
    const status = expand(c, 'field:order.status');
    expect(status).toMatchObject({ note: '退款单也算一笔订单，状态记为 refunded' });
    const lineage = status?.kind === 'field' ? status.lineage : [];
    expect(lineage.find(l => l.source === '会员')).toMatchObject({ note: '会员系统的取消单不进同步' });
    expect(lineage.find(l => l.source === 'CRM')).not.toHaveProperty('note');
    const md = toMarkdown(status!);
    expect(md).toContain('退款单也算一笔订单');
    expect(md).toContain('会员系统的取消单不进同步');
    expect(search(c, '退款单')[0]?.id).toBe('field:order.status');
    expect(search(c, '取消单')[0]?.id).toBe('field:order.status');
    const all = [toMarkdown(overview(c)), toJson(overview(c)), ...c.entries.flatMap(e => [toMarkdown(e), toJson(e)])].join('\n');
    expect(all).not.toContain('机密口径');
    expect(search(c, '机密口径')).toEqual([]);

    await saveBusinessNote(author, { entity: 'order', field: 'status', note: '' });
    await saveBusinessNote(author, { entity: 'order', field: 'status', mappingId: orderMappings!.loyalty, note: '' });
    c = await tenantCatalog(acme);
    expect(expand(c, 'field:order.status')).not.toHaveProperty('note');
    expect(toJson(c.entries)).not.toMatch(/退款单也算|取消单/);
    expect(search(c, '取消单')).toEqual([]);
  });

  it('映射发布、业务说明、定义发布与确认停用各记一版，原因是审计动作；目录没变、起草与丢弃草稿不记；可取某版以来的差异，总览带版本号', async () => {
    const { acme, author, reviewer, orderMappings } = await publishedIdentitySources({ orders: true });
    await drain();
    const current = async () => (await catalogChangesSince(getDb(), acme, 0)).current!;
    const start = await catalogChangesSince(getDb(), acme, 0);
    expect(start.versions.map(v => v.version)).toEqual(start.versions.map((_, i) => i + 1));
    expect(start.versions[0]).toMatchObject({ version: 1, reason: 'source.registered' });
    expect(start.versions.map(v => v.reason)).toEqual(expect.arrayContaining(['mapping.published', 'template.auto_enabled']));
    expect(start.net.added.map(x => x.id)).toEqual(expect.arrayContaining(['entity:order', 'field:order.status', 'template:rfm']));
    const v0 = start.current!;

    await saveBusinessNote(author, { entity: 'order', field: 'status', note: '退款单也算一笔订单' });
    expect(await current()).toBe(v0 + 1);
    // 同一条说明再存一次：目录没变，不记
    await saveBusinessNote(author, { entity: 'order', field: 'status', note: '退款单也算一笔订单' });
    expect(await current()).toBe(v0 + 1);

    await createDefinition(author, 'metric', 'paid_revenue', 'base: order\nmeasure: { agg: sum, field: amount }\ndescription: 实付金额\n');
    await saveDslDraft(author, 'metric', 'paid_revenue', 'base: order\nmeasure: { agg: count }\n');
    expect(await current()).toBe(v0 + 1);
    await publishDefinition(reviewer, 'metric', 'paid_revenue', 1);
    expect(await current()).toBe(v0 + 2);
    await saveDslDraft(author, 'metric', 'paid_revenue', 'base: order\nmeasure: { agg: sum, field: amount }\n');
    await discardDslDraft(author, 'metric', 'paid_revenue');
    expect(await current()).toBe(v0 + 2);

    await drain();
    await requestDisable(author, orderMappings!.loyalty);
    expect(await current()).toBe(v0 + 2);
    await confirmDisable(reviewer, orderMappings!.loyalty);
    expect(await current()).toBe(v0 + 3);

    const since = await catalogChangesSince(getDb(), acme, v0);
    expect(since.current).toBe(v0 + 3);
    expect(since.versions.map(v => [v.version, v.reason])).toEqual([
      [v0 + 1, 'business_note.updated'], [v0 + 2, 'definition.published'], [v0 + 3, 'mapping.disabled'],
    ]);
    expect(since.versions[0].diff.changed).toEqual([expect.objectContaining({ id: 'field:order.status', keys: ['note'] })]);
    expect(since.versions[0].createdAt).toBeInstanceOf(Date);
    expect(since.net.added).toEqual([expect.objectContaining({ id: 'metric:paid_revenue', kind: 'metric' })]);
    expect(since.net.changed.map(x => x.id)).toEqual(expect.arrayContaining(['field:order.status', 'entity:order', 'table:会员/orders']));

    const c = await tenantCatalog(acme);
    expect(c.version).toBe(v0 + 3);
    expect(overview(c).version).toBe(v0 + 3);
    expect(toMarkdown(overview(c))).toContain(`目录版本 ${v0 + 3}`);
  });

  it('自定义实体发布与删除各记一版', async () => {
    const acme = await newTenant('acme');
    const author = await memberOf(acme, 'de@acme.com');
    const reviewer = await memberOf(acme, 'de2@acme.com');
    const id = await createCustomEntity(author, {
      name: 'custom_store', label: '门店', kind: 'dimension',
      fields: [{ name: 'store_id', type: 'string', description: '门店编号', sensitive: false }], primaryKey: ['store_id'],
    });
    expect(await latestVersion(acme)).toBeUndefined();
    const published = await expectBump(acme, 'custom_entity.published', () => publishCustomEntity(reviewer, id, 1));
    expect(published.diff.added.map(x => x.id)).toContain('entity:custom_store');
    const deleted = await expectBump(acme, 'custom_entity.deleted', () => deleteCustomEntity(author, id));
    expect(deleted.diff.removed.map(x => x.id)).toContain('entity:custom_store');
  });

  it('合并组发布记一版', async () => {
    const { acme, author, reviewer, orderMappings } = await publishedIdentitySources({ orders: true });
    await saveMergeGroupDraft(author, 'order', { members: [orderMappings!.crm, orderMappings!.loyalty], rule: { kind: 'priority' } });
    const v = await expectBump(acme, 'merge_group.published', () => publishMergeGroup(reviewer, 'order', 1));
    expect(v.diff.changed.map(x => x.id)).toContain('entity:order');
  });

  it('源视图发布记一版', async () => {
    const { acme, author, reviewer, sources } = await publishedIdentitySources({ orders: true });
    const viewId = await createSourceView(author, sources.crm, {
      name: 'paid_orders', sql: "SELECT order_no, amount, _op, _batch, _commit_ts FROM orders WHERE status = 'paid'",
    });
    const v = await expectBump(acme, 'source_view.published', () => publishSourceView(reviewer, sources.crm, viewId, 1));
    expect(v.diff.added.map(x => x.id)).toContain('table:CRM/paid_orders');
  });

  it('同步范围变更记一版', async () => {
    const { acme, author, sources } = await publishedIdentitySources();
    await grantOnSource(`CREATE TABLE crm.stores (store_id text PRIMARY KEY, updated_at timestamp NOT NULL);
      GRANT SELECT ON ALL TABLES IN SCHEMA crm TO ${READER.user};`);
    await relistSource(author, sources.crm);
    await drain();
    const v = await expectBump(acme, 'source.scope_changed', () => setSyncScope(author, sources.crm, { add: ['stores'] }));
    expect(v.diff.added.map(x => x.id)).toContain('table:CRM/stores');
  });

  it('指标、标签与模板定义的发布各记一版，自动启用模板也记一版；之后的快照不记', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    await drain();
    const { versions } = await catalogChangesSince(getDb(), acme, 0);
    expect(versions.find(v => v.reason === 'template.auto_enabled')?.diff.added.map(x => x.id)).toContain('template:rfm');

    await createDefinition(author, 'metric', 'revenue', 'base: order\nmeasure: { agg: sum, field: amount }\n');
    await expectBump(acme, 'definition.published', () => publishDefinition(reviewer, 'metric', 'revenue', 1));
    await createDefinition(author, 'tag', 'value_tier', 'metric: revenue\nrules:\n  - { value: high, when: { gte: 100 } }\ndefault: low\n');
    const tag = await expectBump(acme, 'definition.published', () => publishDefinition(reviewer, 'tag', 'value_tier', 1));
    expect(tag.diff.added.map(x => x.id)).toEqual(['tag:value_tier']);
    await drain();

    await saveDraft(author, 'rfm', {
      lookbackDays: 3650, statuses: ['paid'],
      binning: { method: 'thresholds', recency: [30, 90, 180, 365], frequency: [2, 3, 5, 8], monetary: [100, 500, 1000, 5000] },
      segments: [{ name: '高价值', m: { min: 3 } }, { name: '其他' }],
    });
    const template = await expectBump(acme, 'template.published', () => publishTemplate(reviewer, 'rfm', 2));
    expect(template.diff.changed.map(x => x.id)).toContain('template:rfm');
    await drain();
    expect((await latestVersion(acme))?.version).toBe(template.version);
  });

  it('源表加列、删列后重新采集各记一版，差异里是该表的列；只改了行数的同步与随后的合并不记', async () => {
    const { acme, author, sources } = await publishedIdentitySources({ orders: true });
    await drain();
    const v0 = (await latestVersion(acme))!.version;

    await grantOnSource('ALTER TABLE crm.orders ADD COLUMN coupon text');
    await relistSource(author, sources.crm);
    await drain();
    const added = await catalogChangesSince(getDb(), acme, v0);
    expect(added.versions.map(v => [v.version, v.reason])).toEqual([[v0 + 1, 'source.profiled']]);
    expect(added.versions[0].diff.changed).toEqual([expect.objectContaining({ id: 'table:CRM/orders', keys: expect.arrayContaining(['columns']) })]);
    expect(expand(await tenantCatalog(acme), 'table:CRM/orders')).toMatchObject({ columns: expect.arrayContaining([expect.objectContaining({ name: 'coupon' })]) });

    await grantOnSource('ALTER TABLE crm.orders DROP COLUMN coupon');
    await relistSource(author, sources.crm);
    await drain();
    expect(await latestVersion(acme)).toMatchObject({ version: v0 + 2, reason: 'source.profiled' });

    await grantOnSource("INSERT INTO crm.orders VALUES ('A9', 1, 'paid', 50, '2024-06-29 10:00', '2024-06-29 10:00', now())");
    await syncSource(author, sources.crm);
    await drain();
    expect((await latestVersion(acme))?.version).toBe(v0 + 2);
    expect(expand(await tenantCatalog(acme), 'entity:order')).toMatchObject({ stats: { rows: 12 } });
    expect((await latestVersion(acme))?.version).toBe(v0 + 2);
  });

  it('目录与最新一版不一致而没有事件记录时，读取时补记一版：只有能力条目变了是 platform.capabilities，否则 catalog.detected；没有版本时记第 1 版', async () => {
    const { acme } = await publishedIdentitySources();
    const tamper = async (drop: string) => {
      const row = (await latestVersion(acme))!;
      expect(row.snapshot.map(e => e.id)).toContain(drop);
      await getDb().update(catalogVersions).set({ snapshot: row.snapshot.filter(e => e.id !== drop) })
        .where(and(eq(catalogVersions.tenantId, acme), eq(catalogVersions.version, row.version)));
      return row.version;
    };

    const v0 = await tamper('capability:metric-dsl');
    expect((await tenantCatalog(acme)).version).toBe(v0 + 1);
    expect(await latestVersion(acme)).toMatchObject({
      version: v0 + 1, reason: 'platform.capabilities', diff: { added: [expect.objectContaining({ id: 'capability:metric-dsl' })], removed: [], changed: [] },
    });
    // 一致之后再读不记
    expect((await tenantCatalog(acme)).version).toBe(v0 + 1);

    await tamper('entity:customer');
    expect((await tenantCatalog(acme)).version).toBe(v0 + 2);
    expect(await latestVersion(acme)).toMatchObject({ reason: 'catalog.detected' });

    await getDb().delete(catalogVersions).where(eq(catalogVersions.tenantId, acme));
    expect((await tenantCatalog(acme)).version).toBe(1);
    expect(await latestVersion(acme)).toMatchObject({ version: 1, reason: 'catalog.initial' });
  });

  it('读取时补记不与先锁住租户行再记版本的事务互相等待', async () => {
    const { acme } = await publishedIdentitySources();
    const row = (await latestVersion(acme))!;
    await getDb().update(catalogVersions).set({ snapshot: row.snapshot.filter(e => e.id !== 'capability:metric-dsl') })
      .where(and(eq(catalogVersions.tenantId, acme), eq(catalogVersions.version, row.version)));

    let reading: Promise<unknown> | undefined;
    await getDb().transaction(async tx => {
      await lockTenant(tx, acme);
      reading = tenantCatalog(acme);
      // 等读取进到补记里，再像 lockTenant 之后记审计那样记版本
      await new Promise(r => setTimeout(r, 300));
      await recordCatalogVersion(tx, acme, 'business_note.updated');
    });
    // 读取等锁住租户行的事务记完才补记，这时目录已一致，不再多记
    expect(await reading).toMatchObject({ version: row.version + 1 });
    expect(await latestVersion(acme)).toMatchObject({ version: row.version + 1, reason: 'business_note.updated' });
  });
});
