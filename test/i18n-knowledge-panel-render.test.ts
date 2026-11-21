// test/i18n-knowledge-panel-render.test.ts —— 知识面板组件接入双语（#1016，ADR-0060）的服务端渲染（纯函数，不连库）：
// 英文词典（en.client.json）经 I18nProvider 注入后渲染 KnowledgePanel 的典型状态（指标 / 实体 / 字段的系统事实、
// 五种知识提案、待复核的别名与口径声明、带历史的业务说明、已加入与未加入的分析主题、只读与空态、未发布），
// 界面文字不能有汉字；作为 props 传进来的数据（error、别名与说明正文、主题名、证据文字）是服务端返回的内容、
// 不算界面文字（随 #932 翻译），英文态全用 ASCII。semantic-claims 的类型 / 取值标签（单位、人民币等）是 app/lib
// 返回的中文、不在本票：mock 成 ASCII 透传（取值标签换成取值本身），当作数据去掉再做无汉字断言。
// 中文界面（词典 null）回退中文原文，输出与接入前一致（验收标准 2）。Form / Link 是 data router 组件，静态渲染里
// 没有上下文，vi.mock 掉 react-router（同 test/i18n-draft-components-render.test.ts），被测组件在 mock 之后导入
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, makeT } from '../app/lib/i18n';
import enClient from '../app/i18n/en.client.json';

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    Form: (props: { children?: ReactNode }) => createElement('form', { method: 'post' }, props.children),
    Link: (props: { to: string; children?: ReactNode }) => createElement('a', { href: props.to }, props.children),
  };
});

vi.mock('~/lib/semantic-claims', async importOriginal => {
  const actual = await importOriginal<typeof import('~/lib/semantic-claims')>();
  // 类型与取值的标签换成各自的代码（ASCII）：口径声明行只剩组件自己的文字
  const CLAIM_TYPES = Object.fromEntries(Object.entries(actual.CLAIM_TYPES).map(([type, def]) => [
    type, { label: type, values: def.values.map(v => ({ value: v.value, label: v.value })) },
  ])) as unknown as typeof actual.CLAIM_TYPES;
  return {
    ...actual,
    CLAIM_TYPES,
    claimTypeLabel: (type: string) => type,
    claimValueLabel: (_type: string, value: string) => value,
  };
});

// 被测组件要在 vi.mock 之后导入（vitest 会把 vi.mock 提升到文件顶部，写在后面即可）
import { KnowledgePanel, type PanelSystem } from '../app/components/knowledge-panel';
import type { EntityEntry, FieldEntry, MetricEntry } from '../app/.server/catalog';
import type { KnowledgePanel as Panel } from '../app/.server/knowledge/panel';

/** 指标的系统事实：覆盖基础实体 / 度量 / 维度 / 依赖 / 系统口径与派生的口径声明 */
const metricSystem: MetricEntry = {
  kind: 'metric', id: 'metric:paid_revenue', name: 'paid_revenue', description: 'sum of amount',
  key: 'paid_revenue', version: 1, base: 'order', spaceId: 'main', measure: 'sum(amount)', dimensions: ['channel'],
  dependencies: { metrics: [], entities: ['order'], fields: ['order.amount'] },
  system: { text: 'sum(amount) grouped by channel', claims: [{ type: 'currency', value: 'CNY' }] },
};

/** 实体的系统事实：覆盖字段（带与不带中文名）与关系 */
const entitySystem: EntityEntry = {
  kind: 'entity', id: 'entity:customer', name: 'customer', description: '', entity: 'customer', custom: false,
  key: ['customer_id'],
  fields: [
    { name: 'customer_id', label: 'Customer ID', type: 'string', description: '' },
    { name: 'status', label: 'status', type: 'string', description: '' },
  ],
  tables: ['crm.customers'], unscoped: [], relations: ['customer has many order'], mergeGroups: [],
  stats: { rows: 10, at: '2026-01-01T00:00:00Z' },
};

/** 映射字段的系统事实：覆盖类型 / 枚举 / 来源（字段面板 hideNote，说明在数据地图抽屉里编辑） */
const fieldSystem: FieldEntry = {
  kind: 'field', id: 'field:customer.status', name: 'status', description: '', entity: 'customer', field: 'status',
  type: 'string', enum: ['created', 'paid'],
  lineage: [{ source: 'crm', table: 'customers', expr: 'status', sourceColumns: ['status'], dictionary: false, sample: [] }],
};

/** 内容齐全的面板：可编辑、五种提案（含主题已删除的归入主题）、待复核的别名与口径声明、带历史的说明、已加入与未加入的主题 */
const fullPanel: Panel = {
  canEdit: true,
  aliases: [
    { id: 'a1', alias: 'paid total', needsReview: false },
    { id: 'a2', alias: 'net revenue', needsReview: true },
  ],
  claims: [
    { type: 'currency', value: 'CNY' },
    { type: 'unit', value: 'unknown', previous: 'count', needsReview: true },
  ],
  note: {
    current: 'paid orders only', needsReview: true,
    history: [
      { at: '2026-01-02T03:04:05Z', by: 'an@acme.com', note: '' },
      { at: '2026-02-03T04:05:06Z', by: 'eng@acme.com', note: 'first version' },
    ],
  },
  subjects: { all: [{ id: 's1', name: 'Retention' }, { id: 's2', name: 'Growth' }], memberOf: ['s1'] },
  proposals: [
    { id: 'p1', kind: 'alias', content: { alias: 'paid amount' }, evidence: [{ text: 'source note paragraph 3', href: '/knowledge/sources/src1?v=2#p3' }] },
    { id: 'p2', kind: 'claim', content: { type: 'currency', value: 'USD' }, evidence: [] },
    { id: 'p3', kind: 'note', content: { note: 'excludes refunds' }, evidence: [] },
    { id: 'p4', kind: 'subject', content: { subjectId: 's2' }, evidence: [] },
    { id: 'p5', kind: 'subject', content: { subjectId: 'gone' }, evidence: [] },
    { id: 'p6', kind: 'term_default', content: { term: 'revenue' }, evidence: [] },
  ],
};

