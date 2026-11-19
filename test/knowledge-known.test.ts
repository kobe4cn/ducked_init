// test/knowledge-known.test.ts —— 粘贴导入与按主题生成落库前比对已生效知识的纯函数 dropKnown（ADR-0046，#948，不碰库）：
// 同值别名（去空白、不分大小写）、同值口径声明（也和系统口径比）、同全文说明被丢掉计 skipped；取值不同的声明照常保留；
// 系统口径取值 unknown（派不出来）与需复核的成员声明（取值已改成 unknown、原值在 previous）不参与比较；subject 不过滤，
// 目录里没有的目标、带 mappingId 的提案不比
import { describe, expect, it } from 'vitest';
import type { CatalogEntry, EntityEntry, FieldEntry, MetricEntry } from '../app/.server/catalog';
import type { Claim, Knowledge } from '../app/.server/knowledge/catalog';
import { dropKnown } from '../app/.server/knowledge/known';
import type { ProposalInput } from '../app/.server/knowledge/proposals';

/** 手写目录输入里定义与模板所属的空间：目录只记录它，不按它过滤（ADR-0048） */
const SPACE = '00000000-0000-0000-0000-000000000000';

const entity = (name: string, knowledge?: Knowledge): EntityEntry => ({
  kind: 'entity', id: `entity:${name}`, name, description: '', entity: name, custom: false, key: ['id'], fields: [],
  tables: [], unscoped: [], relations: [], mergeGroups: [], stats: null, ...(knowledge ? { knowledge } : {}),
});

const field = (entityName: string, name: string, note?: string): FieldEntry => ({
  kind: 'field', id: `field:${entityName}.${name}`, name, description: '', entity: `entity:${entityName}`, field: name,
  type: 'decimal', lineage: [], ...(note !== undefined ? { note } : {}),
});

const metric = (key: string, system: Claim[], knowledge?: Knowledge): MetricEntry => ({
  kind: 'metric', id: `metric:${key}`, name: key, description: '', key, version: 1, spaceId: SPACE, base: 'order', measure: 'sum(amount)',
  dimensions: [], dependencies: { metrics: [], entities: [], fields: [] }, system: { text: '', claims: system },
  ...(knowledge ? { knowledge } : {}),
});

/** 一条提案输入（evidence 与 generatorVersion 不参与比较，给最简形状） */
const input = (kind: ProposalInput['kind'], targetId: string, content: unknown, mappingId: string | null = null): ProposalInput =>
  ({ targetId, mappingId, kind, content, evidence: [], generatorVersion: 'test' });

describe('dropKnown', () => {
  it('同值别名（大小写、空白不同）被丢掉，不同的别名保留', () => {
    const entries: CatalogEntry[] = [entity('order', { aliases: ['成交额', 'GMV'] })];
    const { inputs, skipped } = dropKnown([
      input('alias', 'entity:order', { alias: '成交额' }),
      input('alias', 'entity:order', { alias: ' gmv ' }),
      input('alias', 'entity:order', { alias: '净营收' }),
    ], entries);
    expect(inputs.map(i => i.content)).toEqual([{ alias: '净营收' }]);
    expect(skipped).toBe(2);
  });

  it('同类型同取值的成员声明被丢掉，也和系统口径比', () => {
    const entries: CatalogEntry[] = [
      metric('revenue', [{ type: 'time_meaning', value: 'order_time' }], { claims: [{ type: 'currency', value: 'CNY' }] }),
    ];
    const { inputs, skipped } = dropKnown([
      input('claim', 'metric:revenue', { type: 'currency', value: 'CNY' }),
      input('claim', 'metric:revenue', { type: 'time_meaning', value: 'order_time' }),
    ], entries);
    expect(inputs).toEqual([]);
    expect(skipped).toBe(2);
  });

  it('取值不同的声明照常保留：那是要人判断的冲突，不能丢', () => {
    const entries: CatalogEntry[] = [
      metric('revenue', [], { claims: [{ type: 'currency', value: 'CNY' }] }),
    ];
    const { inputs, skipped } = dropKnown([
      input('claim', 'metric:revenue', { type: 'currency', value: 'USD' }),
      input('claim', 'metric:revenue', { type: 'time_meaning', value: 'order_time' }), // 成员没声明过这个类型
    ], entries);
    expect(inputs.map(i => i.content)).toEqual([{ type: 'currency', value: 'USD' }, { type: 'time_meaning', value: 'order_time' }]);
    expect(skipped).toBe(0);
  });

  it('系统口径取值 unknown 是派不出来，不参与比较：取值 unknown 的提案不会被它丢掉', () => {
    const entries: CatalogEntry[] = [metric('revenue', [{ type: 'currency', value: 'unknown' }])];
    const { inputs, skipped } = dropKnown([input('claim', 'metric:revenue', { type: 'currency', value: 'unknown' })], entries);
    expect(inputs).toHaveLength(1);
    expect(skipped).toBe(0);
  });

  it('需复核的成员声明不参与比较：取值已改成 unknown、原值在 previous，两个取值都不比', () => {
    const entries: CatalogEntry[] = [
      metric('revenue', [], { claims: [{ type: 'unit', value: 'unknown', previous: 'currency_major', needsReview: true }] }),
    ];
    const { inputs, skipped } = dropKnown([
      input('claim', 'metric:revenue', { type: 'unit', value: 'unknown' }),
      input('claim', 'metric:revenue', { type: 'unit', value: 'currency_major' }),
    ], entries);
    expect(inputs).toHaveLength(2);
    expect(skipped).toBe(0);
  });

  it('成员声明的取值是 unknown（非需复核）时照常参与同值比较', () => {
    const entries: CatalogEntry[] = [metric('revenue', [], { claims: [{ type: 'currency', value: 'unknown' }] })];
    const { inputs, skipped } = dropKnown([input('claim', 'metric:revenue', { type: 'currency', value: 'unknown' })], entries);
    expect(inputs).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('说明按去空白后的全文比较：字段比条目顶层的 note，实体比挂载的 knowledge.note', () => {
    const entries: CatalogEntry[] = [
      field('order', 'amount', '下单时的金额'),
      // 字段的 knowledge.note 不是比对对象（字段的说明存在 business_notes、不进 knowledge），比对只看顶层 note
      { ...field('order', 'status', '订单当前状态'), knowledge: { note: '订单的历史状态' } },
      entity('customer', { note: '客户主数据' }),
    ];
    const { inputs, skipped } = dropKnown([
      input('note', 'field:order.amount', { note: ' 下单时的金额 ' }),
      input('note', 'field:order.status', { note: '订单的历史状态' }),
      input('note', 'entity:customer', { note: '客户主数据' }),
      input('note', 'entity:customer', { note: '客户主数据（历史）' }),
    ], entries);
    expect(inputs.map(i => [i.targetId, i.content])).toEqual([
      ['field:order.status', { note: '订单的历史状态' }],
      ['entity:customer', { note: '客户主数据（历史）' }],
    ]);
    expect(skipped).toBe(2);
  });

  it('主题归属不比；目录里没有的目标、带 mappingId 的映射字段提案照原样保留', () => {
    const entries: CatalogEntry[] = [entity('order', { aliases: ['成交额'] })];
    const { inputs, skipped } = dropKnown([
      input('subject', 'entity:order', { subjectId: SPACE }),
      input('alias', 'entity:nope', { alias: '成交额' }),
      input('alias', 'entity:order', { alias: '成交额' }, SPACE),
    ], entries);
    expect(inputs).toHaveLength(3);
    expect(skipped).toBe(0);
  });
});
