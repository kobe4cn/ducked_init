// test/http/business-notes.test.ts —— 实体字段业务说明的 HTTP 接缝（ADR-0041）：分析师在数据地图的字段抽屉里保存说明（intent=note），
// 抽屉显示最新说明与历史（内容、作者、时间），清空是提交空串、记为一条空的历史；每次保存记审计 business_note.updated（不含正文）；
// 长度 1–2000 字（去掉首尾空白后），不存在的实体字段 400，页面上保存失败时编辑框留着刚写的内容；数据工程师与管理员同样能保存；查看者看得到说明、没有编辑入口、提交 403，分析师仍不能 inspect；别的租户看不到、改不了；
// 映射字段的说明（带 mappingId）挂在抽屉的映射来源下，需 sources:write（分析师看得到、提交 403），映射须是本租户、映射到了这个字段的，否则 400
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs } from '../../app/.server/db/schema';
import { currentNotes } from '../../app/.server/business-notes';
import { memberOf, newTenant } from '../pipeline/fixtures';
import { publishedIdentitySources } from '../pipeline/identity-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); });

const fieldRow = (html: string, field: string) => html.match(new RegExp(`<li[^>]*data-field="${field}"[\\s\\S]*?</li>`))![0];
const decode = (html: string) => html.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&');
const note = (fields: Record<string, string>) => ({ intent: 'note', entity: 'customer', field: 'name', ...fields });

