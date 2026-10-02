// 按规则生成映射草稿（纯函数）：源表的列统计 + 目标实体 → 映射 YAML。列名规范化与同义词匹配、格式特征校验、分 / 毫秒 / 无时区时间的转换、
// 值字典骨架、没有主键的表；生成的草稿交给 checkMapping 校验。八张表贴合开发库 crm_source（db_script/mysql_seed.sql）的列统计
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

const POINT_LOGS = table('point_logs', [
  column('id', 'BIGINT', { min: '1', max: '4000' }),
  column('customer_id', 'BIGINT', { min: '1', max: '299' }),
  column('member_no', 'BIGINT', { min: '1', max: '200' }),
  column('change_type', 'VARCHAR', { distinct: 5, top: top('获得', '消费', '兑换', '调整', '过期') }),
  column('points', 'INTEGER', { min: '-149', max: '599' }),
  column('balance', 'INTEGER', { min: '180', max: '2878' }),
  column('order_no', 'VARCHAR', { nullRate: 0.45, length: { min: 13, max: 13 }, formats: [] }),
  column('created_at', 'TIMESTAMP', { min: '2024-01-01 09:03:00', max: '2024-09-23 23:57:00' }),
  column('expire_time', 'TIMESTAMP', { nullRate: 0.65, min: '2025-01-01 09:03:00', max: '2025-09-10 23:57:00' }),
  column('remark', 'VARCHAR', { formats: [] }),
], ['id']);

const CONSENTS = table('consents', [
  column('customer_id', 'BIGINT', { min: '1', max: '1000' }),
  column('channel', 'VARCHAR', { distinct: 4, top: top('短信', '邮件', 'APP推送', '微信') }),
  column('opt_in', 'CHAR', { distinct: 2, top: top('Y', 'N') }),
  column('agree_time', 'TIMESTAMP', { nullRate: 0.13, min: '2023-01-02 22:00:00', max: '2024-05-16 11:00:00' }),
  column('revoke_time', 'TIMESTAMP', { nullRate: 0.8, min: '2024-02-01 19:00:00', max: '2024-08-27 21:00:00' }),
  column('update_time', 'TIMESTAMP', { min: '2023-01-02 22:00:00', max: '2024-08-27 21:00:00' }),
], ['customer_id', 'channel']);

const PREFERENCES = table('preferences', [
  column('id', 'BIGINT', { min: '1', max: '2000' }),
  column('customer_id', 'BIGINT', { min: '1', max: '1000' }),
  column('pref_type', 'VARCHAR', { distinct: 3, top: top('category', 'brand', 'flavor') }),
  column('pref_value', 'VARCHAR', { distinct: 12, formats: [] }),
  column('updated_at', 'TIMESTAMP', { min: '2024-03-01 09:00:00', max: '2024-04-12 00:00:00' }),
], ['id']);

const COUPON_TEMPLATES = table('coupon_templates', [
  column('template_id', 'VARCHAR', { distinct: 7, formats: [] }),
  column('title', 'VARCHAR', { distinct: 7, formats: [] }),
  column('coupon_type', 'VARCHAR', { distinct: 4, top: top('满减', '折扣', '赠品', '免运费') }),
  column('face_value_fen', 'INTEGER', { nullRate: 0.57, min: '1000', max: '5000' }),
  column('pay_rate', 'DECIMAL(5,2)', { nullRate: 0.71, min: '85.00', max: '87.50' }),
  column('threshold_fen', 'INTEGER', { nullRate: 0.57, min: '10000', max: '30000' }),
], ['template_id']);

const COUPONS = table('coupons', [
  column('coupon_code', 'VARCHAR', { distinct: 3000, length: { min: 10, max: 10 }, formats: [] }),
  column('template_id', 'VARCHAR', { distinct: 7, top: top('TPL01', 'TPL02', 'TPL03', 'TPL04', 'TPL05', 'TPL06', 'TPL07') }),
  column('activity_id', 'VARCHAR', { nullRate: 0.25, distinct: 12, formats: [] }),
  column('user_id', 'BIGINT', { min: '1', max: '1000' }),
  column('status', 'VARCHAR', { distinct: 4, top: top('已使用', '未使用', '已过期', '已作废') }),
  column('receive_time', 'TIMESTAMP', { min: '2024-01-01 12:37:00', max: '2024-11-25 03:00:00' }),
  column('use_time', 'TIMESTAMP', { nullRate: 0.6, min: '2024-01-04 12:37:00', max: '2024-11-29 03:00:00' }),
  column('order_no', 'VARCHAR', { nullRate: 0.6, length: { min: 13, max: 13 }, formats: [] }),
  column('discount_fen', 'INTEGER', { nullRate: 0.6, min: '800', max: '5000' }),
  column('expire_time', 'TIMESTAMP', { min: '2024-01-31 12:37:00', max: '2024-12-25 03:00:00' }),
  column('update_time', 'TIMESTAMP', { min: '2024-01-01 12:37:00', max: '2024-12-25 03:00:00' }),
], ['coupon_code']);

const columnsOf = (...tables: TableProfile[]) => (name: string) =>
  tables.find(t => t.name === name)?.columns ?? `数据源中没有表 ${name}`;

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

