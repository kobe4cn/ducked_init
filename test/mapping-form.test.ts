// 映射表单与 YAML 互转（纯函数）：从映射 YAML 读出每个标准字段的表单状态（源列、常用转换、参数、依据、是否只读），
// 改单个字段时在原 Document 上改，保留注释与顺序；枚举字段的值对照与兜底读出、写回；表单不认识的写法只读、原样保留；
// 扩展字段：没用到的源列、读出已有的扩展字段、加上 / 改名 / 删除
import { parseDocument } from 'yaml';
import { describe, expect, it } from 'vitest';
import { entityOf } from '../app/lib/canonical-model';
import {
  dictionaryRows, identityCandidates, newExtension, readExtensions, readForm, readIdentity, seedDictionary, TRANSFORMS, unusedColumns, writeExtension,
  writeField, writeIdentity,
  type FieldChoice, type FieldForm,
} from '../app/lib/mapping-form';
import { draftMapping } from '../app/.server/pipeline/mapping-draft';
import { checkMapping } from '../app/.server/pipeline/mapping-spec';
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
const choiceOf = ({ transform, column, args, parts, raw, dictionary, otherwise }: FieldForm): FieldChoice =>
  ({ transform: transform!, column, args, parts, raw, dictionary, ...(otherwise !== undefined && { otherwise }) });

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

  it('枚举字段读出值对照与兜底：草稿里待填（null）的条目是未对应，没写兜底时不当作写了', () => {
    const hand = field(readForm(parseDocument(HAND), ORDER), 'status');
    expect(hand).toMatchObject({ transform: 'direct', column: 'status', readonly: false, dictionary: [{ from: '已支付', to: 'paid' }] });
    expect(hand).not.toHaveProperty('otherwise');
    const yaml = "model: 1\nentity: order\ntable: orders\nfields:\n  status:\n    expr: st\n    dictionary:\n      '2': refunded\n      9: # 待填\n    otherwise: null\n";
    expect(field(readForm(parseDocument(yaml), ORDER), 'status'))
      .toMatchObject({ readonly: false, dictionary: [{ from: '2', to: 'refunded' }, { from: '9', to: null }], otherwise: null });
    // 没写值字典的枚举字段：对照为空
    expect(field(readForm(parseDocument('fields:\n  status: st\n'), ORDER), 'status')).toMatchObject({ dictionary: [], readonly: false });
  });

  it('非枚举字段的值字典或兜底值、解析失败的表达式与认不出的结构只读，并说明原因', () => {
    const odd = readForm(parseDocument(ODD), CUSTOMER);
    expect(field(odd, 'city')).toMatchObject({ transform: 'direct', readonly: true, reason: expect.stringContaining('值字典') });
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
  // 基准是 yaml 重新输出的文本：手写 YAML 里的非标准格式（如注释前的多个空格）在第一次写入时会被统一；草稿本来就是 yaml 输出的，逐字不变
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

  it('七种常用转换、自定义表达式与值对照 / 兜底都能写回并读出同样的状态', () => {
    const choices: [string, FieldChoice, unknown][] = [
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
      ['status', { transform: 'direct', column: 'st', dictionary: [{ from: '已支付', to: 'paid' }] }, { expr: 'st', dictionary: { 已支付: 'paid' } }],
      ['status', { transform: 'direct', column: 'st', dictionary: [], otherwise: 'cancelled' }, { expr: 'st', otherwise: 'cancelled' }],
    ];
    for (const [name, choice, expr] of choices) {
      const doc = parseDocument('model: 1\nentity: order\ntable: orders\nfields:\n  order_id: order_id\n');
      writeField(doc, ORDER, name, choice);
      expect(doc.toJS().fields[name]).toEqual(expr);
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

describe('值对照与兜底', () => {
  const STATUS = 'model: 1\nentity: order\ntable: orders\nfields:\n  order_id: order_id\n  status: order_status # 同名\n';

  it('填好订单状态的值对照、选兜底：写成对象写法，未对应的源值不写入，写出的 YAML 通过校验', () => {
    const doc = parseDocument(STATUS);
    writeField(doc, ORDER, 'status', {
      transform: 'direct', column: 'order_status',
      dictionary: [{ from: '已支付', to: 'paid' }, { from: 'paid', to: 'paid' }, { from: '2', to: 'refunded' }, { from: '待审核', to: null }],
      otherwise: null,
    });
    const yaml = doc.toString();
    expect(yaml).toBe(`${STATUS.replace('  status: order_status # 同名\n', '')}  status:\n    expr: order_status # 同名\n    dictionary:\n      已支付: paid\n      paid: paid\n      "2": refunded\n    otherwise: null\n`);
    expect(checkMapping(yaml)).toMatchObject({ ok: true });
    expect(field(readForm(parseDocument(yaml), ORDER), 'status')).toMatchObject({ dictionary: [{ from: '已支付', to: 'paid' }, { from: 'paid', to: 'paid' }, { from: '2', to: 'refunded' }], otherwise: null });
  });

  it('改对照或兜底时保留表达式与它的依据注释；去掉对照与兜底时变回标量写法', () => {
    const yaml = draftMapping(ORDERS, ORDER);
    const doc = parseDocument(yaml);
    const status = field(readForm(doc, ORDER), 'status');
    writeField(doc, ORDER, 'status', { ...choiceOf(status), dictionary: [...status.dictionary!, { from: '已关闭', to: 'cancelled' }], otherwise: 'cancelled' });
    expect(doc.toString()).toContain('expr: status # 同名');
    // 没变的对照条目沿用原节点
    expect(field(readForm(doc, ORDER), 'status')).toMatchObject({ dictionary: [...status.dictionary!, { from: '已关闭', to: 'cancelled' }], otherwise: 'cancelled' });
    expect(checkMapping(doc.toString())).toMatchObject({ ok: true });

    writeField(doc, ORDER, 'status', { ...choiceOf(status), dictionary: [] });
    expect(doc.toString()).toMatch(/^ {2}status: status # 同名/m);
  });

  it('草稿里待填（null）的条目：只改兜底时也一并去掉，写出的 YAML 通过校验', () => {
    const doc = parseDocument(draftMapping(table('orders', [column('order_id', 'BIGINT'), column('status', 'VARCHAR', { distinct: 2, top: top('已支付', 'X9') })], ['order_id']), ORDER));
    const status = field(readForm(doc, ORDER), 'status');
    expect(status.dictionary).toEqual([{ from: '已支付', to: 'paid' }, { from: 'X9', to: null }]);
    expect(checkMapping(doc.toString())).toMatchObject({ ok: false });
    writeField(doc, ORDER, 'status', { ...choiceOf(status), otherwise: null });
    expect(doc.toJS().fields.status).toEqual({ expr: 'status', dictionary: { 已支付: 'paid' }, otherwise: null });
    expect(checkMapping(doc.toString())).toMatchObject({ ok: true });
  });

  it('对照表的行：已有对照在前，常见取值与落入兜底里还没对照的源值作为未对应的行接在后面，附上建议的标准值', () => {
    expect(dictionaryRows('order', 'status', [{ from: '已支付', to: 'paid' }, { from: '待付款', to: null }], ['已支付', '已退款', 'zz', '待付款', '已退款']))
      .toEqual([
        { from: '已支付', to: 'paid', extra: false },
        { from: '待付款', to: null, extra: false, suggestion: 'created' },
        { from: '已退款', to: null, extra: true, suggestion: 'refunded' },
        { from: 'zz', to: null, extra: true },
      ]);
  });

  it('新建对照时按常见取值预填能确定的标准值（同值也写上），其余待对应', () => {
    expect(seedDictionary('order', 'status', ['paid', '已退款', '99'])).toEqual([
      { from: 'paid', to: 'paid' }, { from: '已退款', to: 'refunded' }, { from: '99', to: null },
    ]);
  });
});

describe('扩展字段', () => {
  const BASE = 'model: 1\nentity: order\ntable: orders\nfields:\n  order_id: string(order_id) # 主键\n  amount: pay_amount_fen / 100\n';

  it('没用到的源列：标准字段与扩展字段的表达式里引用过的列都不算，草稿文末注释里的扩展字段不算用到', () => {
    const yaml = `${BASE}extensions:\n  x_note: { type: string, expr: "concat(remark, '!')" }\n`;
    expect(unusedColumns(parseDocument(yaml), ORDERS).map(c => c.name)).toEqual(['customer_id', 'status', 'ordered_at', 'pay_time']);
    // 解析不了的表达式不算用到任何列
    expect(unusedColumns(parseDocument('fields:\n  order_id: foo(order_id\n'), ORDERS).map(c => c.name)).toContain('order_id');
    const draft = draftMapping(ORDERS, ORDER);
    expect(draft).toContain('x_remark');
    expect(unusedColumns(parseDocument(draft), ORDERS).map(c => c.name)).toEqual(['remark']);
  });

  it('勾选源列：名字默认 x_<列名>（做不成或重名时 x_col_<列序号>），类型按列推断，不带时区的时间按时区解读', () => {
    expect(newExtension(ORDERS, 'customer_id', [])).toEqual({ name: 'x_customer_id', type: 'integer', expr: 'customer_id' });
    expect(newExtension(ORDERS, 'ordered_at', [])).toEqual({ name: 'x_ordered_at', type: 'timestamp', expr: "from_timezone(ordered_at, 'Asia/Shanghai')" });
    expect(newExtension(ORDERS, 'remark', ['x_remark'])).toMatchObject({ name: 'x_col_7', type: 'string' });
    // x_col_<列序号> 也被占用（如成员改名改成了它）时不覆盖已有的扩展字段
    expect(newExtension(ORDERS, 'remark', ['x_remark', 'x_col_7'])).toMatchObject({ name: 'x_col_7_2' });
    const odd = table('t', [column('备注', 'VARCHAR'), column('Geo', 'GEOMETRY')]);
    expect(newExtension(odd, '备注', [])).toEqual({ name: 'x_col_1', type: 'string', expr: '备注' });
    expect(newExtension(odd, 'Geo', [])).toEqual({ name: 'x_geo', type: 'string', expr: 'string(Geo)' });
  });

  it('加上、改名、改类型与中文名、删除：写出的 YAML 通过校验，其他行不动', () => {
    const doc = parseDocument(BASE);
    writeExtension(doc, 'x_customer_id', newExtension(ORDERS, 'customer_id', []));
    writeExtension(doc, 'x_ordered_at', newExtension(ORDERS, 'ordered_at', []));
    expect(doc.toString()).toBe(`${BASE}extensions:\n  x_customer_id: { type: integer, expr: customer_id }\n  x_ordered_at: { type: timestamp, expr: "from_timezone(ordered_at, 'Asia/Shanghai')" }\n`);
    expect(checkMapping(doc.toString())).toMatchObject({ ok: true });

    writeExtension(doc, 'x_customer_id', { name: 'x_buyer', type: 'string', expr: 'customer_id', label: '买家' });
    expect(readExtensions(doc).extensions).toEqual([
      { name: 'x_buyer', type: 'string', expr: 'customer_id', label: '买家', dictionary: false, sensitive: false, readonly: false },
      { name: 'x_ordered_at', type: 'timestamp', expr: "from_timezone(ordered_at, 'Asia/Shanghai')", label: '', dictionary: false, sensitive: false, readonly: false },
    ]);
    expect(checkMapping(doc.toString())).toMatchObject({ ok: true });
    // 改成已有的名字不行
    expect(() => writeExtension(doc, 'x_buyer', { name: 'x_ordered_at', type: 'string', expr: 'customer_id' })).toThrow(/已有/);

    writeExtension(doc, 'x_buyer', null);
    writeExtension(doc, 'x_ordered_at', null);
    expect(doc.toString()).toBe(BASE);
  });

  it('读入已有的扩展字段：值字典与兜底、注释保留；认不出的写法只读', () => {
    const yaml = `${BASE}extensions:
  # 租户特有
  x_amount_fen: { type: integer, expr: pay_amount_fen } # 原始金额
  x_level:
    type: string
    expr: lvl
    dictionary: { '1': 金卡 }
    otherwise: null
  x_bad: lvl
  x_odd: { type: varchar, expr: lvl }
`;
    const doc = parseDocument(yaml);
    const { extensions } = readExtensions(doc);
    expect(extensions.map(e => [e.name, e.readonly, e.dictionary])).toEqual([['x_amount_fen', false, false], ['x_level', false, true], ['x_bad', true, false], ['x_odd', true, false]]);
    expect(extensions[2].reason).toEqual(expect.any(String));
    expect(() => writeExtension(doc, 'x_bad', null)).toThrow();

    // 只改中文名：值字典、兜底与注释都在
    writeExtension(doc, 'x_level', { name: 'x_level', type: 'string', expr: 'lvl', label: '会员等级' });
    writeExtension(doc, 'x_amount_fen', { name: 'x_amount_fen', type: 'integer', expr: 'pay_amount_fen' });
    const out = doc.toString();
    expect(out).toBe(yaml.replace('    otherwise: null\n', '    otherwise: null\n    label: 会员等级\n'));
    expect(parseDocument(out).toJS().extensions.x_level).toEqual({ type: 'string', expr: 'lvl', dictionary: { 1: '金卡' }, otherwise: null, label: '会员等级' });
    expect(readExtensions(parseDocument('extensions: [a]\n'))).toMatchObject({ extensions: [], reason: expect.any(String) });
  });
  it('敏感：列名或格式像敏感信息的源列加为扩展字段时默认标成敏感（文本）；勾选、取消敏感写回 YAML', () => {
    const contacts = table('contacts', [
      column('id', 'BIGINT'),
      column('wechat_name', 'VARCHAR'),
      column('memo', 'VARCHAR', { formats: [{ format: 'email', share: 0.8 }] }),
      column('birthday', 'DATE'),
      column('level', 'VARCHAR', { formats: [] }),
    ]);
    expect(newExtension(contacts, 'wechat_name', [])).toEqual({ name: 'x_wechat_name', type: 'string', expr: 'wechat_name', sensitive: true });
    expect(newExtension(contacts, 'memo', [])).toEqual({ name: 'x_memo', type: 'string', expr: 'memo', sensitive: true });
    expect(newExtension(contacts, 'birthday', [])).toEqual({ name: 'x_birthday', type: 'string', expr: 'string(birthday)', sensitive: true });
    expect(newExtension(contacts, 'level', [])).toEqual({ name: 'x_level', type: 'string', expr: 'level' });

    const base = 'model: 1\nentity: customer\ntable: contacts\nfields:\n  customer_id: string(id)\n';
    const doc = parseDocument(base);
    writeExtension(doc, 'x_birthday', newExtension(contacts, 'birthday', []));
    writeExtension(doc, 'x_level', newExtension(contacts, 'level', []));
    expect(doc.toString()).toBe(`${base}extensions:\n  x_birthday: { type: string, expr: string(birthday), sensitive: true }\n  x_level: { type: string, expr: level }\n`);
    expect(readExtensions(doc).extensions.map(e => [e.name, e.sensitive, e.readonly])).toEqual([['x_birthday', true, false], ['x_level', false, false]]);
    const sensitive = (yaml: string) => { const r = checkMapping(yaml); return r.ok ? r.plan.columns.filter(c => c.sensitive).map(c => c.name) : r.issues; };
    expect(sensitive(doc.toString())).toEqual(['x_birthday']);

    writeExtension(doc, 'x_level', { name: 'x_level', type: 'string', expr: 'level', sensitive: true });
    writeExtension(doc, 'x_birthday', { name: 'x_birthday', type: 'string', expr: 'string(birthday)', sensitive: false });
    expect(doc.toString()).toBe(`${base}extensions:\n  x_birthday: { type: string, expr: string(birthday) }\n  x_level: { type: string, expr: level, sensitive: true }\n`);
    expect(sensitive(doc.toString())).toEqual(['x_level']);
    // sensitive 写的不是 true / false 时只读
    expect(readExtensions(parseDocument('extensions:\n  x_a: { type: string, expr: a, sensitive: yes please }\n')).extensions[0].readonly).toBe(true);
  });

  it('标准字段照写 sensitive: true 时表单照常可改', () => {
    const doc = parseDocument('model: 1\nentity: customer\ntable: customers\nfields:\n  customer_id: string(customer_id)\n  name: { expr: name, sensitive: true }\n');
    expect(field(readForm(doc, CUSTOMER), 'name')).toMatchObject({ transform: 'direct', column: 'name', readonly: false });
    writeField(doc, CUSTOMER, 'name', { transform: 'text', column: 'name' });
    expect(doc.toJS().fields.name).toEqual({ expr: 'string(name)', sensitive: true });
  });
});

describe('身份打通的匹配字段', () => {
  const BASE = 'model: 1\nentity: customer\ntable: customers\nfields:\n  customer_id: string(id)\n  name: name\n  phone: mobile # 同义词\n  city: city\n'
    + '  email:\nextensions:\n  x_wechat: { type: string, expr: wechat, sensitive: true }\n  x_age: { type: integer, expr: age }\n';

  it('可选的是 YAML 里已映射的敏感字段：标准字段按实体顺序，之后是标成敏感的扩展字段', () => {
    expect(identityCandidates(parseDocument(BASE), CUSTOMER)).toEqual(['name', 'phone', 'x_wechat']);
  });

  it('选字段并排序写成 identity.match，读回一致、通过校验；全部去掉时删掉 identity，其他行不动', () => {
    const doc = parseDocument(BASE.replace('  email:\n', ''));
    expect(readIdentity(doc)).toEqual({ match: [] });
    writeIdentity(doc, ['x_wechat', 'phone']);
    expect(doc.toString()).toContain('identity:\n  match: [ x_wechat, phone ]\n');
    expect(readIdentity(parseDocument(doc.toString()))).toEqual({ match: ['x_wechat', 'phone'] });
    const columns = ['id', 'name', 'mobile', 'city', 'wechat', 'age'].map(name => ({ name, type: 'VARCHAR' }));
    expect(checkMapping(doc.toString(), () => columns)).toMatchObject({ ok: true, plan: { identity: { match: ['x_wechat', 'phone'] } } });
    writeIdentity(doc, []);
    expect(doc.toString()).toBe(BASE.replace('  email:\n', ''));
  });

  it('表单不认识的写法只读', () => {
    expect(readIdentity(parseDocument('identity: [phone]\n'))).toMatchObject({ match: [], reason: expect.stringContaining('YAML') });
    expect(readIdentity(parseDocument('identity:\n  match: phone\n'))).toMatchObject({ reason: expect.stringContaining('YAML') });
    expect(() => writeIdentity(parseDocument('identity: [phone]\n'), ['phone'])).toThrow(/YAML/);
  });
});
