// test/pipeline/identity-merge.test.ts —— 身份打通的流水线接缝（多源确定性合并）：CRM、会员、埋点三个数据源同步进原始层 → 发布映射 → 调度器派发合并 →
// silver._identities 里每条 (_source, customer_id) 对应一个统一消费者，silver._device_owner 里每台登录过的设备归属到最近一次登录的统一消费者，
// silver._consumer 与 silver._consumer_consent 是统一消费者的属性与同意，表里没有明文（ADR-0019）
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { listMappings, mergeNow } from '../../app/.server/mappings';
import { syncSource } from '../../app/.server/source-sync';
import { checkMetric, compileMetric, type DslContext } from '../../app/.server/pipeline/dsl/metric-spec';
import { resolveIdentities } from '../../app/.server/pipeline/identity-engine';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { runTask, silver } from './fixtures';
import { publishedIdentitySources, TRACKING_EVENTS } from './identity-fixtures';
import { grantOnSource } from './source-fixtures';
import { drain, SEEDED, identities, anonymousEvents, consumerConsent, groupsOf, republish } from './identity-helpers';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

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

  it('事件映射声明 customer_id 属于 CRM 数据源后，登录事件按 CRM 那条消费者记录所在的统一消费者给设备定主人', async () => {
    const { acme, author, reviewer, sources, names } = await publishedIdentitySources();
    // 用户 3 只在 CRM 里有（埋点源只有 u1、u2、u9）
    await grantOnSource(`INSERT INTO tracking.events (event_id, user_id, device_id, event_type, ts) VALUES ('e10', '3', 'd5', 'login', '2024-06-04 09:00')`);
    await syncSource(author, sources.tracking);
    await drain();
    expect((await identities(acme)).devices.map(d => d.device_id)).toEqual(['d1', 'd2']);

    const events = (await listMappings(author)).mappings.find(m => m.entity === 'event')!;
    await republish(author, reviewer, events.id, TRACKING_EVENTS.replace('  customer_id: user_id\n', '  customer_id: { expr: user_id, customer_source: CRM }\n'));
    const { rows, devices } = await identities(acme);
    const crm3 = rows.find(r => `${names[r._source]}:${r.customer_id}` === 'crm:3')!.consumer_id;
    // u1、u2、u9 在 CRM 里找不到，登录过的 d1、d2 归不到人
    expect(devices).toEqual([{ device_id: 'd5', consumer_id: crm3, login_at: '2024-06-04 09:00' }]);
    expect(await silver(acme, 'event', 'event_id')).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: 'e1', _source: sources.tracking, _customer_source: sources.crm }),
    ]));
  });

  it('事件映射声明 customer_id 属于 CRM 数据源后，浏览次数指标按 CRM 那条消费者记录算到统一消费者上', async () => {
    const { acme, author, reviewer, sources, names } = await publishedIdentitySources();
    // 用户 3 只在 CRM 里有（埋点源只有 u1、u2、u9）
    await grantOnSource(`INSERT INTO tracking.events (event_id, user_id, device_id, event_type, ts) VALUES ('e10', '3', 'd5', 'view', '2024-06-04 09:00')`);
    await syncSource(author, sources.tracking);
    await drain();
    const ctx: DslContext = { published: new Map(), plans: [], metrics: new Map() };
    const checked = checkMetric('base: event\nmeasure: { agg: count }\ndevice_attribution: false\nfilter:\n  - { field: event_type, op: eq, value: view }\n', ctx);
    if (!checked.ok) throw new Error(JSON.stringify(checked.issues));
    const views = async () => {
      const task = await runTask(acme, 'gold.dsl', { kind: 'metric', key: 'views', asOf: '2024-07-01', sql: compileMetric(checked.spec, ctx, '2024-07-01'), entities: ['event'] });
      expect(task.status).toBe('succeeded');
      const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
      try {
        const table = `gold."${(task.result as { table: string }).table.slice('gold.'.length)}"`;
        return (await session.con.runAndReadAll(`SELECT consumer_id, value::INTEGER AS value FROM ${table}`)).getRowObjectsJson();
      } finally {
        session.close();
      }
    };
    const consumerOf = async (who: string) => (await identities(acme)).rows.find(r => `${names[r._source]}:${r.customer_id}` === who)!.consumer_id;
    // 不声明时 e10 按埋点源的用户 3 找，打通不到；e9 是 u1 的浏览（u1 与 crm 1 同组）
    expect(await views()).toEqual([{ consumer_id: await consumerOf('crm:1'), value: 1 }]);

    const events = (await listMappings(author)).mappings.find(m => m.entity === 'event')!;
    await republish(author, reviewer, events.id, TRACKING_EVENTS.replace('  customer_id: user_id\n', '  customer_id: { expr: user_id, customer_source: CRM }\n'));
    // 声明后 e10 归 crm 3 所在的统一消费者；e9 的 u1 在 CRM 里找不到
    expect(await views()).toEqual([{ consumer_id: await consumerOf('crm:3'), value: 1 }]);
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
      expect(columns.filter(c => /^(name|phone|email|external_id|customer_id|_mapping|_source|_customer_source)(__source)?$/.test(String(c)))).toEqual([]);
      // 没有同意映射（silver.consent 不存在）时 _consumer_consent 是空表
      expect(await read('SELECT count(*)::INTEGER AS n FROM silver._consumer_consent')).toEqual([{ n: 0 }]);

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

  it('统一消费者的同意：每人每渠道一行，取各源里最新的状态并记来源，不看数据源名次；同一时刻撤回优先', async () => {
    const { acme, names } = await publishedIdentitySources({ consents: true });
    const source = Object.fromEntries(Object.entries(names).map(([id, name]) => [name, id]));
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      // crm 1 短信早同意、loyalty 1 短信晚撤回：取撤回；邮件只有 crm 有
      expect(await consumerConsent(session.con, source.crm, '1')).toEqual([
        { channel: 'email', status: 'granted', _source: source.crm },
        { channel: 'sms', status: 'revoked', _source: source.loyalty },
      ]);
      // crm 2 同意与 loyalty 2 撤回同一时刻：取撤回；两边状态对调后仍取撤回，来源跟着换
      expect(await consumerConsent(session.con, source.crm, '2')).toEqual([{ channel: 'sms', status: 'revoked', _source: source.loyalty }]);
      await session.con.run(`UPDATE silver.consent SET status = CASE status WHEN 'granted' THEN 'revoked' ELSE 'granted' END WHERE customer_id = '2'`);
      await resolveIdentities(session.con);
      expect(await consumerConsent(session.con, source.crm, '2')).toEqual([{ channel: 'sms', status: 'revoked', _source: source.crm }]);
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