/** 空面板（只读）：空态与「不能编辑时不渲染表单」 */
const emptyPanel: Panel = {
  canEdit: false, aliases: [], claims: [],
  note: { current: '', history: [], needsReview: false },
  subjects: { all: [], memberOf: [] }, proposals: [],
};

/** 空面板但可编辑：空态下的表单（选择取值、新别名、新建主题） */
const emptyEditablePanel: Panel = { ...emptyPanel, canEdit: true };

/** 几个典型状态 → 各自的静态 HTML；locale 决定出英文（词典已注入）还是回退中文原文 */
function states(locale: 'en' | 'zh-CN'): Record<string, string> {
  const t = makeT(locale, locale === 'en' ? enClient : null);
  const render = (node: ReactNode) => renderToStaticMarkup(createElement(I18nProvider, { t, locale, children: node }));
  // error 是上一次面板提交的服务端报错（数据，随 #932 翻译）：英文态用 ASCII
  const error = locale === 'en' ? 'this alias already exists' : '已有别名「净营收」';
  const panel = (system: PanelSystem, p: Panel | null, props: { error?: string | null; hideNote?: boolean } = {}) =>
    render(createElement(KnowledgePanel, { system, panel: p, targetId: 'metric:paid_revenue', error: props.error ?? null, hideNote: props.hideNote }));
  return {
    指标内容齐全: panel(metricSystem, fullPanel, { error }),
    实体只读空态: panel(entitySystem, emptyPanel),
    字段可编辑空态: panel(fieldSystem, emptyEditablePanel, { hideNote: true }),
    未发布: panel(metricSystem, null),
  };
}

describe('知识面板的双语渲染', () => {
  it('英文界面：典型状态的界面文字全英文，没有汉字；条目内容保持原文', () => {
    for (const [name, html] of Object.entries(states('en'))) {
      expect(html, name).not.toMatch(/[一-鿿]/);
    }
    const full = states('en').指标内容齐全;
    // 各区的标题、状态、按钮与空态（不是只渲染出了空壳）
    expect(full).toContain('Business Knowledge');
    expect(full).toContain('System facts');
    expect(full).toContain('System definition');
    expect(full).toContain('Knowledge from members');
    expect(full).toContain('Knowledge proposals to confirm');
    expect(full).toContain('To confirm');
    expect(full).toContain('Evidence: ');
    expect(full).toContain('Accept with edits');
    expect(full).toContain('Pending review');
    expect(full).toContain('In effect');
    expect(full).toContain('unit: unknown (pending review; was count)');
    expect(full).toContain('time_meaning: not declared');
    expect(full).toContain('“revenue” defaults to this entry');
    expect(full).toContain('Deleted subject');
    expect(full).toContain('History (2 versions)');
    expect(full).toContain('(cleared)');
    const entity = states('en').实体只读空态;
    expect(entity).toContain('Customer ID (customer_id)');
    expect(entity).toContain('No aliases yet');
    expect(entity).toContain('No business note yet');
    expect(entity).toContain('Not in any analysis subject yet');
    const field = states('en').字段可编辑空态;
    expect(field).toContain('Source');
    expect(field).toContain('Enum values');
    expect(field).toContain('Choose a value');
    expect(field).toContain('New subject name, up to 30 characters');
    expect(states('en').未发布).toContain('Business knowledge can be added once the definition is published');
  });

  it('中文界面：词典不下发、按原文回退，输出与接入前一致', () => {
    const full = states('zh-CN').指标内容齐全;
    expect(full).toContain('业务知识');
    expect(full).toContain('系统事实');
    expect(full).toContain('系统口径');
    expect(full).toContain('成员写的知识');
    expect(full).toContain('待确认的知识提案');
    expect(full).toContain('待确认');
    expect(full).toContain('别名：paid amount');
    expect(full).toContain('证据：');
    expect(full).toContain('修改后接受');
    expect(full).toContain('拒绝理由，最多 500 字');
    expect(full).toContain('待复核');
    expect(full).toContain('已生效');
    expect(full).toContain('unit：unknown（待复核，原为 count）');
    expect(full).toContain('time_meaning：未声明');
    expect(full).toContain('『revenue』默认指这一条');
    expect(full).toContain('已删除的主题');
    expect(full).toContain('业务说明');
    expect(full).toContain('历史（2 版）');
    expect(full).toContain('（已清空）');
    expect(full).toContain('分析主题');
    expect(full).toContain(`>已有别名「净营收」<`);
    const entity = states('zh-CN').实体只读空态;
    expect(entity).toContain('Customer ID（customer_id）');
    expect(entity).toContain('还没有别名');
    expect(entity).toContain('还没有业务说明');
    expect(entity).toContain('还没有加入分析主题');
    const field = states('zh-CN').字段可编辑空态;
    expect(field).toContain('来源');
    expect(field).toContain('枚举');
    expect(field).toContain('选择取值');
    expect(field).toContain('新主题名，最多 30 字');
    expect(states('zh-CN').未发布).toContain('发布后才能添加业务知识');
  });
});
