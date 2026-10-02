// 映射表单与 YAML 互转（纯函数）：从映射 YAML 读出每个标准字段的表单状态（源列、常用转换、参数、依据、是否只读），
// 改单个字段时在原 Document 上改，保留注释与顺序；表单不认识的写法只读、原样保留
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';
import { entityOf } from '../app/lib/canonical-model';
import { readForm, TRANSFORMS, writeField, type FieldChoice, type FieldForm } from '../app/lib/mapping-form';
import { draftMapping } from '../app/.server/pipeline/mapping-draft';
import type { ColumnProfile, TableProfile } from '../app/.server/pipeline/source-engine';

const ORDER = entityOf('order')!;
const CUSTOMER = entityOf('customer')!;

const column = (name: string, type: string, extra: Partial<ColumnProfile> = {}): ColumnProfile =>
  ({ name, type, nullRate: 0, distinct: 100, min: null, max: null, ...extra });
const table = (name: string, columns: ColumnProfile[], primaryKey: string[] = []): TableProfile =>
  ({ name, rows: 1000, sampleRows: 1000, columns, watermarkCandidates: [], primaryKey, keyCandidates: [] });
const top = (...values: string[]) => values.map((value, i) => ({ value, rows: 100 - i }));

/** 生成的草稿覆盖：同名、同义词、分转元、毫秒时间戳、时区解读、值字典、文末注释 */
const ORDERS = table('orders', [
  column('order_id', 'BIGINT', { min: '1', max: '5000' }),
  column('customer_id', 'BIGINT', { min: '1', max: '1000' }),
  column('status', 'VARCHAR', { distinct: 3, top: top('已支付', '已退款', '待支付') }),
  column('pay_amount_fen', 'INTEGER', { min: '0', max: '100000' }),
  column('ordered_at', 'TIMESTAMP'),
  column('pay_time', 'BIGINT', { min: '1704067200000', max: '1735689600000' }),
  column('remark', 'VARCHAR'),
], ['order_id']);
const CUSTOMERS = table('customers', [
  column('customer_id', 'BIGINT', { min: '1', max: '1000' }),
  column('name', 'VARCHAR', { formats: [] }),
  column('mobile', 'VARCHAR', { formats: [{ format: 'mobile', share: 1 }] }),
  column('email', 'VARCHAR', { formats: [{ format: 'email', share: 1 }] }),
  column('registered_at', 'TIMESTAMPTZ'),
], ['customer_id']);

const field = (forms: FieldForm[], name: string) => forms.find(f => f.field === name)!;
const choiceOf = ({ transform, column, args, parts, raw }: FieldForm): FieldChoice => ({ transform: transform!, column, args, parts, raw });

/** 把每个可写的字段按读出的状态原样写回 */
function rewriteAll(yaml: string, entity = ORDER) {
  const doc = parseDocument(yaml);
  for (const f of readForm(doc, entity)) if (f.transform && !f.readonly) writeField(doc, entity, f.field, choiceOf(f));
  return doc.toString();
}

const HAND = `# 手写的映射
model: 1
entity: order
table: orders
fields:
  order_id: string(order_id)   # 主键
  customer_id: '"客户 编号"'
  status:
    expr: status
    dictionary:
      已支付: paid
  amount: pay_fen / 100
  created_at: from_timezone(ordered_at,'Asia/Shanghai')
  paid_at: timestamp(paid_time, '%Y-%m-%d %H:%M')
  channel: concat(src, '-', "子 渠道")
  store_id: "'S01'"
  updated_at: from_epoch_millis(updated_ms)
`;

/** 表单不认识或只能当自定义表达式的写法 */
const ODD = `model: 1
entity: customer
table: customers
fields:
  customer_id: coalesce(id, legacy_id)
  name: foo(
  city:
    expr: city
    otherwise: other
  updated_at:
    - a
`;

