// test/pipeline/knowledge-sources.test.ts —— 知识来源（ADR-0046 入口③，#525）的接缝：saveKnowledgeSource → knowledge_sources 表
// （按种类切段、版本、正文哈希）与审计 knowledge_source.created → getKnowledgeSource 读回；不调模型（#526 才解析），不执行 SQL
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditLogs } from '../../app/.server/audit';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, knowledgeSources } from '../../app/.server/db/schema';
import { getKnowledgeSource, saveKnowledgeSource } from '../../app/.server/knowledge/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';

let acme: string;
afterAll(async () => { await closeDb(); });
beforeAll(async () => {
  await resetDb();
  acme = await newTenant('acme');
});

const analyst = () => memberOf(acme, 'an@acme.com', 'analyst');
const errorOf = (p: Promise<unknown>) => p.then(() => '成功', (e: Error & { status?: number }) => `${e.status ?? ''} ${e.message}`);
const rows = () => getDb().select().from(knowledgeSources).where(eq(knowledgeSources.tenantId, acme));
const audits = (action: string) => getDb().select().from(auditLogs)
  .where(eq(auditLogs.tenantId, acme)).then(all => all.filter(a => a.action === action));

describe('保存粘贴的来源原文', () => {
  it('保存后返回来源 id、版本 1 与段落列表（段号从 1 开始），表里存去首尾空白的正文与种类', async () => {
    const saved = await saveKnowledgeSource(await analyst(), {
      title: ' 订单表说明 ',
      kind: 'dictionary',
      body: ' orders 表：订单\n\nstatus 订单状态 ',
    });
    expect(saved.version).toBe(1);
    expect(saved.paragraphs).toEqual([
      { no: 1, text: 'orders 表：订单' },
      { no: 2, text: 'status 订单状态' },
    ]);
    const [row] = await rows();
    expect(row.id).toBe(saved.id);
    expect(row).toMatchObject({ title: '订单表说明', kind: 'dictionary', body: 'orders 表：订单\n\nstatus 订单状态', version: 1 });
  });

  it('SQL 种类按语句切段；另一个成员保存另一个标题得到各自的来源', async () => {
    const saved = await saveKnowledgeSource(await memberOf(acme, 'de@acme.com', 'data_engineer'), {
      title: '订单口径 SQL',
      kind: 'sql',
      body: 'SELECT count(*) FROM silver.orders;\nSELECT amount FROM silver.orders;',
    });
    expect(saved.paragraphs.map(p => p.text)).toEqual([
      'SELECT count(*) FROM silver.orders',
      'SELECT amount FROM silver.orders',
    ]);
    expect((await rows()).length).toBe(2);
  });

  it('空正文、超过 20000 字、超过 200 段时 400，不留行；20000 字、200 段可以保存', async () => {
    expect(await errorOf(saveKnowledgeSource(await analyst(), { title: '空正文', kind: 'sql', body: '  \n ' }))).toMatch(/^400 /);
    expect(await errorOf(saveKnowledgeSource(await analyst(), { kind: 'sql', body: 'SELECT 1' } as never))).toMatch(/^400 /);
    expect(await errorOf(saveKnowledgeSource(await analyst(), { title: ' ', kind: 'sql', body: 'SELECT 1' }))).toMatch(/^400 /);
    expect(await errorOf(saveKnowledgeSource(await analyst(), { title: '未知种类', kind: 'log', body: 'SELECT 1' } as never))).toMatch(/^400 /);
    expect(await errorOf(saveKnowledgeSource(await analyst(), { title: '太长', kind: 'dictionary', body: '字'.repeat(20001) }))).toMatch(/^400 /);
    const many = Array.from({ length: 201 }, (_, i) => `第 ${i} 段`).join('\n\n');
    expect(await errorOf(saveKnowledgeSource(await analyst(), { title: '太多段', kind: 'dictionary', body: many }))).toMatch(/^400 /);
    expect((await rows()).length).toBe(2);

    const atLimit = await saveKnowledgeSource(await analyst(), { title: '边界', kind: 'dictionary', body: '字'.repeat(20000) });
    expect(atLimit.paragraphs.length).toBe(1);
    const atParagraphs = await saveKnowledgeSource(await analyst(), {
      title: '段数边界',
      kind: 'dictionary',
      body: Array.from({ length: 200 }, (_, i) => `第 ${i} 段`).join('\n\n'),
    });
    expect(atParagraphs.paragraphs.at(-1)).toMatchObject({ no: 200 });
  });
});

