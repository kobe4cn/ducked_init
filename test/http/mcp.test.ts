// test/http/mcp.test.ts —— 个人令牌与 /mcp 的 HTTP 接缝：成员在「我的设置」签发（明文只展示一次）、列出、吊销自己的令牌；
// Agent 带 Bearer 令牌 POST /mcp 的 initialize、tools/list、tools/call。没带、错误、已吊销、已过期、租户已暂停、API Key、只带成员 cookie 一律同样的 401；
// 别人的令牌吊销不了（404）；角色每次现查（requireMemberToken 直接调用），成员被移除后令牌失效。
// 工具来自注册表里 external 的那部分、按成员角色过滤：没有发布工具；经 MCP 保存的草稿作者是令牌的成员、审计带 via: 'mcp'，不通过与无权限都是 isError 工具结果
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deniedReason } from '../../app/.server/access';
import { sha256 } from '../../app/.server/auth';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, dslVersions, memberTokens } from '../../app/.server/db/schema';
import { requireMemberToken } from '../../app/.server/member-tokens';
import { changeMemberRole, removeMember } from '../../app/.server/members';
import { suspendTenant } from '../../app/.server/tenants';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

/** 成员在「我的设置」签发一个令牌，返回明文与签发那次响应的 HTML */
async function issue(browser: Client, name: string, fields: Record<string, string> = { days: '30' }) {
  const res = await browser.post('/settings', { intent: 'create', name, ...fields });
  expect(res.status).toBe(200);
  const html = await res.text();
  const token = html.match(/data-member-token="[^"]*"[^>]*>([^<]+)</)?.[1];
  if (!token) throw new Error('签发后的页面没有展示令牌');
  return { token, html };
}

/** 页面上某个名称对应的令牌 ID */
async function tokenIdOf(browser: Client, name: string) {
  const html = await (await browser.get('/settings')).text();
  const row = html.split('<tr').find(r => r.includes(`>${name}<`));
  const id = row?.match(/data-member-token-id="([\w-]+)"/)?.[1];
  if (!id) throw new Error(`我的设置页没有「${name}」`);
  return id;
}

/** 向 /mcp 发一条 JSON-RPC 消息 */
const rpc = (token: string | undefined, message: unknown, browser: Client = app.client()) =>
  browser.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
    body: typeof message === 'string' ? message : JSON.stringify(message),
  });

const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } };
const bearer = (token: string) => new Request('http://localhost/mcp', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

describe('我的设置：个人令牌', () => {
  it('成员签发后只展示一次明文，列表只有名称、前缀、有效期、是否允许查询与时间，库里只存哈希；吊销后审计有记录；空名、超过 64 字、有效期不在可选项里 400', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    expect(await (await analyst.get('/')).text()).toContain('href="/settings"');

    const before = Date.now();
    const { token, html } = await issue(analyst, '我的 Claude Code', { days: '30', allowQuery: 'on' });
    expect(html).toContain('只显示这一次');
    expect(token.startsWith('crm_pat_')).toBe(true);

    const list = await (await analyst.get('/settings')).text();
    expect(list).not.toContain(token);
    expect(list).toContain('我的 Claude Code');
    expect(list).toContain(`${token.slice(0, 16)}…`);
    expect(list).toContain('可执行查询');
    expect(list).toContain('从未使用');

    const [row] = await getDb().select().from(memberTokens);
    expect(row.tokenHash).toBe(sha256(token));
    expect(row.prefix).toBe(token.slice(0, 16));
    expect(row.allowQuery).toBe(true);
    const days = (row.expiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);
    expect(JSON.stringify(row)).not.toContain(token);

    const id = await tokenIdOf(analyst, '我的 Claude Code');
    expect((await analyst.post('/settings', { intent: 'revoke', tokenId: id })).status).toBe(302);
    expect(await (await analyst.get('/settings')).text()).toContain('已吊销');
    expect((await analyst.post('/settings', { intent: 'revoke', tokenId: id })).status).toBe(404);

    const audits = await getDb().select({ action: auditLogs.action, detail: auditLogs.detail }).from(auditLogs).where(eq(auditLogs.targetId, id));
    expect(audits.map(a => a.action).sort()).toEqual(['member_token.created', 'member_token.revoked']);
    for (const a of audits) expect(Object.keys(a.detail as object).sort()).toEqual(['allowQuery', 'expiresAt', 'name', 'prefix']);
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify(audits)).not.toContain(row.tokenHash);

    expect((await analyst.post('/settings', { intent: 'create', name: '  ', days: '30' })).status).toBe(400);
    expect((await analyst.post('/settings', { intent: 'create', name: 'x', days: '0' })).status).toBe(400);
    expect((await analyst.post('/settings', { intent: 'create', name: 'x'.repeat(65), days: '30' })).status).toBe(400);
  });

  it('另一位成员看不到、也吊销不了别人的令牌（404），令牌照常可用', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    const { token } = await issue(analyst, '我的 Agent');
    const id = await tokenIdOf(analyst, '我的 Agent');

    const admin = await loginAs(app, 'admin@acme.com');
    expect(await (await admin.get('/settings')).text()).not.toContain('我的 Agent');
    expect((await admin.post('/settings', { intent: 'revoke', tokenId: id })).status).toBe(404);
    expect((await rpc(token, INITIALIZE)).status).toBe(200);
  });
});

