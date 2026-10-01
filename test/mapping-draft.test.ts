// 按规则生成映射草稿（纯函数）：源表的列统计 + 目标实体 → 映射 YAML。列名规范化与同义词匹配、格式特征校验、分 / 毫秒 / 无时区时间的转换、
// 值字典骨架、没有主键的表；生成的草稿交给 checkMapping 校验。三张表贴合开发库 crm_source（db_script/mysql_seed.sql）的列统计
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { entityOf } from '../app/lib/canonical-model';
import { fieldsForColumn, normalizeName, standardValue } from '../app/lib/field-synonyms';
import { draftMapping } from '../app/.server/pipeline/mapping-draft';
import { checkMapping } from '../app/.server/pipeline/mapping-spec';
import type { ColumnProfile, TableProfile } from '../app/.server/pipeline/source-engine';

const column = (name: string, type: string, extra: Partial<ColumnProfile> = {}): ColumnProfile =>
  ({ name, type, nullRate: 0, distinct: 100, min: null, max: null, ...extra });
const table = (name: string, columns: ColumnProfile[], primaryKey: string[] = []): TableProfile =>
  ({ name, rows: 1000, sampleRows: 1000, columns, watermarkCandidates: [], primaryKey, keyCandidates: [] });
const top = (...values: string[]) => values.map((value, i) => ({ value, rows: 100 - i }));

const ORDERS = table('orders', [
  column('order_id', 'BIGINT', { min: '1', max: '5000' }),
  column('order_no', 'VARCHAR', { length: { min: 13, max: 13 }, formats: [] }),
  column('customer_id', 'BIGINT', { min: '1', max: '1000' }),
  column('status', 'VARCHAR', { distinct: 6, top: top('已完成', '已支付', '已发货', '待支付', '已取消', '已退款') }),
  column('pay_amount', 'DECIMAL(12,2)', { min: '0.00', max: '0.00' }),
  column('ordered_at', 'TIMESTAMP', { min: '2024-01-01 09:37:00', max: '2024-12-01 00:00:00' }),
  column('updated_at', 'TIMESTAMP', { min: '2024-01-01 09:37:00', max: '2024-12-01 00:00:00' }),
], ['order_id']);

const CUSTOMERS = table('customers', [
  column('customer_id', 'BIGINT', { min: '1', max: '1000' }),
  column('name', 'VARCHAR', { formats: [] }),
  column('gender', 'VARCHAR', { distinct: 3, top: top('男', '女', '未知') }),
  column('mobile', 'VARCHAR', { formats: [] }),
  column('email', 'VARCHAR', { nullRate: 0.2, formats: [{ format: 'email', share: 1 }] }),
  column('city', 'VARCHAR', { distinct: 6, top: top('北京', '上海', '广州', '深圳', '杭州', '成都') }),
  column('registered_at', 'TIMESTAMP'),
  column('updated_at', 'TIMESTAMP'),
], ['customer_id']);

const EVENTS = table('events', [
  column('customer_id', 'BIGINT', { nullRate: 0.11, min: '1', max: '1000' }),
  column('event_type', 'VARCHAR', { distinct: 4, top: top('浏览', '加购', '收藏', '搜索') }),
  column('sku', 'VARCHAR', { nullRate: 0.17, distinct: 200 }),
  column('occurred_ms', 'BIGINT', { min: '1704067331000', max: '1706687200000' }),
  column('channel', 'VARCHAR', { distinct: 3, top: top('app', 'mini', 'web') }),
]);

const columnsOf = (...tables: TableProfile[]) => (name: string) =>
  tables.find(t => t.name === name)?.columns.map(c => c.name) ?? `数据源中没有表 ${name}`;

const draft = (t: TableProfile, entity: string, opts?: Parameters<typeof draftMapping>[2]) => draftMapping(t, entityOf(entity)!, opts);
const fields = (yaml: string) => (parse(yaml) as { fields: Record<string, unknown> }).fields;
/** 某个字段那一行（含行尾注释） */
const lineOf = (yaml: string, field: string) => yaml.split('\n').find(l => l.trimStart().startsWith(`${field}:`)) ?? '';