describe('版本与读取', () => {
  let id: string;

  it('同一标题再次保存时版本 +1、正文更新，还是同一行；正文完全相同（别的成员粘也一样）不加版本；只换种类也算变', async () => {
    const first = await saveKnowledgeSource(await analyst(), { title: '会员口径', kind: 'dictionary', body: 'members 表\n\nlevel 等级' });
    const second = await saveKnowledgeSource(await analyst(), { title: '会员口径', kind: 'dictionary', body: 'members 表\n\nlevel 会员等级' });
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(2);
    expect(second.paragraphs).toEqual([
      { no: 1, text: 'members 表' },
      { no: 2, text: 'level 会员等级' },
    ]);
    const unchanged = await saveKnowledgeSource(await memberOf(acme, 'de@acme.com', 'data_engineer'), {
      title: '会员口径', kind: 'dictionary', body: ' members 表\n\nlevel 会员等级 ',   // 只差首尾空白
    });
    expect(unchanged.version).toBe(2);
    const rekinded = await saveKnowledgeSource(await analyst(), { title: '会员口径', kind: 'metric', body: 'members 表\n\nlevel 会员等级' });
    expect(rekinded.version).toBe(3);
    id = first.id;

    const mine = (await rows()).filter(r => r.title === '会员口径');
    expect(mine).toHaveLength(1);   // 没有新建行
    expect(mine[0]).toMatchObject({ id, kind: 'metric', body: 'members 表\n\nlevel 会员等级', version: 3, createdByEmail: 'an@acme.com' });
  });

  it('getKnowledgeSource 按当前正文切段读回；查看者（definitions:read）能看，别的租户或不是 UUID 时 400', async () => {
    const viewer = await memberOf(acme, 'view@acme.com', 'viewer');
    const got = await getKnowledgeSource(viewer, id);
    expect(got).toMatchObject({ id, title: '会员口径', kind: 'metric', version: 3 });
    expect(got.paragraphs).toEqual([
      { no: 1, text: 'members 表' },
      { no: 2, text: 'level 会员等级' },
    ]);
    expect(await errorOf(getKnowledgeSource(viewer, '不是 UUID'))).toMatch(/^400 /);
    const other = await newTenant('other');
    expect(await errorOf(getKnowledgeSource(await memberOf(other, 'an@other.com', 'analyst'), id))).toMatch(/^400 /);
    expect(await errorOf(getKnowledgeSource(viewer, '00000000-0000-0000-0000-000000000000'))).toMatch(/^400 /);
  });
});

describe('权限与审计', () => {
  it('需要 definitions:draft：查看者保存 403、不留行', async () => {
    const before = (await rows()).length;
    const viewer = await memberOf(acme, 'view@acme.com', 'viewer');
    await expect(saveKnowledgeSource(viewer, { title: '查看者的', kind: 'sql', body: 'SELECT 1' })).rejects.toMatchObject({ init: { status: 403 } });
    expect((await rows()).length).toBe(before);
  });

  it('审计 knowledge_source.created 的 detail 只有标题、种类、版本、段数，不含原文；正文没变的那次不记；摘要显示中文', async () => {
    const [row] = (await rows()).filter(r => r.title === '会员口径');
    const logs = (await audits('knowledge_source.created')).filter(l => l.targetId === row.id)
      .sort((a, b) => Number(a.detail.version) - Number(b.detail.version));
    expect(logs.map(l => [l.targetType, l.detail])).toEqual([
      ['knowledge_source', { title: '会员口径', kind: 'dictionary', version: 1, paragraphs: 2 }],
      ['knowledge_source', { title: '会员口径', kind: 'dictionary', version: 2, paragraphs: 2 }],
      ['knowledge_source', { title: '会员口径', kind: 'metric', version: 3, paragraphs: 2 }],   // 只换种类也算一版；正文没变的那次没记
    ]);
    expect(JSON.stringify(logs)).not.toContain('members 表');
    expect(JSON.stringify(logs)).not.toContain('level');
    expect((await listAuditLogs(acme)).find(l => l.action === '粘贴知识来源' && l.summary.includes('会员口径'))?.summary)
      .toBe('「会员口径」（指标说明），第 3 版，2 段');
  });
});