describe('读出表单', () => {
  it('按实体字段顺序列出全部标准字段，常用转换与参数从表达式读出', () => {
    const forms = readForm(parseDocument(HAND), ORDER);
    expect(forms.map(f => f.field)).toEqual(ORDER.fields.map(f => f.name));
    expect(field(forms, 'order_id')).toMatchObject({ transform: 'text', column: 'order_id', args: [], raw: 'string(order_id)', readonly: false, required: true });
    expect(field(forms, 'customer_id')).toMatchObject({ transform: 'direct', column: '客户 编号', required: false });
    expect(field(forms, 'amount')).toMatchObject({ transform: 'cents', column: 'pay_fen' });
    expect(field(forms, 'created_at')).toMatchObject({ transform: 'timezone', column: 'ordered_at', args: ['Asia/Shanghai'] });
    expect(field(forms, 'paid_at')).toMatchObject({ transform: 'parse', column: 'paid_time', args: ['%Y-%m-%d %H:%M'] });
    expect(field(forms, 'store_id')).toMatchObject({ transform: 'fixed', column: null, args: ['S01'] });
    expect(field(forms, 'channel')).toMatchObject({ transform: 'concat', column: null, parts: [{ column: 'src' }, { text: '-' }, { column: '子 渠道' }] });
    expect(field(forms, 'updated_at')).toMatchObject({ transform: 'epoch', column: 'updated_ms', args: ['millis'] });

    const odd = readForm(parseDocument(ODD), CUSTOMER);
    expect(field(odd, 'customer_id')).toMatchObject({ transform: 'custom', column: null, raw: 'coalesce(id, legacy_id)', readonly: false });
    // 没写的字段：没有转换，可写
    expect(field(odd, 'phone')).toMatchObject({ transform: null, column: null, raw: '', readonly: false });
  });

  it('带值对照的对象写法、解析失败的表达式与认不出的结构只读，并说明原因', () => {
    expect(field(readForm(parseDocument(HAND), ORDER), 'status'))
      .toMatchObject({ transform: 'direct', column: 'status', raw: 'status', readonly: true, reason: expect.stringContaining('值对照') });
    const odd = readForm(parseDocument(ODD), CUSTOMER);
    expect(field(odd, 'city')).toMatchObject({ transform: 'direct', readonly: true, reason: expect.stringContaining('值对照') });
    expect(field(odd, 'name')).toMatchObject({ transform: 'custom', raw: 'foo(', readonly: true, reason: expect.stringContaining('表达式') });
    expect(field(odd, 'updated_at')).toMatchObject({ transform: null, readonly: true, reason: expect.any(String) });
  });

  it('必填字段是 dedupe.key 声明的字段，没有声明时是实体主键', () => {
    const forms = readForm(parseDocument('model: 1\nentity: order\ntable: orders\ndedupe:\n  key: [channel, store_id]\n'), ORDER);
    expect(forms.filter(f => f.required).map(f => f.field)).toEqual(['channel', 'store_id']);
  });

  it('依据从草稿的行尾注释读出', () => {
    const customers = readForm(parseDocument(draftMapping(CUSTOMERS, CUSTOMER)), CUSTOMER);
    expect(field(customers, 'customer_id').basis).toBe('同名；源表主键');
    expect(field(customers, 'phone')).toMatchObject({ transform: 'direct', column: 'mobile', basis: '同义词：mobile；格式：手机号' });
    const orders = readForm(parseDocument(draftMapping(ORDERS, ORDER)), ORDER);
    expect(field(orders, 'status').basis).toContain('值字典按常见取值生成');
    expect(field(orders, 'amount')).toMatchObject({ transform: 'cents', column: 'pay_amount_fen', basis: expect.stringContaining('单位：分') });
    expect(field(orders, 'paid_at')).toMatchObject({ transform: 'epoch', args: ['millis'] });
    expect(field(readForm(parseDocument(HAND), ORDER), 'order_id').basis).toBe('主键');
  });

  it('读出的转换都在 TRANSFORMS 里有业务名称', () => {
    const ids = TRANSFORMS.map(t => t.id);
    for (const f of [...readForm(parseDocument(HAND), ORDER), ...readForm(parseDocument(ODD), CUSTOMER)]) if (f.transform) expect(ids).toContain(f.transform);
  });
});

