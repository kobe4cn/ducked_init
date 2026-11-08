// 可发布项发布流程（ADR-0051）的流水线接缝：保存草稿、发布、丢弃在 publishing.ts 一处，用 sourceViewAdapter 做被测适配器 ——
// 双人发布、丢弃回到已发布版本或连父行删、等锁期间的过期检查、审计在发布后动作之后才写。权限与各可发布项自己的校验在各自入口的测试里
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tx } from '../../app/.server/audit';
import { closeDb, getDb, type Db } from '../../app/.server/db/client';
import { auditLogs, sourceViews, sourceViewVersions } from '../../app/.server/db/schema';
import { discard, publish, PublishError, saveDraft } from '../../app/.server/publishing';
import { syncSource } from '../../app/.server/source-sync';
import {
  createSourceView, getSourceView, listSourceViews, publishSourceView, saveSourceViewDraft, sourceViewAdapter, sourceViewCtx, type SourceViewCtx,
} from '../../app/.server/source-views';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { drain, memberOf, newTenant, selectAllTables } from './fixtures';
import { pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

/** 两位数据工程师；登记电商库、选入全部表，确认 customers 与 orders 的水位线并同步一次（同 source-views.test.ts） */
async function syncedSource() {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const { id } = await registerSource(author, await pgSourceInput(READER));
  await selectAllTables(author, id);
  await drain();
  await confirmWatermark(author, id, 'customers', 'updated_at');
  await confirmWatermark(author, id, 'orders', 'order_id');
  await syncSource(author, id);
  await drain();
  return { acme, author, reviewer, id };
}

/** 每个客户的订单数与金额，带出 customers 的平台列 */
const CUSTOMER_ORDERS = `SELECT c.customer_id, c.name, c.email, c.city, count(o.order_id) AS orders, c._op, c._batch, c._commit_ts
FROM customers c LEFT JOIN orders o ON o.customer_id = c.customer_id
GROUP BY ALL
ORDER BY c.customer_id -- 按客户排序
;`;
const CITY_ONLY = 'SELECT customer_id, city, _op, _batch, _commit_ts FROM customers';
const CITY_NOT_NULL = 'SELECT customer_id, city, _op, _batch, _commit_ts FROM customers WHERE city IS NOT NULL';

describe('可发布项的发布流程', () => {
  it('双人发布：最后保存的人发布不了，另一位发布后锁定；再改是新的一版草稿，丢弃回到已发布版本', async () => {
    const { author, reviewer, id } = await syncedSource();
    const viewId = await createSourceView(author, id, { name: 'customer_orders', sql: CUSTOMER_ORDERS });
    const ctx = await sourceViewCtx(author, id, viewId);

    await expect(publish(sourceViewAdapter, author, ctx, 1)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('你最后改了这一版草稿') });
    // 没有基于它的映射时不入队，发布返回 null
    await expect(publish(sourceViewAdapter, reviewer, ctx, 1)).resolves.toBe(null);
    await expect(publish(sourceViewAdapter, reviewer, ctx, 1)).rejects.toMatchObject({ status: 400, message: '已发布的版本已锁定' });
    expect((await getSourceView(author, id, viewId)).published).toMatchObject({ version: 1, publishedByEmail: 'de2@acme.com' });

    expect(await saveDraft(sourceViewAdapter, reviewer, ctx, CITY_ONLY)).toBe(2);
    // 作者也改过之后，最后保存的是作者，审核人可以发布
    expect(await saveDraft(sourceViewAdapter, author, ctx, CITY_NOT_NULL)).toBe(2);
    expect((await getSourceView(author, id, viewId)).draft).toMatchObject({ authors: ['de2@acme.com', 'de@acme.com'], lastEditor: 'de@acme.com' });
    await expect(discard(sourceViewAdapter, author, ctx)).resolves.toEqual({ kept: true });
    const view = await getSourceView(author, id, viewId);
    expect(view.draft).toBeNull();
    expect(view.versions.map(v => v.version)).toEqual([1]);
    expect((await listSourceViews(author, id)).views).toEqual([{ id: viewId, name: 'customer_orders', published: 1, draft: null }]);
  });

  it('丢弃从没发布过的可发布项会连父行一起删；权限在各入口上查，分析师不能起草与发布', async () => {
    const { acme, author, id } = await syncedSource();
    const viewId = await createSourceView(author, id, { name: 'customer_orders', sql: CUSTOMER_ORDERS });
    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    await expect(publishSourceView(analyst, id, viewId, 1)).rejects.toMatchObject({ init: { status: 403 } });
    await expect(saveSourceViewDraft(analyst, id, viewId, CUSTOMER_ORDERS)).rejects.toMatchObject({ init: { status: 403 } });

    await expect(discard(sourceViewAdapter, author, await sourceViewCtx(author, id, viewId))).resolves.toEqual({ kept: false });
    await expect(getSourceView(author, id, viewId)).rejects.toMatchObject({ status: 404 });
  });

  it('发布等锁期间草稿被他人修改时，发布被拒绝并提示刷新', async () => {
    const { author, reviewer, id } = await syncedSource();
    const viewId = await createSourceView(author, id, { name: 'customer_orders', sql: CUSTOMER_ORDERS });
    const ctx = await sourceViewCtx(reviewer, id, viewId);
    let publishing!: Promise<unknown>;
    await getDb().transaction(async tx => {
      await tx.select({ id: sourceViews.id }).from(sourceViews).where(eq(sourceViews.id, viewId)).for('update');
      publishing = publish(sourceViewAdapter, reviewer, ctx, 1).then(() => null, (e: unknown) => e);
      // 等发布阻塞在源视图行的锁上，再像别人保存草稿那样改掉 updatedAt
      for (let i = 0; i < 100; i++) {
        const { rows } = await getDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
        if (rows[0].n > 0) break;
        await new Promise(r => setTimeout(r, 50));
      }
      await tx.update(sourceViewVersions).set({ updatedAt: new Date() }).where(eq(sourceViewVersions.viewId, viewId));
    });
    // 提交后发布才拿到锁，重新读出的草稿与检查时不同
    const error = await publishing;
    expect(error).toBeInstanceOf(PublishError);
    expect((error as PublishError).status).toBe(400);
    expect((error as PublishError).message).toMatch(/请刷新/);
  });

  it('审计在发布后动作（入队）之后才写', async () => {
    const { author, reviewer, id } = await syncedSource();
    const viewId = await createSourceView(author, id, { name: 'customer_orders', sql: CUSTOMER_ORDERS });
    const ctx = await sourceViewCtx(reviewer, id, viewId);
    const countPublished = async (db: Tx | Db) => (await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs)
      .where(and(eq(auditLogs.tenantId, ctx.tenantId), eq(auditLogs.action, 'source_view.published'), eq(auditLogs.targetId, ctx.parentId))))[0].n;
    let duringAfterPublish = -1;
    // 包一层 afterPublish：它运行时（入队前后）这一条发布审计还没有写
    const probed: typeof sourceViewAdapter = {
      ...sourceViewAdapter,
      afterPublish: async (tx, draft, viewCtx) => {
        duringAfterPublish = await countPublished(tx);
        return sourceViewAdapter.afterPublish!(tx, draft, viewCtx, undefined);
      },
    };
    await publish(probed, reviewer, ctx, 1);
    expect(duringAfterPublish).toBe(0);
    expect(await countPublished(getDb())).toBe(1);
  });
});
