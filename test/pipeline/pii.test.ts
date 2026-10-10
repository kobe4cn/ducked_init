// 标准层敏感字段的流水线接缝：同步到原始层 → 发布映射 → 调度器派发合并（领取时派生租户的敏感信息盐）→
// silver.* 与 silver_records 里内置敏感字段只有规范化后加盐的哈希，任务结果与报错里也没有明文（ADR-0005）
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { tasks } from '../../app/.server/db/schema';
import { ensureTenantLakeSchemas, lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { mergeNow } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { tenantPiiSalt } from '../../app/.server/secrets';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { resetDb } from '../http/harness';
import { memberOf, newTenant, publish, selectAllTables, silver } from './fixtures';
import { grantOnSource, pgSourceInput, READER } from './source-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 线索表：同一批人换了写法（空格、大小写、+86 与分隔符），第 2 位的姓名一栏误填了邮箱；微信号是租户特有的敏感信息 */
const LEADS = `
  CREATE TABLE shop.leads (id int PRIMARY KEY, full_name text, mobile text, mail text, wechat text, channel text);
  INSERT INTO shop.leads VALUES
    (1, '  消费者1 ', '+86 138-0000-0001', '  User1@Example.COM ', ' wxid_lead1 ', '门店'),
    (2, 'user2@example.com', '0086 13800000002', NULL, NULL, '小程序');
  GRANT SELECT ON shop.leads TO ${READER.user};`;

const CUSTOMERS = `model: 1
entity: customer
table: customers
fields:
  customer_id: string(customer_id)
  name: name
  phone: phone
  email: lower(email)
  city: city
`;

const LEADS_MAPPING = `model: 1
entity: customer
table: leads
fields:
  customer_id: concat('L', string(id))
  name: full_name
  phone: mobile
  email: mail
`;

/** 两位数据工程师，登记电商库（加上线索表）、选入全部表、确认水位线并同步一次 */
async function syncedSource() {
  const acme = await newTenant('acme');
  const author = await memberOf(acme, 'de@acme.com');
  const reviewer = await memberOf(acme, 'de2@acme.com');
  const input = await pgSourceInput(READER);
  await grantOnSource(LEADS);
  const { id } = await registerSource(author, input);
  await selectAllTables(author, id);
  await drain();
  await confirmWatermark(author, id, 'customers', 'updated_at');
  await syncSource(author, id);
  await drain();
  return { acme, author, reviewer, id };
}

/** 种子里的明文：消费者的姓名、邮箱与手机号，加上线索表的写法 */
const SEEDED = [...Array.from({ length: 40 }, (_, i) => `138${String(i + 1).padStart(8, '0')}`), '消费者', 'example.com', '138-0000'];
const plaintextIn = (text: string) => SEEDED.filter(s => text.toLowerCase().includes(s));

/** 标准层与当前记录里所有表的全部内容（转成 JSON 文本） */
async function silverDump(tenantId: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    const tables = (await session.con.runAndReadAll(`SELECT table_schema AS s, table_name AS t FROM information_schema.tables
      WHERE table_catalog = 'lake' AND table_schema IN ('silver', 'silver_records') ORDER BY ALL`)).getRowObjectsJson() as { s: string; t: string }[];
    const dump = await Promise.all(tables.map(async ({ s, t }) => (await session.con.runAndReadAll(`SELECT * FROM "${s}"."${t}"`)).getRowObjectsJson()));
    return { tables: tables.map(({ s, t }) => `${s}.${t}`), text: JSON.stringify(dump) };
  } finally {
    session.close();
  }
}

async function taskText(tenantId: string) {
  const all = await getDb().select({ result: tasks.result, error: tasks.error }).from(tasks).where(eq(tasks.tenantId, tenantId));
  return JSON.stringify(all);
}

