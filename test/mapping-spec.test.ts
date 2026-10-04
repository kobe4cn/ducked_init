// 映射文档的校验：不符合 Schema、表达式用了白名单之外的函数、引用了源表没有的字段、值字典对应到非标准枚举时被拒绝，并给出 YAML 里的行列位置；
// 以及对照面板从编辑中的 YAML 读出的要点（已对应的字段、去重键）
import { describe, expect, it } from 'vitest';
import { checkMapping } from '../app/.server/pipeline/mapping-spec';
import { mappingOutline } from '../app/lib/mapping-outline';

const ORDERS = (
  [['order_id', 'BIGINT'], ['customer_id', 'BIGINT'], ['amount', 'DECIMAL(10,2)'], ['status', 'VARCHAR'], ['created_at', 'TIMESTAMP'], ['pay_fen', 'INTEGER'], ['下单时间', 'VARCHAR']] as const
).map(([name, type]) => ({ name, type }));
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

const issuesWith = (text: string, source: typeof columns | ((table: string) => { name: string; type: string }[] | string)) => {
  const r = checkMapping(text, source);
  if (r.ok) throw new Error('应当校验失败');
  return r.issues;
};
const issues = (text: string) => issuesWith(text, columns);

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

  it('兜底值带进合并计划：写 null 与不写是两回事，没有值字典的枚举字段也能兜底', () => {
    const plan = (text: string) => {
      const r = checkMapping(text, columns);
      if (!r.ok) throw new Error(r.issues.map(i => i.message).join('\n'));
      return r.plan;
    };
    const status = (text: string) => plan(text).columns.find(c => c.name === 'status')!;
    expect(status(ok.replace('    expr: status\n', '    expr: status\n    otherwise: cancelled\n'))).toMatchObject({ otherwise: 'cancelled' });
    expect(status(ok.replace('    expr: status\n', '    expr: status\n    otherwise: null\n'))).toHaveProperty('otherwise', null);
    expect(status(ok)).not.toHaveProperty('otherwise');
    expect(status(ok.replace(/  status:[^]*$/, '  status: { expr: status, otherwise: null }\n'))).toMatchObject({ otherwise: null, enum: expect.arrayContaining(['paid']) });
    // 扩展字段的兜底值不受标准枚举限制
    const level = plan(`${ok}extensions:\n  x_level: { type: string, expr: string(pay_fen), dictionary: { '1': gold }, otherwise: other }\n`);
    expect(level.columns.find(c => c.name === 'x_level')).toMatchObject({ otherwise: 'other' });
  });

  it('兜底值不是标准枚举、或字段既没有值字典也没有标准枚举时被拒绝', () => {
    const found = issues(ok.replace('    expr: status\n', '    expr: status\n    otherwise: Canceled\n'));
    expect(found).toEqual([expect.objectContaining({ path: 'fields.status.otherwise', message: expect.stringMatching(/Canceled 不是标准枚举值/), hint: 'otherwise: cancelled' })]);
    expect(issues(ok.replace('  customer_id: customer_id', '  customer_id: { expr: customer_id, otherwise: null }'))).toEqual([
      expect.objectContaining({ path: 'fields.customer_id.otherwise', message: expect.stringMatching(/没有值字典/) }),
    ]);
    expect(issues(`${ok}extensions:\n  x_note: { type: string, expr: string(pay_fen), otherwise: other }\n`)).toEqual([
      expect.objectContaining({ path: 'extensions.x_note.otherwise', message: expect.stringMatching(/没有值字典/) }),
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

describe('敏感字段', () => {
  const CUSTOMERS = (table: string) => (table === 'customers'
    ? [{ name: 'id', type: 'BIGINT' }, { name: 'name', type: 'VARCHAR' }, { name: 'wechat', type: 'VARCHAR' }, { name: 'age', type: 'INTEGER' }]
    : `数据源中没有表 ${table}`);
  const BASE = 'model: 1\nentity: customer\ntable: customers\nfields:\n  customer_id: string(id)\n';

  it('扩展字段可以标成敏感：合并计划里的列带上标记；内置敏感字段在计划里总是敏感', () => {
    const r = checkMapping(`${BASE}  name: name\n  gender: \"'unknown'\"\nextensions:\n  x_wechat: { type: string, expr: wechat, sensitive: true }\n  x_age: { type: integer, expr: age, sensitive: false }\n`, CUSTOMERS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const col = (name: string) => r.plan.columns.find(c => c.name === name);
    expect(col('x_wechat')).toMatchObject({ sensitive: true });
    expect(col('name')).toMatchObject({ sensitive: true });
    expect(col('gender')?.sensitive).toBeUndefined();
    expect(col('x_age')?.sensitive).toBeUndefined();
  });

  it('敏感扩展字段只存哈希：类型只能是文本，不能带值字典与兜底', () => {
    const found = issuesWith(`${BASE}extensions:\n  x_age: { type: integer, expr: age, sensitive: true }\n`, CUSTOMERS);
    expect(found).toEqual([expect.objectContaining({ path: 'extensions.x_age.type', message: expect.stringMatching(/敏感.*string/), hint: expect.stringContaining('type: string') })]);
    // 哈希的是源端取值，值字典与兜底对它不起作用
    expect(issuesWith(`${BASE}extensions:\n  x_wechat: { type: string, expr: wechat, sensitive: true, dictionary: { a: b } }\n`, CUSTOMERS)).toEqual([
      expect.objectContaining({ path: 'extensions.x_wechat.sensitive', message: expect.stringContaining('值字典') }),
    ]);
  });

  it('内置敏感字段不能取消敏感标记；标准字段不能自行标成敏感', () => {
    expect(checkMapping(`${BASE}  name: { expr: name, sensitive: true }\n`, CUSTOMERS).ok).toBe(true);
    expect(issuesWith(`${BASE}  name: { expr: name, sensitive: false }\n`, CUSTOMERS)).toEqual([
      expect.objectContaining({ line: 6, path: 'fields.name.sensitive', message: expect.stringContaining('不能取消') }),
    ]);
    expect(issuesWith(`${BASE}  city: { expr: wechat, sensitive: true }\n`, CUSTOMERS)).toEqual([
      expect.objectContaining({ path: 'fields.city.sensitive', message: expect.stringContaining('扩展字段') }),
    ]);
  });
});

describe('身份打通的匹配规则', () => {
  const CUSTOMERS = (table: string) => (table === 'customers'
    ? ['id', 'mobile', 'mail', 'wechat', 'city'].map(name => ({ name, type: name === 'id' ? 'BIGINT' : 'VARCHAR' }))
    : `数据源中没有表 ${table}`);
  const BASE = 'model: 1\nentity: customer\ntable: customers\nfields:\n  customer_id: string(id)\n  phone: mobile\n  email: mail\n  city: city\n'
    + 'extensions:\n  x_wechat: { type: string, expr: wechat, sensitive: true }\n';

  it('匹配字段按顺序是优先级，带进合并计划；没写时计划里没有', () => {
    const r = checkMapping(`${BASE}identity:\n  match: [email, x_wechat, phone]\n`, CUSTOMERS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.identity).toEqual({ match: ['email', 'x_wechat', 'phone'] });
    const plain = checkMapping(BASE, CUSTOMERS);
    expect(plain.ok && plain.plan.identity).toBeUndefined();
  });

  it('只能选本映射映射出来的敏感字段，不能重复，至少一个', () => {
    expect(issuesWith(`${BASE}identity:\n  match: [phone, external_id, city]\n`, CUSTOMERS)).toEqual([
      expect.objectContaining({ path: 'identity.match.1', message: expect.stringContaining('没有映射') }),
      expect.objectContaining({ path: 'identity.match.2', message: expect.stringContaining('不是敏感字段') }),
    ]);
    expect(issuesWith(`${BASE}identity:\n  match: [phone, phone]\n`, CUSTOMERS)).toEqual([expect.objectContaining({ path: 'identity.match', message: '不能有重复项' })]);
    expect(issuesWith(`${BASE}identity:\n  match: []\n`, CUSTOMERS)).toEqual([expect.objectContaining({ path: 'identity.match', message: '不能为空' })]);
  });

  it('只有消费者（customer）映射能配置匹配规则', () => {
    expect(issues(`${ok}identity:\n  match: [customer_id]\n`)).toEqual([
      expect.objectContaining({ path: 'identity', message: expect.stringContaining('customer') }),
    ]);
  });
});

describe('映射报错给出改法', () => {
  const withFields = (lines: string) => ok.replace(/  amount: .*\n  created_at: .*\n/, lines);

  it('fields 下写了不存在的标准字段：按右边的源列名、去掉 x_ 的名字或相近的名字提示该写哪个标准字段', () => {
    const found = issues(withFields('  x_order_ts: created_at\n  x_pay_amount: pay_fen / 100\n'));
    expect(found.map(i => [i.path, i.message])).toEqual([
      ['fields.x_order_ts', expect.stringMatching(/没有标准字段 x_order_ts.*是不是想写 created_at（下单时间）？/)],
      ['fields.x_pay_amount', expect.stringMatching(/没有标准字段 x_pay_amount.*是不是想写 amount（实付金额）？/)],
    ]);
    expect(found[0].hint).toContain('created_at: created_at');
    expect(found[1].hint).toContain('amount: pay_fen / 100');
    // 拼错的字段名按相近匹配
    const typo = issues(withFields('  ammount: pay_fen / 100\n'))[0];
    expect(typo.message).toMatch(/没有标准字段 ammount.*是不是想写 amount（实付金额）？/);
    expect(typo.hint).toBe('amount: pay_fen / 100');
  });

  it('fields 下的 x_ 字段附带放到 extensions 下的写法，类型按源列推断', () => {
    const [ts, pay] = issues(withFields('  x_order_ts: created_at\n  x_pay_amount: pay_fen / 100\n'));
    expect(ts.hint).toContain('extensions:\n  x_order_ts: { type: timestamp, expr: created_at }');
    expect(pay.hint).toContain('extensions:\n  x_pay_amount: { type: decimal, expr: pay_fen / 100 }');
    const [coupon] = issues(withFields('  x_coupon: string(pay_fen)\n'));
    expect(coupon.message).toMatch(/没有标准字段 x_coupon.*extensions/);
    expect(coupon.hint).toBe('extensions:\n  x_coupon: { type: string, expr: string(pay_fen) }');
  });

  it('fields 下写成扩展字段的样子（带 type）时只报一条：移到 extensions 下，type 换成标准层的类型', () => {
    // 行内写法里 DECIMAL(12,2) 的逗号把它拆成了 type: DECIMAL(12 与一个叫 2) 的键，不再逐项报「不认识的项」
    const found = issues(`${ok}  x_discount: { type: DECIMAL(12,2), expr: pay_fen }\n`);
    expect(found).toEqual([expect.objectContaining({
      path: 'fields.x_discount',
      message: expect.stringMatching(/x_discount 带了类型，是扩展字段：请移到 extensions 下/),
      hint: 'extensions:\n  x_discount: { type: decimal, expr: pay_fen }',
    })]);
  });

  it('扩展字段的 type 写成源端的数据库类型时只报一条，给出换算后的写法', () => {
    const found = issues(`${ok}extensions:\n  x_discount: { type: DECIMAL(12,2), expr: pay_fen }\n  x_note:\n    type: VARCHAR\n    expr: string(pay_fen)\n`);
    expect(found.map(i => [i.path, i.message, i.hint])).toEqual([
      ['extensions.x_discount.type', expect.stringMatching(/类型要写标准层的类型.*decimal/), 'x_discount: { type: decimal, expr: pay_fen }'],
      ['extensions.x_note.type', expect.stringMatching(/类型要写标准层的类型/), 'x_note: { type: string, expr: string(pay_fen) }'],
    ]);
  });

  it('值字典用在非文本字段、对应到非标准枚举、缺主键时各附一行改好的写法', () => {
    const dictionary = issues(ok.replace('      已支付: paid', '      已支付: settled'))[0];
    expect(dictionary.hint).toBe('已支付: paid');
    const level = issues(`${ok}extensions:\n  x_level: { type: integer, expr: pay_fen, dictionary: { '1': gold } }\n`)[0];
    expect(level.message).toBe('值字典只能用于文本字段');
    expect(level.hint).toBe("x_level: { type: string, expr: pay_fen, dictionary: { '1': gold } }");
    const key = issues(ok.replace('  order_id: string(order_id)\n', ''))[0];
    expect(key.message).toMatch(/没有映射订单的主键 order_id/);
    expect(key.hint).toBe('order_id: string(order_id)');
    // 源表里没有能对应主键的列时，给出映射主键或声明去重键的写法
    const unknown = checkMapping(ok.replace('  order_id: string(order_id)\n', ''));
    expect(!unknown.ok && unknown.issues[0].hint).toMatch(/^order_id: .*\n# 或者\ndedupe:\n  key: \[/);
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
