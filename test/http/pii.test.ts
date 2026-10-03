// 解密敏感信息的 HTTP 接缝：管理员选一个已发布的映射、填源表主键与原因 → 平台在请求内只读挂载本租户数据湖，从原始层读出该记录敏感字段的明文，
// 只放在这次响应里（不进任务结果与审计日志），审计 pii.revealed 写成功后才返回明文（主键本身是敏感信息时审计里只记哈希）；其他角色 403，其他租户的映射 404（ADR-0005、0007）
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, tasks } from '../../app/.server/db/schema';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { memberOf, newTenant, publish, selectAllTables } from '../pipeline/fixtures';
import { grantOnSource, pgSourceInput, READER } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });

const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

const LEADS = `
  CREATE TABLE shop.leads (id int PRIMARY KEY, full_name text, mobile text, mail text, wechat text, channel text);
  INSERT INTO shop.leads VALUES
    (1, '消费者1', '+86 138-0000-0001', 'User1@Example.COM', 'wxid_lead1', '门店'),
    (2, '消费者2', '0086 13800000002', NULL, NULL, '小程序');
  CREATE TABLE shop.contacts (mail text PRIMARY KEY, full_name text);
  INSERT INTO shop.contacts VALUES ('vip@example.com', '贵宾甲');
  GRANT SELECT ON shop.leads, shop.contacts TO ${READER.user};`;

const LEADS_MAPPING = `model: 1
entity: customer
table: leads
fields:
  customer_id: concat('L', string(id))
  name: full_name
  phone: mobile
  email: mail
extensions:
  x_wechat: { type: string, expr: wechat, sensitive: true }
  x_channel: { type: string, expr: channel }
`;

// 源表主键就是邮箱
const CONTACTS_MAPPING = `model: 1
entity: customer
table: contacts
fields:
  customer_id: concat('C', full_name)
  name: full_name
  email: mail
`;

const PLAINTEXT = ['消费者1', '138-0000-0001', 'User1@Example.COM', 'wxid_lead1'];

/** 开通租户，登记电商库（加上线索表）、同步进原始层，发布线索表的映射（敏感字段在标准层只有哈希）；返回租户与映射 */
async function revealableLead(slug: string) {
  const tenantId = await newTenant(slug);
  const author = await memberOf(tenantId, `de@${slug}.com`);
  const reviewer = await memberOf(tenantId, `de2@${slug}.com`);
  const input = await pgSourceInput(READER);
  await grantOnSource(LEADS);
  const { id } = await registerSource(author, input);
  await selectAllTables(author, id);
  await drain();
  await confirmWatermark(author, id, 'customers', 'updated_at');
  await syncSource(author, id);
  await drain();
  const mappingId = await publish(author, reviewer, id, LEADS_MAPPING);
  return { tenantId, mappingId, publishContacts: () => publish(author, reviewer, id, CONTACTS_MAPPING) };
}

describe('解密敏感信息', () => {
  it('管理员填写原因后看到这条记录敏感字段的明文，明文不进任务结果与审计日志，审计记下操作人、实体、主键与原因', async () => {
    const { mappingId } = await revealableLead('acme');
    const admin = await loginAs(app, 'admin@acme.com');

    const page = await (await admin.get('/pii/reveal')).text();
    expect(page).toContain('解密敏感信息');
    expect(page).toContain(`value="${mappingId}"`);

    // 采集的列统计里本来就有源端取值（ADR-0016），只看解密前后任务表有没有变化
    const taskRows = () => getDb().select().from(tasks).orderBy(tasks.id);
    const tasksBefore = await taskRows();
    const res = await admin.post('/pii/reveal', { mappingId, key: '1', reason: '客户投诉回访，需核对联系方式' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const html = await res.text();
    for (const p of PLAINTEXT) expect(html).toContain(p);
    expect(html).not.toContain('消费者2');

    const audit = await getDb().select().from(auditLogs);
    const revealed = audit.filter(a => a.action === 'pii.revealed');
    expect(revealed).toHaveLength(1);
    expect(revealed[0]).toMatchObject({ actorEmail: 'admin@acme.com', targetType: 'mapping', targetId: mappingId });
    expect(revealed[0].detail).toMatchObject({ entity: 'customer', table: 'leads', key: { id: '1' }, reason: '客户投诉回访，需核对联系方式' });
    expect(PLAINTEXT.filter(p => JSON.stringify(audit).includes(p))).toEqual([]);
    expect(await taskRows()).toEqual(tasksBefore);

    const log = await (await admin.get('/audit')).text();
    expect(log).toContain('解密敏感信息');
    expect(log).toContain('客户投诉回访，需核对联系方式');
  });

  it('源表主键本身是敏感信息时，审计里只记它的哈希', async () => {
    const { publishContacts } = await revealableLead('acme');
    const mappingId = await publishContacts();
    const admin = await loginAs(app, 'admin@acme.com');

    const html = await (await admin.post('/pii/reveal', { mappingId, key: 'vip@example.com', reason: '核对贵宾' })).text();
    expect(html).toContain('贵宾甲');
    const [revealed] = await getDb().select().from(auditLogs).where(eq(auditLogs.action, 'pii.revealed'));
    expect(JSON.stringify(revealed)).not.toContain('vip@example.com');
    expect((revealed.detail as { key: Record<string, string> }).key.mail).toMatch(/^哈希 [0-9a-f]{64}$/);
  });

  it('不填原因、找不到主键时不解密也不记审计', async () => {
    const { mappingId } = await revealableLead('acme');
    const admin = await loginAs(app, 'admin@acme.com');

    const blank = await admin.post('/pii/reveal', { mappingId, key: '1', reason: '  ' });
    expect(blank.status).toBe(400);
    expect(await blank.text()).toContain('请填写解密原因');
    const missing = await admin.post('/pii/reveal', { mappingId, key: '99', reason: '核对' });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('没有找到');

    const audit = await getDb().select().from(auditLogs);
    expect(audit.filter(a => a.action === 'pii.revealed')).toEqual([]);
  });

  it('其他角色 403，其他租户的映射 404', async () => {
    const { tenantId, mappingId } = await revealableLead('acme');
    for (const role of ['data_engineer', 'analyst', 'viewer'] as const) {
      await memberOf(tenantId, `${role}@acme.com`, role);
      const browser = await loginAs(app, `${role}@acme.com`);
      expect((await browser.get('/pii/reveal')).status).toBe(403);
      const res = await browser.post('/pii/reveal', { mappingId, key: '1', reason: '核对' });
      expect(res.status).toBe(403);
    }

    await newTenant('globex');
    const stranger = await loginAs(app, 'admin@globex.com');
    const res = await stranger.post('/pii/reveal', { mappingId, key: '1', reason: '核对' });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(PLAINTEXT.filter(p => html.includes(p))).toEqual([]);

    const audit = await getDb().select().from(auditLogs);
    expect(audit.filter(a => a.action === 'pii.revealed')).toEqual([]);
  });
});
