// test/i18n-lineage-components-render.test.ts —— 数据地图公共组件接入双语（#1018，ADR-0060）的服务端渲染（纯函数，不连库）：
// 英文词典（en.client.json）经 I18nProvider 注入后渲染 RelationStatsCard / StatLine，两个图组件（RelationGraphView /
// FlowGraphView）依赖 @xyflow/react、服务端渲染只出空 div，改为直接渲染导出的 nodeLabel(...)（t 与 locale 作参数传入）。
// 界面文字不能有汉字；血缘图的标准实体名显示英文（Customer（customer））、自定义实体名（label 就是 id）原样，
// 关系统计卡的关系文字仍是英文 id（relationText 不翻译，还是 key 与 data-relation-stat）。作为 props 传进来的数据
// （统计失败的 error、样例键）是服务端返回的内容、不算界面文字，英文夹具里全用 ASCII。
// 中文界面（词典 null）回退中文原文，输出与接入前一致（验收标准 2），特别是「孤儿 20%（2 / 10 行）」的逐字格式
// （test/http/custom-entities.test.ts 用正则断言它）。MergeStatus 的 MERGE_STATUS（app/lib/lineage-flow.ts）与
// ruleLabels / identityChangesLabel（app/lib/lineage-graph.ts）的中文随 #932，不在本票：夹具不给 rules、merged / split，
// 也不渲染 mapping 节点。Link 是 data router 组件，静态渲染里没有上下文，vi.mock 掉（同 test/i18n-draft-components-render.test.ts），
// 被测组件在 mock 之后导入
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider, makeT } from '../app/lib/i18n';
import enClient from '../app/i18n/en.client.json';

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    Link: (props: { to: string; children?: ReactNode }) => createElement('a', { href: props.to }, props.children),
  };
});

// 被测组件要在 vi.mock 之后导入（vitest 会把 vi.mock 提升到文件顶部，写在后面即可）
import { RelationStatsCard, StatLine } from '../app/components/relation-stats-card';
import { nodeLabel as graphNodeLabel } from '../app/components/lineage-graph';
import { nodeLabel as flowNodeLabel } from '../app/components/lineage-flow';
import type { GraphNode } from '../app/lib/lineage-graph';
import type { RelationStat } from '../app/lib/canonical-model';

/** 一条关系的统计：起点 custom_redeem.customer_id → 终点 customer.customer_id（relationText 的输出是英文 id，不翻译） */
const stat = (over: { withValue: number; orphans: number; samples: string[] } | { status: 'unmerged' } | { error: string }): RelationStat =>
  ({ from: { entity: 'custom_redeem', field: 'customer_id' }, ref: { entity: 'customer', field: 'customer_id' }, ...over });

/** 两个图组件的节点夹具：不给 rules / merged / split，避开随 #932 翻译的 ruleLabels 与 identityChangesLabel 的中文 */
const graphNode = (over: Partial<GraphNode> & Pick<GraphNode, 'id' | 'label' | 'kind'>): GraphNode =>
  ({ connected: true, x: 0, y: 0, width: 180, height: 56, ...over });
const identity = { rules: null, summary: { groups: 12345, records: 678901, merged: 0, split: 0 } };

/** 组件与 nodeLabel 的典型状态 → 各自的静态 HTML；locale 决定出英文（词典已注入）还是回退中文原文 */
function states(l: 'en' | 'zh-CN'): Record<string, string> {
  const t = makeT(l, l === 'en' ? enClient : null);
  const render = (node: ReactNode) => renderToStaticMarkup(createElement(I18nProvider, { t, locale: l, children: node }));
  const flow = (d: Parameters<typeof flowNodeLabel>[0], tableCount: Record<string, number> = {}) =>
    renderToStaticMarkup(flowNodeLabel(d, tableCount, {}, t, l));
  return {
    关系卡: render(createElement(RelationStatsCard, {
      relations: [stat({ status: 'unmerged' }), stat({ error: 'boom' }), stat({ withValue: 10, orphans: 2, samples: ['S8', 'S9'] })],
      at: '2026-11-01T08:09:10.000Z',
    })),
    关系卡无合并: render(createElement(RelationStatsCard, { relations: [stat({ withValue: 4, orphans: 0, samples: [] })], at: null })),
    单条未合并: render(createElement(StatLine, { stat: stat({ status: 'unmerged' }) })),
    单条失败: render(createElement(StatLine, { stat: stat({ error: 'boom' }) })),
    单条孤儿: render(createElement(StatLine, { stat: stat({ withValue: 10, orphans: 2, samples: ['S8', 'S9'] }) })),
    图_标准实体: renderToStaticMarkup(graphNodeLabel(graphNode({ id: 'customer', label: '消费者', kind: 'entity' }), undefined, t, l)),
    图_自定义实体: renderToStaticMarkup(graphNodeLabel(graphNode({ id: 'custom_redeem', label: 'custom_redeem', kind: 'entity' }), undefined, t, l)),
    图_身份有摘要: renderToStaticMarkup(graphNodeLabel(graphNode({ id: '_identities', label: '_identities', kind: 'identity', identity }), undefined, t, l)),
    图_身份无摘要: renderToStaticMarkup(graphNodeLabel(graphNode({ id: '_identities', label: '_identities', kind: 'identity', identity: { rules: null, summary: null } }), undefined, t, l)),
    流_折叠源: flow({ kind: 'source', label: 'Shop DB', sourceId: 's1', sourceKind: 'postgres', collapsed: true }, { s1: 3 }),
    流_折叠源单表: flow({ kind: 'source', label: 'Shop DB', sourceId: 's1', sourceKind: 'postgres', collapsed: true }, { s1: 1 }),
    流_源视图: flow({ kind: 'table', label: 'customers_v2', viaView: true }),
    流_标准层表: flow({ kind: 'silver', label: 'silver.customer', entity: 'customer', rows: 12345, mappings: 3 }),
    流_标准层表单数: flow({ kind: 'silver', label: 'silver.order', entity: 'order', rows: 1, mappings: 1 }),
    流_身份有摘要: flow({ kind: 'identity', label: '_identities', identity }),
    流_身份无摘要: flow({ kind: 'identity', label: '_identities', identity: { rules: null, summary: null } }),
  };
}