describe('列名规范化与同义词', () => {
  it('驼峰、大小写、连字符与下划线都规范成同一个写法', () => {
    for (const s of ['OrderId', 'order-id', 'ORDER_ID', 'orderID', 'order__id', 'Order Id']) expect(normalizeName(s)).toBe('order_id');
    expect(normalizeName('HTMLPage')).toBe('html_page');
  });

  it('同名优先于同义词，带单位后缀的列去掉后缀再对应', () => {
    expect(fieldsForColumn('order', 'OrderId')[0]).toMatchObject({ field: 'order_id', by: 'same' });
    expect(fieldsForColumn('order', 'pay_amount')[0]).toMatchObject({ field: 'amount', by: 'synonym' });
    expect(fieldsForColumn('order', 'ordered_at')[0]).toMatchObject({ field: 'created_at', by: 'synonym' });
    expect(fieldsForColumn('order', 'amount_fen')[0]).toMatchObject({ field: 'amount', by: 'same' });
    expect(fieldsForColumn('event', 'occurred_ms')[0]).toMatchObject({ field: 'occurred_at', by: 'synonym' });
    expect(fieldsForColumn('customer', 'Mobile')[0]).toMatchObject({ field: 'phone', by: 'synonym' });
    expect(fieldsForColumn('customer', 'remark')).toEqual([]);
  });

  it('取值近义词对应到标准枚举值，纯数字编码对不上', () => {
    expect(standardValue('order', 'status', '已支付')).toBe('paid');
    expect(standardValue('order', 'status', 'PAID')).toBe('paid');
    expect(standardValue('customer', 'gender', '女')).toBe('female');
    expect(standardValue('order', 'status', '2')).toBeUndefined();
    expect(standardValue('order', 'channel', 'app')).toBeUndefined();
  });
});

