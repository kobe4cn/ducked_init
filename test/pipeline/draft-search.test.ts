// test/pipeline/draft-search.test.ts —— 起草检索（#827 之一）的接缝：modelDraftForDefinition / draftSearch → rankedSearch（租户 hybrid_search
// 开关带向量一路，ADR-0049）+ judgeAmbiguity（歧义与词的默认指向，ADR-0056）。开混合时只靠向量命中的指标进起草上下文、关着时不进且照常起草；
// 两个指标挂同一个别名时结果带歧义提示；设默认指向后不再提示、默认条目排第一
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftSearch } from '../../app/.server/catalog/draft-search';
import { ensureEmbeddings } from '../../app/.server/catalog/embeddings';
import { currentCatalogVersion } from '../../app/.server/catalog/versions';
import { projectionVersion, refreshProjection } from '../../app/.server/catalog/projection';
import { closeDb, getDb } from '../../app/.server/db/client';
import { catalogEmbeddings, catalogProjection, tasks, tenants } from '../../app/.server/db/schema';
import { createDefinition, modelDraftForDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { publishedIdentitySources } from './identity-fixtures';
import { addAlias } from '../../app/.server/knowledge/aliases';
import { acceptProposal, proposeKnowledge } from '../../app/.server/knowledge/proposals';
import { setLlmFetch } from '../../app/.server/llm';
import { SEARCH_LIMIT } from '../../app/.server/pipeline/dsl/model-draft';
import { resetDb } from '../http/harness';
import { drain, memberOf, newTenant } from './fixtures';
import { embeddings, fakeLlm, json, platformDefault, platformEmbedding, type LlmBody, type LlmRequest } from './llm-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setLlmFetch(undefined); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** 只靠向量命中的查询；MARK 只出现在目标指标的说明里——关键词分不出它们，假向量让两者同向、其余正交 */
const QUERY = '顾客流失风险';
const MARK = '不再复购';
const CHURN = `base: order\nmeasure: { agg: count }\ndescription: 未来 90 天内${MARK}的倾向打分\n`;

/** 知识提案的生成器版本（照 catalog-projection.test.ts 的用法，内容不重要） */
const GEN = 'test-gen-1';

/** 假向量按文本内容决定：查询与含 MARK 的文本同向 [1,0]，其余正交 [0,1]（维度一致，余弦可比） */
const vec = (t: string): number[] => t === QUERY || t.includes(MARK) ? [1, 0] : [0, 1];

/** 模型对任何起草需求的回答：一个能过指标校验的最简定义 */
const MODEL_DRAFT = { base: 'order', measure: { agg: 'count' } };

/** drain 之后该有的向量缓存（照 catalog-hybrid.test.ts 的 assertEmbeddingsComplete）：投影的每个文本哈希都有向量，缺了就在报错里列出诊断 */
async function assertEmbeddingsComplete(tenantId: string) {
  const db = getDb();
  const rows = await db.select({ entryId: catalogProjection.entryId, textHash: catalogProjection.textHash })
    .from(catalogProjection).where(eq(catalogProjection.tenantId, tenantId));
  const existing = new Set((await db.select({ textHash: catalogEmbeddings.textHash }).from(catalogEmbeddings)
    .where(and(eq(catalogEmbeddings.tenantId, tenantId), eq(catalogEmbeddings.modelId, 'text-embedding-v3'))))
    .map(v => v.textHash));
  const missing = rows.filter(r => !existing.has(r.textHash));
  if (!missing.length) return;
  const allTasks = await db.select({ kind: tasks.kind, status: tasks.status }).from(tasks).where(eq(tasks.tenantId, tenantId));
  const diag = `起草检索的向量缓存不全`
    + `；缺向量的投影行 ${missing.map(r => `${r.entryId}/${r.textHash.slice(0, 8)}`).join(' ')}`
    + `；租户全部任务 ${allTasks.map(t => `${t.kind}/${t.status}`).join(' ') || '(无)'}`
    + `；投影版本 ${await projectionVersion(db, tenantId)}`
    + `；当前目录版本 ${await currentCatalogVersion(db, tenantId)}`;
  expect(missing, diag).toEqual([]);
}

/** 开通租户、发布只靠向量命中的指标、建投影、配平台 chat 与 embedding 并 drain 补齐向量缓存（assertEmbeddingsComplete 把缓存齐全钉住） */
async function vectorReady() {
  const acme = await newTenant('acme');
  const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
  const reviewer = await memberOf(acme, 'rv@acme.com', 'data_engineer');
  await createDefinition(analyst, 'metric', 'churn_forecast', CHURN);
  await publishDefinition(reviewer, 'metric', 'churn_forecast', 1);
  await refreshProjection(acme);
  platformDefault();
  platformEmbedding();
  // 假 fetch 按请求体分岔：embedding 请求（带 input）按 vec 答向量，chat 请求答一份能过校验的草稿
  const { received } = fakeLlm(setLlmFetch, (_n, body: LlmBody) => 'input' in body
    ? embeddings((body.input as string[]).map(t => vec(t)), { prompt_tokens: 3 })
    : json(MODEL_DRAFT));
  await ensureEmbeddings(acme);
  await drain();
  await assertEmbeddingsComplete(acme);
  return { acme, analyst, received };
}

/** 假 fetch 收到的 chat 请求（不带 input 的那次），messages 里就是发给模型的起草上下文 */
const chatOf = (received: LlmRequest[]) => received.filter(r => !('input' in r.body));

/** 最后一次 chat 请求的检索段（「# 与需求相关的条目」与「# 需求」之间）：起草上下文里由检索决定的那部分——
 *  小租户的分层目录放得下全部分组，条目标识也可能经组内列表出现，区分开 / 关只能看检索段 */
const searchSection = (received: LlmRequest[]) => {
  const user = chatOf(received).at(-1)!.body.messages.at(-1)!;
  return (user.content as string).split('# 与需求相关的条目')[1]!.split('# 需求')[0];
};

/** 身份打通数据源，加一位分析师、一位审核人 */
async function setup() {
  const s = await publishedIdentitySources({ orders: true });
  const analyst = await memberOf(s.acme, 'an@acme.com', 'analyst');
  const reviewer = await memberOf(s.acme, 'rv@acme.com', 'data_engineer');
  return { ...s, analyst, reviewer };
}

describe('起草检索', () => {
  it('租户开了 hybrid_search 时，只靠向量命中的指标进起草上下文；关着时不进，且起草照常不失败', async () => {
    const { acme, analyst, received } = await vectorReady();

    // 开着：先为查询发一次 embedding 请求，发给模型的检索段里有那个只靠向量命中的指标
    await getDb().update(tenants).set({ hybridSearch: true }).where(eq(tenants.id, acme));
    const on = await modelDraftForDefinition(analyst, 'metric', QUERY);
    expect(on.yaml).toContain('# 模型根据需求生成，请核对');
    expect(received.some(r => 'input' in r.body && (r.body.input as string[]).includes(QUERY))).toBe(true);
    expect(searchSection(received)).toContain('## metric:churn_forecast');

    // 关掉：关键词各路命不中它（只命中能力条目，不占名额），检索段为空，也不再发 embedding 请求；草稿照常生成
    const callsBefore = received.length;
    await getDb().update(tenants).set({ hybridSearch: false }).where(eq(tenants.id, acme));
    const off = await modelDraftForDefinition(analyst, 'metric', QUERY);
    expect(off.yaml).toContain('# 模型根据需求生成，请核对');
    expect(searchSection(received)).toContain('没有找到相关条目');
    expect(received.slice(callsBefore).every(r => !('input' in r.body))).toBe(true); // 只有一次 chat，没有 embedding
  });

  it('两个指标挂同一个别名：检索带歧义提示（词与两个候选的标识、名称，不带口径取值）；设默认指向后不再提示，默认条目排第一', async () => {
    const { acme, analyst, reviewer } = await setup();
    const windowed = (field: string) => `base: order\nmeasure: { agg: sum, field: amount }\nwindow: { field: ${field}, days: 30 }\n`;
    for (const [key, field] of [['revenue_365d', 'created_at'], ['gmv_365d', 'paid_at']] as const) {
      await createDefinition(analyst, 'metric', key, windowed(field));
      await publishDefinition(reviewer, 'metric', key, 1);
      await addAlias(analyst, { targetId: `metric:${key}`, alias: '营收' });
    }

    // 本来要追问：歧义提示带词与两个候选（指标的名称就是键），不放口径取值
    const ambiguous = await draftSearch(analyst, '营收', SEARCH_LIMIT);
    const group = ambiguous.ambiguity?.groups[0]!;
    expect(group?.term).toBe('营收');
    expect(group.candidates.map(c => c.id).sort()).toEqual(['metric:gmv_365d', 'metric:revenue_365d']);
    expect(group.candidates.every(c => c.name === c.id.replace(/^metric:/, ''))).toBe(true);
    expect(JSON.stringify(ambiguous.ambiguity)).not.toContain('diffs');

    // 接受「营收 → revenue_365d」的默认指向后：不再歧义，默认条目排第一，两个候选都还在前两名
    const proposal = (await getDb().transaction(tx => proposeKnowledge(tx, acme, {
      targetId: 'metric:revenue_365d', kind: 'term_default', content: { term: '营收' },
      evidence: [{ ref: 'metric:revenue_365d', version: 1 }], generatorVersion: GEN,
    })))!;
    await acceptProposal(analyst, proposal.id);
    const settled = await draftSearch(analyst, '营收', SEARCH_LIMIT);
    expect(settled.ambiguity).toBe(null);
    expect(settled.entries[0]!.id).toBe('metric:revenue_365d');
    expect(settled.entries.slice(0, 2).map(e => e.id).sort()).toEqual(['metric:gmv_365d', 'metric:revenue_365d']);
  });
});
