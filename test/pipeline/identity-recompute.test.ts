// test/pipeline/identity-recompute.test.ts —— 身份打通何时重算：改到 customer、event 或 consent、打通结果表不在或上次失败时整表重算，否则跳过并写明原因；
// customer 映射里可配置的匹配字段与 survivorship 优先级（ADR-0019）
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { tasks } from '../../app/.server/db/schema';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { latestIdentitySummary, listMappings, mergeMapping, mergeNow, publishMapping, saveDraft } from '../../app/.server/mappings';
import { syncSource } from '../../app/.server/source-sync';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { drain } from './fixtures';
import { CRM, LOYALTY, publishedIdentitySources } from './identity-fixtures';
import { grantOnSource } from './source-fixtures';
import { type Identity, identities, consumerConsent, groupsOf, lastMerge, republish } from './identity-helpers';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

describe('身份打通：只在改到 customer、event 或 consent 时重算', () => {
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

  it('只同步、合并了同意映射时也重算 _consumer_consent', async () => {
    const { acme, author, sources, consentMappings } = await publishedIdentitySources({ consents: true });
    await grantOnSource(`UPDATE loyalty.consents SET state = '同意', updated_at = '2024-06-07 10:00' WHERE member_id = 1`);
    await syncSource(author, sources.loyalty);
    await drain();
    const merge = await lastMerge(acme);
    expect((merge.params.mappings as { mapping: string }[]).map(m => m.mapping)).toEqual([consentMappings!.loyalty]);
    expect(merge.result.identities).toMatchObject({ groups: 8 });
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      expect(await consumerConsent(session.con, sources.crm, '1')).toContainEqual({ channel: 'sms', status: 'granted', _source: sources.loyalty });
    } finally {
      session.close();
    }
  });

  it('_consumer 与 _consumer_consent 被删掉后，数据没变的合并把它们补回', async () => {
    const { acme, author } = await publishedIdentitySources({ consents: true });
    const onLake = async <T>(f: (read: (sql: string) => Promise<unknown[]>) => Promise<T>) => {
      const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
      try {
        return await f(async sql => (await session.con.runAndReadAll(sql)).getRowObjectsJson());
      } finally {
        session.close();
      }
    };
    const snapshot = () => onLake(async read => ({
      consumer: await read('SELECT * FROM silver._consumer ORDER BY consumer_id'),
      consent: await read('SELECT * FROM silver._consumer_consent ORDER BY consumer_id, channel'),
    }));
    const before = await snapshot();
    expect(before.consent.length).toBeGreaterThan(0);
    for (const table of ['_consumer', '_consumer_consent']) {
      await onLake(read => read(`DROP TABLE silver.${table}`));
      await mergeNow(author);
      await drain();
      expect((await lastMerge(acme)).result.identities).toMatchObject({ groups: 8 });
      expect(await snapshot()).toEqual(before);
    }
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

  it('统一消费者的属性默认取较新的；给另一个映射配上 survivorship 名次并重新发布后按名次重算', async () => {
    const { acme, author, reviewer, sources, mappings, names } = await publishedIdentitySources();
    // crm 1 与 loyalty 1 是同一个人：两边的城市不同，loyalty 的更新
    await grantOnSource("UPDATE loyalty.members SET updated_at = '2024-06-05' WHERE member_id = 1");
    await syncSource(author, sources.loyalty);
    await drain();
    const withCity = (yaml: string, city: string) => `${yaml}  city: "'${city}'"\n  updated_at: from_timezone(updated_at, 'UTC')\n`;
    await republish(author, reviewer, mappings.crm, withCity(CRM, '上海'));
    await republish(author, reviewer, mappings.loyalty, withCity(LOYALTY, '北京'));
    const crm1 = async () => {
      const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
      try {
        return (await session.con.runAndReadAll(`SELECT c.city, c.city__source FROM silver._consumer c JOIN silver._identities i USING (consumer_id)
          WHERE i._source = '${sources.crm}' AND i.customer_id = '1'`)).getRowObjectsJson();
      } finally {
        session.close();
      }
    };
    expect(await crm1()).toEqual([{ city: '北京', city__source: sources.loyalty }]);
    expect(names[sources.loyalty]).toBe('loyalty');

    // 只改名次：customer 数据不变，入队时发现名次变了，强制重算
    await republish(author, reviewer, mappings.crm, `${withCity(CRM, '上海')}survivorship:\n  priority: 1\n`);
    expect(await crm1()).toEqual([{ city: '上海', city__source: sources.crm }]);
    const merge = await lastMerge(acme);
    expect(merge.params).toMatchObject({ survivorship: { [mappings.crm]: 1 }, identityForce: true });
    expect(merge.result.identities).not.toHaveProperty('skipped');
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
