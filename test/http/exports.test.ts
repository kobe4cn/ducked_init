// test/http/exports.test.ts —— 人群导出接口：外部系统带 Bearer Key 调 POST /api/v1/exports 按标签条件发起导出（入队时定下每个标签的快照），
// 工作进程写成 Parquet / CSV 文件，GET /api/v1/exports/:id 查状态与实际用到的快照，成功后带限时下载链接，凭 token 下载；
// 任务结束 24 小时后调度器删掉文件（ADR-0040）。
// 快照直接在湖里建表、在平台库登记，不跑分析模板
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DuckDBInstance } from '@duckdb/node-api';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, exportLinks, snapshots, tasks } from '../../app/.server/db/schema';
import { cleanupExpiredExports, EXPORT_LINK_TTL_MS } from '../../app/.server/exports';
import { lakeRow } from '../../app/.server/lake';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { listTasks } from '../../app/.server/tasks';
import { newTenant, onLake } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 管理员在页面上创建一把 Key，返回明文 */
async function createKey(admin: Client, name: string) {
  const res = await admin.post('/api-keys', { intent: 'create', name });
  expect(res.status).toBe(200);
  const key = (await res.text()).match(/data-api-key="[^"]*"[^>]*>([^<]+)</)?.[1];
  if (!key) throw new Error('创建后的页面没有展示 Key');
  return key;
}

async function tenantWithKey(slug: string) {
  const tenantId = await newTenant(slug);
  return { tenantId, key: await createKey(await loginAs(app, `admin@${slug}.com`), '营销自动化') };
}

/**
 * 在湖里建一张标签快照表 gold."tag__<uuid>"（consumer_id, tag_key, tag_value）并登记成快照（template tag:<键>），返回快照 ID。
 * 登记时间按 createdAt（默认现在）
 */
async function tagSnapshot(tenantId: string, key: string, people: Record<string, string>, opts: { createdAt?: Date; expiredAt?: Date } = {}) {
  const id = randomUUID();
  const values = Object.entries(people).map(([c, v]) => `('${c}', '${key}', '${v}')`).join(', ');
  await onLake(tenantId, `CREATE TABLE gold."tag__${id}" AS SELECT * FROM (VALUES ${values}) t(consumer_id, tag_key, tag_value)`);
  const [task] = await getDb().insert(tasks).values({ tenantId, kind: 'lake.inventory', status: 'succeeded' }).returning();
  await getDb().insert(snapshots).values({
    id, tenantId, template: `tag:${key}`, taskId: task.id, table: `gold.tag__${id}`, params: {}, rowCount: Object.keys(people).length,
    expiresAt: new Date(Date.now() + 86_400_000), createdAt: opts.createdAt ?? new Date(), expiredAt: opts.expiredAt,
  });
  return id;
}

const post = async (body: unknown, key?: string) => {
  const res = await app.client().request('/api/v1/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key === undefined ? {} : { Authorization: `Bearer ${key}` }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const status = async (id: string, key?: string) => {
  const res = await app.client().request(`/api/v1/exports/${id}`, { headers: key === undefined ? {} : { Authorization: `Bearer ${key}` } });
  return { status: res.status, body: await res.json() };
};

/** 导出文件在本租户存储前缀下的完整路径 */
const exportFile = async (tenantId: string, id: string, format: string) => `${(await lakeRow(tenantId))!.dataPath}_exports/${id}.${format}`;

/** 读出导出文件的 consumer_id（按文件里的顺序） */
async function readExport(tenantId: string, id: string, format: 'parquet' | 'csv') {
  const file = await exportFile(tenantId, id, format);
  const instance = await DuckDBInstance.create(':memory:');
  const con = await instance.connect();
  try {
    const reader = format === 'parquet' ? `read_parquet('${file}')` : `read_csv('${file}', header = true, all_varchar = true)`;
    const result = await con.runAndReadAll(`SELECT * FROM ${reader}`);
    return { columns: result.columnNames(), ids: (result.getRowObjectsJson() as { consumer_id: string }[]).map(r => r.consumer_id) };
  } finally {
    con.closeSync();
    instance.closeSync();
  }
}

const exportTasks = (tenantId: string) =>
  getDb().select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'export.tags')));

