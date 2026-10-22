// 映射表单的服务端渲染（纯函数）：扩展字段按当前名字是已登记关系的起点、类型是文本且不敏感时有键空间输入，
// 指向 customer 的还有「所属数据源」下拉（本数据源与有已发布 customer 映射的其他数据源）；不是起点、非文本、敏感、只读的没有；
// 实时校验的问题显示在对应区块里，对应不上的在表单顶部
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MappingForm } from '../app/components/mapping-form';
import type { MappingIssueView } from '../app/components/mapping-editor';
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

const render = (t: ReferenceTable | null, issues: MappingIssueView[] = []) => renderToStaticMarkup(createElement(MappingForm, {
  yaml: YAML, entity: 'order', table: t, functions: [], issues, onChange: () => {}, onEditYaml: () => {},
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

describe('映射表单里的实时校验问题', () => {
  const issue = (path: string, message: string): MappingIssueView => ({ line: 1, col: 1, path, message });
  /** 某个区块的 HTML（到下一个同类区块之前） */
  const block = (html: string, attr: string) => html.slice(html.indexOf(attr)).split(/data-form-(?:field|extension|extensions|mapping-key-space)=?/)[1];

  it('按 path 显示在字段、扩展字段与键空间区块里；同名时按 fields / extensions 区分', () => {
    const html = render(table, [
      issue('fields.amount', '字段 amount 的表达式有误'),
      issue('extensions.x_note.type', 'x_note 的类型不对'),
      issue('key_space', '键空间格式不对'),
    ]);
    expect(block(html, 'data-form-field="amount"')).toContain('<p data-live-issue="true" data-issue-path="fields.amount">字段 amount 的表达式有误</p>');
    expect(block(html, 'data-form-extension="x_note"')).toContain('x_note 的类型不对');
    expect(block(html, 'data-form-field="order_id"')).not.toContain('data-live-issue');
    expect(block(html, 'data-form-mapping-key-space')).toContain('键空间格式不对');
    expect(html).not.toContain('data-form-issues');
  });

  it('对应不上的（table、assertions、不在表单上的字段与扩展字段、非 customer 的身份打通）放在表单顶部', () => {
    const html = render(table, [
      issue('table', '源表不存在'), issue('assertions.0.sql', '断言有误'), issue('fields.nope', '没有这个字段'),
      issue('extensions.x_gone', '没有这个扩展字段'), issue('identity.match', '只有 customer 能写'),
    ]);
    const top = html.slice(html.indexOf('data-form-issues'), html.indexOf('data-form-mapping-key-space'));
    for (const text of ['源表不存在', '断言有误', '没有这个字段', '没有这个扩展字段', '只有 customer 能写']) expect(top).toContain(text);
    expect(html.match(/data-live-issue=/g)).toHaveLength(5);
  });

  it('customer 映射的身份打通问题显示在身份打通区块里，带改法', () => {
    const html = renderToStaticMarkup(createElement(MappingForm, {
      yaml: 'model: 1\nentity: customer\ntable: members\nfields:\n  customer_id: id\nidentity:\n  match: [email]\n', entity: 'customer', table: null, functions: [],
      issues: [{ ...issue('identity.match.0', '匹配字段 email 没有映射'), hint: 'identity: { match: [phone] }' }], onChange: () => {}, onEditYaml: () => {},
    }));
    const identity = html.slice(html.indexOf('data-form-identity'));
    expect(identity).toContain('<p data-live-issue="true" data-issue-path="identity.match.0">匹配字段 email 没有映射</p>');
    expect(identity).toContain('identity: { match: [phone] }');
    expect(html).not.toContain('data-form-issues');
  });
});
