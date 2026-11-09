// test/tag-form.test.ts —— 标签表单 ↔ TagSpec YAML 互转（纯函数，不碰库，ADR-0025 / 0017）：单指标与多指标（all / any 一层）的表单经 formToYaml
// 过 checkTag、yamlToForm 读回与原表单相等（往返不丢信息：取值保原类型，missing 只写引用到的指标，同一 item 多个比较是 AND）；
// 表单表达不了的写法（all 与 any 同写、未知键、嵌套、比较值不是数字、整份坏 YAML）整条规则或整个键标成只读并说明原因，raw 原样写回后与原定义深相等
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { checkMetric, type DslContext } from '../app/.server/pipeline/dsl/metric-spec';
import { checkTag } from '../app/.server/pipeline/dsl/tag-spec';
import { formToYaml, yamlToForm, type TagForm } from '../app/lib/tag-form';
import { TAG_CONDITIONS, TAG_CONDITION_TEXT } from '../app/lib/tag-vocab';

// ctx 抄 test/tag-spec.test.ts：引用的指标要已发布、没有维度、取值为数字（min / max 的字段是时间就不行）
const base: DslContext = { published: new Map(), plans: [], metrics: new Map() };
const ctx: DslContext = {
  ...base,
  metrics: new Map([
    ['revenue', checkMetric('base: order\nmeasure: { agg: sum, field: amount }\n', base)],
    ['orders', checkMetric('base: order\nmeasure: { agg: count }\n', base)],
    ['last_order_at', checkMetric('base: order\nmeasure: { agg: max, field: created_at }\n', base)],
  ]),
};

const empty: Pick<TagForm, 'rules' | 'missing' | 'readonly'> = { rules: [], missing: {}, readonly: [] };

/** 表单 → YAML 过 checkTag，再读回与原表单相等 */
function roundTrip(form: TagForm) {
  const yaml = formToYaml(form);
  expect(checkTag(yaml, ctx).ok, yaml).toBe(true);
  expect(yamlToForm(yaml), yaml).toEqual(form);
}

describe('表单 ↔ YAML 往返', () => {
  it('单指标：每条规则一个 item，指标写在顶层；同一 item 多个比较（AND）按词表顺序读回', () => {
    roundTrip({
      single: true, metric: 'revenue',
      rules: [
        { value: 'high', combinator: 'all', items: [{ metric: 'revenue', cmp: [{ op: 'gte', value: 1000 }] }] },
        { value: 'mid', combinator: 'all', items: [{ metric: 'revenue', cmp: [{ op: 'gte', value: 100 }, { op: 'lt', value: 1000 }] }] },
      ],
      missing: {}, default: 'low', readonly: [],
    });
  });

  it('多指标：all 与 any 各一层；取值是 number 时写成数字', () => {
    roundTrip({
      single: false,
      rules: [
        { value: 1, combinator: 'all', items: [
          { metric: 'revenue', cmp: [{ op: 'gte', value: 1000 }] },
          { metric: 'orders', cmp: [{ op: 'gte', value: 3 }] },
        ] },
        { value: 2, combinator: 'any', items: [
          { metric: 'revenue', cmp: [{ op: 'gt', value: 2000 }] },
          { metric: 'orders', cmp: [{ op: 'gt', value: 0 }, { op: 'eq', value: 10 }] },
        ] },
      ],
      missing: {}, default: 0, readonly: [],
    });
  });

  it('missing 三态：不写（缺省）、数字、null（记空）；只写规则里引用到的指标', () => {
    roundTrip({
      single: false,
      rules: [{ value: 'high', combinator: 'any', items: [
        { metric: 'revenue', cmp: [{ op: 'gte', value: 1000 }] },
        { metric: 'orders', cmp: [{ op: 'gte', value: 3 }] },
      ] }],
      missing: { revenue: null, orders: 0 }, default: 'low', readonly: [],
    });
    // orders 引用了但没写 missing（缺省）；没被规则引用的指标不该写进 missing（写了会被校验拦下）
    const yaml = formToYaml({
      single: false,
      rules: [{ value: 'high', combinator: 'all', items: [
        { metric: 'revenue', cmp: [{ op: 'gte', value: 100 }] },
        { metric: 'orders', cmp: [{ op: 'gte', value: 1 }] },
      ] }],
      missing: { revenue: 5, last_order_at: 1 }, default: 'low', readonly: [],
    });
    expect(checkTag(yaml, ctx).ok, yaml).toBe(true);
    expect(parse(yaml)).toMatchObject({ missing: { revenue: 5 } });
  });

  it('空规则、空 item、空比较丢掉；default 为空串原样写出（交给 checkTag 拦），description 带上', () => {
    const yaml = formToYaml({
      single: false,
      rules: [
        { value: '', combinator: 'all', items: [{ metric: 'revenue', cmp: [{ op: 'gte', value: 1 }] }] },
        { value: 'high', combinator: 'all', items: [{ metric: 'revenue', cmp: [] }, { metric: '', cmp: [{ op: 'gte', value: 1 }] }] },
        { value: 'ok', combinator: 'any', items: [{ metric: 'revenue', cmp: [{ op: 'gte', value: 1 }, { op: 'eq', value: Number.NaN }] }] },
      ],
      missing: {}, default: '', description: '按消费金额分层', readonly: [],
    });
    expect(checkTag(yaml, ctx).ok).toBe(false); // default 为空被拦，不替客户端编一个
    expect(parse(yaml)).toEqual({
      rules: [{ value: 'ok', when: { any: [{ metric: 'revenue', gte: 1 }] } }], // NaN 的比较丢掉，还剩一个比较的规则留下
      default: '',
      description: '按消费金额分层',
    });
  });

  it('value / default 输入是纯数字时写成 number，否则 string；yamlToForm 保留原类型', () => {
    const yaml = formToYaml({
      single: true, metric: 'revenue',
      rules: [{ value: '100', combinator: 'all', items: [{ metric: 'revenue', cmp: [{ op: 'gte', value: 99 }] }] }],
      missing: {}, default: '低', readonly: [],
    });
    expect(parse(yaml)).toEqual({ metric: 'revenue', rules: [{ value: 100, when: { gte: 99 } }], default: '低' });
  });
});

