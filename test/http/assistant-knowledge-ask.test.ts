// test/http/assistant-knowledge-ask.test.ts —— 助手「记为知识提案」卡片（⑥-4，ADR-0046 / 0056 / 0043）经 /assistant 的 HTTP 接缝：
// 点选歧义候选的那轮答复下服务端确定性组装卡片（askCard，读时计算不存库），本人确认后生成待复核的 term_default 提案
// （targetId 是所选条目、content 只有词、证据只有对话引用、不含用户原话），接受后再问同一个问题不再歧义、按默认口径回答；
// 同词已有待复核提案（不论挂哪个条目）或指纹已被拒绝过时没有卡片、直接提交 409；查看者没有卡片、提交 403；
// 被分享人读回没有卡片（候选照旧返回，按钮由前端对只读隐藏）；index 不指 chosen 消息 400，别人的对话 404
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { assistantConversations, knowledgeAliases } from '../../app/.server/db/schema';
import { ASSISTANT_CONTEXT } from '../../app/.server/assistant/conversations';
import { decryptForTenant } from '../../app/.server/secrets';
import { createDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { listProposals, proposeKnowledge, rejectProposal } from '../../app/.server/knowledge/proposals';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { fakeLlm, platformDefault, text, toolCalls } from '../pipeline/llm-fixtures';
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

/** 夹具（照 assistant-conversations.test.ts 的同名夹具）：发布两个只差时间字段的营收指标并都挂别名「营收」，问「近 30 天的营收」会让 catalog_search 判为歧义、候选就是这两个指标 */
async function askAmbiguousRevenue() {
  const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
  const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
  await memberOf(acme, 'viewer@acme.com', 'viewer');
  const client = await loginAs(app, 'analyst@acme.com');
  const peer = await loginAs(app, 'viewer@acme.com');
  const BY_CREATED = 'base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: created_at, days: 30 }\n';
  const BY_PAID = 'base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: paid_at, days: 30 }\n';
  for (const [key, yaml] of [['revenue_created', BY_CREATED], ['revenue_paid', BY_PAID]] as const) {
    await createDefinition(author, 'metric', key, yaml);
    await publishDefinition(reviewer, 'metric', key, 1);
  }
  // 别名直接写 knowledge_aliases（种子里别名经知识导入进同一张表，这里只需要词本身）；basedOn 为空、不算待复核
  await getDb().insert(knowledgeAliases).values([
    { tenantId: acme, targetId: 'metric:revenue_created', alias: '营收', basedOn: [], createdByEmail: 'de@acme.com' },
    { tenantId: acme, targetId: 'metric:revenue_paid', alias: '营收', basedOn: [], createdByEmail: 'de@acme.com' },
  ]);
  return { acme, analyst, client, peer };
}

/** 问一轮「近 30 天的营收」得到歧义候选（假模型先调一次 catalog_search 再答一句追问），返回对话 id */
async function askAmbiguous(client: Client): Promise<string> {
  fakeLlm(f => app.setLlmFetch(f), n => (n === 1
    ? toolCalls({ name: 'catalog_search', args: { query: '营收' } })
    : text('营收按哪个时间字段算？')));
  const first = await (await post(client, { message: '近 30 天的营收', page: PAGE })).json();
  expect(first.choices?.[0]?.term).toBe('营收');
  return first.conversationId as string;
}

/** 点选一个候选（假模型直接答一句），返回 POST 的解析结果 */
async function pick(client: Client, id: string, entryId: string) {
  fakeLlm(f => app.setLlmFetch(f), () => text('好的，按这个口径算'));
  return (await post(client, { conversationId: id, choice: { entryId } })).json();
}

describe('记为知识提案', () => {
  it('分析师点选候选后这一轮答复带 askCard（读回也带、库里不存），确认后生成待复核的默认指向提案（证据只有对话引用、不含原话），接受后再问不再歧义、按默认口径回答', async () => {
    const { acme, client } = await askAmbiguousRevenue();
    const id = await askAmbiguous(client);
    const picked = await pick(client, id, 'metric:revenue_paid');
    expect(picked).toMatchObject({ conversationId: id });
    // 卡片：index 是带 chosen 的 user 消息（下标 2）的下标，名称取自分析师自己的目录
    expect(picked.askCard).toEqual({ index: 2, term: '营收', entryId: 'metric:revenue_paid', name: 'revenue_paid' });
    // ?id= 读回：同一条 assistant 消息（下标 3）带一样的卡片
    const { conversation } = await (await client.get(`/assistant?id=${id}`)).json();
    expect(conversation.messages[3].askCard).toEqual(picked.askCard);
    // 卡片读时组装、不存库：密文里没有 askCard
    const [row] = await getDb().select().from(assistantConversations).where(eq(assistantConversations.tenantId, acme));
    const stored = JSON.parse((await decryptForTenant(acme, ASSISTANT_CONTEXT, row.sealed)).body).messages;
    expect(stored[3]).not.toHaveProperty('askCard');

    // 确认提交：只收 intent / conversationId / index，body 里多给的 term 与 entryId 一概不读
    const confirmed = await post(client, { intent: 'knowledge.propose', conversationId: id, index: 2, term: '流水', entryId: 'metric:revenue_created' });
    expect(confirmed.status).toBe(200);
    const { proposalId } = await confirmed.json();
    const [p] = await listProposals(getDb(), acme, { status: 'proposed' });
    expect(p.id).toBe(proposalId);
    expect(p).toMatchObject({ kind: 'term_default', targetId: 'metric:revenue_paid', content: { term: '营收' }, generatorVersion: 'assistant-choice/1' });
    // 证据只有对话引用（ADR-0056 第⑤条），用户原话不进提案
    expect(p.evidence).toEqual([{ ref: `assistant_conversation:${id}` }]);
    expect(JSON.stringify(p)).not.toContain('近 30 天的营收');

    // 知识面板上这条提案的证据显示「助手对话中的选择」，不给链接（审核人读不了别人的对话）
    const html = await (await client.get('/knowledge?item=metric%3Arevenue_paid')).text();
    expect(html).toContain('助手对话中的选择');

    // 接受（与面板的表单一致）后再问同一个问题：不再歧义、没有 choices，交给模型的工具输出写明按默认口径
    expect((await client.post('/analytics/definitions/metric/revenue_paid', { intent: 'proposal.accept', proposalId, targetId: 'metric:revenue_paid' })).status).toBe(302);
    const { received } = fakeLlm(f => app.setLlmFetch(f), n => (n === 1
      ? toolCalls({ name: 'catalog_search', args: { query: '营收' } })
      : text('按支付口径算好了')));
    const second = await (await post(client, { message: '近 30 天的营收', page: PAGE })).json();
    expect(second).not.toHaveProperty('choices');
    expect(JSON.stringify(received[1].body.messages)).toContain('按默认口径');
    // 审核状态变了，读回跟着变：已接受过这条默认指向，卡片不再出现
    const after = await (await client.get(`/assistant?id=${id}`)).json();
    expect(after.conversation.messages[3]).not.toHaveProperty('askCard');
  });

  it('同一个词已有待复核的默认指向提案（不论挂哪个条目）时没有卡片、直接提交 409；那条提案被拒绝后再点选同一个条目，指纹已被拒绝过，同样没有卡片、409', async () => {
    const { acme, analyst, client } = await askAmbiguousRevenue();
    // 先挂一条词同为「营收」、挂在另一个条目上的待复核提案（别名已在夹具里挂上，种类校验通过）
    const existing = await getDb().transaction(tx => proposeKnowledge(tx, acme, {
      targetId: 'metric:revenue_created', mappingId: null, kind: 'term_default', content: { term: '营收' },
      evidence: [], generatorVersion: 'test-gen-1',
    }));
    expect(existing).not.toBeNull();

    const id = await askAmbiguous(client);
    const picked = await pick(client, id, 'metric:revenue_paid');
    expect(picked).not.toHaveProperty('askCard');
    const { conversation } = await (await client.get(`/assistant?id=${id}`)).json();
    expect(conversation.messages[3]).not.toHaveProperty('askCard');
    // 直接提交也不新增提案：409 并说明原因
    const direct = await post(client, { intent: 'knowledge.propose', conversationId: id, index: 2 });
    expect(direct.status).toBe(409);
    expect(await direct.json()).toEqual({ error: '这个词已有待复核的默认指向提案' });
    expect(await listProposals(getDb(), acme, { status: 'proposed' })).toHaveLength(1);

    // 拒绝那条提案后再问一轮、点选同一个条目（revenue_created）：指纹已被拒绝过，同样没有卡片、提交 409
    await rejectProposal(analyst, existing!.id, '不要');
    const againId = await askAmbiguous(client);
    const again = await pick(client, againId, 'metric:revenue_created');
    expect(again).not.toHaveProperty('askCard');
    const rejected = await post(client, { intent: 'knowledge.propose', conversationId: againId, index: 2 });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: '这条默认指向提案已被拒绝过' });
    expect(await listProposals(getDb(), acme)).toHaveLength(1);
  });

  it('查看者没有卡片、直接提交 403；被分享人读回没有卡片（候选照旧返回）；index 不指 chosen 消息 400；别人的对话 404', async () => {
    const { client, peer } = await askAmbiguousRevenue();
    // 查看者自己问一轮并点选：卡片与提交都要 definitions:draft，查看者没有
    const viewerId = await askAmbiguous(peer);
    const picked = await pick(peer, viewerId, 'metric:revenue_paid');
    expect(picked).not.toHaveProperty('askCard');
    const denied = await post(peer, { intent: 'knowledge.propose', conversationId: viewerId, index: 2 });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toContain('仅');

    // 被分享人读回：没有卡片（候选照旧返回，#737；「看不到候选按钮」由前端对只读隐藏）
    const id = await askAmbiguous(client);
    await pick(client, id, 'metric:revenue_paid');
    expect((await post(client, { intent: 'share', conversationId: id, email: 'viewer@acme.com' })).status).toBe(200);
    const shared = await (await peer.get(`/assistant?id=${id}`)).json();
    expect(shared.conversation.messages[3]).not.toHaveProperty('askCard');
    expect(JSON.stringify(shared)).not.toContain('askCard');
    expect(shared.conversation.messages[1].choices).toHaveLength(1);

    // index 指向不带 chosen 的消息（问句与答复都算）时 400
    expect((await post(client, { intent: 'knowledge.propose', conversationId: id, index: 0 })).status).toBe(400);
    expect((await post(client, { intent: 'knowledge.propose', conversationId: id, index: 3 })).status).toBe(400);
    expect((await post(client, { intent: 'knowledge.propose', conversationId: id, index: 2.5 })).status).toBe(400);
    // 被分享的查看者提交：先挡权限 403（卡片与提交都要 definitions:draft，检查在对话之前）
    expect((await post(peer, { intent: 'knowledge.propose', conversationId: id, index: 2 })).status).toBe(403);
    // 别人的对话：有权限但没被分享（管理员也一样）按 404，不泄露存在性
    const admin = await loginAs(app, 'admin@acme.com');
    expect((await post(admin, { intent: 'knowledge.propose', conversationId: id, index: 2 })).status).toBe(404);
  });
});
