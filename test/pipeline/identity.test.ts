// 身份打通的流水线接缝：CRM、会员、埋点三个数据源同步进原始层 → 发布映射 → 调度器派发合并（改到 customer 或 event、
// 打通结果表不在或入队时要求强制时整表重算打通，否则跳过）→ silver._identities 里每条 (_source, customer_id) 对应一个统一消费者，
// silver._device_owner 里每台登录过的设备归属到最近一次登录的统一消费者，任务结果带打通摘要，表里没有明文
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CurrentMember } from '../../app/.server/auth';
import { closeDb, getDb } from '../../app/.server/db/client';
import { tasks } from '../../app/.server/db/schema';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { latestIdentitySummary, listMappings, mergeMapping, mergeNow, publishMapping, saveDraft } from '../../app/.server/mappings';
import { syncSource } from '../../app/.server/source-sync';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { checkMetric, compileMetric, type DslContext } from '../../app/.server/pipeline/dsl/metric-spec';
import { resolveIdentities } from '../../app/.server/pipeline/identity-engine';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { runTask, silver } from './fixtures';
import { CRM, LOYALTY, publishedIdentitySources } from './identity-fixtures';
import { grantOnSource } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 种子里的明文：手机号（规范化前后）、邮箱、外部 ID 与姓名 */
const SEEDED = ['13800000001', '138 0000', '138-0000', '13800000002', '13900000005', '139 0000', 'zhang@crm', 'wang5@example', 'qian7@example',
  'li4@loyalty', 'wx_union_8', '13700000009', '张三', '李四', '王五', '钱七', '孙八'];

type Identity = { _source: string; customer_id: string; consumer_id: string };
type DeviceOwner = { device_id: string; consumer_id: string; login_at: string };

/** silver._identities 的全部行（按数据源与 customer_id 排序）与整表的 JSON 文本，以及 silver._device_owner 的全部行（按设备排序） */
async function identities(tenantId: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const rows = await read<Identity>('SELECT * FROM silver._identities ORDER BY _source, customer_id');
    const devices = await read<DeviceOwner>(`SELECT * REPLACE (strftime(login_at AT TIME ZONE 'UTC', '%Y-%m-%d %H:%M') AS login_at)
      FROM silver._device_owner ORDER BY device_id`);
    return { rows, text: JSON.stringify(rows), devices };
  } finally {
    session.close();
  }
}

/** 匿名事件（customer_id 为空）经设备归属到的统一消费者；设备没有归属时为 null */
async function anonymousEvents(tenantId: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return (await session.con.runAndReadAll(`SELECT e.event_id, o.consumer_id FROM silver."event" e
      LEFT JOIN silver._device_owner o USING (device_id) WHERE e.customer_id IS NULL ORDER BY e.event_id`)).getRowObjectsJson();
  } finally {
    session.close();
  }
}

/** 按统一消费者分组，每组是「数据源名:customer_id」的列表；组按第一条排序，便于整体比较 */
const groupsOf = (rows: Identity[], names: Record<string, string>) => {
  const groups = new Map<string, string[]>();
  for (const r of rows) groups.set(r.consumer_id, [...(groups.get(r.consumer_id) ?? []), `${names[r._source]}:${r.customer_id}`]);
  return [...groups.values()].map(g => g.sort()).sort((a, b) => a[0].localeCompare(b[0]));
};

/** 本租户最近一次合并任务（按创建时间） */
async function lastMerge(tenantId: string) {
  const [merge] = await getDb().select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'silver.merge')))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  return merge as typeof merge & { result: { identities?: Record<string, unknown> } };
}

/** 给映射存一版新草稿并由另一位成员发布，跑空调度器（合并与打通完成） */
async function republish(author: CurrentMember, reviewer: CurrentMember, mappingId: string, yaml: string) {
  await publishMapping(reviewer, mappingId, await saveDraft(author, mappingId, yaml));
  await drain();
}

