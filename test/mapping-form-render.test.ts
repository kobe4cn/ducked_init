// 映射表单的服务端渲染（纯函数）：扩展字段按当前名字是已登记关系的起点、类型是文本且不敏感时有键空间输入，
// 指向 customer 的还有「所属数据源」下拉（本数据源与有已发布 customer 映射的其他数据源）；不是起点、非文本、敏感、只读的没有；
// 实时校验的问题显示在对应区块里，对应不上的在表单顶部；表单显示时编辑区下方的结果只给结论、不逐项列出
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MappingForm } from '../app/components/mapping-form';
import { LiveMappingIssues, type MappingIssueView } from '../app/components/mapping-editor';
import type { ReferenceTable } from '../app/components/mapping-reference';
import { entityOf } from '../app/lib/canonical-model';
import { I18nProvider, makeT } from '../app/lib/i18n';
import enClient from '../app/i18n/en.client.json';

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

  it('customer 映射有属性取舍名次的输入（照 YAML 填好），它的问题显示在旁边；order 映射没有这个控件，问题在顶部', () => {
    const html = renderToStaticMarkup(createElement(MappingForm, {
      yaml: 'model: 1\nentity: customer\ntable: members\nfields:\n  customer_id: id\nsurvivorship:\n  priority: 2\n', entity: 'customer', table: null, functions: [],
      issues: [{ ...issue('survivorship.priority', 'priority 应不小于 1'), hint: 'survivorship: { priority: 1 }' }], onChange: () => {}, onEditYaml: () => {},
    }));
    const block = html.slice(html.indexOf('data-form-survivorship'));
    expect(block).toContain('aria-label="属性取舍名次"');
    expect(block).toMatch(/value="2"/);
    expect(block).toContain('<p data-live-issue="true" data-issue-path="survivorship.priority">priority 应不小于 1</p>');
    expect(block).toContain('survivorship: { priority: 1 }');
    expect(html).not.toContain('data-form-issues');

    const order = render(table, [issue('survivorship', '只有消费者（customer）映射能配置属性取舍的优先级')]);
    expect(order).not.toContain('data-form-survivorship');
    expect(order).not.toContain('aria-label="属性取舍名次"');
    const top = order.slice(order.indexOf('data-form-issues'), order.indexOf('data-form-mapping-key-space'));
    expect(top).toContain('只有消费者（customer）映射能配置属性取舍的优先级');
  });
});

describe('英文界面', () => {
  /** 带值对照的枚举字段（status），源列的常见取值给出建议（field-synonyms 的 ASCII 同义词） */
  const DICT_YAML = `model: 1
entity: order
table: orders
fields:
  order_id: order_no
  status: { expr: status, dictionary: { paid: paid }, otherwise: null }
`;
  const dictTable: ReferenceTable = {
    ...table, columns: [{ name: 'status', type: 'text', nullRate: 0, distinct: 3, top: [{ value: 'paid', rows: 50 }, { value: 'pending', rows: 3 }, { value: 'refund', rows: 1 }] }],
  };
  const renderEn = (yaml: string, t: ReferenceTable | null, issues: MappingIssueView[] = []) => renderToStaticMarkup(createElement(
    I18nProvider,
    { t: makeT('en', enClient), locale: 'en' as const, children: createElement(MappingForm, { yaml, entity: 'order', table: t, functions: [], issues, onChange: () => {}, onEditYaml: () => {} }) },
  ));
  /** 输出里仍是中文的数据（order 各字段的说明、lib 给的只读 reason、issue message、lib 的 TRANSFORMS 选项文字）随 #932 翻译，先去掉再断言界面文字 */
  const stripData = (html: string) => [...entityOf('order')!.fields.map(f => f.description), '这种写法表单不认识，请在 YAML 里修改']
    .reduce((out, zh) => out.split(zh).join(''), html)
    .replace(/<p data-live-issue[\s\S]*?<\/p>/g, '')
    .replace(/<option[^>]*>[^<]*[一-鿿][^<]*<\/option>/g, '');

  it('表单的标签、按钮与提示是英文，标准字段名与类型按界面语言显示；提交的值仍是代码名', () => {
    const html = stripData(renderEn(YAML, table));
    expect(html).not.toMatch(/[一-鿿]/);
    // 标准字段名与字段类型走 builtinName（#1011 的词典）
    expect(html).toContain('Order ID');
    expect(html).toContain('Amount Paid');
    expect(html).toContain('Decimal (2 places)');
    expect(html).toContain('Timestamp (UTC)');
    // 区块标签与提示
    expect(html).toContain('Key space');
    expect(html).toContain('Extension fields');
    expect(html).toContain('Required (dedupe key)');
    // 表单提交的值不因界面语言改变：字段类型的 option value 仍是代码名（转换的 option 文字是 lib 数据，随 #932 翻译，已被上面按汉字去掉）
    expect(html).toContain('value="string"');
    expect(html).toContain('value="integer"');
  });

  it('值对照与兜底（枚举字段）、实时校验的错误态、没有源表的空态同样没有汉字（数据除外）', () => {
    const dict = stripData(renderEn(DICT_YAML, dictTable));
    expect(dict).not.toMatch(/[一-鿿]/);
    expect(dict).toContain('Standard value for paid');
    expect(dict).toContain('Apply suggested mappings for 2 source values');
    expect(dict).toContain('Map other values to null');

    const error = stripData(renderEn(YAML, table, [{ line: 6, col: 9, path: 'table', message: '源表 orders 中没有字段 nope' }]));
    expect(error).not.toMatch(/[一-鿿]/);
    expect(error).toContain('Issues found by live validation');

    // 空态提示只在 YAML 里还没有扩展字段时出现
    const empty = stripData(renderEn('model: 1\nentity: order\ntable: orders\nfields:\n  order_id: order_no\n', null));
    expect(empty).not.toMatch(/[一-鿿]/);
    expect(empty).toContain('No source table to compare against; write extension fields in the YAML');
  });
});

describe('编辑区下方的实时校验结果', () => {
  const validation = {
    state: 'issues' as const, error: '映射有 1 个问题', notices: [],
    issues: [{ line: 6, col: 9, path: 'fields.name', message: '源表 signups 中没有字段 姓名_不存在' }],
  };
  const live = (inForm?: boolean) => renderToStaticMarkup(createElement(LiveMappingIssues, { validation, inForm, onJump: () => {} }));

  it('默认逐项列出（带行列）；inForm 时只有结论与提示，不列出问题', () => {
    expect(live()).toContain('第 6 行第 9 列（fields.name）：源表 signups 中没有字段 姓名_不存在');
    const html = live(true);
    expect(html).toContain('映射有 1 个问题');
    expect(html).toContain('问题显示在表单里对应的位置');
    expect(html).not.toContain('data-issue-path');
    expect(html).not.toContain('姓名_不存在');
  });
});
