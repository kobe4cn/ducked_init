// test/http/assistant-knowledge-missing.test.ts —— 知识入口 ⑥-5 / ⑥-6：说法未命中时的结构化候选、「都不是」与「记为别名」卡片经 /assistant 的 HTTP 接缝：
// catalog_search 判为未命中（关键词命中但没有任何标识 / 别名 / 名称命中、词 1–20 字且不含空白、投影没回退、候选非空）的那轮 assistant 消息
// 带 kind: 'missing' 的候选组（词加最接近的条目 id，只有 metric / tag / entity / field、最多 5 个，读回按读者自己的目录组装成带名称的视图），
// sealed 里没有候选 id 明文、发给模型的历史不含 choices；词命中名称、判为歧义、超 20 字或含空白时都不带未命中组（歧义组不带 kind 键，行为不变）；
// POST 带 choice 点选未命中组的候选：核对规则与 ⑥-3 相同（在最后一条 assistant 消息的候选里、在自己的目录里、对话属于本人），
// 生成「『词』指的是 〈名称〉（entryId）」的 user 消息并带 chosen.kind: 'missing'，这一轮答复带 kind: 'alias' 的「记为别名」卡片
//（读时计算不存库），确认后生成待复核的 alias 提案（assistant-missing/1），接受后再搜同一说法按别名命中、不再出未命中组；
// choice.entryId 为 null 是「都不是」：生成「『词』不是这些候选里的任何一个」（不带 chosen、不出卡片），上一轮没有未命中组时 400 且不请求模型
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { assistantConversations, knowledgeAliases } from '../../app/.server/db/schema';
import { appendTurn, ASSISTANT_CONTEXT } from '../../app/.server/assistant/conversations';
import { retireAlias } from '../../app/.server/knowledge/aliases';
import { listProposals, proposeKnowledge, rejectProposal } from '../../app/.server/knowledge/proposals';
import { decryptForTenant } from '../../app/.server/secrets';
import { memberOf } from '../pipeline/fixtures';
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

