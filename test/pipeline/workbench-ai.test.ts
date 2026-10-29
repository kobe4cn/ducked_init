// test/pipeline/workbench-ai.test.ts —— 工作台 AI 起草 SQL 的流水线接缝（ADR-0043）：成员 draftWorkbenchSql(需求) → 按本人能读的目录请求模型 →
// 在只读挂载上按工作台白名单校验（不执行）→ 返回的 SQL 与审计 workbench.ai_drafted { sql, valid }，没有 workbench.query
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs } from '../../app/.server/db/schema';
import { setLlmFetch } from '../../app/.server/llm';
import { draftWorkbenchSql } from '../../app/.server/workbench-ai';
import { resetDb } from '../http/harness';
import { memberOf } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';
import { fakeLlm, json, platformDefault } from './llm-fixtures';

let acme: string;
afterAll(async () => { await closeDb(); });
afterEach(() => { setLlmFetch(undefined); vi.unstubAllEnvs(); });
beforeAll(async () => {
  await resetDb();
  ({ acme } = await publishedIdentitySources({ orders: true }));
});

const analyst = () => memberOf(acme, 'analyst@acme.com', 'analyst');
const audits = (action: string) => getDb().select().from(auditLogs).where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, action)));
/** 记下这条 SQL 的起草审计（各用例的 SQL 不同，按 SQL 区分；库在用例间共用） */
const drafted = async (sql: string) => (await audits('workbench.ai_drafted')).map(a => a.detail).filter(d => (d as { sql: string }).sql === sql);
const errorOf = (p: Promise<unknown>) => p.then(() => '成功', (e: Error & { status?: number }) => `${e.status ?? ''} ${e.message}`);
/** 模型总是给出这条 SQL */
const modelWrites = (sql: string) => { platformDefault(); return fakeLlm(setLlmFetch, () => json({ sql })); };

describe('AI 起草 SQL', () => {
  it('合规的 SQL 原样返回，不执行；审计 { sql, valid: true }，不含需求原文；请求里带着目录', async () => {
    const sql = 'SELECT city, count(*) AS n FROM silver.customer GROUP BY city';
    const { received } = modelWrites(sql);
    const queries = (await audits('workbench.query')).length;

    expect(await draftWorkbenchSql(await analyst(), '每个城市的客户数')).toEqual({ sql });

    expect((await audits('workbench.query')).length).toBe(queries);
    expect(await drafted(sql)).toEqual([{ sql, valid: true }]);
    expect(JSON.stringify(await audits('workbench.ai_drafted'))).not.toContain('每个城市');
    const prompt = received[0].body.messages.map(m => m.content).join('\n');
    expect(prompt).toContain('silver');
    expect(prompt).toContain('customer');
    expect(prompt).toContain('每个城市的客户数');
  });

  it('返回与审计的都是去掉结尾分号与空白后的 SQL', async () => {
    modelWrites('  SELECT count(*) FROM silver.customer;\n');
    expect(await draftWorkbenchSql(await analyst(), '客户总数')).toEqual({ sql: 'SELECT count(*) FROM silver.customer' });
    expect(await drafted('SELECT count(*) FROM silver.customer')).toEqual([{ sql: 'SELECT count(*) FROM silver.customer', valid: true }]);
  });

  it.each([
    ['写语句', 'INSERT INTO silver.customer SELECT * FROM silver.customer'],
    ['读不该读的表', 'SELECT * FROM stage.x'],
  ])('模型给出%s时 422，审计 valid: false', async (_, sql) => {
    modelWrites(sql);
    expect(await errorOf(draftWorkbenchSql(await analyst(), '随便查查'))).toMatch(/^422 AI 起草的 SQL 没有通过校验：/);
    expect(await drafted(sql)).toEqual([{ sql, valid: false }]);
  });

  it('需求为空或超过 2000 字时 400，没配置模型服务时 409，都不发请求', async () => {
    const { f } = fakeLlm(setLlmFetch, () => json({ sql: 'SELECT 1' }));
    expect(await errorOf(draftWorkbenchSql(await analyst(), '每个城市的客户数'))).toMatch(/^409 未配置模型服务/);
    platformDefault();
    expect(await errorOf(draftWorkbenchSql(await analyst(), '  '))).toMatch(/^400 /);
    expect(await errorOf(draftWorkbenchSql(await analyst(), '查'.repeat(2001)))).toMatch(/^400 /);
    expect(f).not.toHaveBeenCalled();
  });

  it('模型失败时 422', async () => {
    platformDefault();
    fakeLlm(setLlmFetch, () => json({ query: 'SELECT 1' }));
    expect(await errorOf(draftWorkbenchSql(await analyst(), '每个城市的客户数'))).toMatch(/^422 /);
  });

  it('查看者 403', async () => {
    modelWrites('SELECT 1');
    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');
    await expect(draftWorkbenchSql(viewer, '每个城市的客户数')).rejects.toMatchObject({ init: { status: 403 } });
  });
});
