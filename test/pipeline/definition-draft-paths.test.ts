// test/pipeline/definition-draft-paths.test.ts —— 模型起草的指标定义补路径首段的实体名（#367，ADR-0035，纯函数）：
// `->` 路径首段没写实体名时按 base 补成 <base>.<字段> 再转 YAML，补全后能过 checkMetric；校验本身不放宽，传入的对象不改
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { checkMetric } from '../../app/.server/pipeline/dsl/metric-spec';
import { completeDraftPaths, definitionOutputToYaml } from '../../app/.server/pipeline/dsl/model-draft';
import { CONTEXT } from '../../scripts/eval-requirements/golden';

const BY_CITY = { base: 'order', measure: { agg: 'sum', field: 'amount' }, dimensions: [{ name: 'city', path: 'customer_id -> customer.city' }] };
const ITEM_WINDOW = { base: 'order_item', measure: { agg: 'count_distinct', field: 'product_id' }, window: { field: 'order_id -> order.created_at', days: 180 } };

describe('起草的指标补路径首段的实体名', () => {
  it('维度路径首段补成 order.customer_id，补全后过校验', () => {
    const yaml = definitionOutputToYaml('metric', BY_CITY);
    expect(yaml).toContain('order.customer_id -> customer.city');
    const r = checkMetric(yaml, CONTEXT);
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it('时间窗口路径首段补成 order_item.order_id，补全后过校验', () => {
    const yaml = definitionOutputToYaml('metric', ITEM_WINDOW);
    expect(yaml).toContain('order_item.order_id -> order.created_at');
    const r = checkMetric(yaml, CONTEXT);
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it('校验没放宽：没补全的定义直接校验仍报「每一段要写成 实体.字段」', () => {
    for (const spec of [BY_CITY, ITEM_WINDOW]) {
      const r = checkMetric(stringify(spec), CONTEXT);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.map(i => i.message).join('\n')).toContain('每一段要写成 实体.字段');
    }
  });

  it('ratio 分子的过滤字段也补全，已有实体名与裸字段不动，传入的对象不改', () => {
    const output = {
      base: 'order_item',
      measure: {
        agg: 'ratio',
        numerator: { agg: 'count_distinct', field: 'order_id', filter: [{ field: 'order_id -> order.status', op: 'eq', value: 'refunded' }] },
        denominator: { agg: 'count_distinct', field: 'order_id' },
      },
      filter: [{ field: 'order.status', op: 'eq', value: 'paid' }, { field: 'quantity', op: 'gt', value: 0 }],
    };
    const before = structuredClone(output);
    const done = completeDraftPaths('metric', output) as typeof output;
    expect(done.measure.numerator.filter[0]!.field).toBe('order_item.order_id -> order.status');
    expect(done.filter.map(c => c.field)).toEqual(['order.status', 'quantity']);
    expect(output).toEqual(before);
  });

  it('标签原样返回', () => {
    const tag = { metric: 'x', rules: [] };
    expect(completeDraftPaths('tag', tag)).toBe(tag);
  });
});
