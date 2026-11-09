// 标签构建器的服务端渲染（纯函数，#518）：数字框清空后状态里是 NaN——比较数字与「按数值」框都显示为空（不显示 NaN / 0），
// 隐藏字段 form 里 NaN 的比较丢掉、NaN 的 missing 当缺省不写（不能被 JSON 写成 null 变成「记空」）；负数原样显示与序列化
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TagBuilder } from '../app/components/tag-builder';
import type { TagForm } from '../app/lib/tag-form';

const metrics = [{ key: 'revenue', label: '消费金额' }, { key: 'orders', label: 'orders' }];
const render = (form: TagForm) => renderToStaticMarkup(createElement(TagBuilder, { metrics, defaultForm: form }));
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const hidden = (html: string) => JSON.parse(decode(/name="form" value="([^"]*)"/.exec(html)![1]!)) as TagForm;
const inputValue = (html: string, label: string) => new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0].match(/value="([^"]*)"/)?.[1];

describe('TagBuilder 数字框', () => {
  it('清空（NaN）的比较数字显示为空，序列化时这条比较丢掉', () => {
    const html = render({
      single: false, missing: {}, default: 'low', readonly: [],
      rules: [{ value: 'high', combinator: 'all', items: [
        { metric: 'revenue', cmp: [{ op: 'gte', value: Number.NaN }] },
        { metric: 'orders', cmp: [{ op: 'gte', value: -5 }] },
      ] }],
    });
    const values = [...html.matchAll(/<input[^>]*aria-label="比较数字"[^>]*>/g)].map(m => m[0].match(/value="([^"]*)"/)?.[1] ?? '');
    expect(values).toEqual(['', '-5']);
    expect(hidden(html).rules).toEqual([{ value: 'high', combinator: 'all', items: [{ metric: 'orders', cmp: [{ op: 'gte', value: -5 }] }] }]);
  });

  it('「按数值」框清空（NaN）显示为空，序列化时这个指标的 missing 当缺省不写（不是记空）', () => {
    const html = render({
      single: false, missing: { revenue: Number.NaN, orders: null }, default: 'low', readonly: [],
      rules: [{ value: 'high', combinator: 'all', items: [
        { metric: 'revenue', cmp: [{ op: 'gte', value: 1 }] },
        { metric: 'orders', cmp: [{ op: 'gte', value: 1 }] },
      ] }],
    });
    expect(inputValue(html, '消费金额 的缺省数值')).toBe('');
    expect(hidden(html).missing).toEqual({ orders: null });
  });
});