describe('实体字段的业务说明', () => {
  it('分析师在字段抽屉里保存说明：抽屉显示最新说明与历史，清空记为一条空的历史，每次保存记审计且不含正文', async () => {
    const { acme } = await publishedIdentitySources();
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');

    const before = fieldRow(decode(await (await analyst.get('/lineage?node=customer')).text()), 'name');
    expect(before).toContain('name="intent" value="note"');
    expect(before).not.toContain('data-note=');

    const res = await analyst.post('/lineage?node=customer', note({ note: '  会员实名，脱敏前的展示名  ' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/lineage?node=customer');
    // 页面上经客户端提交时请求的是 /lineage.data，重定向仍回到 /lineage
    const data = await analyst.post('/lineage.data?node=customer', note({ note: '会员实名' }));
    expect(await data.text()).toContain('/lineage?node=customer');

    let row = fieldRow(decode(await (await analyst.get('/lineage?node=customer')).text()), 'name');
    expect(row).toContain('data-note="会员实名"');
    expect(row.match(/data-note-version/g)).toHaveLength(2);
    expect(row).toContain('会员实名，脱敏前的展示名');
    expect(row).toContain('analyst@acme.com');
    // 别的字段不受影响
    expect(fieldRow(decode(await (await analyst.get('/lineage?node=customer')).text()), 'email')).not.toContain('data-note=');

    // 清空：显式提交空串
    expect((await analyst.post('/lineage?node=customer', note({ note: '' }))).status).toBe(302);
    row = fieldRow(decode(await (await analyst.get('/lineage?node=customer')).text()), 'name');
    expect(row).not.toContain('data-note=');
    expect(row.match(/data-note-version/g)).toHaveLength(3);
    expect(row).toContain('已清空');
    expect((await currentNotes(getDb(), acme)).get('customer.name')).toBe('');

    const audits = await getDb().select().from(auditLogs).where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, 'business_note.updated')));
    expect(audits).toHaveLength(3);
    for (const a of audits) {
      expect(a.actorEmail).toBe('analyst@acme.com');
      expect(a.detail).toEqual({ entity: 'customer', field: 'name', mappingId: null });
      expect(JSON.stringify(a)).not.toContain('会员实名');
    }
  });

  it('说明去掉首尾空白后要有 1–2000 字，不存在的实体字段 400，都不留记录', async () => {
    const { acme } = await publishedIdentitySources();
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');

    // 页面上保存失败：编辑框展开、留着刚写的内容并给出原因
    const failed = await analyst.post('/lineage?node=customer', note({ note: `${'字'.repeat(2001)}` }));
    expect(failed.status).toBe(400);
    const failedRow = fieldRow(decode(await failed.text()), 'name');
    expect(failedRow).toContain('说明最多 2000 字');
    expect(failedRow).toContain('字'.repeat(2001));

    for (const fields of <Record<string, string>[]>[{ note: '   ' }, { note: '字'.repeat(2001) }, {}, { note: 'x', field: 'nope' }, { note: 'x', entity: 'nope' }, { note: 'x', entity: 'custom_nope' }]) {
      expect((await analyst.post('/lineage?node=customer', note(fields))).status).toBe(400);
    }
    expect((await currentNotes(getDb(), acme)).size).toBe(0);

    expect((await analyst.post('/lineage?node=customer', note({ note: `  ${'字'.repeat(2000)}  ` }))).status).toBe(302);
    expect((await currentNotes(getDb(), acme)).get('customer.name')).toBe('字'.repeat(2000));
  });

  it('数据工程师与管理员也能保存说明', async () => {
    const { acme } = await publishedIdentitySources();
    await memberOf(acme, 'eng@acme.com', 'data_engineer');
    await memberOf(acme, 'boss@acme.com', 'admin');
    expect((await (await loginAs(app, 'eng@acme.com')).post('/lineage?node=customer', note({ note: '工程师写的' }))).status).toBe(302);
    expect((await currentNotes(getDb(), acme)).get('customer.name')).toBe('工程师写的');
    expect((await (await loginAs(app, 'boss@acme.com')).post('/lineage?node=customer', note({ note: '管理员写的' }))).status).toBe(302);
    expect((await currentNotes(getDb(), acme)).get('customer.name')).toBe('管理员写的');
  });

  it('查看者看得到说明，没有编辑入口，提交 403；分析师提交 inspect 仍然 403', async () => {
    const { acme } = await publishedIdentitySources();
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    await memberOf(acme, 'viewer@acme.com', 'viewer');
    const analyst = await loginAs(app, 'analyst@acme.com');
    const viewer = await loginAs(app, 'viewer@acme.com');
    expect((await analyst.post('/lineage?node=customer', note({ note: '会员实名' }))).status).toBe(302);

    const row = fieldRow(decode(await (await viewer.get('/lineage?node=customer')).text()), 'name');
    expect(row).toContain('data-note="会员实名"');
    expect(row).toContain('data-note-version');
    expect(row).not.toContain('value="note"');
    expect((await viewer.post('/lineage?node=customer', note({ note: '改掉' }))).status).toBe(403);
    expect((await currentNotes(getDb(), acme)).get('customer.name')).toBe('会员实名');

    expect((await analyst.post('/lineage', { intent: 'inspect' })).status).toBe(403);
    expect((await analyst.post('/lineage', { intent: 'rebuild', entity: 'customer' })).status).toBe(403);
  });

  it('别的租户看不到、改不了这份说明', async () => {
    const { acme } = await publishedIdentitySources();
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const analyst = await loginAs(app, 'analyst@acme.com');
    expect((await analyst.post('/lineage?node=customer', note({ note: '会员实名' }))).status).toBe(302);

    const globex = await newTenant('globex');
    await memberOf(globex, 'analyst@globex.com', 'analyst');
    const other = await loginAs(app, 'analyst@globex.com');
    expect(await (await other.get('/lineage?node=customer')).text()).not.toContain('会员实名');
    // 只写进自己租户
    expect((await other.post('/lineage?node=customer', note({ note: '另一家的口径' }))).status).toBe(302);
    expect((await currentNotes(getDb(), acme)).get('customer.name')).toBe('会员实名');
    expect((await currentNotes(getDb(), globex)).get('customer.name')).toBe('另一家的口径');
    expect(decode(await (await analyst.get('/lineage?node=customer')).text())).not.toContain('另一家的口径');
  });
});

// 字段行里一个映射来源：到下一个映射来源或字段行结束为止
const sourceBlock = (row: string, mapping: string) => row.match(new RegExp(`<div[^>]*data-field-mapping="${mapping}"[\\s\\S]*?(?=<div[^>]*data-field-mapping=|</li>)`))![0];

