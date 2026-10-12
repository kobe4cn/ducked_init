// test/pipeline/source-drift.test.ts —— 映射源表列差异的流水线接缝：发布映射 → 源表加列 / 删列 → relistSource 重新采集 → mappingDrift 对比发布时的采集与最近一次采集
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CurrentMember } from '../../app/.server/auth';
import { closeDb } from '../../app/.server/db/client';
import { saveDraft } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { syncSource } from '../../app/.server/source-sync';
import { mappingDrift } from '../../app/.server/source-drift';
import { confirmWatermark, registerSource, relistSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, publish, selectAllTables } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

// phone 发布时就在，有意不映射
const CUSTOMERS = `model: 1
entity: customer
table: customers
fields:
  customer_id: string(customer_id)
  name: name
  email: lower(email)
  city: city
  registered_at: from_timezone(created_at, 'Asia/Shanghai')
  updated_at: updated_at
`;

/** 登记数据源、选表、同步一次，发布 customers 映射 */
async function publishedCustomers() {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const { id } = await registerSource(author, await pgSourceInput(READER));
  await selectAllTables(author, id);
  await drain();
  await confirmWatermark(author, id, 'customers', 'updated_at');
  await syncSource(author, id);
  await drain();
  const mappingId = await publish(author, reviewer, id, CUSTOMERS);
  return { acme, author, id, mappingId };
}

/** 改源表结构后重新采集 */
async function alterAndRelist(author: CurrentMember, id: string, ddl: string) {
  await grantOnSource(ddl);
  await relistSource(author, id);
  await drain();
}

describe('映射源表列差异', () => {
  it('源表没变时没有差异；发布时已存在、没映射的列不算新列', async () => {
    const { acme, author, id } = await publishedCustomers();
    await relistSource(author, id);
    await drain();
    expect((await mappingDrift(acme)).size).toBe(0);
  });

  it('发布后源表新增一列并重新采集：标出这一列，带类型与常见取值', async () => {
    const { acme, author, id, mappingId } = await publishedCustomers();
    await alterAndRelist(author, id, `ALTER TABLE shop.customers ADD COLUMN level text; UPDATE shop.customers SET level = 'gold'`);
    const drift = (await mappingDrift(acme)).get(mappingId);
    expect(drift).toMatchObject({ sourceId: id, tableName: 'customers', missing: [] });
    expect(drift!.newColumns).toHaveLength(1);
    expect(drift!.newColumns[0]).toMatchObject({ name: 'level', type: 'VARCHAR', top: [{ value: 'gold', rows: 40 }] });
  });

  it('映射引用的列在源端被删除并重新采集：报源端已删除', async () => {
    const { acme, author, id, mappingId } = await publishedCustomers();
    await alterAndRelist(author, id, 'ALTER TABLE shop.customers DROP COLUMN email');
    expect((await mappingDrift(acme, [mappingId])).get(mappingId)).toMatchObject({ newColumns: [], missing: ['email'] });
  });

  it('草稿保存时引用了新列，新列提醒消失', async () => {
    const { acme, author, id, mappingId } = await publishedCustomers();
    await alterAndRelist(author, id, 'ALTER TABLE shop.customers ADD COLUMN level text');
    expect((await mappingDrift(acme)).get(mappingId)?.newColumns.map(c => c.name)).toEqual(['level']);
    await saveDraft(author, mappingId, `${CUSTOMERS}extensions:\n  x_level: { type: string, expr: level }\n`);
    expect((await mappingDrift(acme)).has(mappingId)).toBe(false);
  });
});