describe('/mcp', () => {
  it('有效令牌能 initialize、tools/list；通知回 202，tools/call 没有这个工具是 isError 结果，未知方法、坏 JSON、批量各有错误码；GET 405', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'an@acme.com', 'analyst');
    const { token } = await issue(await loginAs(app, 'an@acme.com'), 'Agent');

    const init = await rpc(token, INITIALIZE);
    expect(init.status).toBe(200);
    expect(init.headers.get('Content-Type')).toContain('application/json');
    expect(await init.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'duckdb-crm', version: '1' } },
    });

    const notified = await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe('');

    const list = await (await rpc(token, { jsonrpc: '2.0', id: 'a', method: 'tools/list' })).json();
    expect(list).toMatchObject({ jsonrpc: '2.0', id: 'a' });
    expect(list.result.tools.length).toBeGreaterThan(0);
    const call = await (await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x', arguments: {} } })).json();
    expect(call).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '没有这个工具' }], isError: true } });
    expect((await (await rpc(token, { jsonrpc: '2.0', id: 3, method: 'resources/list' })).json()).error.code).toBe(-32601);
    expect((await (await rpc(token, '{not json')).json()).error.code).toBe(-32700);
    expect((await (await rpc(token, [INITIALIZE])).json()).error.code).toBe(-32600);

    const get = await app.client().request('/mcp', { headers: { Authorization: `Bearer ${token}` } });
    expect(get.status).toBe(405);

    const [row] = await getDb().select().from(memberTokens);
    expect(row.lastUsedAt).not.toBeNull();
  });

  it('没带令牌、令牌错误、已吊销、已过期、租户已暂停、API Key、只带成员 cookie 一律同样的 401', async () => {
    const acme = await newTenant('acme');
    await memberOf(acme, 'an@acme.com', 'analyst');
    const analyst = await loginAs(app, 'an@acme.com');
    const { token: revoked } = await issue(analyst, '要吊销的');
    const { token: expired } = await issue(analyst, '要过期的');
    const { token: live } = await issue(analyst, '一直有效的');
    await analyst.post('/settings', { intent: 'revoke', tokenId: await tokenIdOf(analyst, '要吊销的') });
    await getDb().update(memberTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(memberTokens.tokenHash, sha256(expired)));
    expect(await (await analyst.get('/settings')).text()).toContain('已过期');

    const admin = await loginAs(app, 'admin@acme.com');
    const keyHtml = await (await admin.post('/api-keys', { intent: 'create', name: '营销自动化' })).text();
    const apiKey = keyHtml.match(/data-api-key="[^"]*"[^>]*>([^<]+)</)![1];

    const failures = [
      await rpc(undefined, INITIALIZE),
      await rpc('crm_pat_not-a-token', INITIALIZE),
      await rpc(revoked, INITIALIZE),
      await rpc(expired, INITIALIZE),
      await rpc(apiKey, INITIALIZE),
      // 成员已登录的浏览器不带令牌：不读 cookie
      await rpc(undefined, INITIALIZE, analyst),
    ];
    expect((await rpc(live, INITIALIZE)).status).toBe(200);
    await suspendTenant(null, acme, '欠费');
    failures.push(await rpc(live, INITIALIZE));

    const bodies: string[] = [];
    for (const res of failures) {
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toHaveProperty('error');
  });

  it('角色每次从成员表现查，改角色立刻生效；成员被移除后同一个令牌 401', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com', 'data_engineer');
    const { token } = await issue(await loginAs(app, 'de@acme.com'), 'Agent', { days: '7' });
    const admin = await memberOf(acme, 'admin@acme.com', 'admin');

    const first = await requireMemberToken(bearer(token));
    expect(first.actor).toMatchObject({ memberId: engineer.memberId, email: 'de@acme.com', role: 'data_engineer', tenant: { id: acme } });
    expect(first.allowQuery).toBe(false);

    await changeMemberRole(admin, engineer.memberId, 'analyst');
    expect((await requireMemberToken(bearer(token))).actor.role).toBe('analyst');

    await removeMember(admin, engineer.memberId);
    const res = await rpc(token, INITIALIZE);
    expect(res.status).toBe(401);
    expect(await getDb().select().from(memberTokens)).toHaveLength(0);
  });
});