describe('身份打通：多源消费者确定性合并', () => {
  it('手机号写法不同、只有邮箱相同、外部 ID 相同、手机-邮箱链上的记录合并为同一个消费者；空手机与空邮箱不合并', async () => {
    const { acme, names } = await publishedIdentitySources();
    const { rows, text } = await identities(acme);
    expect(groupsOf(rows, names)).toEqual([
      ['crm:1', 'loyalty:1', 'tracking:u1'],
      ['crm:2', 'loyalty:2', 'tracking:u2'],
      ['crm:3', 'loyalty:3'],
      ['crm:4'],
      ['crm:5', 'crm:6', 'loyalty:5'],
      ['crm:7', 'loyalty:6'],
      ['loyalty:4'],
      ['tracking:u9'],
    ]);

    // 统一消费者 ID 不是任何敏感字段的哈希；表里没有明文
    const hashes = (await silver(acme, 'customer', '_source, customer_id')).flatMap(r => [r.name, r.phone, r.email, r.external_id]);
    expect(rows.filter(r => hashes.includes(r.consumer_id))).toEqual([]);
    expect(SEEDED.filter(s => text.toLowerCase().includes(s.toLowerCase()))).toEqual([]);

    // 最后一次合并的任务结果带打通摘要
    const [merge] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
    expect(merge.status).toBe('succeeded');
    expect((merge.result as { identities: unknown }).identities).toMatchObject({ groups: 8, records: 16, devices: 2 });
  });

  it('登录过的设备归属到最近一次登录的统一消费者，同一时刻登录并列时取较小的 consumer_id；匿名事件经设备归属', async () => {
    const { acme, names } = await publishedIdentitySources();
    const { rows, devices } = await identities(acme);
    const consumerOf = (who: string) => rows.find(r => `${names[r._source]}:${r.customer_id}` === who)!.consumer_id;
    const [u1, u2, u9] = ['tracking:u1', 'tracking:u2', 'tracking:u9'].map(consumerOf);
    // u1 与 crm 1 是同一个人：设备归属到统一消费者，不是埋点源里的用户
    expect(u1).toBe(consumerOf('crm:1'));

    // d1 先被 u1 登录、后被 u2 登录；d2 同一时刻被 u9、u1 登录；d3 只有匿名事件、d4 没有 login，都不归属
    expect(devices).toEqual([
      { device_id: 'd1', consumer_id: u2, login_at: '2024-06-02 10:00' },
      { device_id: 'd2', consumer_id: [u1, u9].sort()[0], login_at: '2024-06-03 09:00' },
    ]);
    expect(await anonymousEvents(acme)).toEqual([
      { event_id: 'e2', consumer_id: u2 },
      { event_id: 'e4', consumer_id: u2 },
      { event_id: 'e7', consumer_id: [u1, u9].sort()[0] },
      { event_id: 'e8', consumer_id: null },
    ]);
  });

  it('event 指标的快照里匿名事件经设备归属计入设备主人；没有 _device_owner 的老湖给出提示', async () => {
    const { acme, names } = await publishedIdentitySources();
    const { rows } = await identities(acme);
    const consumerOf = (who: string) => rows.find(r => `${names[r._source]}:${r.customer_id}` === who)!.consumer_id;
    const [u1, u2, u9] = ['tracking:u1', 'tracking:u2', 'tracking:u9'].map(consumerOf);
    const ctx: DslContext = { published: new Map(), plans: [], metrics: new Map() };
    const checked = checkMetric('base: event\nmeasure: { agg: count }\nfilter:\n  - { field: event_type, op: ne, value: login }\n', ctx);
    if (!checked.ok) throw new Error(JSON.stringify(checked.issues));
    const params = { kind: 'metric', key: 'views', asOf: '2024-07-01', sql: compileMetric(checked.spec, ctx, '2024-07-01'), entities: ['event'] };

    // d1 的 e2、e4 归 u2；d2 的 e7 归 u1、u9 中较小的；d3 的 e8 不计入；e9 是 u1 登录状态下的浏览
    const task = await runTask(acme, 'gold.dsl', params);
    expect(task.status).toBe('succeeded');
    const table = `gold."${(task.result as { table: string }).table.slice('gold.'.length)}"`;
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      const snapshot = (await session.con.runAndReadAll(`SELECT consumer_id, value::INTEGER AS value FROM ${table} ORDER BY consumer_id`)).getRowObjectsJson();
      const d2 = [u1, u9].sort()[0];
      const expected = new Map<string, number>([[u2, 2], [u1, 1]]);
      expected.set(d2, (expected.get(d2) ?? 0) + 1);
      expect(snapshot).toEqual([...expected].sort(([a], [b]) => a.localeCompare(b)).map(([consumer_id, value]) => ({ consumer_id, value })));
      await session.con.run('DROP TABLE silver._device_owner');
    } finally {
      session.close();
    }

    const failed = await runTask(acme, 'gold.dsl', params);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('silver._device_owner');
  });

  it('统一消费者属性：每人一行，按 updated_at 取最新的非空值并记来源，名次优先于 updated_at；不收敏感字段', async () => {
    const { acme, names, mappings } = await publishedIdentitySources();
    const source = Object.fromEntries(Object.entries(names).map(([id, name]) => [name, id]));
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    const read = async (sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson();
    try {
      // 合并已经写出 _consumer：每个统一消费者一行，没有敏感字段
      const [{ consumers, groups }] = await read(`SELECT (SELECT count(*) FROM silver._consumer)::INTEGER AS consumers,
        (SELECT count(DISTINCT consumer_id) FROM silver._identities)::INTEGER AS groups`);
      expect(consumers).toBe(groups);
      const columns = (await read('DESCRIBE silver._consumer')).map(c => c.column_name);
      expect(columns).toEqual(expect.arrayContaining(['consumer_id', 'city', 'city__source', 'updated_at']));
      expect(columns.filter(c => /^(name|phone|email|external_id|customer_id|_mapping|_source)(__source)?$/.test(String(c)))).toEqual([]);

      // crm 1、loyalty 1、tracking u1 是同一个人：loyalty 的城市更新，tracking 最新但城市为空
      await session.con.run(`UPDATE silver.customer SET city = CASE _source WHEN '${source.crm}' THEN '上海' WHEN '${source.loyalty}' THEN '北京' END,
        updated_at = CASE _source WHEN '${source.crm}' THEN TIMESTAMPTZ '2024-06-01 00:00:00+00' WHEN '${source.loyalty}' THEN TIMESTAMPTZ '2024-06-05 00:00:00+00'
          ELSE TIMESTAMPTZ '2024-06-09 00:00:00+00' END
        WHERE customer_id IN ('1', 'u1')`);
      const u1 = async () => read(`SELECT c.city, c.city__source FROM silver._consumer c JOIN silver._identities i USING (consumer_id)
        WHERE i._source = '${source.tracking}' AND i.customer_id = 'u1'`);
      await resolveIdentities(session.con);
      expect(await u1()).toEqual([{ city: '北京', city__source: source.loyalty }]);
      await resolveIdentities(session.con, undefined, { priority: { [mappings.crm]: 1 } });
      expect(await u1()).toEqual([{ city: '上海', city__source: source.crm }]);

      // 映射里标成敏感的字段（由 consumerSensitive 汇总传入）也不进 _consumer
      await resolveIdentities(session.con, undefined, { sensitive: ['city'] });
      expect((await read('DESCRIBE silver._consumer')).map(c => c.column_name)).not.toContain('city');
    } finally {
      session.close();
    }
  });

  it('consumer.city 维度的指标里一个人只出现一次；没有 _consumer 的老湖给出重新合并的提示', async () => {
    const { acme, names } = await publishedIdentitySources();
    const source = Object.fromEntries(Object.entries(names).map(([id, name]) => [name, id]));
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      await session.con.run(`UPDATE silver.customer SET city = CASE _source WHEN '${source.crm}' THEN '上海' ELSE '北京' END,
        updated_at = CASE _source WHEN '${source.crm}' THEN TIMESTAMPTZ '2024-06-01 00:00:00+00' ELSE TIMESTAMPTZ '2024-06-05 00:00:00+00' END
        WHERE customer_id = '1'`);
      await resolveIdentities(session.con);
    } finally {
      session.close();
    }
    const ctx: DslContext = { published: new Map(), plans: [], metrics: new Map() };
    const checked = checkMetric('base: customer\nmeasure: { agg: count }\ndimensions:\n  - { name: city, path: consumer.city }\n', ctx);
    if (!checked.ok) throw new Error(JSON.stringify(checked.issues));
    const params = { kind: 'metric', key: 'by_city', asOf: '2024-07-01', sql: compileMetric(checked.spec, ctx, '2024-07-01'), entities: ['customer'] };

    const task = await runTask(acme, 'gold.dsl', params);
    expect(task.status).toBe('succeeded');
    const table = `gold."${(task.result as { table: string }).table.slice('gold.'.length)}"`;
    const again = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      // crm 1、loyalty 1、tracking u1 是同一个人：只有一行，城市取较新的北京，三条源记录都计入
      const rows = (await again.con.runAndReadAll(`SELECT g.city, g.value::INTEGER AS value FROM ${table} g
        JOIN silver._identities i USING (consumer_id) WHERE i._source = '${source.crm}' AND i.customer_id = '1'`)).getRowObjectsJson();
      expect(rows).toEqual([{ city: '北京', value: 3 }]);
      await again.con.run('DROP TABLE silver._consumer');
    } finally {
      again.close();
    }

    const failed = await runTask(acme, 'gold.dsl', params);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('silver._consumer');
    expect(failed.error).toContain('重新合并一次映射');
  });

  it('同样的输入再合并一次，打通表与设备归属表的内容完全一致', async () => {
    const { acme, author } = await publishedIdentitySources();
    const before = await identities(acme);
    await mergeNow(author);
    await drain();
    const after = await identities(acme);
    expect(after.rows).toEqual(before.rows);
    expect(after.devices).toEqual(before.devices);
  });
});