const VIP = { c1: 'yes', c2: 'yes', c3: 'yes', c4: 'no' };
const CITY = { c1: 'sh', c2: 'bj', c3: 'sh', c4: 'sh' };

describe('发起导出', () => {
  it('合法时 202 返回任务 ID 与每个标签所用的快照（指定的或最新未过期的），记审计；没有 Key 或 Key 无效 401', async () => {
    const { tenantId, key } = await tenantWithKey('acme');
    await tagSnapshot(tenantId, 'vip', VIP, { createdAt: new Date(Date.now() - 60_000) });
    const latestVip = await tagSnapshot(tenantId, 'vip', VIP);
    await tagSnapshot(tenantId, 'vip', VIP, { createdAt: new Date(Date.now() + 60_000), expiredAt: new Date() });
    const oldCity = await tagSnapshot(tenantId, 'city', CITY, { createdAt: new Date(Date.now() - 60_000) });
    await tagSnapshot(tenantId, 'city', CITY);

    const body = { conditions: [{ tag: 'vip', value: 'yes' }, { tag: 'city', value: 'sh' }], snapshots: { city: oldCity }, format: 'csv' };
    expect((await post(body)).status).toBe(401);
    expect((await post(body, 'not-a-key')).status).toBe(401);
    expect(await exportTasks(tenantId)).toEqual([]);

    const res = await post(body, key);
    expect(res).toEqual({ status: 202, body: { id: expect.any(String), status: 'queued', snapshots: { vip: latestVip, city: oldCity } } });
    const [task] = await exportTasks(tenantId);
    expect(task.id).toBe(res.body.id);
    expect(task.params).toMatchObject({ format: 'csv', conditions: [{ tag: 'vip', value: 'yes' }, { tag: 'city', value: 'sh', table: `tag__${oldCity}` }] });

    const [audit] = await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'export.requested'));
    expect(audit).toMatchObject({ tenantId, actorType: 'system', targetId: res.body.id });
    expect(audit.detail).toEqual({ keyPrefix: key.slice(0, 8), conditions: body.conditions, snapshots: res.body.snapshots, format: 'csv' });

    expect((await listTasks(tenantId)).find(t => t.id === res.body.id)?.kindLabel).toBe('人群导出');
  });

  it('条件为空、超过 5 条、标签重复、键不合法、取值不合法、格式不对、标签没有可用快照、指定的快照不可用时 400，不入队', async () => {
    const { tenantId, key } = await tenantWithKey('acme');
    const other = await tenantWithKey('globex');
    const vip = await tagSnapshot(tenantId, 'vip', VIP);
    const city = await tagSnapshot(tenantId, 'city', CITY);
    const expired = await tagSnapshot(tenantId, 'vip', VIP, { createdAt: new Date(Date.now() - 60_000), expiredAt: new Date() });
    const lapsed = await tagSnapshot(tenantId, 'vip', VIP, { createdAt: new Date(Date.now() - 60_000) });
    await getDb().update(snapshots).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(snapshots.id, lapsed));
    const foreign = await tagSnapshot(other.tenantId, 'vip', VIP);
    const vipYes = { tag: 'vip', value: 'yes' };

    const bad: unknown[] = [
      'not json',
      [],
      {},
      { conditions: [] },
      { conditions: Array.from({ length: 6 }, (_, i) => ({ tag: `t${i}`, value: 'x' })) },
      { conditions: [vipYes, { tag: 'vip', value: 'no' }] },
      { conditions: [{ tag: 'Bad-Key', value: 'x' }] },
      { conditions: [{ tag: 'vip', value: '' }] },
      { conditions: [{ tag: 'vip', value: 'x'.repeat(201) }] },
      { conditions: [{ tag: 'vip', value: 1 }] },
      { conditions: [vipYes], format: 'xlsx' },
      { conditions: [{ tag: 'nosnap', value: 'x' }] },
      { conditions: [vipYes], snapshots: { vip: foreign } },
      { conditions: [vipYes], snapshots: { vip: city } },
      { conditions: [vipYes], snapshots: { vip: expired } },
      { conditions: [vipYes], snapshots: { vip: lapsed } },
      { conditions: [vipYes], snapshots: { vip: randomUUID() } },
      { conditions: [vipYes], snapshots: { vip: 'not-a-uuid' } },
      { conditions: [vipYes], snapshots: { city } },
      { conditions: [vipYes], snapshots: [vip] },
    ];
    for (const body of bad) expect(await post(body, key), JSON.stringify(body)).toEqual({ status: 400, body: { error: expect.any(String) } });
    // 别的租户的快照与不存在的一样，不泄露它存在
    expect((await post({ conditions: [vipYes], snapshots: { vip: foreign } }, key)).body)
      .toEqual((await post({ conditions: [vipYes], snapshots: { vip: randomUUID() } }, key)).body);
    expect(await exportTasks(tenantId)).toEqual([]);
    expect(await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'export.requested'))).toEqual([]);
  });
});

