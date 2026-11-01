// test/pipeline/identity-stable-id.test.ts —— 统一消费者 ID 分配后固定：合并、拆分、退役的变更记录，摘要的 merged / split / hot，
// 不参与匹配的哈希（exclude），撞号加盐与老湖播种（ADR-0019）
import type { DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tx } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { excludeValue, includeValue } from '../../app/.server/identity-exclusions';
import { enqueueMerge, mergeNow } from '../../app/.server/mappings';
import { syncSource } from '../../app/.server/source-sync';
import { resolveIdentities } from '../../app/.server/pipeline/identity-engine';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { resetDb } from '../http/harness';
import { runTask } from './fixtures';
import { CRM, publishedIdentitySources } from './identity-fixtures';
import { grantOnSource } from './source-fixtures';
import { drain, type Identity, identities, lastMerge, republish } from './identity-helpers';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

describe('身份打通：统一消费者 ID 分配后固定', () => {
  type Change = { old_id: string; new_id: string | null; reason: string };
  /** silver._consumer_id_changes 的全部行（不含时间），silver._consumer_ids 里已退役的 ID 与每个 ID 的分配时间 */
  async function idTables(tenantId: string) {
    const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
    const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
    try {
      const ids = await read<{ consumer_id: string; assigned_at: string; retired: boolean }>(
        'SELECT consumer_id, epoch_ms(assigned_at)::VARCHAR AS assigned_at, retired_at IS NOT NULL AS retired FROM silver._consumer_ids');
      return {
        changes: await read<Change>('SELECT old_id, new_id, reason FROM silver._consumer_id_changes ORDER BY reason, old_id, new_id'),
        retired: ids.filter(r => r.retired).map(r => r.consumer_id).sort(),
        assignedAt: Object.fromEntries(ids.map(r => [r.consumer_id, Number(r.assigned_at)])),
      };
    } finally {
      session.close();
    }
  }
  /** 从 before 到现在新增的变更记录与新退役的 ID（发布各源时已有的合并不算） */
  async function idChanges(tenantId: string, before: Awaited<ReturnType<typeof idTables>>) {
    const now = await idTables(tenantId);
    const seen = new Set(before.changes.map(c => JSON.stringify(c)));
    return { changes: now.changes.filter(c => !seen.has(JSON.stringify(c))), retired: now.retired.filter(id => !before.retired.includes(id)) };
  }
  /** 让 5 条源记录共用一个已有的手机号哈希（像占位号），返回这个哈希；它原来的记录照旧用它 */
  async function shareOnePhone(con: DuckDBConnection) {
    const [{ hash }] = (await con.runAndReadAll(`SELECT min(phone) AS hash FROM silver.customer`)).getRowObjectsJson() as { hash: string }[];
    await con.run(`CREATE TEMP TABLE five AS SELECT DISTINCT _source, customer_id FROM silver.customer ORDER BY ALL LIMIT 5;
      UPDATE silver.customer c SET phone = '${hash}' FROM five f WHERE c._source = f._source AND c.customer_id = f.customer_id`);
    return hash;
  }
  /** 「数据源名:customer_id」→ 统一消费者 ID */
  const idsOf = (rows: Identity[], names: Record<string, string>) =>
    Object.fromEntries(rows.map(r => [`${names[r._source]}:${r.customer_id}`, r.consumer_id]));

  it('新源记录把两个已有消费者连起来：存活的 ID 取分配较早、平局取较小的那个，另一个记 merge 并退役；其余 ID 不变', async () => {
    const { acme, author, sources, names } = await publishedIdentitySources();
    const before = idsOf((await identities(acme)).rows, names);
    const tables = await idTables(acme);
    // 手机号与 u9 相同、邮箱与 crm 3 / loyalty 3 相同
    await grantOnSource(`INSERT INTO crm.customers VALUES (8, '王五', '13700000009', 'wang5@example.com', NULL, '2024-06-02')`);
    await syncSource(author, sources.crm);
    await drain();
    const after = idsOf((await identities(acme)).rows, names);
    const [kept, gone] = [before['crm:3'], before['tracking:u9']]
      .sort((a, b) => tables.assignedAt[a] - tables.assignedAt[b] || a.localeCompare(b));
    for (const who of ['crm:3', 'loyalty:3', 'crm:8', 'tracking:u9']) expect(after[who]).toBe(kept);
    for (const who of Object.keys(before).filter(w => !['crm:3', 'loyalty:3', 'tracking:u9'].includes(w))) expect(after[who]).toBe(before[who]);
    expect(await idChanges(acme, tables)).toEqual({ changes: [{ old_id: gone, new_id: kept, reason: 'merge' }], retired: [gone] });
    expect((await lastMerge(acme)).result.identities).toMatchObject({ groups: 7, merged: 1, split: 0 });
  });

  it('改规则使组拆开：原 ID 留给拥有其过半原成员的那组，其余组分到新 ID 并记 split；没有哪组过半时原 ID 退役、记 retire', async () => {
    const { acme, author, reviewer, mappings, names } = await publishedIdentitySources();
    const before = idsOf((await identities(acme)).rows, names);
    const tables = await idTables(acme);
    await republish(author, reviewer, mappings.crm, `${CRM}identity:\n  match: [phone, external_id]\n`);
    const after = idsOf((await identities(acme)).rows, names);
    const all = new Set(Object.values(before));
    // {crm2, loyalty2 | u2} 2 比 1、{crm5, loyalty5 | crm6} 2 比 1：原 ID 留给两条的那组
    expect([after['crm:2'], after['loyalty:2']]).toEqual([before['crm:2'], before['crm:2']]);
    expect([after['crm:5'], after['loyalty:5']]).toEqual([before['crm:5'], before['crm:5']]);
    expect(all.has(after['tracking:u2'])).toBe(false);
    expect(all.has(after['crm:6'])).toBe(false);
    // {crm3 | loyalty3} 1 比 1：没有哪组过半，两组都拿新 ID，原 ID 退役
    for (const who of ['crm:3', 'loyalty:3']) expect(all.has(after[who])).toBe(false);
    expect(after['crm:3']).not.toBe(after['loyalty:3']);

    const expected = [
      { old_id: before['crm:2'], new_id: after['tracking:u2'], reason: 'split' },
      { old_id: before['crm:3'], new_id: after['crm:3'], reason: 'split' },
      { old_id: before['crm:3'], new_id: after['loyalty:3'], reason: 'split' },
      { old_id: before['crm:5'], new_id: after['crm:6'], reason: 'split' },
    ].sort((a, b) => a.old_id.localeCompare(b.old_id) || a.new_id.localeCompare(b.new_id));
    expect(await idChanges(acme, tables)).toEqual({
      changes: [{ old_id: before['crm:3'], new_id: null, reason: 'retire' }, ...expected], retired: [before['crm:3']] });
    expect((await lastMerge(acme)).result.identities).toMatchObject({ groups: 11, merged: 0, split: 3 });
    // 其余组 ID 不变
    for (const who of ['crm:1', 'loyalty:1', 'crm:4', 'crm:7', 'loyalty:4', 'tracking:u9']) expect(after[who]).toBe(before[who]);
  });

  it('没有任何变化的重算不产生变更记录，ID 不变', async () => {
    const { acme } = await publishedIdentitySources();
    const before = await identities(acme);
    const tables = await idTables(acme);
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      expect(await resolveIdentities(session.con)).toMatchObject({ groups: 8, records: 16, merged: 0, split: 0 });
    } finally {
      session.close();
    }
    const after = await identities(acme);
    expect(after.rows).toEqual(before.rows);
    expect(after.devices).toEqual(before.devices);
    expect(await idChanges(acme, tables)).toEqual({ changes: [], retired: [] });
  });

  /** 把 size 条源记录的组里按 ID 排在前 count 个的组（各取整组）改用旧 ID x */
  const shareX = (size: number, count: number) => `
    UPDATE silver._identities SET consumer_id = 'x' WHERE consumer_id IN
      (SELECT consumer_id FROM silver._identities GROUP BY 1 HAVING count(*) = ${size} ORDER BY 1 LIMIT ${count});`;
  /** 把 x 记进分配表（未退役），重算才会给它填 retired_at */
  const addX = `INSERT INTO silver._consumer_ids VALUES ('x', now() - INTERVAL 1 DAY, NULL);`;

  it('摘要的 merged、split 按组计：三个旧 ID 合成一组算 1、一个旧 ID 拆成三组算 1，变更表仍是每个 ID 一条', async () => {
    const { acme } = await publishedIdentitySources();
    const tables = await idTables(acme);
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      // 让一个三条记录的组原来分属三个 ID，再让三个单条记录的组原来共用一个 ID
      await session.con.run(`
        UPDATE silver._identities SET consumer_id = 'm-' || _source || '-' || customer_id
        WHERE consumer_id = (SELECT consumer_id FROM silver._identities GROUP BY 1 HAVING count(*) = 3 ORDER BY 1 LIMIT 1);
        ${shareX(1, 3)}`);
      expect(await resolveIdentities(session.con)).toMatchObject({ groups: 8, merged: 1, split: 1 });
    } finally {
      session.close();
    }
    const { changes } = await idChanges(acme, tables);
    expect(changes.filter(c => c.reason === 'merge')).toHaveLength(2);
    expect(changes.filter(c => c.reason === 'split').map(c => c.old_id)).toEqual(['x', 'x', 'x']);
  });

  it('一个旧 ID 拆成 1+1+1：三组都拿新 ID、各记 split，另记一条 retire，分配表里它的 retired_at 填上', async () => {
    const { acme } = await publishedIdentitySources();
    const tables = await idTables(acme);
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      await session.con.run(`${shareX(1, 3)} ${addX}`);
      expect(await resolveIdentities(session.con)).toMatchObject({ groups: 8, merged: 0, split: 1 });
      const ids = (await session.con.runAndReadAll(`SELECT DISTINCT consumer_id FROM silver._identities`)).getRowObjectsJson();
      expect(ids).not.toContainEqual({ consumer_id: 'x' });
    } finally {
      session.close();
    }
    const { changes, retired } = await idChanges(acme, tables);
    expect(changes.filter(c => c.old_id === 'x').map(c => c.reason)).toEqual(['retire', 'split', 'split', 'split']);
    expect(changes.find(c => c.reason === 'retire')).toEqual({ old_id: 'x', new_id: null, reason: 'retire' });
    expect(new Set(changes.filter(c => c.reason === 'split').map(c => c.new_id)).size).toBe(3);
    expect(retired).toEqual(['x']);
  });

  it('一个旧 ID 拆成 3+1：三条那组过半、留下旧 ID，另一组拿新 ID 记 split，不记 retire', async () => {
    const { acme } = await publishedIdentitySources();
    const tables = await idTables(acme);
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      await session.con.run(`${shareX(3, 1)} ${shareX(1, 1)} ${addX}`);
      expect(await resolveIdentities(session.con)).toMatchObject({ groups: 8, merged: 0, split: 1 });
      const [{ n }] = (await session.con.runAndReadAll(`SELECT count(*)::INT AS n FROM silver._identities WHERE consumer_id = 'x'`))
        .getRowObjectsJson() as { n: number }[];
      expect(n).toBe(3);
    } finally {
      session.close();
    }
    const { changes, retired } = await idChanges(acme, tables);
    expect(changes.map(c => [c.old_id, c.reason])).toEqual([['x', 'split']]);
    expect(retired).toEqual([]);
  });

  it('摘要的 hot 列出连上源记录数达到阈值的匹配值（哈希、记录数、数据源），按记录数降序；低于阈值的不列', async () => {
    const { acme } = await publishedIdentitySources();
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
    try {
      expect((await resolveIdentities(session.con)).hot).toEqual([]);
      const hash = await shareOnePhone(session.con);
      // 这个哈希原来就有的记录也算在内
      const [{ records, sources }] = await read<{ records: number; sources: string[] }>(`SELECT count(DISTINCT (_source, customer_id))::INT AS records,
        list(DISTINCT _source ORDER BY _source) AS sources FROM silver.customer WHERE phone = '${hash}'`);
      expect(records).toBeGreaterThanOrEqual(5);
      const below = await read<{ value: string }>(`SELECT phone AS value FROM silver.customer WHERE phone IS NOT NULL
        GROUP BY 1 HAVING count(DISTINCT (_source, customer_id)) < 3`);
      const { hot } = await resolveIdentities(session.con, undefined, { hotThreshold: 3 });
      expect(hot).toContainEqual({ rule: 'phone', hash, records, sources });
      expect(hot.every(h => h.records >= 3)).toBe(true);
      expect(hot.map(h => h.records)).toEqual(hot.map(h => h.records).sort((a, b) => b - a));
      expect(hot.some(h => below.some(b => b.value === h.hash))).toBe(false);
      expect((await resolveIdentities(session.con, undefined, { hotThreshold: records + 1 })).hot).toEqual([]);
    } finally {
      session.close();
    }
  });

  it('exclude 里的哈希当作没有值：只靠它相连的记录分开并记 split，分组与把它置空时相同，不进 hot', async () => {
    const { acme } = await publishedIdentitySources();
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
    /** 分组（每组是排好序的「数据源:customer_id」） */
    const partition = async () => (await read<{ members: string[] }>(`SELECT list(_source || ':' || customer_id ORDER BY _source, customer_id) AS members
      FROM silver._identities GROUP BY consumer_id ORDER BY members`)).map(r => r.members);
    try {
      const hash = await shareOnePhone(session.con);
      const sharing = (await read<{ who: string }>(`SELECT DISTINCT _source || ':' || customer_id AS who FROM silver.customer WHERE phone = '${hash}'`))
        .map(r => r.who);
      await resolveIdentities(session.con);
      const together = await partition();
      expect(together.filter(g => sharing.some(w => g.includes(w)))).toHaveLength(1);

      const summary = await resolveIdentities(session.con, undefined, { exclude: [hash], hotThreshold: 1 });
      expect(summary.split).toBeGreaterThan(0);
      expect(summary.hot.length).toBeGreaterThan(0);
      expect(summary.hot.some(h => h.hash === hash)).toBe(false);
      const afterExclude = await partition();
      expect(afterExclude.filter(g => sharing.some(w => g.includes(w))).length).toBeGreaterThan(1);

      // 与在数据里把这个值置空（映射里写 nullif）分组相同：其他字段仍能连起来的照样合并
      await session.con.run(`UPDATE silver.customer SET phone = NULL WHERE phone = '${hash}'`);
      await resolveIdentities(session.con);
      expect(afterExclude).toEqual(await partition());
    } finally {
      session.close();
    }
  });

  it('合并任务参数 identityExclude 传到打通；不是 64 位十六进制哈希的列表时任务失败', async () => {
    const { acme } = await publishedIdentitySources();
    const { params } = await lastMerge(acme);
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    let hash: string;
    try {
      hash = await shareOnePhone(session.con);
    } finally {
      session.close();
    }
    for (const bad of [hash, ['13800000001'], [hash.toUpperCase()], [hash.slice(1)], [hash, 1]]) {
      const failed = await runTask(acme, 'silver.merge', { ...params, identityExclude: bad });
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('identityExclude');
      expect(failed.error).not.toContain('13800000001');
    }
    const groups = async (extra: Record<string, unknown>) => {
      const task = await runTask(acme, 'silver.merge', { ...params, identityForce: true, ...extra });
      expect(task.status).toBe('succeeded');
      return (task.result as { identities: { groups: number } }).identities.groups;
    };
    const together = await groups({});
    expect(await groups({ identityExclude: [hash] })).toBeGreaterThan(together);
    expect(await groups({ identityExclude: [] })).toBe(together);
  });

  it('标为不参与匹配后入队的合并带上排除列表并强制重算，只靠它相连的记录各自成组；列表没变的下一次合并跳过打通，撤销后又强制重算', async () => {
    const { acme, author } = await publishedIdentitySources();
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    let hash: string;
    let sharing: string[];
    try {
      hash = await shareOnePhone(session.con);
      sharing = ((await session.con.runAndReadAll(`SELECT DISTINCT _source || ':' || customer_id AS who FROM silver.customer WHERE phone = '${hash}'`))
        .getRowObjectsJson() as { who: string }[]).map(r => r.who);
      await resolveIdentities(session.con);
    } finally {
      session.close();
    }
    /** 共用这个哈希的源记录分在几个统一消费者里 */
    const sharingGroups = async () => new Set((await identities(acme)).rows.filter(r => sharing.includes(`${r._source}:${r.customer_id}`)).map(r => r.consumer_id)).size;
    expect(await sharingGroups()).toBe(1);
    /** 在一个事务里改排除列表并入队合并，跑空调度器，返回这次合并 */
    const mark = async (change: (tx: Tx) => Promise<boolean>) => {
      await getDb().transaction(async tx => { expect(await change(tx)).toBe(true); expect(await enqueueMerge(tx, acme)).not.toBeNull(); });
      await drain();
      return lastMerge(acme);
    };

    const excluded = await mark(tx => excludeValue(tx, acme, author, hash, sharing.length));
    expect(excluded).toMatchObject({ status: 'succeeded', params: { identityExclude: [hash], identityForce: true } });
    expect(excluded.result.identities).not.toHaveProperty('skipped');
    expect(await sharingGroups()).toBeGreaterThan(1);

    await mergeNow(author);
    await drain();
    const unchanged = await lastMerge(acme);
    expect(unchanged.params).toMatchObject({ identityExclude: [hash], identityForce: false });
    expect(unchanged.result.identities).toMatchObject({ skipped: expect.any(String) });

    const included = await mark(tx => includeValue(tx, acme, author, hash));
    expect(included).toMatchObject({ status: 'succeeded', params: { identityExclude: [], identityForce: true } });
    expect(await sharingGroups()).toBe(1);
  });

  it('merge 退役的 ID 把它在上一版里的全部源记录记进 _consumer_id_members；没有 merge 的重算不写', async () => {
    const { acme } = await publishedIdentitySources();
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    const read = async (sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson();
    const members = (where = 'true') => read(`SELECT consumer_id, _source, customer_id FROM silver._consumer_id_members WHERE ${where} ORDER BY ALL`);
    try {
      const before = await members();
      // 一个三条记录的组原来分属两个 ID：最小的一条用 m-1，另两条用 m-2；没在分配表里的 ID 平局取较小的，m-2 退役
      await session.con.run(`
        CREATE TEMP TABLE trio AS SELECT _source, customer_id, row_number() OVER (ORDER BY _source, customer_id) AS k FROM silver._identities
        WHERE consumer_id = (SELECT consumer_id FROM silver._identities GROUP BY 1 HAVING count(*) = 3 ORDER BY 1 LIMIT 1);
        UPDATE silver._identities i SET consumer_id = CASE WHEN t.k = 1 THEN 'm-1' ELSE 'm-2' END FROM trio t
        WHERE i._source = t._source AND i.customer_id = t.customer_id`);
      const expected = await read(`SELECT 'm-2' AS consumer_id, _source, customer_id FROM trio WHERE k > 1 ORDER BY ALL`);
      expect(await resolveIdentities(session.con)).toMatchObject({ merged: 1, split: 0 });
      expect(await members(`consumer_id LIKE 'm-%'`)).toEqual(expected);
      expect(await members(`consumer_id NOT LIKE 'm-%'`)).toEqual(before);
      expect(await read(`SELECT DISTINCT consumer_id FROM silver._identities i JOIN trio t USING (_source, customer_id)`)).toEqual([{ consumer_id: 'm-1' }]);
      const all = await members();
      expect(await resolveIdentities(session.con)).toMatchObject({ merged: 0, split: 0 });
      expect(await members()).toEqual(all);
    } finally {
      session.close();
    }
  });

  it('新组的哈希撞上分配过的 ID（包括已退役的）时加盐重算，直到不撞', async () => {
    const { acme } = await publishedIdentitySources();
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    const read = async (sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson();
    try {
      // 新源记录 (zz, new1) 自成一组：它的哈希与加一次盐的哈希都已分配过（退役），取加两次盐的
      await session.con.run(`INSERT INTO silver.customer (_source, customer_id) VALUES ('zz', 'new1');
        INSERT INTO silver._consumer_ids SELECT sha256('zz' || chr(31) || 'new1' || s), TIMESTAMPTZ '2024-01-01 00:00:00+00', TIMESTAMPTZ '2024-02-01 00:00:00+00'
        FROM (VALUES (''), (chr(31) || '1')) t(s)`);
      await resolveIdentities(session.con);
      expect(await read(`SELECT consumer_id = sha256('zz' || chr(31) || 'new1' || chr(31) || '2') AS salted FROM silver._identities
        WHERE _source = 'zz'`)).toEqual([{ salted: true }]);
    } finally {
      session.close();
    }
  });

  it('老湖有 _identities、没有分配表时，重算用现有 ID 播种，原 ID 全部保留、不记变更', async () => {
    const { acme, author } = await publishedIdentitySources();
    const before = await identities(acme);
    const tables = await idTables(acme);
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      // 模拟老湖：ID 不是现在的哈希（老湖的 ID 也可能来自别的算法），分配表还不存在
      await session.con.run(`UPDATE silver._identities SET consumer_id = 'old-' || consumer_id; DROP TABLE silver._consumer_ids`);
    } finally {
      session.close();
    }
    await mergeNow(author);
    await drain();
    expect((await lastMerge(acme)).result.identities).toMatchObject({ groups: 8, merged: 0, split: 0 });
    const after = await identities(acme);
    expect(after.rows).toEqual(before.rows.map(r => ({ ...r, consumer_id: `old-${r.consumer_id}` })));
    expect(await idChanges(acme, tables)).toEqual({ changes: [], retired: [] });
  });
});