describe('映射字段的业务说明', () => {
  it('数据工程师在映射来源下保存说明：只显示在这个来源下，有历史与审计（不含正文）；分析师看得到、没有编辑入口、提交 403', async () => {
    const { acme, mappings } = await publishedIdentitySources();
    await memberOf(acme, 'eng@acme.com', 'data_engineer');
    await memberOf(acme, 'analyst@acme.com', 'analyst');
    const eng = await loginAs(app, 'eng@acme.com');
    const analyst = await loginAs(app, 'analyst@acme.com');

    const before = sourceBlock(fieldRow(decode(await (await eng.get('/lineage?node=customer')).text()), 'name'), mappings.crm);
    expect(before).toContain(`name="mappingId" value="${mappings.crm}"`);

    const res = await eng.post('/lineage?node=customer', note({ mappingId: mappings.crm, note: '  CRM 的姓名是门店手填，常有昵称  ' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/lineage?node=customer');
    expect((await eng.post('/lineage?node=customer', note({ mappingId: mappings.crm, note: 'CRM 门店手填' }))).status).toBe(302);

    const notes = await currentNotes(getDb(), acme);
    expect(notes.get(`customer.name@${mappings.crm}`)).toBe('CRM 门店手填');
    expect(notes.has('customer.name')).toBe(false);

    for (const member of [eng, analyst]) {
      const row = fieldRow(decode(await (await member.get('/lineage?node=customer')).text()), 'name');
      const crm = sourceBlock(row, mappings.crm);
      expect(crm).toContain('data-note="CRM 门店手填"');
      expect(crm.match(/data-note-version/g)).toHaveLength(2);
      expect(crm).toContain('CRM 的姓名是门店手填，常有昵称');
      expect(crm).toContain('eng@acme.com');
      // 实体字段说明与别的映射来源不受影响
      expect(sourceBlock(row, mappings.loyalty)).not.toContain('data-note=');
      expect(row.replace(crm, '')).not.toContain('CRM 门店手填');
    }
    const analystCrm = sourceBlock(fieldRow(decode(await (await analyst.get('/lineage?node=customer')).text()), 'name'), mappings.crm);
    expect(analystCrm).not.toContain('name="mappingId"');
    expect((await analyst.post('/lineage?node=customer', note({ mappingId: mappings.crm, note: '分析师改' }))).status).toBe(403);
    expect((await currentNotes(getDb(), acme)).get(`customer.name@${mappings.crm}`)).toBe('CRM 门店手填');

    const audits = await getDb().select().from(auditLogs).where(and(eq(auditLogs.tenantId, acme), eq(auditLogs.action, 'business_note.updated')));
    expect(audits).toHaveLength(2);
    for (const a of audits) {
      expect(a.actorEmail).toBe('eng@acme.com');
      expect(a.detail).toEqual({ entity: 'customer', field: 'name', mappingId: mappings.crm });
      expect(JSON.stringify(a)).not.toContain('门店手填');
    }
  });

  it('管理员也能保存；映射属于别的租户、没映射到这个字段或不存在时 400，不留记录', async () => {
    const { acme, mappings } = await publishedIdentitySources();
    const globex = await publishedIdentitySources({ slug: 'globex' });
    await memberOf(acme, 'boss@acme.com', 'admin');
    const boss = await loginAs(app, 'boss@acme.com');

    for (const mappingId of [globex.mappings.crm, mappings.tracking, '00000000-0000-0000-0000-000000000000', 'not-a-uuid']) {
      expect((await boss.post('/lineage?node=customer', note({ mappingId, note: '说明' }))).status).toBe(400);
    }
    expect((await currentNotes(getDb(), acme)).size).toBe(0);
    expect((await currentNotes(getDb(), globex.acme)).size).toBe(0);

    expect((await boss.post('/lineage?node=customer', note({ mappingId: mappings.loyalty, note: '会员全名' }))).status).toBe(302);
    expect((await currentNotes(getDb(), acme)).get(`customer.name@${mappings.loyalty}`)).toBe('会员全名');
  });
});
