// test/pipeline/source-comments.test.ts —— 表注释与列注释的采集（#522）：登记 / 重新列出表 → platform.source_comments 里的定位、版本与消失时间
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { sourceComments } from '../../app/.server/db/schema';
import { relistSource, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';
import { grantOnSource, pgSourceInput, READER, seedMysqlSource } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

/** 已保存的注释按定位排序：表注释是 `schema.table`，列注释是 `schema.table.column` */
async function savedComments(sourceId: string) {
  const rows = await getDb().select().from(sourceComments).where(eq(sourceComments.sourceId, sourceId));
  return rows
    .sort((a, b) => (`${a.tableName}.${a.columnName}` < `${b.tableName}.${b.columnName}` ? -1 : 1))
    .map(r => ({ at: `${r.tableSchema}.${r.tableName}${r.columnName ? `.${r.columnName}` : ''}`, text: r.commentText }));
}

describe('PostgreSQL 表注释与列注释', () => {
  it('登记时采到 COMMENT ON TABLE / COLUMN：带 schema、表、列定位与采集时间；只采 spec.schema 里有读权限的表', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const input = await pgSourceInput(READER);
    await grantOnSource(`
      COMMENT ON TABLE shop.customers IS '消费者表';
      COMMENT ON COLUMN shop.customers.email IS '邮箱';
      COMMENT ON COLUMN shop.orders.amount IS '金额';
      COMMENT ON TABLE shop.events IS '埋点表';
      REVOKE SELECT ON shop.events FROM ${READER.user};
      DROP SCHEMA IF EXISTS other CASCADE;
      CREATE SCHEMA other;
      CREATE TABLE other.settings (id int);
      COMMENT ON TABLE other.settings IS '不在 spec.schema 里';`);
    const { id } = await registerSource(engineer, input);

    const saved = await savedComments(id);
    expect(saved).toEqual([
      { at: 'shop.customers', text: '消费者表' },
      { at: 'shop.customers.email', text: '邮箱' },
      { at: 'shop.orders.amount', text: '金额' },
    ]);
    const rows = await getDb().select().from(sourceComments).where(eq(sourceComments.sourceId, id));
    expect(rows.every(r => r.version === 1 && !r.goneAt && r.collectedAt instanceof Date)).toBe(true);
  });

  it('重新列出表：原文没变版本不变，变了 +1；注释删掉的行记消失时间，同原文回来时清掉且版本不变', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const input = await pgSourceInput(READER);
    await grantOnSource(`COMMENT ON TABLE shop.regions IS '第一版'`);
    const { id } = await registerSource(engineer, input);
    const rows = async () => getDb().select().from(sourceComments).where(eq(sourceComments.sourceId, id));
    expect((await rows()).map(r => [r.commentText, r.version, r.goneAt])).toEqual([['第一版', 1, null]]);

    await relistSource(engineer, id); // 原文没变
    expect((await rows()).map(r => [r.commentText, r.version])).toEqual([['第一版', 1]]);

    await grantOnSource(`COMMENT ON TABLE shop.regions IS '第二版'`);
    await relistSource(engineer, id); // 原文变了
    expect((await rows()).map(r => [r.commentText, r.version, r.goneAt])).toEqual([['第二版', 2, null]]);

    await grantOnSource(`COMMENT ON TABLE shop.regions IS NULL`); // 源端删掉注释
    await relistSource(engineer, id);
    const [gone] = await rows();
    expect([gone.commentText, gone.version, gone.goneAt instanceof Date]).toEqual(['第二版', 2, true]);

    await grantOnSource(`COMMENT ON TABLE shop.regions IS '第二版'`); // 同原文回来
    await relistSource(engineer, id);
    expect((await rows()).map(r => [r.commentText, r.version, r.goneAt])).toEqual([['第二版', 2, null]]);
  });

  it('原文截断到 2000 字；单源最多 5000 条，按表、列的顺序保留', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const input = await pgSourceInput(READER);
    const columns = (n: number) => Array.from({ length: n }, (_, i) => `c${i} int`).join(', ');
    const commentAll = (table: string, n: number) =>
      Array.from({ length: n }, (_, i) => `COMMENT ON COLUMN shop.${table}.c${i} IS '注';`).join('');
    // 4 张表各 1251 个带注释的列，加上 regions 的长表注释、regions.code 的列注释共 5006 条：regions 排最前，随后是 zcap0…zcap3 的列注释
    // regions.code 的第 2000 个字是 emoji（UTF-16 里占两个码元），按字截断时整个保留，不留半个代理对
    await grantOnSource(`
      COMMENT ON TABLE shop.regions IS '${'长'.repeat(2500)}';
      COMMENT ON COLUMN shop.regions.code IS '${'长'.repeat(1999)}😀尾';
      CREATE TABLE shop.zcap0 (${columns(1251)}); CREATE TABLE shop.zcap1 (${columns(1251)});
      CREATE TABLE shop.zcap2 (${columns(1251)}); CREATE TABLE shop.zcap3 (${columns(1251)});
      GRANT SELECT ON ALL TABLES IN SCHEMA shop TO ${READER.user};
      ${commentAll('zcap0', 1251)}${commentAll('zcap1', 1251)}${commentAll('zcap2', 1251)}${commentAll('zcap3', 1251)}`);
    const { id } = await registerSource(engineer, input);

    const saved = await savedComments(id);
    expect(saved.length).toBe(5000);
    expect(saved.filter(c => c.at === 'shop.regions').map(c => c.text)).toEqual(['长'.repeat(2000)]);
    expect(saved.filter(c => c.at === 'shop.regions.code').map(c => c.text)).toEqual(['长'.repeat(1999) + '😀']);
    expect(saved.filter(c => c.at.startsWith('shop.zcap')).length).toBe(4998);
  });
});

describe.skipIf(!process.env.TEST_MYSQL_URL)('MySQL 表注释与列注释', () => {
  it('登记时采到 TABLE_COMMENT / COLUMN_COMMENT；空串视为没有注释；视图的 TABLE_COMMENT（固定为 VIEW）不算注释', async () => {
    const acme = await newTenant('acme');
    const engineer = await memberOf(acme, 'de@acme.com');
    const base = await seedMysqlSource({ withView: true });
    const { id } = await registerSource(engineer, { ...base, name: '订单库', ...READER });
    // orders_v 没有表注释；它的 order_id 列注释继承自基表 orders.order_id，是真注释，照样采
    expect(await savedComments(id)).toEqual([
      { at: `${base.database}.orders`, text: '订单表' },
      { at: `${base.database}.orders.order_id`, text: '订单号' },
      { at: `${base.database}.orders_v.order_id`, text: '订单号' },
    ]);
  });
});
