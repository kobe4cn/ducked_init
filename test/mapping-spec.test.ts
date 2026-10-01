// 映射文档的校验：不符合 Schema、表达式用了白名单之外的函数、引用了源表没有的字段、值字典对应到非标准枚举时被拒绝，并给出 YAML 里的行列位置；
// 以及对照面板从编辑中的 YAML 读出的要点（已对应的字段、去重键）
import { describe, expect, it } from 'vitest';
import { checkMapping } from '../app/.server/pipeline/mapping-spec';
import { mappingOutline } from '../app/lib/mapping-outline';

const ORDERS = ['order_id', 'customer_id', 'amount', 'status', 'created_at', 'pay_fen', '下单时间'];
const columns = (table: string) => (table === 'orders' ? ORDERS : `数据源中没有表 ${table}`);

const ok = `model: 1
entity: order
table: orders
fields:
  order_id: string(order_id)
  customer_id: customer_id
  amount: coalesce(amount, pay_fen / 100)
  created_at: from_timezone("下单时间", 'Asia/Shanghai')
  status:
    expr: status
    dictionary:
      已支付: paid
      '2': refunded
`;

const issues = (text: string) => {
  const r = checkMapping(text, columns);
  if (r.ok) throw new Error('应当校验失败');
  return r.issues;
};

describe('映射文档的校验', () => {
  it('合法的映射得到合并计划：没有声明去重键时按实体主键去重', () => {
    const r = checkMapping(ok, columns);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toMatchObject({ entity: 'order', table: 'orders', key: ['order_id'], latest: null });
    expect(r.plan.columns.find(c => c.name === 'status')).toMatchObject({ dictionary: { 已支付: 'paid', 2: 'refunded' }, enum: expect.arrayContaining(['paid']) });
    // 标准层表有实体的全部字段，没映射的为空
    expect(r.plan.entityColumns.map(c => c.name)).toContain('paid_at');
  });

  it('YAML 语法错误给出行列', () => {
    expect(issues('model: 1\nentity: [order\n')).toEqual([expect.objectContaining({ line: 3, message: expect.stringContaining('YAML 语法错误') })]);
  });

  it('不符合 Schema 时逐项给出位置：缺项、不认识的项、类型不对', () => {
    const found = issues(`model: 2
entity: order
fields:
  order_id: order_id
  amount: 12
colour: red
`);
    expect(found).toEqual([
      { line: 1, col: 1, path: '', message: '缺少 table' },
      { line: 1, col: 8, path: 'model', message: '应为 1（标准模型 v1）' },
      { line: 5, col: 11, path: 'fields.amount', message: expect.stringContaining('应为文本或对象') },
      { line: 6, col: 1, path: 'colour', message: '不认识的项 colour' },
    ]);
  });

  it('表达式只允许白名单函数，并指出出错的位置', () => {
    const found = issues(ok.replace('string(order_id)', "read_csv('/etc/passwd')"));
    expect(found).toEqual([{ line: 5, col: 13, path: 'fields.order_id', message: expect.stringMatching(/函数 read_csv 不在白名单内/) }]);
    // 不能借字符串或子查询拼出任意 SQL：语法本身不接受
    expect(issues(ok.replace('string(order_id)', '(SELECT 1)'))[0].message).toMatch(/表达式错误/);
    expect(issues(ok.replace("'Asia/Shanghai'", "'Mars/Base'"))[0].message).toMatch(/不认识的时区/);
  });

  it('引用源表里没有的字段、映射到标准模型里没有的字段、值字典对应到非标准枚举都被拒绝', () => {
    const found = issues(ok
      .replace('customer_id: customer_id', 'customer_id: buyer')
      .replace('      已支付: paid', '      已支付: settled')
      .replace('fields:\n', 'fields:\n  coupon: coupon_code\n'));
    expect(found.map(i => [i.line, i.path, i.message])).toEqual([
      [5, 'fields.coupon', expect.stringMatching(/没有标准字段 coupon.*x_ 开头/)],
      [7, 'fields.customer_id', '源表 orders 中没有字段 buyer'],
      [13, 'fields.status.dictionary.已支付', expect.stringMatching(/settled 不是标准枚举值/)],
    ]);
  });

  it('源表不能用于映射时指出原因；去重键与取最新字段必须是映射出来的字段', () => {
    expect(issues(ok.replace('table: orders', 'table: payments'))).toEqual([
      expect.objectContaining({ line: 3, path: 'table', message: '数据源中没有表 payments' }),
    ]);
    const found = issues(`${ok}dedupe:\n  key: [order_no]\n  latest: status\n`);
    expect(found.map(i => i.message)).toEqual(['去重键 order_no 不是本映射映射出来的字段', '取最新字段 status 应为时间、日期或数字']);
  });

  it('扩展字段以 x_ 开头并带类型；自定义实体的字段都写在 extensions 里，必须声明去重键', () => {
    const extended = checkMapping(`${ok}extensions:\n  x_coupon: { type: string, expr: string(pay_fen) }\n`, columns);
    expect(extended.ok && extended.plan.entityColumns.at(-1)).toEqual({ name: 'x_coupon', type: 'string' });
    expect(issues(`${ok}extensions:\n  coupon: { type: string, expr: pay_fen }\n`)[0].message).toMatch(/必须以 x_ 开头/);

    const custom = `model: 1\nentity: custom_coupon\ntable: orders\nextensions:\n  code: { type: string, expr: string(order_id) }\n`;
    expect(issues(custom).map(i => i.message)).toEqual(['自定义实体必须声明去重键 dedupe.key']);
    expect(checkMapping(`${custom}dedupe: { key: [code] }\n`, columns).ok).toBe(true);
  });
});

describe('对照面板读出的 YAML 要点', () => {
  it('只把写了表达式的字段算作已对应，读出 dedupe.key；写到一半解析出错时尽量取能解析的部分', () => {
    const outline = mappingOutline('entity: order\ntable: orders\nfields:\n  order_id: order_no\n  amount:\ndedupe:\n  key: [order_no_x]\n');
    expect(outline).toEqual({ entity: 'order', table: 'orders', fields: new Set(['order_id']), dedupeKey: ['order_no_x'] });
    expect(mappingOutline('entity: order\nfields:\n  status: { expr: status\n').entity).toBe('order');
    expect(mappingOutline('fields: [').fields.size).toBe(0);
  });
});