describe('导出结果与状态', () => {
  it('跑完后文件只有 consumer_id、按它排序、是所有条件同时满足的人；状态带格式、快照与行数；别的租户、别的任务 404', async () => {
    const { tenantId, key } = await tenantWithKey('acme');
    const other = await tenantWithKey('globex');
    const vip = await tagSnapshot(tenantId, 'vip', VIP);
    const city = await tagSnapshot(tenantId, 'city', CITY);
    const conditions = [{ tag: 'vip', value: 'yes' }, { tag: 'city', value: 'sh' }];

    const parquet = (await post({ conditions }, key)).body;
    const csv = (await post({ conditions, format: 'csv' }, key)).body;
    expect(await status(parquet.id, key)).toEqual({ status: 200, body: { id: parquet.id, status: 'queued', format: 'parquet', snapshots: { vip, city }, rowCount: null } });
    await drain();

    expect(await status(parquet.id, key)).toEqual({
      status: 200, body: { id: parquet.id, status: 'succeeded', format: 'parquet', snapshots: { vip, city }, rowCount: 2, download: expect.any(Object) },
    });
    expect(await status(csv.id, key)).toEqual({
      status: 200, body: { id: csv.id, status: 'succeeded', format: 'csv', snapshots: { vip, city }, rowCount: 2, download: expect.any(Object) },
    });
    expect(await readExport(tenantId, parquet.id, 'parquet')).toEqual({ columns: ['consumer_id'], ids: ['c1', 'c3'] });
    expect(await readExport(tenantId, csv.id, 'csv')).toEqual({ columns: ['consumer_id'], ids: ['c1', 'c3'] });

    const one = (await post({ conditions: [{ tag: 'city', value: 'sh' }] }, key)).body;
    await drain();
    expect(await readExport(tenantId, one.id, 'parquet')).toEqual({ columns: ['consumer_id'], ids: ['c1', 'c3', 'c4'] });

    expect((await status(parquet.id)).status).toBe(401);
    expect(await status(parquet.id, other.key)).toEqual({ status: 404, body: { error: expect.any(String) } });
    const [inventory] = await getDb().select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'lake.inventory')));
    expect((await status(inventory.id, key)).status).toBe(404);
    expect((await status(randomUUID(), key)).status).toBe(404);
    expect((await status('not-a-uuid', key)).status).toBe(404);
  });

  it('结果一致：用第一次响应里的快照再导一次，即使中间产出了更新的快照，文件内容也相同；不指定时换成最新的', async () => {
    const { tenantId, key } = await tenantWithKey('acme');
    await tagSnapshot(tenantId, 'vip', VIP, { createdAt: new Date(Date.now() - 60_000) });
    const conditions = [{ tag: 'vip', value: 'yes' }];
    const first = (await post({ conditions }, key)).body;
    await drain();

    const newer = await tagSnapshot(tenantId, 'vip', { c1: 'no', c2: 'yes', c5: 'yes' });
    const again = (await post({ conditions, snapshots: first.snapshots }, key)).body;
    const latest = (await post({ conditions }, key)).body;
    expect(again.snapshots).toEqual(first.snapshots);
    expect(latest.snapshots).toEqual({ vip: newer });
    await drain();

    expect(await readExport(tenantId, again.id, 'parquet')).toEqual(await readExport(tenantId, first.id, 'parquet'));
    expect((await readExport(tenantId, first.id, 'parquet')).ids).toEqual(['c1', 'c2', 'c3']);
    expect((await readExport(tenantId, latest.id, 'parquet')).ids).toEqual(['c2', 'c5']);
  });

  it('排队期间快照表被删掉时任务失败、提示重新发起，不留下文件', async () => {
    const { tenantId, key } = await tenantWithKey('acme');
    const vip = await tagSnapshot(tenantId, 'vip', VIP);
    const { id } = (await post({ conditions: [{ tag: 'vip', value: 'yes' }] }, key)).body;
    await onLake(tenantId, `DROP TABLE gold."tag__${vip}"`);
    await drain();

    expect(await status(id, key)).toEqual({
      status: 200, body: { id, status: 'failed', format: 'parquet', snapshots: { vip }, rowCount: null, error: '快照已过期，请重新发起导出' },
    });
    expect(existsSync(await exportFile(tenantId, id, 'parquet'))).toBe(false);
  });
});