describe('表单表达不了的写法只读', () => {
  it('all 与 any 同写、未知键、嵌套、比较值不是数字：整条规则只读，raw 原样写回后与原定义深相等', () => {
    const yaml = `metric: revenue
rules:
  - value: high
    when:
      all: [{ metric: revenue, gte: 1000 }]
      any: [{ metric: orders, gte: 3 }]
  - value: mid
    when: { gte: 100, unknown: 1 }
  - value: nested
    when:
      all: [{ metric: revenue, gte: { gte: 1 } }]
default: low
`;
    const form = yamlToForm(yaml);
    expect(form.single).toBe(true);
    expect(form.rules).toEqual([]);
    expect(form.readonly.map(r => r.key)).toEqual(['rules.0', 'rules.1', 'rules.2']);
    for (const r of form.readonly) expect(r.reason, r.key).toContain('请在 YAML 里修改');
    const out = formToYaml(form);
    // 标签的 Schema 很严（additionalProperties 全关）：认不出的写法本身就不合法，写回后原样保留、仍由 checkTag 拦下，不悄悄改写
    expect(checkTag(out, ctx).ok, out).toBe(false);
    expect(parse(out), out).toEqual(parse(yaml));
  });

  it('不认识的顶层键与 missing 的非数字取值只读；写回不丢', () => {
    const yaml = `unknown_top: yes
rules:
  - value: high
    when: { all: [{ metric: revenue, gte: 1000 }] }
missing: { revenue: 很多 }
default: low
`;
    const form = yamlToForm(yaml);
    expect(form.readonly.map(r => r.key)).toEqual(['unknown_top', 'missing']);
    expect(form.missing).toEqual({});
    expect(parse(formToYaml(form))).toEqual(parse(yaml));
  });

  it('整份读不出（YAML 语法错误、顶层不是对象、rules 不是列表）时 key 为 $yaml 或对应键，原样写回', () => {
    const bad = 'rules: [';
    expect(yamlToForm(bad)).toMatchObject({ readonly: [{ key: '$yaml' }] });
    expect(formToYaml(yamlToForm(bad))).toBe(bad);
    const list = '- a\n- b\n';
    expect(yamlToForm(list)).toMatchObject({ readonly: [{ key: '$yaml' }] });
    expect(yamlToForm('rules: 3\ndefault: low\n')).toMatchObject({ rules: [], readonly: [{ key: 'rules' }] });
  });

  it('多指标的 when 是平铺比较（不是 all / any）时也只读：表单没有这种写法', () => {
    const yaml = `rules:
  - value: high
    when: { gte: 100 }
default: low
`;
    const form = yamlToForm(yaml);
    expect(form.rules).toEqual([]);
    expect(form.readonly.map(r => r.key)).toEqual(['rules.0']);
    expect(parse(formToYaml(form))).toEqual(parse(yaml));
  });

  it('只被只读规则引用的指标，missing 里的取值写回不丢', () => {
    const yaml = `rules:
  - value: a
    when: { all: [{ metric: foo, gte: 1 }, { any: [] }] }
  - value: b
    when: { any: [{ metric: bar, gte: 2 }] }
missing: { foo: 0, bar: null }
default: c
`;
    const form = yamlToForm(yaml);
    expect(form.readonly.map(r => r.key)).toEqual(['rules.0']);
    expect(parse(formToYaml(form))).toEqual(parse(yaml));
  });

  it('顶层 metric 不是字符串时只读，写回原样保留（非法值交给 checkTag 拦）', () => {
    const yaml = `metric: 5
rules:
  - value: a
    when: { all: [{ metric: foo, gte: 1 }] }
default: c
`;
    const form = yamlToForm(yaml);
    expect(form.readonly.map(r => r.key)).toContain('metric');
    const out = formToYaml(form);
    expect(parse(out), out).toEqual(parse(yaml));
  });
});

describe('词汇表', () => {
  it('比较运算与中文说明一一对应（表单下拉直接用）', () => {
    expect(TAG_CONDITIONS).toEqual(['gte', 'gt', 'lte', 'lt', 'eq']);
    expect(Object.keys(TAG_CONDITION_TEXT)).toEqual([...TAG_CONDITIONS]);
  });
});
