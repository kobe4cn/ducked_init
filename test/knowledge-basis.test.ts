// test/knowledge-basis.test.ts —— 业务知识的依据摘要（ADR-0046）：稳定 JSON 与指标、标签、映射计划的摘要（纯函数）
import { describe, expect, it } from 'vitest';
import { definitionHash, planHash, stableJson } from '../app/.server/knowledge/basis';
import type { MergeMappingParam } from '../app/.server/pipeline/merge-engine';

const plan = (over: Partial<MergeMappingParam> = {}): MergeMappingParam => ({
  mapping: 'm-order', version: 3, sourceId: 's-shop', entity: 'order', table: 'orders',
  columns: [
    { name: 'order_id', type: 'string', expr: 'string(order_id)' },
    { name: 'status', type: 'string', expr: 'state', enum: ['paid', 'refunded'] },
  ],
  entityColumns: [], key: ['order_id'], latest: null,
  ...over,
});

describe('依据摘要', () => {
  it('稳定 JSON：对象键顺序不同结果相同，数组顺序照旧', () => {
    expect(stableJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(stableJson({ a: { c: null, d: [2, 1] }, b: 1 }));
    expect(stableJson({ a: { c: null, d: [2, 1] }, b: 1 })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });

  it('指标与标签的摘要：同一份 YAML 不变，内容一改就变', () => {
    const yaml = 'base: order\nmeasure: { agg: sum, field: amount }\n';
    expect(definitionHash(yaml)).toBe(definitionHash(yaml));
    expect(definitionHash(yaml)).toMatch(/^[0-9a-f]{64}$/);
    expect(definitionHash(yaml.replace('sum', 'avg'))).not.toBe(definitionHash(yaml));
  });

  it('映射计划的摘要：键顺序、版本号、源视图版本号、合并组与实体主键不影响，列、表达式或源视图 SQL 一改就变', () => {
    const h = planHash(plan());
    expect(planHash(plan())).toBe(h);
    const reordered = Object.fromEntries(Object.entries(plan()).reverse()) as MergeMappingParam;
    expect(planHash(reordered)).toBe(h);
    expect(planHash(plan({ version: 4 }))).toBe(h);
    expect(planHash(plan({ group: { id: 'g', rule: { kind: 'priority' }, key: ['order_id'], members: [] } }))).toBe(h);
    expect(planHash(plan({ uniqueKey: ['order_id'], uniqueBySource: true }))).toBe(h);
    const view = (version: number, sql: string) => plan({ sourceView: { version, sql, tables: ['orders'] } });
    expect(planHash(view(2, 'select 1'))).toBe(planHash(view(1, 'select 1')));
    expect(planHash(view(1, 'select 2'))).not.toBe(planHash(view(1, 'select 1')));
    expect(planHash(plan({ columns: [{ name: 'order_id', type: 'string', expr: 'string(no)' }] }))).not.toBe(h);
    expect(planHash(plan({ table: 'orders_v2' }))).not.toBe(h);
  });
});