describe('身份打通：只在改到 customer 或 event 时重算', () => {
  it('没有变化的合并跳过打通并写明原因：打通表不动，数据地图的摘要仍是上次真正打通的那次', async () => {
    const { acme, author } = await publishedIdentitySources();
    const before = await identities(acme);
    const summary = await latestIdentitySummary(acme);
    await mergeNow(author);
    await drain();
    const merge = await lastMerge(acme);
    expect(merge.status).toBe('succeeded');
    expect(merge.result.identities).toEqual({ durationMs: 0, skipped: expect.stringMatching(/沿用上次/) });
    expect((await identities(acme)).text).toBe(before.text);
    expect(await latestIdentitySummary(acme)).toEqual(summary);
    expect(summary).toMatchObject({ groups: 8, records: 16, devices: 2 });
  });

  it('只合并订单映射时跳过打通', async () => {
    const { acme, author } = await publishedIdentitySources({ orders: true });
    // 发布订单映射后的首次合并（重建、有插入）只带订单映射
    expect((await lastMerge(acme)).result.identities).toMatchObject({ skipped: expect.any(String) });
    const order = (await listMappings(author)).mappings.find(m => m.entity === 'order')!;
    await mergeMapping(author, order.id);
    await drain();
    expect((await lastMerge(acme)).result.identities).toMatchObject({ skipped: expect.any(String) });
  });

  it('上次打通失败时，没有数据变化也强制重算', async () => {
    const { acme, author } = await publishedIdentitySources();
    const last = await lastMerge(acme);
    await getDb().update(tasks).set({ result: { ...last.result, identities: { durationMs: 1, error: '模拟失败' } } }).where(eq(tasks.id, last.id));
    await mergeNow(author);
    await drain();
    const merge = await lastMerge(acme);
    expect(merge.params.identityForce).toBe(true);
    expect(merge.result.identities).toMatchObject({ groups: 8, records: 16, devices: 2 });
  });

  it('上次合并没写结果就结束（崩溃、超时）时，没有数据变化也强制重算', async () => {
    const { acme, author } = await publishedIdentitySources();
    const last = await lastMerge(acme);
    await getDb().update(tasks).set({ status: 'failed', result: null }).where(eq(tasks.id, last.id));
    await mergeNow(author);
    await drain();
    const merge = await lastMerge(acme);
    expect(merge.params.identityForce).toBe(true);
    expect(merge.result.identities).toMatchObject({ groups: 8, records: 16, devices: 2 });
  });

  it('打通结果表不存在时重算', async () => {
    const { acme, author } = await publishedIdentitySources();
    const before = await identities(acme);
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      await session.con.run('DROP TABLE silver._device_owner');
    } finally {
      session.close();
    }
    await mergeNow(author);
    await drain();
    expect((await lastMerge(acme)).result.identities).toMatchObject({ groups: 8, devices: 2 });
    expect((await identities(acme)).devices).toEqual(before.devices);
  });
});

