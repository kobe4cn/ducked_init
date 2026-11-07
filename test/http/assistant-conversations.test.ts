// test/http/assistant-conversations.test.ts —— AI 助手对话的保存与只读分享（ADR-0043）经 /assistant 的 HTTP 接缝：
// 每轮问答记进本人的对话（标题与消息加密存一个字段），刷新后从列表打开继续；别人（含管理员）按 id 读 404；
// 分享给同租户成员后对方只读、不能续写，可撤销，分享与撤销记审计；成员被移出租户时其对话与分享随之删除；
// 工作台的结果解读存进本人的对话（带 query：SQL、行数与列名，不存取值），/workbench?sql= 把 SQL 填进编辑框、不执行
import { and, eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { assistantConversations, assistantConversationShares, auditLogs, dslVersions } from '../../app/.server/db/schema';
import { appendTurn, ASSISTANT_CONTEXT } from '../../app/.server/assistant/conversations';
import { MAX_HISTORY } from '../../app/.server/assistant/loop';
import { catalogFor } from '../../app/.server/assistant/tools';
import { semanticHash } from '../../app/.server/catalog/plan';
import { createDefinition, publishDefinition, saveDslDraft } from '../../app/.server/dsl-definitions';
import { removeMember } from '../../app/.server/members';
import { decryptForTenant } from '../../app/.server/secrets';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { fakeLlm, json, platformDefault, text, toolCalls } from '../pipeline/llm-fixtures';
import { loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => {
  await resetDb();
  platformDefault();
});
afterEach(() => { app.setLlmFetch(undefined); vi.unstubAllEnvs(); });

const PAGE = { path: '/lineage', title: '数据地图' };
const post = (client: Client, body: unknown) =>
  client.request('/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** 假模型：每次请求记下收到的请求，先调一次目录工具，再按顺序给出答复 */
function fakeModel(replies: string[]) {
  let i = 0;
  return fakeLlm(f => app.setLlmFetch(f), (_n, body) => body.messages.at(-1)!.role === 'user'
    ? toolCalls({ id: 'c1', name: 'catalog_overview', args: {} })
    : text(replies[i++])).received;
}

async function analystAndPeer() {
  const acme = await newTenant('acme');
  const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
  await memberOf(acme, 'viewer@acme.com', 'viewer');
  return { acme, analyst, client: await loginAs(app, 'analyst@acme.com'), peer: await loginAs(app, 'viewer@acme.com') };
}

/** 本人问两轮，返回对话 id */
async function twoTurns(client: Client) {
  fakeModel(['有客户、订单等实体', '客户有姓名、手机号等字段']);
  const first = await (await post(client, { message: '有哪些机密实体？', page: PAGE })).json();
  const second = await (await post(client, { conversationId: first.conversationId, message: '客户有哪些字段？', page: PAGE })).json();
  expect(second.conversationId).toBe(first.conversationId);
  return first.conversationId as string;
}

describe('助手对话', () => {
  it('两轮问答自动保存：刷新后在「我的对话」里看到并读回、续写时带上历史；别人（含管理员）按 id 读 404；库里只有密文', async () => {
    const { acme, analyst, client, peer } = await analystAndPeer();
    const id = await twoTurns(client);

    const list = await (await client.get('/assistant')).json();
    expect(list.mine).toEqual([{ id, title: '有哪些机密实体？', updatedAt: expect.any(String) }]);
    expect(list.shared).toEqual([]);
    const { conversation } = await (await client.get(`/assistant?id=${id}`)).json();
    expect(conversation).toEqual({
      id, owned: true, sharedWith: [], title: '有哪些机密实体？',
      messages: [
        { role: 'user', content: '有哪些机密实体？' },
        { role: 'assistant', content: '有客户、订单等实体', toolsUsed: ['catalog_overview'] },
        { role: 'user', content: '客户有哪些字段？' },
        { role: 'assistant', content: '客户有姓名、手机号等字段', toolsUsed: ['catalog_overview'] },
      ],
    });

    // 续写时把保存的历史交给模型，不带工具输出
    const requests = fakeModel(['好的']);
    expect((await post(client, { conversationId: id, message: '谢谢', page: PAGE })).status).toBe(200);
    expect(requests[0].body.messages.filter(m => m.role !== 'system').map(m => m.content)).toEqual(['有哪些机密实体？', '有客户、订单等实体', '客户有哪些字段？', '客户有姓名、手机号等字段', '谢谢']);

    const admin = await loginAs(app, 'admin@acme.com');
    for (const other of [peer, admin]) {
      expect((await other.get(`/assistant?id=${id}`)).status).toBe(404);
      expect(await (await other.get('/assistant')).json()).toMatchObject({ mine: [], shared: [] });
      expect((await post(other, { conversationId: id, message: '接着说', page: PAGE })).status).toBe(404);
    }
    expect((await client.get('/assistant?id=not-a-uuid')).status).toBe(404);

    // 问满 MAX_HISTORY 条以后还能续写：只把最近的若干轮交给模型，保存的对话照样变长
    for (let i = 0; i < MAX_HISTORY / 2; i++) await appendTurn(analyst, id, `问题 ${i}`, `答复 ${i}`, []);
    const long = fakeModel(['还能接着答']);
    expect((await post(client, { conversationId: id, message: '最后一问', page: PAGE })).status).toBe(200);
    const sent = long[0].body.messages.filter(m => m.role !== 'system');
    expect(sent).toHaveLength(MAX_HISTORY - 1);
    expect(sent.at(-2)?.content).toBe(`答复 ${MAX_HISTORY / 2 - 1}`);
    expect((await (await client.get(`/assistant?id=${id}`)).json()).conversation.messages).toHaveLength(6 + MAX_HISTORY + 2);

    const rows = await getDb().select().from(assistantConversations).where(eq(assistantConversations.tenantId, acme));
    expect(rows).toHaveLength(1);
    for (const text of ['机密', '客户', 'catalog_overview']) expect(rows[0].sealed).not.toContain(text);
    expect(Object.keys(rows[0]).sort()).toEqual(['createdAt', 'id', 'memberId', 'sealed', 'tenantId', 'updatedAt']);
  });

  it('校验过的计划随对话加密保存（ADR-0050）：?id= 读回的 assistant 消息带 plan、sealed 里没有条目 id 明文；续写时发给模型的历史不带计划', async () => {
    const { acme } = await publishedIdentitySources();
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const client = await loginAs(app, 'analyst@acme.com');
    // 计划选中 entity:customer，哈希按分析师自己的目录算（写法照 pipeline/assistant 的「先检索再校验计划」）
    const hash = semanticHash((await catalogFor(analyst)).entries.find(e => e.id === 'entity:customer')!);
    const plan = {
      schemaVersion: 1, mode: 'reuse_result',
      selected: [{ id: 'entity:customer', semanticHash: hash }],
      request: { dimensions: [] },
      steps: [{ id: 's1', action: 'answer', inputs: ['entity:customer'] }],
      assumptions: [], questions: [],
    };
    const replies = [
      toolCalls({ name: 'catalog_search', args: { query: 'customer' } }),
      toolCalls({ name: 'validate_plan', args: { plan } }),
      text('计划可用'),
      text('不客气'), // 第二轮直接文字答复，不再检索校验
    ];
    const { received } = fakeLlm(f => app.setLlmFetch(f), n => replies[n - 1]);
    const first = await (await post(client, { message: '消费者分析能用现有目录吗', page: PAGE })).json();
    expect(first).toMatchObject({ reply: '计划可用', toolsUsed: ['catalog_search', 'validate_plan'] });

    // 读回：校验计划的那轮 assistant 消息带 plan，只有条目 id、版本与哈希，没有检索结果与工具原文
    const { conversation } = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(conversation.messages).toEqual([
      { role: 'user', content: '消费者分析能用现有目录吗' },
      { role: 'assistant', content: '计划可用', toolsUsed: ['catalog_search', 'validate_plan'], plan },
    ]);

    // 续写：交给模型的历史只有文字（不含计划，比如哈希值与 schemaVersion）；本轮没再校验，新消息不带 plan
    const second = await (await post(client, { conversationId: first.conversationId, message: '谢谢', page: PAGE })).json();
    expect(second).toMatchObject({ conversationId: first.conversationId, reply: '不客气', toolsUsed: [] });
    const sent = JSON.stringify(received[3].body.messages);
    expect(sent).not.toContain(hash);
    expect(sent).not.toContain('schemaVersion');
    const after = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(after.conversation.messages.at(-1)).toEqual({ role: 'assistant', content: '不客气', toolsUsed: [] });

    // 库里只有密文：计划里的条目 id 不在 sealed 里
    const [row] = await getDb().select().from(assistantConversations).where(eq(assistantConversations.tenantId, acme));
    expect(row.sealed).not.toContain('entity:customer');
  });

  it('续写时路由从完整对话里取最近一份计划作存草稿前重新校验的依据：两次请求之间发布了新版本，第二次直接保存被拒、不写 dsl_versions（ADR-0050）', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources();
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const client = await loginAs(app, 'analyst@acme.com');
    const COUNT_MEMBERS = 'base: customer\nmeasure: { agg: count }\n';
    await createDefinition(author, 'metric', 'member_count', COUNT_MEMBERS);
    await publishDefinition(reviewer, 'metric', 'member_count', 1);
    const entry = (await catalogFor(analyst)).entries.find(e => e.id === 'metric:member_count')!;
    if (entry.kind !== 'metric') throw new Error('member_count 发布后不在目录里');
    const plan = {
      schemaVersion: 1, mode: 'reuse_result',
      selected: [{ id: 'metric:member_count', version: entry.version, semanticHash: semanticHash(entry) }],
      request: { dimensions: [] },
      steps: [{ id: 's1', action: 'answer', inputs: ['metric:member_count'] }],
      assumptions: [], questions: [],
    };
    const replies = [
      toolCalls({ name: 'catalog_search', args: { query: 'member_count' } }),
      toolCalls({ name: 'validate_plan', args: { plan } }),
      text('计划可用'),
      // 第二次请求：模型不再检索校验，直接保存
      toolCalls({ name: 'save_definition_draft', args: { kind: 'metric', key: 'member_count', yaml: COUNT_MEMBERS } }),
      text('好的，先重新检索'),
    ];
    const { received } = fakeLlm(f => app.setLlmFetch(f), n => replies[n - 1]);
    const first = await (await post(client, { message: '统计会员数', page: PAGE })).json();
    expect(first).toMatchObject({ reply: '计划可用', toolsUsed: ['catalog_search', 'validate_plan'] });

    // 带计划的那轮之后再问满 MAX_HISTORY 条：它落在交给模型的 history 截断范围之外，路由只能在完整消息列表里找到它
    for (let i = 0; i < MAX_HISTORY / 2; i++) await appendTurn(analyst, first.conversationId, `问题 ${i}`, `答复 ${i}`, []);

    // 两次请求之间另一位成员存了第 2 版并发布：计划里的 v1 过期
    await saveDslDraft(author, 'metric', 'member_count', `# 换个说法\n${COUNT_MEMBERS}`);
    await publishDefinition(reviewer, 'metric', 'member_count', 2);
    const before = (await getDb().select().from(dslVersions)).length;

    const second = await (await post(client, { conversationId: first.conversationId, message: '把它保存为草稿', page: PAGE })).json();
    expect(second).toMatchObject({ conversationId: first.conversationId, reply: '好的，先重新检索', toolsUsed: ['save_definition_draft'] });
    const sentHistory = received[3].body.messages.filter(m => m.role !== 'system' && m.role !== 'tool').map(m => m.content);
    expect(sentHistory).not.toContain('计划可用');
    const tool = received[4].body.messages.filter(m => m.role === 'tool').at(-1)!;
    expect(tool.content).toContain('未保存：计划已过期');
    expect(tool.content).toContain('依赖变了');
    expect((await getDb().select().from(dslVersions)).length).toBe(before);
  });

  it('本人只读分享给同租户成员：对方在「分享给我的」里能读、不能续写也不能再分享；不能分享给自己或外租户；撤销后 404；分享与撤销记审计', async () => {
    const { acme, client, peer } = await analystAndPeer();
    const globex = await newTenant('globex');
    await memberOf(globex, 'other@globex.com', 'analyst');
    const id = await twoTurns(client);

    for (const email of ['analyst@acme.com', 'other@globex.com', 'nobody@acme.com']) {
      expect((await post(client, { intent: 'share', conversationId: id, email })).status).toBe(400);
    }
    const shared = await post(client, { intent: 'share', conversationId: id, email: ' Viewer@ACME.com ' });
    expect(await shared.json()).toEqual({ ok: true, email: 'viewer@acme.com' });
    // 再分享一次不变，也不重复记审计
    expect((await post(client, { intent: 'share', conversationId: id, email: 'viewer@acme.com' })).status).toBe(200);
    expect((await (await client.get(`/assistant?id=${id}`)).json()).conversation.sharedWith).toEqual(['viewer@acme.com']);

    expect((await (await peer.get('/assistant')).json()).shared).toEqual([{ id, title: '有哪些机密实体？', owner: 'analyst@acme.com', updatedAt: expect.any(String) }]);
    const { conversation } = await (await peer.get(`/assistant?id=${id}`)).json();
    expect(conversation).toMatchObject({ owned: false, sharedWith: [], title: '有哪些机密实体？' });
    expect(conversation.messages).toHaveLength(4);
    expect((await post(peer, { conversationId: id, message: '接着说', page: PAGE })).status).toBe(403);
    expect((await post(peer, { intent: 'share', conversationId: id, email: 'admin@acme.com' })).status).toBe(404);
    expect((await (await client.get(`/assistant?id=${id}`)).json()).conversation.messages).toHaveLength(4);

    expect((await post(client, { intent: 'unshare', conversationId: id, email: 'viewer@acme.com' })).status).toBe(200);
    expect((await post(client, { intent: 'unshare', conversationId: id, email: 'viewer@acme.com' })).status).toBe(400);
    expect((await peer.get(`/assistant?id=${id}`)).status).toBe(404);
    expect((await (await peer.get('/assistant')).json()).shared).toEqual([]);

    const audits = await getDb().select().from(auditLogs).where(and(eq(auditLogs.tenantId, acme), like(auditLogs.action, 'assistant.%')));
    expect(audits.map(a => [a.action, a.targetId, a.actorEmail, a.detail])).toEqual([
      ['assistant.conversation_shared', id, 'analyst@acme.com', { member: 'viewer@acme.com' }],
      ['assistant.conversation_unshared', id, 'analyst@acme.com', { member: 'viewer@acme.com' }],
    ]);
  });

  it('成员被移出租户后，其对话与相关分享行都被删除', async () => {
    const { acme, analyst, client, peer } = await analystAndPeer();
    const mine = await twoTurns(client);
    expect((await post(client, { intent: 'share', conversationId: mine, email: 'viewer@acme.com' })).status).toBe(200);
    fakeModel(['好的']);
    const theirs = (await (await post(peer, { message: '我的问题', page: PAGE })).json()).conversationId;
    expect((await post(peer, { intent: 'share', conversationId: theirs, email: 'analyst@acme.com' })).status).toBe(200);

    await removeMember(await memberOf(acme, 'admin@acme.com'), analyst.memberId);
    const conversations = await getDb().select().from(assistantConversations).where(eq(assistantConversations.tenantId, acme));
    expect(conversations.map(c => c.id)).toEqual([theirs]);
    // 它自己对话的分享与别人分享给它的都没了
    expect(await getDb().select().from(assistantConversationShares)).toEqual([]);
    expect((await (await peer.get('/assistant')).json()).shared).toEqual([]);
  });

  it('工作台的解读存进本人的对话，回看时带 SQL、行数与列名；同一页面再解读追加到同一个对话；别人的对话 404 且不请求模型；保存的内容里没有结果取值', async () => {
    const { acme } = await publishedIdentitySources();
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const client = await loginAs(app, 'analyst@acme.com');
    const { received } = fakeLlm(f => app.setLlmFetch(f), () => json({ interpretation: '客户平均分布在四个城市' }));
    // 结果里有 add_to_cart 等事件类型，SQL 与解读里都没有
    const sql = 'SELECT event_type, count(*) AS n FROM 埋点.events GROUP BY event_type ORDER BY n DESC';
    const conversationIn = (html: string) => html.match(/name="conversationId" value="([^"]+)"/)?.[1];

    const first = await client.post('/workbench', { intent: 'interpret', sql, confirmed: '1' });
    expect(first.status).toBe(200);
    const id = conversationIn(await first.text());
    expect(id).toBeDefined();

    const list = await (await client.get('/assistant')).json();
    expect(list.mine).toEqual([{ id, title: `解读：${sql.slice(0, 30)}`, updatedAt: expect.any(String) }]);
    const query = { sql, rows: 3, columns: ['event_type', 'n'] };
    const turn = [
      { role: 'user', content: `请解读这段查询的结果：\n\`\`\`sql\n${sql}\n\`\`\``, query },
      { role: 'assistant', content: '客户平均分布在四个城市' },
    ];
    expect((await (await client.get(`/assistant?id=${id}`)).json()).conversation.messages).toEqual(turn);

    // 同一页面（表单带着 conversationId）先预览再确认，追加到同一个对话
    const preview = await client.post('/workbench', { intent: 'interpret_preview', sql, conversationId: id! });
    expect(conversationIn(await preview.text())).toBe(id);
    const second = await client.post('/workbench', { intent: 'interpret', sql, confirmed: '1', conversationId: id! });
    expect(conversationIn(await second.text())).toBe(id);
    expect((await (await client.get(`/assistant?id=${id}`)).json()).conversation.messages).toEqual([...turn, ...turn]);
    // 不是自己的对话 404，不请求模型
    expect(received).toHaveLength(2);
    expect((await client.post('/workbench', { intent: 'interpret', sql, confirmed: '1', conversationId: crypto.randomUUID() })).status).toBe(404);
    expect(received).toHaveLength(2);

    const [row] = await getDb().select().from(assistantConversations).where(eq(assistantConversations.tenantId, acme));
    const body = (await decryptForTenant(acme, ASSISTANT_CONTEXT, row.sealed)).body;
    expect(body).toContain('埋点.events');
    for (const value of ['add_to_cart', 'login', 'view']) expect(body).not.toContain(value);
  });

  it('从侧栏「在工作台重新执行」打开 /workbench?sql=：SQL 填进编辑框，不执行；超过 20000 字时忽略', async () => {
    const { acme } = await publishedIdentitySources();
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const client = await loginAs(app, 'analyst@acme.com');
    const queries = async () => (await getDb().select().from(auditLogs)
      .where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, 'workbench.query')))).length;
    const before = await queries();
    const rerun = 'SELECT event_type FROM 埋点.events';
    const page = await (await client.get(`/workbench?sql=${encodeURIComponent(rerun)}`)).text();
    expect(page).toMatch(new RegExp(`<textarea[^>]*name="sql"[^>]*>${rerun}</textarea>`));
    expect(page).not.toContain('data-workbench-result');
    expect(await queries()).toBe(before);
    // 超过 20000 字时忽略
    const tooLong = await (await client.get(`/workbench?sql=${encodeURIComponent(`SELECT 1 -- ${'x'.repeat(20_000)}`)}`)).text();
    expect(tooLong).toMatch(/<textarea[^>]*name="sql"[^>]*><\/textarea>/);
  });
});
