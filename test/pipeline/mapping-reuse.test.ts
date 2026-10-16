// test/pipeline/mapping-reuse.test.ts —— 复用已发布映射的流水线接缝（ADR-0034）：两个数据源登记同一套库并采集 → draftFor 按源表结构指纹找本租户已发布的映射
// → 命中时返回改写后的 YAML，不命中照常按规则生成；复用的草稿照常保存、空跑与双人发布
import { and, eq } from 'drizzle-orm';
import { parse } from 'yaml';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs } from '../../app/.server/db/schema';
import { createMapping, draftFor, dryRunMapping, MappingError, profiledTables, publishMapping } from '../../app/.server/mappings';
import { draftMapping } from '../../app/.server/pipeline/mapping-draft';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { entityOf } from '../../app/lib/canonical-model';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, publish, selectAllTables } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

const ORDERS = `# 门店订单
model: 1
entity: order
table: orders
fields:
  order_id: string(order_id)
  customer_id: string(customer_id)
  amount: amount # 元
  status: { expr: status, dictionary: { paid: paid, refunded: refunded } }
  created_at: created_at
`;

/** 和 shop.orders 只差一处的表：多一列、少一列、改类型、没有主键 */
const VARIANTS = `
  CREATE TABLE shop.orders_more (order_id bigint PRIMARY KEY, customer_id int NOT NULL, amount numeric(10, 2) NOT NULL, status text NOT NULL, created_at timestamp NOT NULL, note text);
  CREATE TABLE shop.orders_less (order_id bigint PRIMARY KEY, customer_id int NOT NULL, amount numeric(10, 2) NOT NULL, created_at timestamp NOT NULL);
  CREATE TABLE shop.orders_typed (order_id bigint PRIMARY KEY, customer_id int NOT NULL, amount numeric(12, 2) NOT NULL, status text NOT NULL, created_at timestamp NOT NULL);
  CREATE TABLE shop.orders_nokey (order_id bigint NOT NULL, customer_id int NOT NULL, amount numeric(10, 2) NOT NULL, status text NOT NULL, created_at timestamp NOT NULL);
  GRANT SELECT ON ALL TABLES IN SCHEMA shop TO ${READER.user};
`;

/** 在租户里登记一个指向电商库的数据源，选入全部表并采集完 */
async function addSource(member: Awaited<ReturnType<typeof memberOf>>, name: string, extra = '') {
  const input = await pgSourceInput(READER, name);
  if (extra) await grantOnSource(extra);
  const { id } = await registerSource(member, input);
  await selectAllTables(member, id);
  await drain();
  return id;
}

/** acme 的门店1 发布了 shop.orders → order，再登记同一套库的门店2（extra 是门店2 登记前在源库里多建的表） */
async function twoShops(extra = '') {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const shop1 = await addSource(author, '门店1');
  const mappingId = await publish(author, reviewer, shop1, ORDERS);
  const shop2 = await addSource(author, '门店2', extra);
  return { acme, author, reviewer, shop1, shop2, mappingId };
}

const REUSED = /^# 复用已发布映射/;
const RULES = /^# 按规则生成的草稿/;

describe('复用已发布映射', () => {
  it('新登记的源表结构与已发布映射的源表一致时，草稿直接复用那个映射并注明来源映射与版本', async () => {
    const { author, shop1, shop2, mappingId } = await twoShops();
    const yaml = await draftFor(author, shop2, 'orders', 'order');
    expect(yaml).toContain(`# 复用已发布映射 ${mappingId}（数据源「门店1」/ orders，第 1 版）：源表结构指纹一致`);
    expect(yaml).toContain('# 门店订单');
    expect(parse(yaml).fields).toEqual(parse(ORDERS).fields);
    // 实体不同、源表就是来源映射自己的表时不复用
    expect(await draftFor(author, shop2, 'orders', 'customer')).toMatch(RULES);
    expect(await draftFor(author, shop1, 'orders', 'order')).toMatch(RULES);
  });

  it('结构不一致（多列、少列、类型不同、主键不同）时照常按规则生成；别的租户的映射不复用', async () => {
    const { author, shop2 } = await twoShops(VARIANTS);
    for (const table of ['orders_more', 'orders_less', 'orders_typed', 'orders_nokey']) {
      const profiled = (await profiledTables(author.tenant.id, shop2))(table);
      if (typeof profiled === 'string') throw new Error(profiled);
      expect(await draftFor(author, shop2, table, 'order'), table).toBe(draftMapping(profiled.table, entityOf('order')!, { key: profiled.key ?? undefined }));
    }

    // acme 已发布了结构一致的映射，另一个租户登记同一套库时不复用
    const beta = await newTenant('beta');
    const betaAuthor = await memberOf(beta, 'de@beta.com');
    expect(await draftFor(betaAuthor, await addSource(betaAuthor, '门店1'), 'orders', 'order')).toMatch(RULES);
  });

  it('复用的草稿照常保存为成员的草稿、空跑，保存的人不能发布、另一位能发布', async () => {
    const { acme, author, reviewer, shop2 } = await twoShops();
    const mapping = await createMapping(author, shop2, await draftFor(author, shop2, 'orders', 'order'));
    const [audit] = await getDb().select().from(auditLogs)
      .where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, 'mapping.drafted'), eq(auditLogs.targetId, mapping.id)));
    expect(audit).toMatchObject({ actorType: 'member', actorEmail: author.email, detail: expect.objectContaining({ source: '门店2', table: 'orders' }) });

    await confirmWatermark(author, shop2, 'orders', 'order_id');
    await syncSource(author, shop2);
    await drain();
    const dry = await dryRunMapping(author, mapping.id, 1);
    expect(dry.rows).toHaveLength(50);

    await expect(publishMapping(author, mapping.id, 1)).rejects.toBeInstanceOf(MappingError);
    await expect(publishMapping(reviewer, mapping.id, 1)).resolves.not.toThrow();
  });
});
