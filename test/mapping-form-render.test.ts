// 映射表单的服务端渲染（纯函数）：扩展字段按当前名字是已登记关系的起点、类型是文本且不敏感时有键空间输入，
// 指向 customer 的还有「所属数据源」下拉（本数据源与有已发布 customer 映射的其他数据源）；不是起点、非文本、敏感、只读的没有
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MappingForm } from '../app/components/mapping-form';
import type { ReferenceTable } from '../app/components/mapping-reference';

const YAML = `model: 1
entity: order
table: orders
fields:
  order_id: order_no
extensions:
  x_ticket: { type: string, expr: ticket_no, key_space: helpdesk }
  x_buyer: { type: string, expr: buyer, customer_source: crm }
  x_amount: { type: integer, expr: amount }
  x_secret: { type: string, expr: secret, sensitive: true }
  x_note: { type: string, expr: note }
  x_odd: { type: string, expr: odd, key_space: [a] }
`;

const table: ReferenceTable = {
  name: 'orders', sampleRows: 0, primaryKey: [], watermark: null, columns: [], keySpaces: {},
  customerSources: [{ id: 'src-crm', name: 'crm' }, { id: 'src-mall', name: 'mall' }],
  relationOrigins: { order: { x_ticket: 'custom_ticket', x_buyer: 'customer', x_amount: 'custom_ticket', x_secret: 'customer', x_odd: 'custom_ticket' } },
};

const render = (t: ReferenceTable | null) => renderToStaticMarkup(createElement(MappingForm, {
  yaml: YAML, entity: 'order', table: t, functions: [], onChange: () => {}, onEditYaml: () => {},
}));
/** 一个扩展字段行的 HTML（到下一个扩展字段行或扩展字段区块结束） */
const row = (html: string, name: string) => html.slice(html.indexOf(`data-form-extension="${name}"`)).split('data-form-extension="')[1];

describe('映射表单的扩展字段行', () => {
  it('关系起点、文本且不敏感的扩展字段有键空间输入（照 YAML 填好），指向 customer 的另有所属数据源下拉', () => {
    const html = render(table);
    const ticket = row(html, 'x_ticket');
    expect(ticket).toContain('data-form-key-space="x_ticket"');
    expect(ticket).toContain('键空间（custom_ticket 的主键所在）');
    expect(ticket).toMatch(/aria-label="x_ticket 的键空间"[^>]*value="helpdesk"|value="helpdesk"[^>]*aria-label="x_ticket 的键空间"/);
    expect(ticket).not.toContain('所属数据源');

    const buyer = row(html, 'x_buyer');
    expect(buyer).toContain('data-form-key-space="x_buyer"');
    expect(buyer).toContain('aria-label="x_buyer 的所属数据源"');
    expect(buyer).toMatch(/value="">本数据源<\/option><option[^>]*value="crm" selected="">crm<\/option><option[^>]*value="mall">mall<\/option>/);
  });

  it('不是关系起点、非文本、敏感、只读的扩展字段没有这两个控件；没有对照数据时都没有', () => {
    const html = render(table);
    for (const name of ['x_note', 'x_amount', 'x_secret', 'x_odd']) expect(row(html, name)).not.toContain('data-form-key-space');
    expect(row(html, 'x_odd')).toContain('到 YAML 修改');
    expect(render(null)).not.toMatch(/data-form-key-space="x_/);
  });
});
