// test/http/assistant-conversations.test.ts —— AI 助手对话的保存与只读分享（ADR-0043）经 /assistant 的 HTTP 接缝：
// 每轮问答记进本人的对话（标题与消息加密存一个字段），刷新后从列表打开继续；别人（含管理员）按 id 读 404；
// 分享给同租户成员后对方只读、不能续写，可撤销，分享与撤销记审计；成员被移出租户时其对话与分享随之删除；
// 工作台的结果解读存进本人的对话（带 query：SQL、行数与列名，不存取值），/workbench?sql= 把 SQL 填进编辑框、不执行；
// 带 plan 的消息在读时按读者自己的目录组装计划卡（#452，ADR-0050：读时再校验；ADR-0005：被分享人按自己的目录，看不到的条目只留 id）；
// 「排除了哪些口径」（#539）：被分享人看不到的条目只有原因、id 与名称都不进卡片，带 excluded 的计划存草稿不判过期
import { and, eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { assistantConversations, assistantConversationShares, auditLogs, dslVersions } from '../../app/.server/db/schema';
import { appendTurn, ASSISTANT_CONTEXT } from '../../app/.server/assistant/conversations';
import { MAX_HISTORY } from '../../app/.server/assistant/loop';
import { catalogFor } from '../../app/.server/assistant/tools';
import type { PlanCardView } from '../../app/.server/assistant/plan-card';
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

  it('校验过的计划随对话加密保存（ADR-0050）：?id= 读回的 assistant 消息只带 planCard、不带原始 plan（#539），sealed 里没有条目 id 明文；续写时发给模型的历史不带计划', async () => {
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

    // 读回：校验计划的那轮 assistant 消息不带原始 plan（#539：看不到的 excluded 条目 id 不能经它泄露），
    // 只带读时组装的 planCard（#452：卡片的名称、数据截至是动态的，用 objectContaining 收敛断言）
    const { conversation } = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(conversation.messages).toEqual([
      { role: 'user', content: '消费者分析能用现有目录吗' },
      { role: 'assistant', content: '计划可用', toolsUsed: ['catalog_search', 'validate_plan'], planCard: expect.objectContaining({ status: 'valid', mode: 'reuse_result' }) },
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

  it('填入工作台通过的 SQL 随对话加密保存：POST 返回与 ?id= 读回的 assistant 消息都带 workbenchSql、sealed 里没有明文；被拒的那轮不带（#437）', async () => {
    const { acme } = await publishedIdentitySources();
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const client = await loginAs(app, 'analyst@acme.com');
    // 计划照上一条用例选中 entity:customer，mode 改成 draft_query（draft_query 不做口径与粒度检查，校验仍是 valid）
    const hash = semanticHash((await catalogFor(analyst)).entries.find(e => e.id === 'entity:customer')!);
    const plan = {
      schemaVersion: 1, mode: 'draft_query',
      selected: [{ id: 'entity:customer', semanticHash: hash }],
      request: { dimensions: [] },
      steps: [{ id: 's1', action: 'answer', inputs: ['entity:customer'] }],
      assumptions: [], questions: [],
    };
    // 工作台 AI 用过的按城市统计 SQL（test/pipeline/workbench-ai.test.ts）
    const CITY_COUNT = 'SELECT city, count(*) AS n FROM silver.customer GROUP BY city';
    const replies = [
      toolCalls({ name: 'catalog_search', args: { query: 'customer' } }),
      toolCalls({ name: 'validate_plan', args: { plan } }),
      toolCalls({ name: 'prefill_workbench', args: { sql: `  ${CITY_COUNT};\n` } }),
      text('SQL 已准备好'),
      // 第二轮：校验 reuse_result 计划后填工作台被拒（只有 draft_query 的计划能填）
      toolCalls({ name: 'catalog_search', args: { query: 'customer' } }),
      toolCalls({ name: 'validate_plan', args: { plan: { ...plan, mode: 'reuse_result' as const } } }),
      toolCalls({ name: 'prefill_workbench', args: { sql: CITY_COUNT } }),
      text('这次没有填入'),
    ];
    const { received } = fakeLlm(f => app.setLlmFetch(f), n => replies[n - 1]);
    // 通过的那轮：返回的 workbenchSql 是去掉首尾空白与结尾分号后的 SQL
    const first = await (await post(client, { message: '按城市统计客户', page: PAGE })).json();
    expect(first).toMatchObject({ reply: 'SQL 已准备好', toolsUsed: ['catalog_search', 'validate_plan', 'prefill_workbench'], workbenchSql: CITY_COUNT });

    // ?id= 读回：assistant 消息带 workbenchSql，content 里只有答复文字；planCard 照 #452 读时组装
    const { conversation } = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(conversation.messages).toEqual([
      { role: 'user', content: '按城市统计客户' },
      { role: 'assistant', content: 'SQL 已准备好', toolsUsed: ['catalog_search', 'validate_plan', 'prefill_workbench'], workbenchSql: CITY_COUNT, planCard: expect.objectContaining({ status: 'valid', mode: 'draft_query' }) },
    ]);
    // 库里只有密文
    const [row] = await getDb().select().from(assistantConversations).where(eq(assistantConversations.tenantId, acme));
    expect(row.sealed).not.toContain('silver.customer');

    // 被拒的那轮：POST 返回与读回的 assistant 消息都没有 workbenchSql；发给模型的历史也不带 SQL（content 里不写 SQL）。
    // 本轮校验过计划，返回照带 planCard（#452）
    const second = await (await post(client, { conversationId: first.conversationId, message: '再按会员数统计', page: PAGE })).json();
    expect(second).toEqual({ conversationId: first.conversationId, reply: '这次没有填入', toolsUsed: ['catalog_search', 'validate_plan', 'prefill_workbench'], planCard: expect.objectContaining({ status: 'valid', mode: 'reuse_result' }) });
    const after = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(after.conversation.messages.at(-1)).not.toHaveProperty('workbenchSql');
    expect(JSON.stringify(received[4].body.messages)).not.toContain('silver.customer');
  });

  it('答复下的计划卡按读者的目录在读时组装（#452，ADR-0050 / 0005）：POST 返回与 ?id= 读回都带 planCard、不带 plan 的消息没有；被分享的查看者看不到源表条目，卡片只留 id、状态不是 valid、不出现源表名称', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');
    const client = await loginAs(app, 'analyst@acme.com');
    const peer = await loginAs(app, 'viewer@acme.com');
    // 带时间窗口的指标：request 没写 windowDays，卡片的窗口取指标的 window.days
    const REVENUE_30D = 'base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: created_at, days: 30 }\n';
    await createDefinition(author, 'metric', 'revenue_30d', REVENUE_30D);
    await publishDefinition(reviewer, 'metric', 'revenue_30d', 1);
    const catalog = await catalogFor(analyst);
    const entry = (id: string) => {
      const e = catalog.entries.find(x => x.id === id);
      if (!e) throw new Error(`${id} 不在分析师目录里`);
      return e;
    };
    // 查看者没有 sources:read，目录里没有 table: 条目（ADR-0005）
    expect((await catalogFor(viewer)).entries.some(e => e.kind === 'table')).toBe(false);
    const [customer, metric, table] = ['entity:customer', 'metric:revenue_30d', 'table:CRM/orders'].map(entry);
    if (customer.kind !== 'entity' || metric.kind !== 'metric' || table.kind !== 'table') throw new Error('目录条目种类不对');
    // publishedIdentitySources 已跑过合并，实体必须有最近一次合并时间，下面卡片的 asOf 才测得到「实体取 stats.at」
    if (!customer.stats) throw new Error('实体没有合并时间');
    const plan = {
      schemaVersion: 1, mode: 'reuse_result',
      selected: [
        { id: 'entity:customer', semanticHash: semanticHash(customer) },
        { id: 'metric:revenue_30d', version: metric.version, semanticHash: semanticHash(metric) },
        { id: 'table:CRM/orders', semanticHash: semanticHash(table) },
      ],
      request: { dimensions: ['order.amount'], population: '全部订单' },
      steps: [{ id: 's1', action: 'answer', inputs: ['entity:customer', 'metric:revenue_30d', 'table:CRM/orders'] }],
      assumptions: [{ text: '金额按下单时间统计', confirmed: true }, { text: '退款另算', confirmed: false }],
      questions: [],
    };
    const replies = [
      toolCalls({ name: 'catalog_search', args: { query: '订单金额' } }),
      toolCalls({ name: 'validate_plan', args: { plan } }),
      text('可以复用现有结果'),
      text('收到'),
    ];
    const { received } = fakeLlm(f => app.setLlmFetch(f), n => replies[n - 1]);
    const first = await (await post(client, { message: '统计各金额的订单', page: PAGE })).json();
    // POST 返回的卡片：按分析师自己的目录重新校验是 valid，条目带名称与说明、数据截至（实体取最近一次合并时间），窗口取指标的 window.days
    expect(first).toMatchObject({ reply: '可以复用现有结果', toolsUsed: ['catalog_search', 'validate_plan'] });
    expect(first.planCard).toEqual({
      status: 'valid', mode: 'reuse_result', resultHref: '/analytics/definitions/metric/revenue_30d',
      selected: [
        { id: 'entity:customer', name: customer.name, description: customer.description, asOf: customer.stats.at },
        { id: 'metric:revenue_30d', name: metric.name, description: metric.description, asOf: '暂无快照' },
        { id: 'table:CRM/orders', name: table.name, description: table.description, asOf: table.stats?.at ?? '暂无快照' },
      ],
      assumptions: [{ text: '金额按下单时间统计', confirmed: true }, { text: '退款另算', confirmed: false }],
      request: { windowDays: 30, dimensions: ['order.amount'], population: '全部订单' },
      issues: [], questions: [],
    });

    // ?id= 读回：同一条 assistant 消息带一样的卡片，user 消息没有这个键
    const { conversation } = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(conversation.messages[0]).not.toHaveProperty('planCard');
    expect(conversation.messages[1].planCard).toEqual(first.planCard);

    // 只读分享给查看者：卡片按查看者自己的目录组装，源表条目只留 id、状态不是 valid、不出现源表名称与说明；
    // 看得到的实体与指标照常带名称
    expect((await post(client, { intent: 'share', conversationId: first.conversationId, email: 'viewer@acme.com' })).status).toBe(200);
    const shared = await (await peer.get(`/assistant?id=${first.conversationId}`)).json();
    const viewerCard: PlanCardView = shared.conversation.messages[1].planCard;
    expect(viewerCard.status).toBe('invalid');
    // 不是 valid 就不给现有结果的入口（#453）
    expect(viewerCard.resultHref).toBeUndefined();
    expect(viewerCard.issues.map(i => i.message)).toContain('选中的条目不在可见目录里（无权限、未发布或已停用）');
    expect(viewerCard.selected.find(s => s.id === 'table:CRM/orders')).toEqual({ id: 'table:CRM/orders' });
    expect(viewerCard.selected.find(s => s.id === 'metric:revenue_30d')?.name).toBe(metric.name);
    expect(JSON.stringify(viewerCard)).not.toContain(table.description);
    expect(JSON.stringify(viewerCard)).not.toContain('源表');

    // 卡片只读时组装、不写库：解密后的消息体仍存着 plan，但没有 planCard，也没有卡片才有的文字
    const [row] = await getDb().select().from(assistantConversations).where(eq(assistantConversations.tenantId, acme));
    const body = (await decryptForTenant(acme, ASSISTANT_CONTEXT, row.sealed)).body;
    expect(JSON.parse(body).messages[1].plan).toEqual(plan);
    expect(body).not.toContain('planCard');
    expect(body).not.toContain('暂无快照');
    expect(body).not.toContain('计划已通过校验');

    // 也不进发给模型的历史：续写一轮，这轮发给模型的历史里上一条 assistant 的 content 原样是答复正文，不带卡片
    const next = await (await post(client, { conversationId: first.conversationId, message: '好的', page: PAGE })).json();
    expect(next).toMatchObject({ reply: '收到' });
    const history = received[3].body.messages;
    const sent = JSON.stringify(history);
    expect(sent).not.toContain('暂无快照');
    expect(sent).not.toContain('planCard');
    expect(sent).not.toContain(customer.description);
    expect(history.find((m: { role: string }) => m.role === 'assistant')?.content).toBe('可以复用现有结果');
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

  it('计划卡的「排除了哪些口径」按读者的目录组装（#539）：主人读回两项都带名称；被分享的查看者看不到的源表只有原因，响应里不出现它的 id 与名称；带 excluded 的计划续写存草稿不报「计划已过期」', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources({ orders: true });
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const viewer = await memberOf(acme, 'viewer@acme.com', 'viewer');
    const client = await loginAs(app, 'analyst@acme.com');
    const peer = await loginAs(app, 'viewer@acme.com');
    const REVENUE_30D = 'base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: created_at, days: 30 }\n';
    await createDefinition(author, 'metric', 'revenue_30d', REVENUE_30D);
    await publishDefinition(reviewer, 'metric', 'revenue_30d', 1);
    const catalog = await catalogFor(analyst);
    const entry = (id: string) => {
      const e = catalog.entries.find(x => x.id === id);
      if (!e) throw new Error(`${id} 不在分析师目录里`);
      return e;
    };
    const [customer, metric, table] = ['entity:customer', 'metric:revenue_30d', 'table:CRM/orders'].map(entry);
    if (metric.kind !== 'metric') throw new Error('revenue_30d 不是指标');
    // selected 只有指标，excluded 带源表（查看者看不到）与消费者实体（查看者看得到）：三个 id 都要出现在 catalog_search 结果里
    const plan = {
      schemaVersion: 1, mode: 'reuse_result',
      selected: [{ id: 'metric:revenue_30d', version: metric.version, semanticHash: semanticHash(metric) }],
      request: { dimensions: [] },
      steps: [{ id: 's1', action: 'answer', inputs: ['metric:revenue_30d'] }],
      assumptions: [], questions: [],
      excluded: [
        { id: 'table:CRM/orders', reason: '原始订单表还要自己算口径，不如现成指标' },
        { id: 'entity:customer', reason: '消费者实体不带金额，回答用不着' },
      ],
    };
    const replies = [
      toolCalls({ name: 'catalog_search', args: { query: '订单金额' } }),
      toolCalls({ name: 'validate_plan', args: { plan } }),
      text('可以复用现有结果'),
      // 第二轮：不再检索校验，直接存草稿（走对话里最近一份计划重新校验）
      toolCalls({ name: 'save_definition_draft', args: { kind: 'metric', key: 'revenue_30d', yaml: REVENUE_30D } }),
      text('草稿已保存'),
    ];
    const { received } = fakeLlm(f => app.setLlmFetch(f), n => replies[n - 1]);
    const first = await (await post(client, { message: '统计近 30 天的订单金额', page: PAGE })).json();
    expect(first).toMatchObject({ reply: '可以复用现有结果', toolsUsed: ['catalog_search', 'validate_plan'] });
    // 主人的卡片：重新校验 valid（excluded 的 id 也算检索过），两项 excluded 都带 id 与名称
    expect(first.planCard.status).toBe('valid');
    expect(first.planCard.excluded).toEqual([
      { id: 'table:CRM/orders', name: table.name, reason: '原始订单表还要自己算口径，不如现成指标' },
      { id: 'entity:customer', name: customer.name, reason: '消费者实体不带金额，回答用不着' },
    ]);
    const own = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(own.conversation.messages[1].planCard.excluded).toEqual(first.planCard.excluded);
    expect(own.conversation.messages[1]).not.toHaveProperty('plan');

    // 只读分享给查看者：源表条目他看不到，excluded 里只有原因（id 与名称都不出现，id 自带数据源名）；
    // 看得到的实体照常带名称；excluded 不查可见目录，计划对他也是 valid
    expect((await post(client, { intent: 'share', conversationId: first.conversationId, email: 'viewer@acme.com' })).status).toBe(200);
    const shared = await (await peer.get(`/assistant?id=${first.conversationId}`)).json();
    const viewerCard: PlanCardView = shared.conversation.messages[1].planCard;
    expect(viewerCard.status).toBe('valid');
    expect(viewerCard.excluded).toEqual([
      { reason: '原始订单表还要自己算口径，不如现成指标' },
      { id: 'entity:customer', name: customer.name, reason: '消费者实体不带金额，回答用不着' },
    ]);
    expect(JSON.stringify(viewerCard)).not.toContain('table:CRM/orders');
    expect(JSON.stringify(shared)).not.toContain('table:CRM/orders');
    expect(JSON.stringify(viewerCard)).not.toContain(table.name);

    // 带 excluded 的计划存草稿（tools.ts 重新校验时 excluded 也算检索过）：不报「计划已过期」，草稿真的存下
    const second = await (await post(client, { conversationId: first.conversationId, message: '把它保存为草稿', page: PAGE })).json();
    expect(second).toMatchObject({ conversationId: first.conversationId, reply: '草稿已保存', toolsUsed: ['save_definition_draft'] });
    const tool = received[4].body.messages.filter((m: { role: string }) => m.role === 'tool').at(-1)!;
    expect(tool.content).toContain('已保存为草稿');
    expect(tool.content).not.toContain('计划已过期');
  });

  it('计划卡的 resultHref 只在重新校验通过时给：两次读取之间另一位成员发布了新版本，?id= 读回的卡片不是 valid、没有 resultHref（#453，ADR-0050）', async () => {
    const { acme, author, reviewer } = await publishedIdentitySources();
    const analyst = await memberOf(acme, 'analyst@acme.com', 'analyst');
    const client = await loginAs(app, 'analyst@acme.com');
    const COUNT_MEMBERS = 'base: customer\nmeasure: { agg: count }\n';
    await createDefinition(author, 'metric', 'member_total', COUNT_MEMBERS);
    await publishDefinition(reviewer, 'metric', 'member_total', 1);
    const entry = (await catalogFor(analyst)).entries.find(e => e.id === 'metric:member_total')!;
    if (entry.kind !== 'metric') throw new Error('member_total 发布后不在目录里');
    const plan = {
      schemaVersion: 1, mode: 'reuse_result',
      selected: [{ id: 'metric:member_total', version: entry.version, semanticHash: semanticHash(entry) }],
      request: { dimensions: [] },
      steps: [{ id: 's1', action: 'answer', inputs: ['metric:member_total'] }],
      assumptions: [], questions: [],
    };
    const replies = [
      toolCalls({ name: 'catalog_search', args: { query: '会员总数' } }),
      toolCalls({ name: 'validate_plan', args: { plan } }),
      text('可以复用现有结果'),
    ];
    fakeLlm(f => app.setLlmFetch(f), n => replies[n - 1]);
    // POST 返回的卡片按当时目录校验是 valid：链到所选指标（第一个有结果页的条目）的结果页
    const first = await (await post(client, { message: '统计会员总数', page: PAGE })).json();
    expect(first.planCard).toMatchObject({ status: 'valid', mode: 'reuse_result', resultHref: '/analytics/definitions/metric/member_total' });
    // 两次读取之间另一位成员存了第 2 版并发布：卡片读时重新校验不再通过，不给入口
    await saveDslDraft(author, 'metric', 'member_total', `# 换个说法\n${COUNT_MEMBERS}`);
    await publishDefinition(reviewer, 'metric', 'member_total', 2);
    const after = await (await client.get(`/assistant?id=${first.conversationId}`)).json();
    expect(after.conversation.messages[1].planCard.status).not.toBe('valid');
    expect(after.conversation.messages[1].planCard.resultHref).toBeUndefined();
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