describe('开发库三张表生成的草稿', () => {
  const columns = columnsOf(ORDERS, CUSTOMERS, EVENTS);

  it('orders：直接通过保存校验，同义词与转换写在行尾注释里', () => {
    const yaml = draft(ORDERS, 'order');
    expect(checkMapping(yaml, columns)).toMatchObject({ ok: true, plan: { key: ['order_id'] } });
    expect(fields(yaml)).toMatchObject({
      order_id: 'string(order_id)',
      customer_id: 'string(customer_id)',
      amount: 'pay_amount',
      created_at: "from_timezone(ordered_at, 'Asia/Shanghai')",
      updated_at: "from_timezone(updated_at, 'Asia/Shanghai')",
      status: { expr: 'status', dictionary: { 已完成: 'completed', 已支付: 'paid', 已发货: 'shipped', 待支付: 'created', 已取消: 'cancelled', 已退款: 'refunded' } },
    });
    expect(lineOf(yaml, 'amount')).toContain('# 同义词：pay_amount');
    expect(lineOf(yaml, 'created_at')).toMatch(/# 同义词：ordered_at.*时区/);
    expect(lineOf(yaml, 'order_id')).toContain('# 同名');
    // 没对应上的标准字段与多出来的源列列在文末
    const tail = yaml.slice(yaml.lastIndexOf('\n\n'));
    expect(tail).toMatch(/paid_at/);
    expect(tail).toMatch(/order_no/);
  });

  it('customers：带空格的手机号过不了格式校验，不自动对应，在文末说明', () => {
    const yaml = draft(CUSTOMERS, 'customer');
    expect(checkMapping(yaml, columns).ok).toBe(true);
    expect(fields(yaml)).not.toHaveProperty('phone');
    expect(fields(yaml)).toMatchObject({ email: 'email', gender: { dictionary: { 男: 'male', 女: 'female', 未知: 'unknown' } } });
    expect(lineOf(yaml, 'email')).toContain('格式：邮箱');
    expect(yaml).toMatch(/# .*phone.*mobile.*手机号/);
  });

  it('events：没有主键时用整行拼出事件 ID 并注释说明，毫秒时间戳转成时间', () => {
    const yaml = draft(EVENTS, 'event');
    expect(checkMapping(yaml, columns)).toMatchObject({ ok: true, plan: { key: ['event_id'] } });
    expect(fields(yaml)).toMatchObject({
      event_id: "concat(customer_id, '|', event_type, '|', sku, '|', occurred_ms, '|', channel)",
      customer_id: 'string(customer_id)',
      occurred_at: 'from_epoch_millis(occurred_ms)',
    });
    expect(lineOf(yaml, 'event_id')).toContain('没有主键');
    expect(lineOf(yaml, 'occurred_at')).toContain('毫秒');
    expect(yaml).toMatch(/# 源表里没用到的列.*sku.*channel/);
  });
});

describe('转换与值字典', () => {
  it('列名带 _cents / _fen 的金额除以 100', () => {
    const t = table('orders', [column('id', 'BIGINT'), column('total_fen', 'BIGINT'), column('PayAmountCents', 'INTEGER')], ['id']);
    const yaml = draft(t, 'order');
    expect(fields(yaml).amount).toBe('PayAmountCents / 100');
    expect(lineOf(yaml, 'amount')).toContain('分');
    expect(fields(draft(table('orders', [column('id', 'BIGINT'), column('total_fen', 'BIGINT')], ['id']), 'order')).amount).toBe('total_fen / 100');
  });

  it('BIGINT 只有取值落在毫秒范围内才当毫秒时间戳；秒级用 from_epoch_seconds，其余不对应', () => {
    const at = (min: string, max: string) =>
      fields(draft(table('events', [column('id', 'VARCHAR'), column('ts', 'BIGINT', { min, max })], ['id']), 'event')).occurred_at;
    expect(at('1704067200000', '1706687200000')).toBe('from_epoch_millis(ts)');
    expect(at('1704067200', '1706687200')).toBe('from_epoch_seconds(ts)');
    expect(at('1', '5000')).toBeUndefined();
  });

  it('带时区的时间直接用，不带时区的按给定时区解读', () => {
    const t = table('orders', [column('id', 'VARCHAR'), column('created_at', 'TIMESTAMP WITH TIME ZONE'), column('pay_time', 'TIMESTAMP')], ['id']);
    const f = fields(draft(t, 'order', { timezone: 'UTC' }));
    expect(f.created_at).toBe('created_at');
    expect(f.paid_at).toBe("from_timezone(pay_time, 'UTC')");
  });

  it('值字典里对不上的取值（纯数字编码）留空，校验只拦在这些字典项上并报出位置', () => {
    const t = table('orders', [column('order_id', 'VARCHAR'), column('state', 'INTEGER', { top: undefined }), column('status', 'VARCHAR', { top: top('已支付', '1', '9') })], ['order_id']);
    const yaml = draft(t, 'order');
    expect(fields(yaml).status).toMatchObject({ dictionary: { 已支付: 'paid', 1: null, 9: null } });
    const r = checkMapping(yaml);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map(i => i.path)).toEqual(['fields.status.dictionary.1', 'fields.status.dictionary.9']);
    const lines = yaml.split('\n');
    expect(lines[r.issues[0].line - 1]).toMatch(/"1":.*# 待填/);
  });

  it('格式特征对不上、类型不兼容的列不自动对应', () => {
    const t = table('customers', [
      column('id', 'VARCHAR'),
      column('phone', 'VARCHAR', { formats: [{ format: 'mobile', share: 0.9 }] }),
      column('email', 'VARCHAR', { formats: [] }),
      column('birthday', 'BOOLEAN'),
    ], ['id']);
    const yaml = draft(t, 'customer');
    const f = fields(yaml);
    expect(f).toMatchObject({ customer_id: 'id', phone: 'phone' });
    expect(f).not.toHaveProperty('email');
    expect(f).not.toHaveProperty('birthday');
    expect(lineOf(yaml, 'phone')).toContain('格式：手机号');
  });

  it('需要引号的列名在表达式里加上双引号', () => {
    const t = table('orders', [column('Order ID', 'VARCHAR'), column('Created-At', 'TIMESTAMP')], ['Order ID']);
    const yaml = draft(t, 'order');
    expect(fields(yaml)).toMatchObject({ order_id: '"Order ID"', created_at: `from_timezone("Created-At", 'Asia/Shanghai')` });
    expect(checkMapping(yaml, () => ['Order ID', 'Created-At']).ok).toBe(true);
  });
});

describe('去重键', () => {
  it('实体主键没有对应上时用源表主键拼出来', () => {
    const t = table('order_items', [column('order_id', 'BIGINT'), column('line_no', 'INTEGER'), column('sku', 'VARCHAR'), column('qty', 'INTEGER')], ['order_id', 'line_no']);
    const yaml = draft(t, 'order_item');
    expect(fields(yaml)).toMatchObject({ order_item_id: "concat(order_id, '-', line_no)", order_id: 'string(order_id)', product_id: 'sku', quantity: 'qty' });
    expect(lineOf(yaml, 'order_item_id')).toContain('源表主键');
    expect(checkMapping(yaml).ok).toBe(true);
  });

  it('源表主键对应到别的字段时声明去重键；没有主键时用成员声明的业务主键', () => {
    const t = table('members', [column('card', 'VARCHAR'), column('member_id', 'BIGINT'), column('customer_id', 'BIGINT')], ['customer_id']);
    expect(parse(draft(t, 'membership')).dedupe).toEqual({ key: ['customer_id'] });
    const declared = table('members', [column('member_id', 'BIGINT'), column('customer_id', 'BIGINT')]);
    const yaml = draft(declared, 'membership', { key: ['member_id'] });
    expect(fields(yaml).membership_id).toBe('string(member_id)');
    expect(parse(yaml).dedupe).toBeUndefined();
    expect(lineOf(yaml, 'membership_id')).toContain('业务主键');
  });
});