const download = (url: string) => app.client().request(url);
const downloadAudits = () => getDb().select().from(auditLogs).where(eq(auditLogs.action, 'export.downloaded'));

describe('下载链接', () => {
  it('成功后每次查询都签发新链接（只存哈希），凭 token 流式下载、每次记审计；过期或文件不在 410，别的导出或不存在的 token 404', async () => {
    const { tenantId, key } = await tenantWithKey('acme');
    await tagSnapshot(tenantId, 'vip', VIP);
    const parquet = (await post({ conditions: [{ tag: 'vip', value: 'yes' }] }, key)).body;
    const csv = (await post({ conditions: [{ tag: 'vip', value: 'yes' }], format: 'csv' }, key)).body;
    expect((await status(parquet.id, key)).body).not.toHaveProperty('download');
    await drain();

    const before = Date.now();
    const first = (await status(parquet.id, key)).body.download;
    const second = (await status(parquet.id, key)).body.download;
    expect(first.url).toMatch(new RegExp(`^/api/v1/exports/${parquet.id}/download\\?token=[\\w-]+$`));
    expect(second.url).not.toBe(first.url);
    const expiresAt = new Date(first.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + EXPORT_LINK_TTL_MS - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + EXPORT_LINK_TTL_MS);
    const tokens = [first, second].map(d => new URL(d.url, 'http://x').searchParams.get('token')!);
    const links = await getDb().select().from(exportLinks).where(eq(exportLinks.taskId, parquet.id));
    expect(links).toHaveLength(2);
    expect(links.map(l => l.tokenHash)).not.toContain(tokens[0]);
    expect(links.every(l => l.tenantId === tenantId)).toBe(true);

    // 新链接不让旧链接失效；同一链接可以重复下载，不需要 Bearer
    for (const url of [first.url, second.url, first.url]) {
      const res = await download(url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/vnd.apache.parquet');
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="export-${parquet.id}.parquet"`);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(await readFile(await exportFile(tenantId, parquet.id, 'parquet')));
    }
    const csvRes = await download((await status(csv.id, key)).body.download.url);
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csvRes.headers.get('content-disposition')).toBe(`attachment; filename="export-${csv.id}.csv"`);
    expect((await csvRes.text()).trim().split('\n')).toEqual(['consumer_id', 'c1', 'c2', 'c3']);

    const audits = await downloadAudits();
    expect(audits).toHaveLength(4);
    expect(audits.filter(a => a.targetId === parquet.id)).toEqual(Array(3).fill(expect.objectContaining({
      tenantId, actorType: 'system', targetType: 'task', targetId: parquet.id, detail: { id: parquet.id },
    })));
    expect(JSON.stringify(audits)).not.toContain(tokens[0]);

    // token 属于别的导出、不存在、没给时 404
    expect((await download(`/api/v1/exports/${csv.id}/download?token=${tokens[0]}`)).status).toBe(404);
    expect((await download(`/api/v1/exports/${parquet.id}/download?token=nope`)).status).toBe(404);
    expect((await download(`/api/v1/exports/${parquet.id}/download`)).status).toBe(404);
    expect((await download(`/api/v1/exports/not-a-uuid/download?token=${tokens[0]}`)).status).toBe(404);

    // 链接到期后 410，另一个链接照常
    await getDb().execute(sql`UPDATE platform.export_links SET expires_at = now() - interval '1 minute' WHERE id = ${links[0].id}`);
    const statuses = await Promise.all([first.url, second.url].map(async u => (await download(u)).status));
    expect(statuses.sort()).toEqual([200, 410]);
    expect(await downloadAudits()).toHaveLength(5);
    // 导出还在保留期内时，到期的链接不被清理，仍是 410
    await cleanupExpiredExports();
    expect((await download(first.url)).status).toBe(410);

    // 文件不在了（例如湖迁移后）时 410，不记审计
    await rm(await exportFile(tenantId, parquet.id, 'parquet'));
    expect((await download(second.url)).status).toBe(410);
    expect(await downloadAudits()).toHaveLength(5);
  });

  it('任务结束 24 小时后状态 expired、不再签发链接、下载 410；调度器删掉文件，链接到期后也删掉，再跑一次不报错；新的导出与它的链接不受影响', async () => {
    const { tenantId, key } = await tenantWithKey('acme');
    await tagSnapshot(tenantId, 'vip', VIP);
    const old = (await post({ conditions: [{ tag: 'vip', value: 'yes' }] }, key)).body;
    const fresh = (await post({ conditions: [{ tag: 'vip', value: 'yes' }], format: 'csv' }, key)).body;
    await drain();
    const { url } = (await status(old.id, key)).body.download;
    const freshUrl = (await status(fresh.id, key)).body.download.url;
    expect((await download(url)).status).toBe(200);

    await getDb().execute(sql`UPDATE platform.tasks SET finished_at = now() - interval '25 hours' WHERE id = ${old.id}`);
    expect(await status(old.id, key)).toEqual({
      status: 200, body: { id: old.id, status: 'expired', format: 'parquet', snapshots: old.snapshots, rowCount: 3 },
    });
    expect((await download(url)).status).toBe(410);

    await cleanupExpiredExports();
    expect(existsSync(await exportFile(tenantId, old.id, 'parquet'))).toBe(false);
    expect(existsSync(await exportFile(tenantId, fresh.id, 'csv'))).toBe(true);
    expect((await download(url)).status).toBe(410);
    expect((await status(old.id, key)).body.status).toBe('expired');
    expect((await download(freshUrl)).status).toBe(200);

    await getDb().execute(sql`UPDATE platform.export_links SET expires_at = now() - interval '1 minute'`);
    await cleanupExpiredExports();
    expect((await getDb().select().from(exportLinks)).map(l => l.taskId)).toEqual([fresh.id]);
    expect(existsSync(await exportFile(tenantId, fresh.id, 'csv'))).toBe(true);
    expect((await download(url)).status).toBe(404);
  });
});