const PAGE = { path: '/analytics', title: '分析' };
const post = (client: Client, body: unknown) =>
  client.request('/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** 夹具：orders: true 的身份打通租户（订单字段已进目录），没有别名与指标。「实际支付」不在任何名称或别名里，
 * 关键词「实际」「际支」「支付」只命中描述里有这些词的字段（field:order.amount 实付金额、field:coupon.discount_amount 抵扣金额、field:order.paid_at 支付时间），
 * catalog_search 判它为未命中 */
async function ordersTenant() {
  const { acme } = await publishedIdentitySources({ orders: true });
  const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
  await memberOf(acme, 'viewer@acme.com', 'viewer');
  return { acme, analyst, client: await loginAs(app, 'analyst@acme.com'), peer: await loginAs(app, 'viewer@acme.com') };
}

/** 问一轮，假模型先搜 query 再答一句，返回请求记录与 POST 的解析结果 */
async function askWithSearch(client: Client, query: string, message = `按${query}看看`) {
  const { received } = fakeLlm(f => app.setLlmFetch(f), n => (n === 1
    ? toolCalls({ name: 'catalog_search', args: { query } })
    : text('先给你最接近的几个条目')));
  const first = await (await post(client, { message, page: PAGE })).json();
  return { received, first };
}

/** 这轮请求里 catalog_search 回填给模型的工具输出（用来证明关键词命中过，排除「检索为空所以没有候选」） */
const toolOutputs = (received: { body: { messages: { role: string }[] } }[]) =>
  JSON.stringify(received[1].body.messages.filter(m => m.role === 'tool'));

describe('说法未命中的结构化候选（⑥-5）', () => {
  it('判为未命中的那轮 assistant 消息带 kind: missing 的候选组：POST 返回与 ?id= 读回一致，候选只有 metric/tag/entity/field 并带名称；sealed 里没有 id 明文，发给模型的历史不含 choices', async () => {
    const { acme, client } = await ordersTenant();
    const { received, first } = await askWithSearch(client, '实际支付');
    expect(first).toMatchObject({ toolsUsed: ['catalog_search'] });
    expect(first.choices).toHaveLength(1);
    const [group] = first.choices;
    expect(group.term).toBe('实际支付');
    expect(group.kind).toBe('missing');
    for (const c of group.candidates) expect(c.entryId).toMatch(/^(metric|tag|entity|field):/);
    expect(group.candidates.map((c: { entryId: string }) => c.entryId).sort()).toEqual(
      ['field:coupon.discount_amount', 'field:order.amount', 'field:order.paid_at']);
    expect(group.candidates.find((c: { entryId: string }) => c.entryId === 'field:order.amount').name).toBe('实付金额');

    // ?id= 读回：同一条 assistant 消息带一样的视图，user 消息没有这个键
    const { conversation } = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(conversation.messages[0]).not.toHaveProperty('choices');
    expect(conversation.messages[1].choices).toEqual(first.choices);

    // 库里只有密文；解密后存的是词加候选条目 id（带 kind），名称读时按读者目录组装、不存
    const [row] = await getDb().select().from(assistantConversations).where(eq(assistantConversations.tenantId, acme));
    expect(row.sealed).not.toContain('field:order.amount');
    const stored = JSON.parse((await decryptForTenant(acme, ASSISTANT_CONTEXT, row.sealed)).body).messages[1].choices;
    expect(stored).toEqual([{
      term: '实际支付', kind: 'missing',
      candidates: expect.arrayContaining(['field:order.amount', 'field:coupon.discount_amount', 'field:order.paid_at']),
    }]);
    expect(stored[0].candidates).toHaveLength(3);

    // 续写一轮：交给模型的历史不含 choices
    expect((await post(client, { conversationId: first.conversationId, message: '谢谢', page: PAGE })).status).toBe(200);
    expect(JSON.stringify(received[2].body.messages)).not.toContain('candidates');
    expect(JSON.stringify(received[2].body.messages)).not.toContain('missing');
  });

  it('这几种情况都不带未命中组：词超过 20 字或含空白（关键词照常命中）、词命中了条目名称', async () => {
    const { client } = await ordersTenant();
    // 含空白：关键词「实际」「支付」仍命中 order.amount 的描述（工具输出里有它），但词里有空格
    const spaced = await askWithSearch(client, '实际支付 汇总');
    expect(spaced.first).not.toHaveProperty('choices');
    expect(toolOutputs(spaced.received)).toContain('实付金额');
    // 超过 20 字：关键词仍命中
    const long = await askWithSearch(client, '实际支付' + '呢'.repeat(18));
    expect(long.first).not.toHaveProperty('choices');
    expect(toolOutputs(long.received)).toContain('实付金额');
    // 命中名称：实付金额是 field:order.amount 的名称（name 一路有命中，不算未命中）
    const named = await askWithSearch(client, '实付金额');
    expect(named.first).not.toHaveProperty('choices');
  });

  it('点选未命中组的候选：生成「『实际支付』指的是 …」的用户消息继续这一轮（模型收到它），user 消息带 chosen.kind: missing，这一轮答复带 kind: alias 的「记为别名」卡片（POST 返回与读回一致、库里不存）', async () => {
    const { acme, client } = await ordersTenant();
    const { received, first } = await askWithSearch(client, '实际支付');
    const picked = await (await post(client, { conversationId: first.conversationId, choice: { entryId: 'field:order.amount' } })).json();
    expect(picked).toMatchObject({ conversationId: first.conversationId });
    // 卡片：index 是带 chosen 的 user 消息（下标 2）的下标，未命中点选的 kind 是 alias（记为别名），名称取自分析师自己的目录
    expect(picked.askCard).toEqual({ index: 2, term: '实际支付', entryId: 'field:order.amount', name: '实付金额', kind: 'alias' });

    // 服务端生成的用户消息：词从存着的未命中组反查、名称从自己的目录取（不收客户端传来的词或候选列表）
    const GENERATED = '『实际支付』指的是 〈实付金额〉（field:order.amount）';
    const sent = received[2].body.messages
      .filter((m: { role: string }) => m.role !== 'system' && m.role !== 'tool')
      .map((m: { content: string }) => m.content);
    expect(sent).toEqual(['按实际支付看看', '先给你最接近的几个条目', GENERATED]);
    expect(JSON.stringify(received[2].body.messages)).not.toContain('chosen');

    // 读回：user 消息带 chosen（kind: missing），它后面的 assistant 消息（下标 3）带一样的卡片；卡片读时组装、不存库
    const { conversation } = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(conversation.messages[2]).toEqual({ role: 'user', content: GENERATED, chosen: { term: '实际支付', entryId: 'field:order.amount', kind: 'missing' } });
    expect(conversation.messages[3].askCard).toEqual(picked.askCard);
    const [row] = await getDb().select().from(assistantConversations).where(eq(assistantConversations.tenantId, acme));
    const stored = JSON.parse((await decryptForTenant(acme, ASSISTANT_CONTEXT, row.sealed)).body).messages;
    expect(stored[3]).not.toHaveProperty('askCard');
  });

  it('确认「记为别名」卡片后有一条待复核的 alias 提案（content 只有词、证据只有对话引用、不含原话），接受后再搜同一说法按别名命中、不再出未命中组', async () => {
    const { acme, analyst, client } = await ordersTenant();
    const { first } = await askWithSearch(client, '实际支付');
    await post(client, { conversationId: first.conversationId, choice: { entryId: 'field:order.amount' } });

    // 确认提交：只收 intent / conversationId / index，body 里多给的 term 与 entryId 一概不读
    const confirmed = await post(client, { intent: 'knowledge.propose', conversationId: first.conversationId, index: 2, term: '流水', entryId: 'field:order.paid_at' });
    expect(confirmed.status).toBe(200);
    const { proposalId } = await confirmed.json();
    const [p] = await listProposals(getDb(), acme, { status: 'proposed' });
    expect(p.id).toBe(proposalId);
    expect(p).toMatchObject({ kind: 'alias', targetId: 'field:order.amount', content: { alias: '实际支付' }, generatorVersion: 'assistant-missing/1' });
    expect(p.evidence).toEqual([{ ref: `assistant_conversation:${first.conversationId}` }]);
    expect(JSON.stringify(p)).not.toContain('按实际支付看看');

    // 接受（与 /knowledge 面板的表单一致）后再搜同一个说法：按别名命中，不再出未命中组
    expect((await client.post('/knowledge', { intent: 'proposal.accept', proposalId, targetId: 'field:order.amount' })).status).toBe(302);
    const again = await askWithSearch(client, '实际支付');
    expect(again.first).not.toHaveProperty('choices');
    expect(toolOutputs(again.received)).toContain('别名「实际支付」');
    // 审核状态变了，读回跟着变：词已是这个条目的别名，卡片不再出现
    const after = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(after.conversation.messages[3]).not.toHaveProperty('askCard');

    // 接受后直接提交：词已是这个条目的别名，409、不新增提案
    const repeat = await post(client, { intent: 'knowledge.propose', conversationId: first.conversationId, index: 2 });
    expect(repeat.status).toBe(409);
    expect(await repeat.json()).toEqual({ error: '这个说法已经是这个条目的名称或别名' });

    // 停用这条别名后再提交：实时目录里已没有它，但指纹已接受过，仍 409、不新增提案
    const [alias] = await getDb().select({ id: knowledgeAliases.id }).from(knowledgeAliases).where(and(
      eq(knowledgeAliases.tenantId, acme), eq(knowledgeAliases.targetId, 'field:order.amount'), eq(knowledgeAliases.alias, '实际支付')));
    await retireAlias(analyst, alias.id);
    const retired = await post(client, { intent: 'knowledge.propose', conversationId: first.conversationId, index: 2 });
    expect(retired.status).toBe(409);
    expect(await retired.json()).toEqual({ error: '已接受过这条别名' });
    expect(await listProposals(getDb(), acme)).toHaveLength(1);
  });

  it('同一个说法已有待复核的 alias 提案（不论挂在哪个条目上）时没有卡片、直接提交 409；那条提案被拒绝后再点选它挂的条目，指纹已被拒绝过，同样没有卡片、409', async () => {
    const { acme, analyst, client } = await ordersTenant();
    // 先挂一条词同为「实际支付」、挂在另一个字段上的待复核提案（alias 提案提出时不查冲突，重复要靠 proposalBlock 预检挡）
    const existing = await getDb().transaction(tx => proposeKnowledge(tx, acme, {
      targetId: 'field:order.paid_at', mappingId: null, kind: 'alias', content: { alias: '实际支付' },
      evidence: [], generatorVersion: 'test-gen-1',
    }));
    expect(existing).not.toBeNull();

    const { first } = await askWithSearch(client, '实际支付');
    const picked = await (await post(client, { conversationId: first.conversationId, choice: { entryId: 'field:order.amount' } })).json();
    expect(picked).not.toHaveProperty('askCard');
    const { conversation } = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(conversation.messages[3]).not.toHaveProperty('askCard');
    // 直接提交也不新增提案：409 并说明原因
    const direct = await post(client, { intent: 'knowledge.propose', conversationId: first.conversationId, index: 2 });
    expect(direct.status).toBe(409);
    expect(await direct.json()).toEqual({ error: '这个说法已有待复核的别名提案' });
    expect(await listProposals(getDb(), acme, { status: 'proposed' })).toHaveLength(1);

    // 拒绝后再问一轮、点选那条提案挂的条目（paid_at）：指纹已被拒绝过，同样没有卡片、提交 409
    await rejectProposal(analyst, existing!.id, '不要');
    const second = await askWithSearch(client, '实际支付');
    const again = await (await post(client, { conversationId: second.first.conversationId, choice: { entryId: 'field:order.paid_at' } })).json();
    expect(again).not.toHaveProperty('askCard');
    const rejected = await post(client, { intent: 'knowledge.propose', conversationId: second.first.conversationId, index: 2 });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: '这条别名提案已被拒绝过' });
    expect(await listProposals(getDb(), acme)).toHaveLength(1);
  });

  it('同词待复核提案的比较不分大小写；词已是目标条目的名称或有效别名（实时目录）时没有卡片、提交 409', async () => {
    const { acme, analyst, client } = await ordersTenant();
    // 种一条词为「GMV」的待复核别名提案：chosen 里的词是小写 gmv，也该被挡住（这里直接种 chosen，不经搜索）
    await getDb().transaction(tx => proposeKnowledge(tx, acme, {
      targetId: 'field:order.paid_at', mappingId: null, kind: 'alias', content: { alias: 'GMV' },
      evidence: [], generatorVersion: 'test-gen-1',
    }));
    const lowerId = await appendTurn(analyst, null, {
      userText: '『gmv』指的是 〈实付金额〉（field:order.amount）', reply: '好的', toolsUsed: [],
      chosen: { term: 'gmv', entryId: 'field:order.amount', kind: 'missing' },
    });
    const lower = await (await client.get(`/assistant?id=${lowerId}`)).json();
    expect(JSON.stringify(lower)).not.toContain('askCard');
    const lowerSubmit = await post(client, { intent: 'knowledge.propose', conversationId: lowerId, index: 0 });
    expect(lowerSubmit.status).toBe(409);
    expect(await lowerSubmit.json()).toEqual({ error: '这个说法已有待复核的别名提案' });

    // 词正是目标条目的名称：不是别名候选，不出卡片
    const namedId = await appendTurn(analyst, null, {
      userText: '『实付金额』指的是 〈实付金额〉（field:order.amount）', reply: '好的', toolsUsed: [],
      chosen: { term: '实付金额', entryId: 'field:order.amount', kind: 'missing' },
    });
    const namedRead = await (await client.get(`/assistant?id=${namedId}`)).json();
    expect(JSON.stringify(namedRead)).not.toContain('askCard');
    const named = await post(client, { intent: 'knowledge.propose', conversationId: namedId, index: 0 });
    expect(named.status).toBe(409);
    expect(await named.json()).toEqual({ error: '这个说法已经是这个条目的名称或别名' });

    // 词是目标条目的有效别名（直接写 knowledge_aliases，同 ⑥-4 夹具的做法；这条没有提案历史，挡住的只能是实时目录）
    await getDb().insert(knowledgeAliases).values([
      { tenantId: acme, targetId: 'field:order.amount', alias: '实付', basedOn: [], createdByEmail: 'de@acme.com' },
    ]);
    const aliasedId = await appendTurn(analyst, null, {
      userText: '『实付』指的是 〈实付金额〉（field:order.amount）', reply: '好的', toolsUsed: [],
      chosen: { term: '实付', entryId: 'field:order.amount', kind: 'missing' },
    });
    const aliased = await post(client, { intent: 'knowledge.propose', conversationId: aliasedId, index: 0 });
    expect(aliased.status).toBe(409);
    expect(await aliased.json()).toEqual({ error: '这个说法已经是这个条目的名称或别名' });
    expect(await listProposals(getDb(), acme)).toHaveLength(1);
  });

  it('查看者点选后没有卡片、直接提交 403；被分享人读回没有卡片（候选照旧返回）', async () => {
    const { client, peer } = await ordersTenant();
    // 查看者自己问一轮并点选：卡片与提交都要 definitions:draft，查看者没有
    const { first: viewerFirst } = await askWithSearch(peer, '实际支付');
    const picked = await (await post(peer, { conversationId: viewerFirst.conversationId, choice: { entryId: 'field:order.amount' } })).json();
    expect(picked).not.toHaveProperty('askCard');
    const denied = await post(peer, { intent: 'knowledge.propose', conversationId: viewerFirst.conversationId, index: 2 });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toContain('仅');

    // 被分享人读回：没有卡片（候选照旧返回，「看不到候选按钮」由前端对只读隐藏）
    const { first } = await askWithSearch(client, '实际支付');
    await post(client, { conversationId: first.conversationId, choice: { entryId: 'field:order.amount' } });
    expect((await post(client, { intent: 'share', conversationId: first.conversationId, email: 'viewer@acme.com' })).status).toBe(200);
    const shared = await (await peer.get(`/assistant?id=${first.conversationId}`)).json();
    expect(shared.conversation.messages[3]).not.toHaveProperty('askCard');
    expect(JSON.stringify(shared)).not.toContain('askCard');
    expect(shared.conversation.messages[1].choices).toHaveLength(1);
  });

  it('「都不是」：未命中组生成『词』不是这些候选里的任何一个继续这一轮，user 消息不带 chosen；上一轮没有未命中组（只有歧义组或没有候选）时 400 且不请求模型', async () => {
    const { analyst, client } = await ordersTenant();
    const { received, first } = await askWithSearch(client, '实际支付');
    const none = await (await post(client, { conversationId: first.conversationId, choice: { entryId: null } })).json();
    expect(none).toMatchObject({ conversationId: first.conversationId });
    // 没选任何候选，不存 chosen，自然不出「记为别名」卡片
    expect(none).not.toHaveProperty('askCard');

    const GENERATED = '『实际支付』不是这些候选里的任何一个';
    const sent = received[2].body.messages
      .filter((m: { role: string }) => m.role !== 'system' && m.role !== 'tool')
      .map((m: { content: string }) => m.content);
    expect(sent.at(-1)).toBe(GENERATED);
    expect(JSON.stringify(received[2].body.messages)).not.toContain('chosen');
    const { conversation } = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(conversation.messages[2]).toEqual({ role: 'user', content: GENERATED });
    expect(JSON.stringify(conversation)).not.toContain('askCard');

    // 只有歧义组（不带 kind 键，照 assistant-conversations.test.ts 的歧义夹具的存储形状）或没有候选组：都 400
    const ambiguousId = await appendTurn(analyst, null, {
      userText: '近 30 天的营收', reply: '营收按哪个时间字段算？', toolsUsed: ['catalog_search'],
      choices: [{ term: '营收', candidates: ['metric:revenue_created', 'metric:revenue_paid'] }],
    });
    expect((await post(client, { conversationId: ambiguousId, choice: { entryId: null } })).status).toBe(400);
    const plainId = await appendTurn(analyst, null, { userText: '客户是什么', reply: '客户是消费者实体', toolsUsed: ['catalog_search'] });
    expect((await post(client, { conversationId: plainId, choice: { entryId: null } })).status).toBe(400);
    // 这两条 400 都没请求模型（只有「都不是」成功的那一轮多了一次请求）
    expect(received).toHaveLength(3);
  });

  it('choice 核对：点选不在候选里 / 不在自己目录里的条目、与 message 同给、entryId 不是字符串也不是 null 时 400 且不请求模型；别人的对话 404', async () => {
    const { analyst, client, peer } = await ordersTenant();
    const { received, first } = await askWithSearch(client, '实际支付');
    const id = first.conversationId as string;
    // 目录里有的实体但不在候选里
    expect((await post(client, { conversationId: id, choice: { entryId: 'entity:customer' } })).status).toBe(400);
    // 与 message 同给（点选与「都不是」都算）
    expect((await post(client, { conversationId: id, choice: { entryId: 'field:order.amount' }, message: '就这个' })).status).toBe(400);
    expect((await post(client, { conversationId: id, choice: { entryId: null }, message: '都不是' })).status).toBe(400);
    // entryId 是其他非字符串值
    expect((await post(client, { conversationId: id, choice: { entryId: 5 } })).status).toBe(400);
    // 在候选里、但不在自己的目录里：种一条候选含已不在目录里的条目
    const staleId = await appendTurn(analyst, null, {
      userText: '支付金额', reply: '是这几个吗？', toolsUsed: ['catalog_search'],
      choices: [{ term: '支付金额', kind: 'missing', candidates: ['metric:gone'] }],
    });
    expect((await post(client, { conversationId: staleId, choice: { entryId: 'metric:gone' } })).status).toBe(400);
    // 别人的对话：没被分享（管理员也一样）按 404，不泄露存在性
    expect((await post(peer, { conversationId: id, choice: { entryId: 'field:order.amount' } })).status).toBe(404);
    expect((await post(peer, { conversationId: id, choice: { entryId: null } })).status).toBe(404);
    expect(received).toHaveLength(2);
  });
});
