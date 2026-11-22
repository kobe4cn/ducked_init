// test/i18n-metric-builder-render.test.ts —— 指标构建器与一句话解析面板的静态渲染（#1053，纯函数，不连库）：
// 英文界面下两个组件写死的界面文字没有汉字：聚合 / 分子分母 / 过滤运算下拉的说明查组件内的字面量 t() 对照表
// （metric-vocab 的 AGG_TEXT 等词表是数据不接翻译，照 mapping-functions-text 的做法），解析面板的位置（条件第 N 行等）
// 与固定说明按界面语言；模型写的说明（items[].reason）与路由传的实体 / 字段名是数据，不在本票翻译。
// 提交进隐藏字段 form 的表单值不随界面语言变化。两个组件不引 react-router，静态渲染不需要 mock；
// 中文界面（词典不下发）的输出与改造前的中文一致（夹具全 ASCII，输出里的汉字就只剩组件写死的界面文字）
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MetricBuilder, type BuilderEntity } from '../app/components/metric-builder';
import { MetricParsePanel, type FormDiff, type MetricParseResult } from '../app/components/metric-parse-panel';
import { I18nProvider, makeT } from '../app/lib/i18n';
import type { MetricForm } from '../app/lib/metric-form';
import enClient from '../app/i18n/en.client.json';

const HAN = /[一-鿿]/;
/** 按界面语言静态渲染；中文界面词典传 null（词典未下发），与真实中文界面一致 */
const render = (locale: 'en' | 'zh-CN', node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { t: makeT(locale, locale === 'en' ? enClient : null), locale, children: node }));

const ENTITIES: BuilderEntity[] = [{
  name: 'order', label: 'Order',
  fields: [
    { name: 'order_id', type: 'string' },
    { name: 'amount', type: 'decimal' },
    { name: 'status', type: 'string', enum: ['paid', 'pending'] },
    { name: 'placed_at', type: 'timestamp' },
  ],
}];

/** sum + 一条 eq 过滤 + 窗口：聚合、字段、条件行（字段 / 运算 / 取值）与时间窗口的控件都渲染出来 */
const SUM_FORM: MetricForm = {
  base: 'order', agg: 'sum', field: 'amount',
  filter: [{ field: 'status', op: 'eq', value: 'paid' }],
  window: { field: 'placed_at', days: 30 },
  dimensions: [], readonly: [],
};

/** ratio：分子、分母两块（各自的聚合与字段下拉、条件行） */
const RATIO_FORM: MetricForm = {
  base: 'order', agg: 'ratio',
  numerator: { agg: 'count', filter: [{ field: 'status', op: 'not_null' }] },
  denominator: { agg: 'sum', field: 'amount', filter: [] },
  filter: [], dimensions: [], readonly: [],
};

/** 解析面板：四块全渲染（items 的 reason 是模型写的说明，不翻，夹具用 ASCII 代替） */
const PARSE: MetricParseResult = {
  items: [{ path: 'measure', reason: 'model note' }, { path: 'filter.1', reason: 'model note' }, { path: 'window', reason: 'model note' }],
  unknowns: ['nope'],
  unsupported: ['either A or B'],
  dropped: ['region', 'channel'],
};
const DIFF: readonly FormDiff[] = [{ before: '', after: 'Counts the number of rows.' }];