describe('写回 YAML', () => {
  it('读 → 原样写回 → 文本不变（注释、顺序、引号都在）', () => {
    expect(rewriteAll(HAND)).toBe(parseDocument(HAND).toString());
    expect(rewriteAll(ODD, CUSTOMER)).toBe(ODD);
    for (const [t, e] of [[ORDERS, ORDER], [CUSTOMERS, CUSTOMER]] as const) {
      const yaml = draftMapping(t, e);
      expect(rewriteAll(yaml, e)).toBe(yaml);
    }
  });

  it('改一个字段只改动那一行，改了表达式后清掉原来的依据注释', () => {
    const yaml = draftMapping(ORDERS, ORDER);
    const doc = parseDocument(yaml);
    writeField(doc, ORDER, 'created_at', { transform: 'timezone', column: 'ordered_at', args: ['UTC'] });
    const before = yaml.split('\n');
    const after = doc.toString().split('\n');
    expect(after.length).toBe(before.length);
    const changed = after.flatMap((l, i) => (l === before[i] ? [] : [[before[i], l]]));
    expect(changed).toEqual([[expect.stringMatching(/^ {2}created_at: from_timezone\(ordered_at, 'Asia\/Shanghai'\) # 同义词/), "  created_at: from_timezone(ordered_at, 'UTC')"]]);
  });

  it('七种常用转换与自定义表达式都能写回并读出同样的状态', () => {
    const choices: [string, FieldChoice, string][] = [
      ['customer_id', { transform: 'direct', column: '客户 编号' }, '"客户 编号"'],
      ['amount', { transform: 'cents', column: 'pay_fen' }, 'pay_fen / 100'],
      ['status', { transform: 'text', column: 'st' }, 'string(st)'],
      ['created_at', { transform: 'timezone', column: 'ts', args: ['Asia/Tokyo'] }, "from_timezone(ts, 'Asia/Tokyo')"],
      ['paid_at', { transform: 'parse', column: 'paid', args: ['%Y/%m/%d'] }, "timestamp(paid, '%Y/%m/%d')"],
      ['paid_at', { transform: 'parse', column: 'paid', args: [] }, 'timestamp(paid)'],
      ['updated_at', { transform: 'epoch', column: 'ms', args: ['seconds'] }, 'from_epoch_seconds(ms)'],
      ['channel', { transform: 'concat', parts: [{ column: 'a' }, { text: "it's" }, { column: 'null' }] }, `concat(a, 'it''s', "null")`],
      ['store_id', { transform: 'fixed', args: ["S'01"] }, "'S''01'"],
      ['store_id', { transform: 'custom', raw: 'coalesce(a, b)' }, 'coalesce(a, b)'],
    ];
    for (const [name, choice, expr] of choices) {
      const doc = parseDocument('model: 1\nentity: order\ntable: orders\nfields:\n  order_id: order_id\n');
      writeField(doc, ORDER, name, choice);
      expect(doc.getIn(['fields', name])).toBe(expr);
      expect(field(readForm(parseDocument(doc.toString()), ORDER), name)).toMatchObject({ ...choice, readonly: false });
    }
  });

  it('日期字段的日期解析写成 date(...)', () => {
    const doc = parseDocument('model: 1\nentity: customer\ntable: c\n');
    writeField(doc, CUSTOMER, 'birthday', { transform: 'parse', column: 'bd', args: ['%Y%m%d'] });
    expect(doc.getIn(['fields', 'birthday'])).toBe("date(bd, '%Y%m%d')");
  });

  it('YAML 里没有的字段按实体字段顺序插入，没有 fields 时新建', () => {
    const doc = parseDocument('model: 1\nentity: order\ntable: orders\nfields:\n  order_id: order_id\n  amount: amt\n');
    writeField(doc, ORDER, 'paid_at', { transform: 'direct', column: 'pt' });
    writeField(doc, ORDER, 'customer_id', { transform: 'direct', column: 'cid' });
    expect(Object.keys(doc.toJS().fields)).toEqual(['order_id', 'customer_id', 'amount', 'paid_at']);

    const empty = parseDocument('model: 1\nentity: order\ntable: orders\n');
    writeField(empty, ORDER, 'order_id', { transform: 'direct', column: 'id' });
    expect(empty.toString()).toBe('model: 1\nentity: order\ntable: orders\nfields:\n  order_id: id\n');
  });

  it('只有 expr 的对象写法改 expr；清空对应时删掉该字段', () => {
    const doc = parseDocument('fields:\n  order_id:\n    expr: id\n  amount: amt # 依据\n');
    writeField(doc, ORDER, 'order_id', { transform: 'text', column: 'id' });
    writeField(doc, ORDER, 'amount', null);
    expect(doc.toString()).toBe('fields:\n  order_id:\n    expr: string(id)\n');
  });

  it('只读的字段不能写，写别的字段时原样保留', () => {
    const doc = parseDocument(ODD);
    expect(() => writeField(doc, CUSTOMER, 'city', { transform: 'direct', column: 'x' })).toThrow();
    expect(() => writeField(doc, CUSTOMER, 'name', { transform: 'direct', column: 'x' })).toThrow();
    expect(() => writeField(doc, CUSTOMER, 'updated_at', null)).toThrow();
    // 缺源列、空的自定义表达式写不进去
    expect(() => writeField(doc, CUSTOMER, 'phone', { transform: 'text' })).toThrow();
    expect(() => writeField(doc, CUSTOMER, 'phone', { transform: 'custom', raw: ' ' })).toThrow();
    writeField(doc, CUSTOMER, 'customer_id', { transform: 'direct', column: 'id' });
    expect(doc.toString()).toBe(ODD.replace('coalesce(id, legacy_id)', 'id'));
  });
});