describe('标准层的敏感字段只存加盐哈希', () => {
  it('姓名、手机号、邮箱规范化后按租户加盐哈希：不同写法得到同一个哈希，与字段名无关，空值仍为空', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CUSTOMERS);
    await publish(author, reviewer, id, LEADS_MAPPING);
    const salt = await tenantPiiSalt(acme);
    const hash = (v: string) => createHash('sha256').update(salt + v).digest('hex');

    const rows = await silver(acme, 'customer', 'customer_id');
    const byId = Object.fromEntries(rows.map(r => [r.customer_id, r]));
    expect(byId['1']).toMatchObject({ name: hash('消费者1'), phone: hash('13800000001'), email: hash('user1@example.com'), city: '上海' });
    expect(byId['4']).toMatchObject({ email: null });
    // 线索表里换了写法的同一个人
    expect(byId.L1).toMatchObject({ name: byId['1'].name, phone: byId['1'].phone, email: byId['1'].email });
    // 姓名一栏里的邮箱与邮箱字段里的同一个值哈希相同
    expect(byId.L2).toMatchObject({ name: byId['2'].email, phone: byId['2'].phone, email: null });

    const { tables, text } = await silverDump(acme);
    expect(tables).toEqual(expect.arrayContaining(['silver.customer', 'silver._merges']));
    expect(tables.filter(t => t.startsWith('silver_records.'))).toHaveLength(2);
    expect(plaintextIn(text)).toEqual([]);
    expect(plaintextIn(await taskText(acme))).toEqual([]);
  });

  it('标成敏感的扩展字段与内置敏感字段一样只存加盐哈希，没标的扩展字段照常存明文', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, `${LEADS_MAPPING}extensions:
  x_wechat: { type: string, expr: wechat, sensitive: true }
  x_channel: { type: string, expr: channel }
`);
    const salt = await tenantPiiSalt(acme);
    const hash = (v: string) => createHash('sha256').update(salt + v).digest('hex');

    const rows = await silver(acme, 'customer', 'customer_id');
    expect(rows.map(r => [r.customer_id, r.x_wechat, r.x_channel])).toEqual([['L1', hash('wxid_lead1'), '门店'], ['L2', null, '小程序']]);
    const { text } = await silverDump(acme);
    expect(text).not.toContain('wxid_lead1');
    expect(plaintextIn(text)).toEqual([]);
  });

  it('哈希上线之前按明文合并的标准层，下次合并时识别出来并重建', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, CUSTOMERS);
    // 还原成老的数据湖：合并日志没有 scheme 列，标准层与当前记录里是明文
    const session = await openTenantLake(lakeSpecOf((await lakeRow(acme))!), { memoryLimitMb: 256, threads: 1 });
    try {
      const [{ t }] = (await session.con.runAndReadAll(`SELECT table_name AS t FROM information_schema.tables
        WHERE table_catalog = 'lake' AND table_schema = 'silver_records'`)).getRowObjectsJson() as { t: string }[];
      await session.con.run(`ALTER TABLE silver._merges DROP COLUMN scheme;
        UPDATE silver.customer SET name = '消费者' || customer_id;
        UPDATE silver_records."${t}" SET name = '消费者' || customer_id`);
    } finally {
      session.close();
    }
    expect(plaintextIn((await silverDump(acme)).text)).toEqual(['消费者']);
    // 上线前先跑 pnpm lake:ensure，给合并日志补上 scheme 列（老的日志为空）
    await ensureTenantLakeSchemas(acme);

    const task = await mergeNow(author);
    await drain();
    const [merged] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
    expect(merged.status).toBe('succeeded');
    expect((merged.result as { mappings: { mode: string }[] }).mappings).toEqual([expect.objectContaining({ mode: 'rebuild', rows: 40 })]);
    expect(plaintextIn((await silverDump(acme)).text)).toEqual([]);
  });

  it('转换出错时报错里不带敏感字段的源端取值与盐', async () => {
    const { acme, author, reviewer, id } = await syncedSource();
    await publish(author, reviewer, id, `${LEADS_MAPPING}  registered_at: timestamp(trim(mail))\n`);
    const [merge] = await getDb().select().from(tasks).where(eq(tasks.tenantId, acme)).orderBy(tasks.createdAt).then(all => all.filter(t => t.kind === 'silver.merge'));
    expect(merge.status).toBe('failed');
    expect(merge.error).toMatch(/TIMESTAMP/i);
    expect(merge.error).not.toMatch(/user1@example/i);
    // DuckDB 的报错会摘出一段 SQL，其中可能有盐
    expect(merge.error).not.toContain(await tenantPiiSalt(acme));
    expect(plaintextIn(await taskText(acme))).toEqual([]);
  });
});
