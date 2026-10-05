// 源视图的流水线接缝：同步到原始层 → createSourceView / saveSourceViewDraft 在只读挂载的数据湖上校验 SQL 并返回列与样本 →
// 只能读本数据源原始层的表；双人发布与丢弃
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { bronzeSchema } from '../../app/.server/pipeline/sync-engine';
import { syncSource } from '../../app/.server/source-sync';
import {
  createSourceView, discardSourceViewDraft, getSourceView, listSourceViews, previewSourceView, publishSourceView, saveSourceViewDraft,
} from '../../app/.server/source-views';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, selectAllTables } from './fixtures';
import { pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 两位数据工程师；登记电商库、选入全部表，确认 customers 与 orders 的水位线并同步一次 */
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

describe('源视图草稿', () => {
  it('保存后返回视图的列与前 20 行样本，像敏感信息的列是加盐哈希', async () => {
    const { author, id } = await syncedSource();
    const viewId = await createSourceView(author, id, { name: 'customer_orders', sql: CUSTOMER_ORDERS });
    const preview = await previewSourceView(author, id, viewId, 1);

    expect(preview.columns.map(c => c.name)).toEqual(['customer_id', 'name', 'email', 'city', 'orders', '_op', '_batch', '_commit_ts']);
    expect(preview.columns.filter(c => c.sensitive).map(c => c.name)).toEqual(['name', 'email']);
    expect(preview.columns.find(c => c.name === 'orders')!.type).toBe('BIGINT');
    expect(preview.rows).toHaveLength(20);
    expect(preview.rows[0].customer_id).toBe(1);
    expect(['北京', '上海', '广州', '深圳']).toContain(preview.rows[0].city);
    for (const r of preview.rows) {
      expect(String(r.name)).toMatch(/^[0-9a-f]{64}$/);
      if (r.email !== null) expect(String(r.email)).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(JSON.stringify(preview.rows)).not.toContain('@');

    const view = await getSourceView(author, id, viewId);
    expect(view.draft).toMatchObject({ version: 1, sql: CUSTOMER_ORDERS.trim().replace(/[;\s]+$/, ''), lastEditor: 'de@acme.com' });
    expect((await listSourceViews(author, id)).views).toEqual([{ id: viewId, name: 'customer_orders', published: null, draft: 1 }]);
  });

  it('只能读本数据源原始层的表：写入、标准层、结果层、其他数据源、表函数与不带平台列的视图都被拦下，什么也不保存', async () => {
    const { author, id } = await syncedSource();
    const other = bronzeSchema('00000000-0000-0000-0000-000000000001');
    const rejected: [string, RegExp][] = [
      ['DELETE FROM customers', /只能是一条 SELECT/],
      ['CREATE TABLE x AS SELECT * FROM customers', /只能是一条 SELECT/],
      ['SELECT * FROM customers; SELECT * FROM orders', /只能是一条 SELECT/],
      ['SELECT * FROM silver.customer', /不能读 silver\.customer/],
      ['SELECT * FROM customers WHERE customer_id IN (SELECT 1 FROM gold.rfm)', /不能读 gold\.rfm/],
      [`SELECT * FROM ${other}.customers`, new RegExp(`不能读 ${other}\\.customers`)],
      [`SELECT * FROM ${bronzeSchema(id)}_mirror.events`, /不能读/],
      ["SELECT * FROM read_parquet('/tmp/*.parquet')", /表函数 read_parquet/],
      ['SHOW TABLES', /SHOW/],
      // 内层 CTE 的名字在外层不可见：外层同名的引用不是 CTE，是系统视图
      ['SELECT * FROM (WITH duckdb_databases AS (SELECT 1) SELECT * FROM duckdb_databases) a, duckdb_databases', /原始层没有表 duckdb_databases/],
      [`SELECT * FROM lake.${bronzeSchema(id)}.customers`, /不能读 lake\./],
      ["SELECT getenv('HOME') AS h, _op, _batch, _commit_ts FROM customers", /函数 getenv/],
      ["SELECT current_setting('allowed_directories') AS s, _op, _batch, _commit_ts FROM customers", /函数 current_setting/],
      ['SELECT * FROM products', /原始层没有表 products/],
      ['SELECT customer_id, name FROM customers', /平台列 _op、_batch、_commit_ts/],
      ['SELECT * FROM customers WHERE no_such_column = 1', /源视图执行出错/],
      ['SELEC 1', /语法错误/],
    ];
    for (const [sql, message] of rejected) {
      const error = await createSourceView(author, id, { name: 'v', sql }).then(() => '已保存', (e: Error) => e.message);
      expect(error, sql).toMatch(message);
    }
    await expect(createSourceView(author, id, { name: 'Bad-Name', sql: CUSTOMER_ORDERS })).rejects.toThrow(/视图名/);
    expect((await listSourceViews(author, id)).views).toEqual([]);

    // 带本数据源原始层前缀的表名与 CTE 都可以
    const qualified = `WITH c AS (SELECT * FROM ${bronzeSchema(id)}.customers) SELECT customer_id, _op, _batch, _commit_ts FROM c`;
    const viewId = await createSourceView(author, id, { name: 'v', sql: qualified });
    await expect(saveSourceViewDraft(author, id, viewId, 'SELECT * FROM silver.customer')).rejects.toThrow(/不能读 silver\.customer/);
    expect((await getSourceView(author, id, viewId)).draft!.sql).toBe(qualified);
  });

  it('敏感列在原始层就换成哈希：改名、拼接、改成平台列的别名、类型转换报错都看不到明文', async () => {
    const { author, id } = await syncedSource();
    const viewId = await createSourceView(author, id, {
      name: 'disguised',
      sql: "SELECT customer_id, email || ' ' AS c1, name AS _e, concat('x:', phone) AS c2, struct_pack(m := email) AS c3, _op, _batch, _commit_ts FROM customers",
    });
    const preview = await previewSourceView(author, id, viewId, 1);
    expect(preview.columns.filter(c => c.sensitive).map(c => c.name)).toEqual(['c1', '_e', 'c2', 'c3']);
    for (const r of preview.rows) {
      for (const c of ['c1', '_e', 'c2', 'c3']) if (r[c] !== null) expect(String(r[c]), c).toMatch(/^[0-9a-f]{64}$/);
    }
    // 类型转换的报错里也只有哈希
    const error = await createSourceView(author, id, { name: 'cast', sql: 'SELECT email::INTEGER AS e, _op, _batch, _commit_ts FROM customers WHERE email IS NOT NULL' })
      .then(() => '已保存', (e: Error) => e.message);
    expect(error).toMatch(/源视图执行出错.*[0-9a-f]{64}/);
    expect(error).not.toContain('@');
  });
});

describe('源视图发布', () => {
  it('双人发布：最后保存的人发布不了，另一位发布后锁定；再改是新的一版草稿，丢弃回到已发布版本', async () => {
    const { author, reviewer, id } = await syncedSource();
    const viewId = await createSourceView(author, id, { name: 'customer_orders', sql: CUSTOMER_ORDERS });

    await expect(publishSourceView(author, id, viewId, 1)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('你最后改了这一版草稿') });
    await publishSourceView(reviewer, id, viewId, 1);
    await expect(publishSourceView(reviewer, id, viewId, 1)).rejects.toMatchObject({ status: 400, message: '已发布的版本已锁定' });
    expect((await getSourceView(author, id, viewId)).published).toMatchObject({ version: 1, publishedByEmail: 'de2@acme.com' });

    expect(await saveSourceViewDraft(reviewer, id, viewId, 'SELECT customer_id, city, _op, _batch, _commit_ts FROM customers')).toBe(2);
    // 作者也改过之后，最后保存的是作者，审核人可以发布
    expect(await saveSourceViewDraft(author, id, viewId, 'SELECT customer_id, city, _op, _batch, _commit_ts FROM customers WHERE city IS NOT NULL')).toBe(2);
    expect((await getSourceView(author, id, viewId)).draft).toMatchObject({ authors: ['de2@acme.com', 'de@acme.com'], lastEditor: 'de@acme.com' });
    expect(await discardSourceViewDraft(author, id, viewId)).toEqual({ kept: true });
    const view = await getSourceView(author, id, viewId);
    expect(view.draft).toBeNull();
    expect(view.versions.map(v => v.version)).toEqual([1]);
    expect((await listSourceViews(author, id)).views).toEqual([{ id: viewId, name: 'customer_orders', published: 1, draft: null }]);
  });

  it('丢弃从没发布过的源视图会删除它；分析师不能起草与发布', async () => {
    const { acme, author, id } = await syncedSource();
    const viewId = await createSourceView(author, id, { name: 'customer_orders', sql: CUSTOMER_ORDERS });
    const analyst = await memberOf(acme, 'an@acme.com', 'analyst');
    await expect(publishSourceView(analyst, id, viewId, 1)).rejects.toMatchObject({ init: { status: 403 } });
    await expect(saveSourceViewDraft(analyst, id, viewId, CUSTOMER_ORDERS)).rejects.toMatchObject({ init: { status: 403 } });

    expect(await discardSourceViewDraft(author, id, viewId)).toEqual({ kept: false });
    await expect(getSourceView(author, id, viewId)).rejects.toMatchObject({ status: 404 });
  });
});
