// test/pipeline/mcp-query.test.ts —— 令牌允许执行查询时经 MCP 执行查询（#299，ADR-0042 / 0036 / 0043）：externalToolsFor(成员, { allowQuery }) 才有 run_query，
// invokeTool 按工作台规则执行、对全部返回行剔除敏感列、系统列与取值含哈希的列，每次执行记 workbench.query 带 via: 'mcp'；
// handleMcp 把白名单、并发 429 等 WorkbenchError 转成 isError 的工具结果。平台内助手的 toolsFor 没有它
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { externalToolsFor, invokeTool, toolsFor } from '../../app/.server/assistant/tools';
import type { CurrentMember } from '../../app/.server/auth';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs } from '../../app/.server/db/schema';
import { handleMcp } from '../../app/.server/mcp';
import { runQuery } from '../../app/.server/workbench';
import { resetDb } from '../http/harness';
import { memberOf } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

const HASH = /[0-9a-f]{64}/i;
const SLOW = `SELECT count(*) FROM ${Array.from({ length: 12 }, (_, i) => `silver.customer c${i}`).join(', ')}`;

let acme: string;
afterAll(async () => { await closeDb(); });
beforeAll(async () => {
  await resetDb();
  ({ acme } = await publishedIdentitySources());
});

const analyst = () => memberOf(acme, 'analyst@acme.com', 'analyst');
const viewer = () => memberOf(acme, 'viewer@acme.com', 'viewer');
const viaMcp = (m: CurrentMember): CurrentMember => ({ ...m, via: 'mcp' });
const queries = async (sql: string) => (await getDb().select().from(auditLogs)
  .where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, 'workbench.query'))))
  .map(a => a.detail as Record<string, unknown>).filter(d => d.sql === sql);
const run = async (m: CurrentMember, sql: string) =>
  JSON.parse((await invokeTool(viaMcp(m), 'run_query', { sql }, { allowQuery: true })).text) as
    { columns: string[]; rows: (string | null)[][]; truncated: boolean; dropped: string[] };
/** 经 handleMcp 调 run_query，返回 MCP 的工具结果 */
const callMcp = async (m: CurrentMember, sql: string, allowQuery = true) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_query', arguments: { sql } } });
  return (await (await handleMcp(m, body, { allowQuery })).json()).result as { content: { text: string }[]; isError: boolean };
};

describe('run_query 的授权', () => {
  it('没勾选允许执行查询时没有、调用被拒；查看者勾选了也被拒；平台内助手的 toolsFor 没有', async () => {
    const a = await analyst();
    const v = await viewer();
    expect(externalToolsFor(a, { allowQuery: false }).map(t => t.name)).not.toContain('run_query');
    expect(externalToolsFor(a, { allowQuery: true }).map(t => t.name)).toContain('run_query');
    expect(externalToolsFor(v, { allowQuery: true }).map(t => t.name)).not.toContain('run_query');
    expect(toolsFor(a).map(t => t.name)).not.toContain('run_query');

    await expect(invokeTool(a, 'run_query', { sql: 'SELECT 1' })).rejects.toMatchObject({ init: { status: 403 } });
    await expect(invokeTool(v, 'run_query', { sql: 'SELECT 1' }, { allowQuery: true })).rejects.toMatchObject({ init: { status: 403 } });
    expect(await callMcp(a, 'SELECT 1', false)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^没有执行查询的授权/) }] });
    expect(await callMcp(v, 'SELECT 1')).toMatchObject({ isError: true });
    expect(await queries('SELECT 1')).toEqual([]);
  });
});

describe('run_query', () => {
  it('返回列名与行；审计 workbench.query 带 via: mcp，不含结果', async () => {
    const sql = 'SELECT city, count(*) AS n FROM silver.customer GROUP BY 1 ORDER BY 1';
    const out = await run(await analyst(), sql);
    expect(out).toMatchObject({ columns: ['city', 'n'], truncated: false, dropped: [] });
    expect(out.rows.length).toBeGreaterThan(0);
    expect(typeof out.rows[0][1]).toBe('string');
    const [detail] = await queries(sql);
    expect(detail).toMatchObject({ sql, via: 'mcp', rows: out.rows.length });
    expect(JSON.stringify(detail)).not.toContain(String(out.rows[0][0]));
  });

  it('敏感列、系统列与取值含哈希的列（phone AS p）剔除，结果里没有哈希', async () => {
    const out = await run(await analyst(), "SELECT phone AS p, email, city, 1 AS _hash, 'a' AS contact_x FROM silver.customer");
    expect(out.columns).toEqual(['city']);
    expect(out.dropped).toEqual(['p', 'email', '_hash', 'contact_x']);
    expect(JSON.stringify(out)).not.toMatch(HASH);
  });

  it('前 50 行没有哈希、之后才有时照样剔除', async () => {
    const plain = "SELECT 0 AS k, 'plain' AS x FROM silver.customer c1, silver.customer c2, silver.customer c3";
    const sql = `SELECT x, k FROM (${plain} UNION ALL SELECT 1, phone FROM silver.customer) ORDER BY k`;
    const out = await run(await analyst(), sql);
    expect(out.rows.length).toBeGreaterThan(50 + 1);
    expect(out).toMatchObject({ columns: ['k'], dropped: ['x'] });
    expect(JSON.stringify(out)).not.toMatch(HASH);
  });

  it('白名单不过与并发 429 都是 isError 的工具结果，出错也记审计带 via: mcp', async () => {
    const a = await analyst();
    const bad = 'SELECT * FROM stage.x';
    expect(await callMcp(a, bad)).toMatchObject({ isError: true });
    expect((await queries(bad))[0]).toMatchObject({ via: 'mcp', error: expect.any(String) });

    const controller = new AbortController();
    const first = runQuery(a, SLOW, controller.signal).catch(e => e as Error);
    await new Promise(r => setTimeout(r, 1000));
    const busy = await callMcp(a, 'SELECT 2 AS two');
    expect(busy).toMatchObject({ isError: true });
    expect(busy.content[0].text).toMatch(/本租户已有查询在运行/);
    controller.abort();
    await first;
    expect(await callMcp(a, 'SELECT 3 AS three')).toMatchObject({ isError: false, content: [{ text: expect.stringContaining('"three"') }] });
  }, 120_000);
});
