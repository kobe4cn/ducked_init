// test/http/assistant-conversations.test.ts —— AI 助手对话的保存与只读分享（ADR-0043）经 /assistant 的 HTTP 接缝：
// 每轮问答记进本人的对话（标题与消息加密存一个字段），刷新后从列表打开继续；别人（含管理员）按 id 读 404；
// 分享给同租户成员后对方只读、不能续写，可撤销，分享与撤销记审计；成员被移出租户时其对话与分享随之删除；
// 工作台的结果解读存进本人的对话（带 query：SQL、行数与列名，不存取值），/workbench?sql= 把 SQL 填进编辑框、不执行
import { and, eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { assistantConversations, assistantConversationShares, auditLogs } from '../../app/.server/db/schema';
import { appendTurn, ASSISTANT_CONTEXT } from '../../app/.server/assistant/conversations';
import { MAX_HISTORY } from '../../app/.server/assistant/loop';
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
