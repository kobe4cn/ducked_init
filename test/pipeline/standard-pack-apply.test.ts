// test/pipeline/standard-pack-apply.test.ts —— 应用标准模板包（ADR-0046 知识入口②，#520）：applyStandardPack 只对租户已发布映射写入的实体把包条目展开成
// 知识提案（generatorVersion 与证据带包版本）；目标上已有同类知识（同名别名不分大小写、同类型口径声明、非空说明）的跳过；重跑与拒绝过的由 proposeMany
// 的指纹计 existing / rejected；包版本升级后再跑：已接受的知识不被覆盖、内容变了的条目提新提案、旧的未处理提案保留
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../app/.server/db/client';
import { knowledgeAliases, knowledgeProposals } from '../../app/.server/db/schema';
import { applyStandardPack } from '../../app/.server/knowledge/apply-pack';
import { acceptProposal, rejectProposal } from '../../app/.server/knowledge/proposals';
import { PACK_VERSION, type PackEntry } from '../../app/lib/standard-pack';
import { resetDb } from '../http/harness';
import { memberOf } from './fixtures';
import { publishedIdentitySources } from './identity-fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const apply = (tenantId: string, pack?: readonly PackEntry[], version?: number) =>
  getDb().transaction(tx => applyStandardPack(tx, tenantId, pack, version));
const proposalRows = (tenantId: string) => getDb().select().from(knowledgeProposals).where(eq(knowledgeProposals.tenantId, tenantId));

/** 只发布 customer 映射的数据源（order 没有已发布映射）与一位能处理提案的分析师 */
async function setup() {
  const s = await publishedIdentitySources();
  const analyst = await memberOf(s.acme, 'an@acme.com', 'analyst');
  return { ...s, analyst };
}

describe('应用标准模板包', () => {
  it('只对已发布映射写入的实体生成提案：生成 field:customer.*、不生成 field:order.*，generatorVersion 与证据带包版本', async () => {
    const { acme } = await setup();
    const out = await apply(acme);
    expect(out.created.map(p => [p.targetId, p.kind, p.content])).toEqual([
      ['field:customer.customer_id', 'alias', { alias: '客户 ID' }],
      ['field:customer.customer_id', 'alias', { alias: '用户 ID' }],
      ['field:customer.city', 'alias', { alias: '所在城市' }],
      ['field:customer.registered_at', 'alias', { alias: '注册日期' }],
    ]);
    expect(out.created.some(p => p.targetId.startsWith('field:order.'))).toBe(false);
    for (const p of out.created) {
      expect(p).toMatchObject({ status: 'proposed', generatorVersion: `standard-pack@${PACK_VERSION}`, evidence: [{ ref: 'pack:standard', version: PACK_VERSION }] });
    }
    expect(out).toMatchObject({ existing: 0, rejected: 0, invalid: [], stale: 0, skipped: 0 });
  });

  it('重跑不重复：全部计 existing；拒绝过的计 rejected 不再出现；目标上已有同名别名（不分大小写）、同类型口径声明、非空说明的跳过', async () => {
    const { acme, analyst } = await setup();
    const first = await apply(acme);
    expect(first.created).toHaveLength(4);
    // 重跑：指纹相同的都计 existing，不新增
    const again = await apply(acme);
    expect(again).toMatchObject({ created: [], existing: 4, rejected: 0, skipped: 0 });
    // 拒绝一条（注册日期）后重跑：那条计 rejected、不新增
    await rejectProposal(analyst, first.created[3]!.id, '不要这个说法');
    const third = await apply(acme);
    expect(third).toMatchObject({ created: [], existing: 3, rejected: 1 });
    // 接受「客户 ID」后，换大小写不同的同名别名再跑：计 skipped、不提新提案
    await acceptProposal(analyst, first.created[0]!.id);
    const cased = await apply(acme, [{ targetId: 'field:customer.customer_id', aliases: ['客户 id'] }]);
    expect(cased).toMatchObject({ created: [], skipped: 1, existing: 0 });
    // 同类型口径声明（取值变了也算）与非空说明（文字变了也算）都跳过
    const withClaimAndNote = await apply(acme, [{
      targetId: 'field:customer.city',
      claims: [{ type: 'time_meaning', value: 'event_time' }],
      note: '客户所在的城市',
    }]);
    expect(withClaimAndNote.created.map(p => [p.kind, p.content])).toEqual([
      ['claim', { type: 'time_meaning', value: 'event_time' }],
      ['note', { note: '客户所在的城市' }],
    ]);
    for (const p of withClaimAndNote.created) await acceptProposal(analyst, p.id);
    const afterKnowledge = await apply(acme, [{
      targetId: 'field:customer.city',
      claims: [{ type: 'time_meaning', value: 'record_time' }],
      note: '换了文字的说明',
    }]);
    expect(afterKnowledge).toMatchObject({ created: [], skipped: 2 });
  });

  it('包版本升级后再跑：已接受的知识不被覆盖，内容变了的条目提新提案（新版本号），旧的未处理提案保留', async () => {
    const { acme, analyst } = await setup();
    const first = await apply(acme);
    await acceptProposal(analyst, first.created[2]!.id); // 「所在城市」
    // 版本 2 的包：city 的条目多了一个新别名，其余没变
    const out = await apply(acme, [
      { targetId: 'field:customer.customer_id', aliases: ['客户 ID', '用户 ID'] },
      { targetId: 'field:customer.city', aliases: ['所在城市', '用户城市'] },
      { targetId: 'field:customer.registered_at', aliases: ['注册日期'] },
    ], 2);
    // 内容没变的照旧计 existing；「所在城市」已接受成知识、被跳过；新别名「用户城市」是内容变了的新提案
    expect(out).toMatchObject({ existing: 3, skipped: 1, rejected: 0, invalid: [] });
    expect(out.created.map(p => [p.targetId, p.content])).toEqual([['field:customer.city', { alias: '用户城市' }]]);
    expect(out.created[0]).toMatchObject({ generatorVersion: 'standard-pack@2', evidence: [{ ref: 'pack:standard', version: 2 }] });
    // 旧的未处理提案保留，已接受的没被覆盖、也没有再提「所在城市」
    expect((await proposalRows(acme)).filter(p => p.targetId === 'field:customer.city')
      .map(p => [p.status, p.content])).toEqual([['accepted', { alias: '所在城市' }], ['proposed', { alias: '用户城市' }]]);
    const aliasRows = await getDb().select().from(knowledgeAliases).where(eq(knowledgeAliases.tenantId, acme));
    expect(aliasRows.filter(a => a.targetId === 'field:customer.city').map(a => a.alias)).toEqual(['所在城市']);
  });
});