describe('英文界面：指标构建器', () => {
  it('标签、说明、占位与按钮是英文，聚合与过滤运算下拉的选项是英文，整页没有汉字', () => {
    const html = render('en', createElement(MetricBuilder, { entities: ENTITIES, defaultForm: SUM_FORM }));
    expect(html).not.toMatch(HAN);
    expect(html).toContain('Base entity');
    expect(html).toContain('Aggregate');
    expect(html).toContain('Filters (all listed conditions must hold)');
    expect(html).toContain('Time window (optional)');
    expect(html).toContain('Add a row');
    expect(html).toContain('Delete this row');
    // 聚合下拉：选项说明查组件内对照表（词表 AGG_TEXT 是数据不接翻译）
    expect(html).toContain('Sum of a field (numeric)');
    expect(html).toContain('Rows; with a field, counts only rows where the field is not null');
    // 条件行：字段 / 运算 / 取值（enum 下拉）三段与占位
    expect(html).toContain('(Select a field)');
    expect(html).toContain('equals a value');
    expect(html).toContain('(Select)');
    // 时间窗口：字段下拉的「不限时间」与「近 N 天」的近 / 天
    expect(html).toContain('No time window');
    expect(html).toContain('Last');
    expect(html).toContain('days');
  });

  it('ratio 的分子、分母两块是英文：标题、aria-label、聚合选项与「不选（数行数）」', () => {
    const html = render('en', createElement(MetricBuilder, { entities: ENTITIES, defaultForm: RATIO_FORM }));
    expect(html).not.toMatch(HAN);
    expect(html).toContain('Numerator');
    expect(html).toContain('Denominator');
    expect(html).toContain('aria-label="Numerator aggregate"');
    expect(html).toContain('aria-label="Denominator field"');
    expect(html).toContain('The numerator or denominator is the number of rows');
    expect(html).toContain('The numerator or denominator is the sum of a field');
    expect(html).toContain('None (count rows)');
  });
});

describe('英文界面：一句话解析面板', () => {
  it('四块都是英文：位置（条件第 N 行、计算什么、时间窗口、分子、分母）、固定说明与（空），没有汉字', () => {
    const html = render('en', createElement(MetricParsePanel, { parse: PARSE, diff: DIFF }));
    expect(html).not.toMatch(HAN);
    expect(html).toContain('Item-by-item notes');
    expect(html).toContain('What is calculated: model note');
    expect(html).toContain('Condition row 2: model note');
    expect(html).toContain('Time window: model note');
    expect(html).toContain('Phrases not recognized');
    expect(html).toContain('Unsupported phrases');
    expect(html).toContain('Why not');
    expect(html).toContain('(empty)');
    expect(html).toContain('Differences from the current form');
    expect(html).toContain('region, channel');
  });
});

describe('提交的表单值不因界面语言改变', () => {
  it('隐藏字段 form 的序列化结果两种语言相同（聚合、字段、条件原样）', () => {
    const value = '&quot;base&quot;:&quot;order&quot;';
    expect(render('en', createElement(MetricBuilder, { entities: ENTITIES, defaultForm: SUM_FORM }))).toContain(value);
    expect(render('zh-CN', createElement(MetricBuilder, { entities: ENTITIES, defaultForm: SUM_FORM }))).toContain(value);
  });
});

describe('中文界面输出与改造前一致', () => {
  it('构建器仍是原文：标签、聚合与运算选项、占位、按钮与说明', () => {
    const html = render('zh-CN', createElement(MetricBuilder, { entities: ENTITIES, defaultForm: SUM_FORM }));
    expect(html).toContain('基础实体');
    expect(html).toContain('聚合');
    expect(html).toContain('过滤条件（列出的条件全部满足）');
    expect(html).toContain('时间窗口（可不填）');
    expect(html).toContain('（请选择字段）');
    expect(html).toContain('等于 value');
    expect(html).toContain('field（数字）求和');
    expect(html).toContain('行数；写了 field 时只数 field 不为空的行');
    expect(html).toContain('不限时间');
    expect(html).toContain('添加一行');
    expect(html).toContain('删除这一行');
    expect(html).toContain('按 asOf（统计日）往前数自然日：只算窗口字段在这个范围内的记录。');
  });

  it('解析面板仍是原文：四块的标题、位置与固定说明', () => {
    const html = render('zh-CN', createElement(MetricParsePanel, { parse: PARSE, diff: DIFF }));
    expect(html).toContain('逐项说明');
    expect(html).toContain('计算什么：model note');
    expect(html).toContain('条件第 2 行：model note');
    expect(html).toContain('时间窗口：model note');
    expect(html).toContain('没认出的说法');
    expect(html).toContain('支持不了的说法');
    expect(html).toContain('（空）');
    expect(html).toContain('和当前表单的差异（点「确认覆盖」才会替换）');
    expect(html).toContain('以下维度构建器不支持，没有填入：region、channel。要按维度拆开，请在 YAML 模式里写。');
  });
});
