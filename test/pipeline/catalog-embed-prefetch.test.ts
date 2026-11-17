// test/pipeline/catalog-embed-prefetch.test.ts —— 目录改动后提前补算检索向量（#824，ADR-0047 / 0049 / 0054）的接缝：
// 成员改动经 catalogTx 记下新版本、事务提交后 prefetchEmbeddings（开了混合检索且配了 embedding 端点的租户）→ refreshProjection
// （改动少时同步刷新，不排 catalog.projection）→ ensureEmbeddings 去重排一个 catalog.embed；
// 没开混合检索或没配端点的租户不排任务、不刷投影；drain 后向量覆盖全部投影哈希，之后的混合检索不再触发补算
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveBusinessNote } from '../../app/.server/business-notes';
import { ensureEmbeddings } from '../../app/.server/catalog/embeddings';
import { tenantCatalog } from '../../app/.server/catalog/load';
import { projectionVersion, rankedSearch, refreshProjection } from '../../app/.server/catalog/projection';
import { currentCatalogVersion } from '../../app/.server/catalog/versions';
import { closeDb, getDb } from '../../app/.server/db/client';
import { catalogEmbeddings, catalogProjection, tasks, tenants } from '../../app/.server/db/schema';
import { setLlmFetch } from '../../app/.server/llm';
import { resetDb } from '../http/harness';
import { drain, memberOf, newTenant } from './fixtures';
import { embeddings, fakeLlm, platformEmbedding, type LlmBody } from './llm-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => { setLlmFetch(undefined); vi.unstubAllEnvs(); });

/** 开通租户并同步建投影（新租户的目录有规范实体等条目，两类投影的文字相同） */
async function setup(slug: string) {
  const tenantId = await newTenant(slug);
  await refreshProjection(tenantId);
  return tenantId;
}

/** 每条文本的假向量由内容决定（[文本长度, 0.5]），与分批、排序无关 */
const byLength = (_n: number, body: LlmBody) => embeddings(body.input.map((t: string) => [t.length, 0.5]), { prompt_tokens: 7 });

/** 本租户的 catalog.embed 任务 */
const embedTasks = (tenantId: string) =>
  getDb().select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'catalog.embed')));

/** 本租户的 catalog.projection 与 catalog.embed 任务 */
const catalogTasks = (tenantId: string) =>
  getDb().select().from(tasks).where(and(eq(tasks.tenantId, tenantId), inArray(tasks.kind, ['catalog.projection', 'catalog.embed'])));

describe('目录改动后提前补算检索向量', () => {
  it('开了混合检索且配了 embedding 的租户，catalogTx 记下新版本后去重排一个 catalog.embed（改动少时不排 catalog.projection）；drain 后向量覆盖全部投影哈希，再混合检索不再触发补算；没开混合检索的租户同样改动不排任务', async () => {
    const acme = await setup('acme');
    const beta = await setup('beta');
    // 只有 acme 打开混合检索（直接改库即可，开关入口的 HTTP 行为由 ops / model-provider 测试覆盖）
    await getDb().update(tenants).set({ hybridSearch: true }).where(eq(tenants.id, acme));
    platformEmbedding();
    fakeLlm(setLlmFetch, byLength);
    await drain(); // 清掉开通租户时排的任务
    await ensureEmbeddings(acme); // 先把 acme 的投影与向量补齐，记下任务数
    await drain();
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded']);

    const acmeActor = await memberOf(acme, 'an@acme.com', 'analyst');
    const betaActor = await memberOf(beta, 'an@beta.com', 'analyst');
    await saveBusinessNote(acmeActor, { targetId: 'entity:order', note: '订单是客户下单的一次结账 #824' });
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded', 'queued']); // 提前排上了一个
    expect((await catalogTasks(acme)).filter(t => t.kind === 'catalog.projection')).toHaveLength(0); // 改动少：同步刷新，不排 catalog.projection

    // 再改一条：已有同类任务排队时不重复排
    await saveBusinessNote(acmeActor, { targetId: 'entity:order', note: '订单是客户下单的一次结账（v2）' });
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded', 'queued']);

    // 没开混合检索的租户（同样配着平台端点）不排任何补算任务
    await saveBusinessNote(betaActor, { targetId: 'entity:order', note: '同样改动' });
    expect(await catalogTasks(beta)).toHaveLength(0);

    await drain();
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded', 'succeeded']);
    // 向量覆盖了改动后的全部检索文字哈希
    const hashes = (await getDb().selectDistinct({ textHash: catalogProjection.textHash })
      .from(catalogProjection).where(eq(catalogProjection.tenantId, acme)))
      .map(r => r.textHash).sort();
    const embedded = (await getDb().select({ textHash: catalogEmbeddings.textHash }).from(catalogEmbeddings)
      .where(and(eq(catalogEmbeddings.tenantId, acme), eq(catalogEmbeddings.modelId, 'text-embedding-v3'))))
      .map(r => r.textHash).sort();
    expect(hashes.length).toBeGreaterThan(0);
    expect(embedded).toEqual(hashes);

    // 之后的一次混合检索不再触发补算
    const c = await tenantCatalog(acme);
    const hybrid = await rankedSearch(acme, 'full', c, '订单', {}, 20, { hybrid: true });
    expect(hybrid.fallback).toBe(false);
    expect((await embedTasks(acme)).map(t => t.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('没配 embedding 端点时开着混合检索改目录也不排任务、不刷投影、不发模型请求', async () => {
    const acme = await setup('acme');
    await getDb().update(tenants).set({ hybridSearch: true }).where(eq(tenants.id, acme));
    const { received } = fakeLlm(setLlmFetch, byLength);
    await drain();

    const actor = await memberOf(acme, 'an@acme.com', 'analyst');
    const projectionBefore = await projectionVersion(getDb(), acme);
    await saveBusinessNote(actor, { targetId: 'entity:order', note: '没有端点时的说明' });
    expect(await currentCatalogVersion(getDb(), acme)).toBeGreaterThan(projectionBefore!); // 版本确实记了
    expect(await projectionVersion(getDb(), acme)).toBe(projectionBefore); // 不刷投影
    expect(await catalogTasks(acme)).toHaveLength(0); // 不排任务
    expect(received).toHaveLength(0); // 不发模型请求
  });
});