describe('数据地图公共组件的界面文字按界面语言翻译（ADR-0060）', () => {
  it('英文界面：关系统计卡与两个图的节点文字都没有汉字（数据除外——夹具里都是 ASCII）', () => {
    const en = states('en');
    for (const [name, html] of Object.entries(en)) expect(html, name).not.toMatch(/[一-鿿]/);
    // 关系统计卡：说明三句、三种单条统计；关系文字仍是英文 id（relationText 不翻译，还是 key 与 data-relation-stat）
    expect(en.关系卡).toContain('Published relations');
    expect(en.关系卡).toContain('Orphan rows: rows that have a value at the source but are missing from the target primary key.');
    expect(en.关系卡).toContain('Stats are from the latest merge (');
    expect(en.关系卡).toContain('Sensitive fields are hashed in the Silver layer, so no sample keys are shown.');
    expect(en.关系卡).toContain('Not merged yet');
    expect(en.关系卡).toContain('Stats failed: boom');
    expect(en.关系卡).toContain('data-orphans="2">Orphan rows 20% (2 / 10 rows)<');
    expect(en.关系卡).toContain('Sample keys: <span class="font-mono">S8, S9</span>');
    expect(en.关系卡).toContain('data-relation-stat="custom_redeem.customer_id → customer.customer_id"');
    expect(en.关系卡无合并).not.toContain('Stats are from');
    // 关系图：标准实体名英文、自定义实体（label 就是 id）原样；身份节点的摘要与「尚未合并」
    expect(en.图_标准实体).toContain('Customer（customer）');
    expect(en.图_自定义实体).toContain('custom_redeem');
    expect(en.图_身份有摘要).toContain('Unified consumers 12,345 · records 678,901');
    expect(en.图_身份无摘要).toContain('Not merged yet');
    // 流向图：折叠的源表数（ICU 复数）、源视图、行数与映射数（英文千分位）
    expect(en.流_折叠源).toContain('3 source tables, click to expand');
    expect(en.流_折叠源单表).toContain('1 source table, click to expand');
    expect(en.流_源视图).toContain('Source View');
    expect(en.流_标准层表).toContain('12,345 rows · 3 mappings');
    expect(en.流_标准层表单数).toContain('1 row · 1 mapping');
    expect(en.流_身份有摘要).toContain('Unified consumers 12,345 · records 678,901');
    expect(en.流_身份无摘要).toContain('Not merged yet');
  });

  it('中文界面：词典不下发、按中文原文回退，输出与接入前一致', () => {
    const zh = states('zh-CN');
    // 关系统计卡：说明三句（日期句只在有合并时间时出现）、三种单条统计；孤儿行的逐字格式被 HTTP 测试正则断言
    expect(zh.关系卡).toContain('已发布关系');
    expect(zh.关系卡).toContain('孤儿：起点有值、在终点主键里找不到的行。统计于最近一次合并（');
    expect(zh.关系卡).toContain('敏感字段在标准层里是哈希，不给样例键。');
    expect(zh.关系卡).toContain('尚未合并');
    expect(zh.关系卡).toContain('统计失败：boom');
    expect(zh.关系卡).toContain('data-orphans="2">孤儿 20%（2 / 10 行）<');
    expect(zh.关系卡).toContain('样例键：<span class="font-mono">S8、S9</span>');
    expect(zh.关系卡).toContain('data-relation-stat="custom_redeem.customer_id → customer.customer_id"');
    expect(zh.关系卡无合并).toContain('孤儿：起点有值、在终点主键里找不到的行。敏感字段在标准层里是哈希，不给样例键。');
    expect(zh.关系卡无合并).not.toContain('统计于');
    // 关系图：标准实体名（中文）与 id 拼回，自定义实体原样；摘要数字仍按 zh-CN 千分位
    expect(zh.图_标准实体).toContain('消费者（customer）');
    expect(zh.图_自定义实体).toContain('custom_redeem');
    expect(zh.图_身份有摘要).toContain('统一消费者 12,345 · 记录 678,901');
    expect(zh.图_身份无摘要).toContain('尚未合并');
    // 流向图：源表数、源视图、行数与映射数（zh-CN 千分位与原来一致）
    expect(zh.流_折叠源).toContain('3 张源表，点击展开');
    expect(zh.流_折叠源单表).toContain('1 张源表，点击展开');
    expect(zh.流_源视图).toContain('源视图');
    expect(zh.流_标准层表).toContain('12,345 行 · 3 个映射');
    expect(zh.流_标准层表单数).toContain('1 行 · 1 个映射');
    expect(zh.流_身份有摘要).toContain('统一消费者 12,345 · 记录 678,901');
    expect(zh.流_身份无摘要).toContain('尚未合并');
  });
});