describe('开发库八张表生成的草稿', () => {
  const columns = columnsOf(ORDERS, CUSTOMERS, EVENTS, POINT_LOGS, CONSENTS, PREFERENCES, COUPON_TEMPLATES, COUPONS);

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

  it('point_logs：积分流水的主要字段都对上，中文变动类型预填值字典，直接通过保存校验', () => {
    const yaml = draft(POINT_LOGS, 'points_transaction');
    expect(checkMapping(yaml, columns)).toMatchObject({ ok: true, plan: { key: ['points_transaction_id'] } });
    expect(fields(yaml)).toMatchObject({
      points_transaction_id: 'string(id)',
      customer_id: 'string(customer_id)',
      membership_id: 'string(member_no)',
      change_type: { expr: 'change_type', dictionary: { 获得: 'earn', 消费: 'spend', 兑换: 'redeem', 调整: 'adjust', 过期: 'expire' } },
      points_change: 'points',
      balance_after: 'balance',
      order_id: 'order_no',
      occurred_at: "from_timezone(created_at, 'Asia/Shanghai')",
      expires_at: "from_timezone(expire_time, 'Asia/Shanghai')",
    });
    expect(lineOf(yaml, 'membership_id')).toContain('# 同义词：member_no');
    expect(yaml).toMatch(/# 源表里没用到的列.*remark/);
    // member_id 在积分流水里是会员号，不是消费者 ID
    expect(fieldsForColumn('points_transaction', 'member_id')[0]).toMatchObject({ field: 'membership_id' });
  });

  it('consents：复合主键就是营销同意的主键，渠道与 Y / N 预填值字典，直接通过保存校验', () => {
    const yaml = draft(CONSENTS, 'consent');
    expect(checkMapping(yaml, columns)).toMatchObject({ ok: true, plan: { key: ['customer_id', 'channel'] } });
    expect(fields(yaml)).toEqual({
      customer_id: 'string(customer_id)',
      channel: { expr: 'channel', dictionary: { 短信: 'sms', 邮件: 'email', APP推送: 'push', 微信: 'wechat' } },
      status: { expr: 'opt_in', dictionary: { Y: 'granted', N: 'revoked' } },
      granted_at: "from_timezone(agree_time, 'Asia/Shanghai')",
      revoked_at: "from_timezone(revoke_time, 'Asia/Shanghai')",
      updated_at: "from_timezone(update_time, 'Asia/Shanghai')",
    });
    expect(yaml).not.toContain('dedupe');
  });

  it('preferences：偏好类型与偏好值对上，按实体主键去重并提示确认，直接通过保存校验', () => {
    const yaml = draft(PREFERENCES, 'preference');
    expect(checkMapping(yaml, columns)).toMatchObject({ ok: true, plan: { key: ['customer_id', 'preference_type', 'preference_value'] } });
    expect(fields(yaml)).toEqual({
      customer_id: 'string(customer_id)',
      preference_type: 'pref_type',
      preference_value: 'pref_value',
      updated_at: "from_timezone(updated_at, 'Asia/Shanghai')",
    });
    expect(yaml).toContain('按 customer_id + preference_type + preference_value 去重，请确认它唯一');
  });

  it('coupon_templates：券类型预填值字典，面额与门槛以分为单位除以 100，直接通过保存校验', () => {
    const yaml = draft(COUPON_TEMPLATES, 'coupon_template');
    expect(checkMapping(yaml, columns)).toMatchObject({ ok: true, plan: { key: ['coupon_template_id'] } });
    expect(fields(yaml)).toEqual({
      coupon_template_id: 'template_id',
      name: 'title',
      coupon_type: { expr: 'coupon_type', dictionary: { 满减: 'cash', 折扣: 'discount', 赠品: 'gift', 免运费: 'shipping' } },
      face_value: 'face_value_fen / 100',
      pay_percent: 'pay_rate',
      min_spend: 'threshold_fen / 100',
    });
    expect(yaml).not.toContain('源表里没用到的列');
  });

  it('coupons：券码作主键，中文券状态预填值字典，抵扣金额以分为单位，直接通过保存校验', () => {
    const yaml = draft(COUPONS, 'coupon');
    expect(checkMapping(yaml, columns)).toMatchObject({ ok: true, plan: { key: ['coupon_id'] } });
    expect(fields(yaml)).toEqual({
      coupon_id: 'coupon_code',
      coupon_template_id: 'template_id',
      campaign_id: 'activity_id',
      customer_id: 'string(user_id)',
      status: { expr: 'status', dictionary: { 已使用: 'redeemed', 未使用: 'issued', 已过期: 'expired', 已作废: 'voided' } },
      issued_at: "from_timezone(receive_time, 'Asia/Shanghai')",
      redeemed_at: "from_timezone(use_time, 'Asia/Shanghai')",
      order_id: 'order_no',
      discount_amount: 'discount_fen / 100',
      expires_at: "from_timezone(expire_time, 'Asia/Shanghai')",
      updated_at: "from_timezone(update_time, 'Asia/Shanghai')",
    });
    expect(lineOf(yaml, 'coupon_id')).toContain('源表主键');
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
    expect(checkMapping(yaml, () => [{ name: 'Order ID', type: 'VARCHAR' }, { name: 'Created-At', type: 'TIMESTAMP' }]).ok).toBe(true);
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
