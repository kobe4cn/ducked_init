// test/pipeline/catalog-tx.test.ts —— catalogTx（ADR-0054）：成员事务的目录版本由 catalogTx 在事务收尾时记一次，
// recordAudit 只把白名单动作登记进上下文；审计之后再改目录，这一版快照包含那部分改动；多个目录动作只记一版、原因取第一个；
// 没有目录动作不记版本；嵌套 catalogTx 与审计别的租户抛错，事务回滚、不留版本与审计行
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { recordAudit } from '../../app/.server/audit';
import { saveBusinessNoteTx } from '../../app/.server/business-notes';
import { catalogTx } from '../../app/.server/catalog/tx';
import { closeDb, getDb } from '../../app/.server/db/client';
import { auditLogs, catalogVersions } from '../../app/.server/db/schema';
import { addAliasTx } from '../../app/.server/knowledge/aliases';
import { resetDb } from '../http/harness';
import { memberOf, newTenant } from './fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

/** 本租户最新一版目录版本；还没有版本时为 undefined */
const latestVersion = async (tenantId: string) => (await getDb().select().from(catalogVersions)
  .where(eq(catalogVersions.tenantId, tenantId)).orderBy(desc(catalogVersions.version)).limit(1))[0];

/** 开一个租户与一位分析师（内置实体在目录里，别名与说明都不需要数据源） */
async function setup(slug = 'acme') {
  const tenantId = await newTenant(slug);
  const analyst = await memberOf(tenantId, `an@${slug}.com`, 'analyst');
  return { tenantId, analyst };
}

describe('catalogTx：成员事务收尾时记一版目录版本', () => {
  it('审计之后再改目录，这一版快照同时包含两处改动', async () => {
    const { tenantId, analyst } = await setup();
    await catalogTx(tenantId, async tx => {
      await addAliasTx(tx, analyst, { targetId: 'entity:order', alias: '交易单' });
      await saveBusinessNoteTx(tx, analyst, { targetId: 'entity:order', note: '下单记录' });
    });
    const v = await latestVersion(tenantId);
    expect(v?.version).toBe(1);
    expect(v?.snapshot.find(e => e.id === 'entity:order'))
      .toMatchObject({ knowledge: { aliases: ['交易单'], note: '下单记录' } });
  });

  it('两个目录动作只记一版，原因取第一个', async () => {
    const { tenantId, analyst } = await setup();
    await catalogTx(tenantId, async tx => {
      await saveBusinessNoteTx(tx, analyst, { targetId: 'entity:order', note: '下单记录' });
      await addAliasTx(tx, analyst, { targetId: 'entity:order', alias: '交易单' });
    });
    expect(await latestVersion(tenantId)).toMatchObject({ version: 1, reason: 'business_note.updated' });
    expect(await getDb().select().from(catalogVersions).where(eq(catalogVersions.tenantId, tenantId))).toHaveLength(1);
  });

  it('没有目录动作时不记版本', async () => {
    const { tenantId } = await setup();
    await catalogTx(tenantId, async () => {});
    await catalogTx(tenantId, async tx => {
      // 非目录动作的审计照常留行，不记版本
      await recordAudit(tx, { tenantId, system: true, action: 'workbench.query', targetType: 'workbench' });
    });
    expect(await latestVersion(tenantId)).toBeUndefined();
    expect((await getDb().select().from(auditLogs).where(eq(auditLogs.tenantId, tenantId)))
      .filter(r => r.action === 'workbench.query')).toHaveLength(1);
  });

  it('嵌套调用 catalogTx 抛错', async () => {
    const { tenantId, analyst } = await setup();
    await expect(catalogTx(tenantId, async tx =>
      catalogTx(tenantId, async inner => addAliasTx(inner, analyst, { targetId: 'entity:order', alias: '交易单' })),
    )).rejects.toThrow(/嵌套 catalogTx/);
    expect(await latestVersion(tenantId)).toBeUndefined();
  });

  it('catalogTx 里审计别的租户的目录动作抛错，事务回滚不留版本与审计行', async () => {
    const { tenantId } = await setup('acme');
    const other = await setup('globex');
    await expect(catalogTx(tenantId, tx =>
      addAliasTx(tx, other.analyst, { targetId: 'entity:order', alias: '交易单' }),
    )).rejects.toThrow(/审计了租户/);
    expect(await latestVersion(tenantId)).toBeUndefined();
    expect(await latestVersion(other.tenantId)).toBeUndefined();
    expect((await getDb().select().from(auditLogs).where(eq(auditLogs.tenantId, other.tenantId)))
      .filter(r => r.action === 'alias.added')).toHaveLength(0);
  });
});
