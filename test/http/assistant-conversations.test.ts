// test/http/assistant-conversations.test.ts —— AI 助手对话的保存与只读分享（ADR-0043）经 /assistant 的 HTTP 接缝：
// 每轮问答记进本人的对话（标题与消息加密存一个字段），刷新后从列表打开继续；别人（含管理员）按 id 读 404；
// 分享给同租户成员后对方只读、不能续写，可撤销，分享与撤销记审计；成员被移出租户时其对话与分享随之删除
import { and, eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { assistantConversations, assistantConversationShares, auditLogs } from '../../app/.server/db/schema';
import { appendTurn } from '../../app/.server/assistant/conversations';
import { MAX_HISTORY } from '../../app/.server/assistant/loop';
import { removeMember } from '../../app/.server/members';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { loginAs, resetDb, startApp, type Client, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => {
  await resetDb();
  vi.stubEnv('LLM_BASE_URL', 'https://platform.example.com/v1');
  vi.stubEnv('LLM_MODEL', 'qwen-plus');
  vi.stubEnv('LLM_API_KEY', 'sk-platform-secret');
});
afterEach(() => { app.setLlmFetch(undefined); vi.unstubAllEnvs(); });

const PAGE = { path: '/lineage', title: '数据地图' };
const post = (client: Client, body: unknown) =>
  client.request('/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** 假模型：每次请求记下收到的消息，先调一次目录工具，再按顺序给出答复 */
function fakeModel(replies: string[]) {
  const requests: { role: string; content: string }[][] = [];
  let i = 0;
  app.setLlmFetch((async (_url: string, init: RequestInit) => {
    const { messages } = JSON.parse(String(init.body));
    requests.push(messages);
    if (messages.at(-1).role === 'user') {
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'catalog_overview', arguments: '{}' } }] } }] });
    }
    return Response.json({ choices: [{ message: { content: replies[i++] } }] });
  }) as typeof fetch);
  return requests;
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
    expect(requests[0].filter(m => m.role !== 'system').map(m => m.content)).toEqual(['有哪些机密实体？', '有客户、订单等实体', '客户有哪些字段？', '客户有姓名、手机号等字段', '谢谢']);

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
    const sent = long[0].filter(m => m.role !== 'system');
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
});