describe('身份打通：可配置匹配字段与优先级', () => {
  it('在 customer 映射里去掉邮箱、重新发布后按新规则重算：只靠邮箱相连的记录分开', async () => {
    const { acme, author, reviewer, mappings, names } = await publishedIdentitySources();
    await republish(author, reviewer, mappings.crm, `${CRM}identity:\n  match: [phone, external_id]\n`);
    const { rows } = await identities(acme);
    expect(groupsOf(rows, names)).toEqual([
      ['crm:1', 'loyalty:1', 'tracking:u1'],
      ['crm:2', 'loyalty:2'],
      ['crm:3'],
      ['crm:4'],
      ['crm:5', 'loyalty:5'],
      ['crm:6'],
      ['crm:7', 'loyalty:6'],
      ['loyalty:3'],
      ['loyalty:4'],
      ['tracking:u2'],
      ['tracking:u9'],
    ]);
    const [merge] = (await listTasks(acme)).filter(t => t.kind === 'silver.merge');
    expect(merge.params.identity).toEqual(['phone', 'external_id']);
  });

  it('更高优先级的字段双方都有值且不同时，不按更低优先级的字段合并', async () => {
    const { acme, author, reviewer, sources, mappings, names } = await publishedIdentitySources();
    // 同一个手机号、不同的邮箱
    await grantOnSource(`INSERT INTO crm.customers VALUES (8, '吴十', '13600000008', 'wu@crm.test', NULL, '2024-06-02');
      INSERT INTO loyalty.members VALUES (7, '吴十', '136 0000 0008', 'wu10@loyalty.test', NULL, '2024-06-02');`);
    for (const id of [sources.crm, sources.loyalty]) await syncSource(author, id);
    await drain();
    const together = (rows: Identity[]) => groupsOf(rows, names).find(g => g.includes('crm:8'));
    // 默认规则里手机号优先：合并
    expect(together((await identities(acme)).rows)).toEqual(['crm:8', 'loyalty:7']);

    // 邮箱优先于手机号：邮箱冲突，不再按手机号合并；其余记录照旧
    await republish(author, reviewer, mappings.crm, `${CRM}identity:\n  match: [email, phone, external_id]\n`);
    const { rows } = await identities(acme);
    expect(together(rows)).toEqual(['crm:8']);
    expect(groupsOf(rows, names).find(g => g.includes('crm:5'))).toEqual(['crm:5', 'crm:6', 'loyalty:5']);
  });

  it('两个 customer 映射配置的规则不一致时发布被拒绝；规则一致或另一个没配置时可以发布', async () => {
    const { author, reviewer, mappings } = await publishedIdentitySources();
    await republish(author, reviewer, mappings.crm, `${CRM}identity:\n  match: [phone, email]\n`);
    const draft = await saveDraft(author, mappings.loyalty, `${LOYALTY}identity:\n  match: [email, phone]\n`);
    await expect(publishMapping(reviewer, mappings.loyalty, draft)).rejects.toThrow(/匹配规则不一致.*customers → customer（phone > email）.*members → customer（email > phone）/);
    await republish(author, reviewer, mappings.loyalty, `${LOYALTY}identity:\n  match: [phone, email]\n`);
  });
});