const COUNT_MEMBERS = 'base: customer\nmeasure: { agg: count }\n';
const BAD_METRIC = 'base: nope\nmeasure: { agg: count }\n';

/** 调一个工具，返回 JSON-RPC 的 result */
async function callTool(token: string, name: string, args?: unknown) {
  const res = await rpc(token, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, ...(args === undefined ? {} : { arguments: args }) } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.error).toBeUndefined();
  return body.result as { content: { type: string; text: string }[]; isError: boolean };
}

const toolNames = async (token: string): Promise<string[]> =>
  (await (await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).result.tools.map((t: { name: string }) => t.name);

describe('/mcp 工具', () => {
  it('tools/list 是成员角色可用的 external 工具（名称、说明、inputSchema），没有发布工具；查看者看不到 save_*', async () => {
    const { acme } = await publishedIdentitySources();
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const { token: analystToken } = await issue(await loginAs(app, 'analyst@acme.com'), 'Agent');
    const { token: viewerToken } = await issue(await loginAs(app, 'viewer@acme.com'), 'Agent');
    const { token: engineerToken } = await issue(await loginAs(app, 'de@acme.com'), 'Agent');

    const { result } = await (await rpc(analystToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
    const save = result.tools.find((t: { name: string }) => t.name === 'save_definition_draft');
    expect(Object.keys(save).sort()).toEqual(['description', 'inputSchema', 'name']);
    expect(save.inputSchema).toMatchObject({ type: 'object', required: ['kind', 'key', 'yaml'] });

    const analyst = await toolNames(analystToken);
    expect(analyst).toEqual(expect.arrayContaining(['catalog_overview', 'catalog_search', 'validate_definition', 'save_definition_draft']));
    expect(analyst).not.toContain('save_mapping_draft');
    expect(analyst).not.toContain('run_query');
    expect(await toolNames(engineerToken)).toContain('save_mapping_draft');
    const viewer = await toolNames(viewerToken);
    expect(viewer).toContain('catalog_search');
    expect(viewer.filter(n => n.startsWith('save_') || n.startsWith('validate_'))).toEqual([]);
    for (const n of [...analyst, ...await toolNames(engineerToken)]) expect(n).not.toMatch(/publish/);
  });

  it('分析师经 MCP 读目录并保存指标草稿：作者是分析师、审计带 via: mcp；校验不通过是 isError 结果、不保存', async () => {
    const { acme } = await publishedIdentitySources();
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const { token } = await issue(await loginAs(app, 'analyst@acme.com'), 'Agent');

    const found = await callTool(token, 'catalog_search', { query: '会员' });
    expect(found.isError).toBe(false);
    expect(found.content[0].text.length).toBeGreaterThan(0);

    const bad = await callTool(token, 'save_definition_draft', { kind: 'metric', key: 'member_count', yaml: BAD_METRIC });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/base/);
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);

    const saved = await callTool(token, 'save_definition_draft', { kind: 'metric', key: 'member_count', yaml: COUNT_MEMBERS });
    expect(saved).toEqual({ content: [{ type: 'text', text: expect.stringContaining('已保存为草稿：metric/member_count 第 1 版') }], isError: false });

    const [version] = await getDb().select().from(dslVersions);
    expect(version).toMatchObject({ authors: ['analyst@acme.com'], status: 'draft', yaml: COUNT_MEMBERS });
    const [audit] = await getDb().select().from(auditLogs)
      .where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, 'definition.drafted')));
    expect(audit).toMatchObject({ actorEmail: 'analyst@acme.com', detail: { kind: 'metric', key: 'member_count', version: 1, via: 'mcp' } });
  });

  it('无权限或输入不对的工具调用是 isError 结果（403 的说明原样给出），不是 500', async () => {
    const { acme } = await publishedIdentitySources();
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const { token } = await issue(await loginAs(app, 'viewer@acme.com'), 'Agent');

    const denied = await callTool(token, 'save_definition_draft', { kind: 'metric', key: 'member_count', yaml: COUNT_MEMBERS });
    expect(denied).toEqual({ content: [{ type: 'text', text: deniedReason('definitions:draft') }], isError: true });
    expect(await getDb().select().from(dslVersions)).toHaveLength(0);

    const badInput = await callTool(token, 'catalog_search', {});
    expect(badInput.isError).toBe(true);
    expect(badInput.content[0].text).toContain('输入不对');
  });
});
