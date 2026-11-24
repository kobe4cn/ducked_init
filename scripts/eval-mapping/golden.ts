// scripts/eval-mapping/golden.ts —— 映射黄金集（ADR-0035 的评测）：每个样例是手写的表统计、目标实体与期望映射 YAML（golden/<name>.yaml，改写自种子映射）。
// 自定义实体样例带登记（registration）：评测与产品一样用自定义实体的规则草稿、带登记校验。
// 表统计照采集的写法：文本列才有 top，敏感列（手机号、邮箱）不给 top；列名与期望 YAML 引用的源列一致
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { noteKey } from '../../app/lib/business-note-key';
import { buildCatalog, type CatalogInput } from '../../app/.server/catalog';
import type { RegisteredEntity } from '../../app/.server/custom-entities';
import type { ColumnProfile, TableProfile } from '../../app/.server/pipeline/source-engine';

/** 样例要考的情形：字段改名、金额以分计、状态是中文或数字枚举、有重复行要去重、自定义实体、事件类型（取列或常量） */
export type GoldenKind = 'rename' | 'cents' | 'status_enum' | 'dedupe' | 'custom_entity' | 'event_type';

export interface GoldenCase {
  name: string;
  kinds: GoldenKind[];
  entity: string;
  profile: TableProfile;
  expectedYaml: string;
  /** 自定义实体样例的登记；标准实体样例没有 */
  registration?: RegisteredEntity;
}

const column = (name: string, type: string, extra: Partial<ColumnProfile> = {}): ColumnProfile =>
  ({ name, type, nullRate: 0, distinct: 1000, min: null, max: null, ...extra });
const table = (name: string, columns: ColumnProfile[], primaryKey: string[] = [], keyCandidates: string[] = []): TableProfile =>
  ({ name, rows: 1000, sampleRows: 1000, columns, watermarkCandidates: [], primaryKey, keyCandidates });
const top = (...values: string[]) => values.map((value, i) => ({ value, rows: 200 - i * 20 }));
const yaml = (name: string) => readFileSync(join(import.meta.dirname, 'golden', `${name}.yaml`), 'utf8');

const golden = (name: string, kinds: GoldenKind[], entity: string, profile: TableProfile, registration?: RegisteredEntity): GoldenCase =>
  ({ name, kinds, entity, profile, expectedYaml: yaml(name), ...(registration && { registration }) });

const storeField = (name: string, description: string) => ({ name, type: 'string' as const, description, sensitive: false });
/** 自定义实体「门店」的登记，照 crm-seed check-mappings.ts 的 custom_store；不带关系（否则还要登记订单与区域） */
const CUSTOM_STORE: RegisteredEntity = {
  name: 'custom_store', label: '门店', kind: 'dimension',
  fields: [
    storeField('store_id', '门店编码，源端的门店标识'),
    storeField('store_name', '门店名称'),
    storeField('region_id', '门店所属区域的编码'),
  ],
  primaryKey: ['store_id'],
};

export const GOLDEN: GoldenCase[] = [
  golden('rename-customers', ['rename'], 'customer', table('customers', [
    column('customer_id', 'BIGINT', { min: '1', max: '1000' }),
    column('nick_name', 'VARCHAR', { distinct: 950, length: { min: 2, max: 12 }, formats: [] }),
    column('mobile', 'VARCHAR', { nullRate: 0.05, length: { min: 11, max: 11 }, formats: [{ format: 'mobile', share: 1 }] }),
    column('email', 'VARCHAR', { nullRate: 0.3, length: { min: 12, max: 30 }, formats: [{ format: 'email', share: 1 }] }),
    column('unionid', 'VARCHAR', { nullRate: 0.4, length: { min: 28, max: 28 }, formats: [] }),
    column('gender', 'VARCHAR', { nullRate: 0.1, distinct: 2, top: top('F', 'M') }),
    column('city', 'VARCHAR', { distinct: 6, top: top('上海', '北京', '杭州', '广州', '深圳', '成都') }),
    column('created_at', 'TIMESTAMP WITH TIME ZONE', { min: '2023-01-02 10:00:00+08', max: '2024-11-30 21:00:00+08' }),
    column('updated_at', 'TIMESTAMP WITH TIME ZONE', { min: '2023-01-02 10:00:00+08', max: '2024-12-01 08:00:00+08' }),
  ], ['customer_id'])),

  golden('cents-letter-status', ['cents', 'status_enum'], 'order', table('live_orders', [
    column('order_code', 'VARCHAR', { length: { min: 16, max: 16 }, formats: [] }),
    column('viewer_id', 'BIGINT', { min: '1', max: '800' }),
    column('state', 'VARCHAR', { distinct: 6, top: top('C', 'P', 'S', 'N', 'X', 'R') }),
    column('amount_cents', 'BIGINT', { min: '990', max: '259900' }),
    column('ordered_at', 'TIMESTAMP', { min: '2024-01-01 20:01:00', max: '2024-11-30 23:40:00' }),
    column('paid_at', 'TIMESTAMP', { nullRate: 0.15, min: '2024-01-01 20:03:00', max: '2024-11-30 23:42:00' }),
    column('modified_at', 'TIMESTAMP', { min: '2024-01-01 20:03:00', max: '2024-12-01 10:00:00' }),
  ], [], ['order_code'])),

  golden('chinese-status', ['status_enum'], 'order', table('sales', [
    column('sale_id', 'BIGINT', { min: '1', max: '1000' }),
    column('member_id', 'BIGINT', { nullRate: 0.2, distinct: 600, min: '1', max: '700' }),
    column('status', 'VARCHAR', { distinct: 6, top: top('已完成', '已支付', '已发货', '待支付', '已取消', '已退款') }),
    column('amount', 'DECIMAL(12,2)', { min: '9.90', max: '3999.00' }),
    column('sold_at', 'DATETIME', { min: '2024-01-01 09:12:00', max: '2024-11-30 21:58:00' }),
    column('paid_at', 'DATETIME', { nullRate: 0.1, min: '2024-01-01 09:13:00', max: '2024-11-30 21:59:00' }),
    column('store_code', 'VARCHAR', { distinct: 12, length: { min: 5, max: 5 }, top: top('SH001', 'SH002', 'BJ001', 'HZ001', 'GZ001', 'SZ001') }),
    column('updated_at', 'DATETIME', { min: '2024-01-01 09:13:00', max: '2024-12-01 08:00:00' }),
  ], ['sale_id'])),

  golden('dedupe-orders', ['dedupe', 'status_enum'], 'order', table('orders', [
    column('order_no', 'VARCHAR', { distinct: 980, length: { min: 14, max: 14 }, formats: [] }),
    column('buyer_member_no', 'VARCHAR', { distinct: 500, length: { min: 8, max: 8 }, formats: [] }),
    column('status', 'VARCHAR', { distinct: 6, top: top('DONE', 'PAID', 'SHIPPED', 'UNPAID', 'CANCELED', 'REFUND') }),
    column('pay_amount', 'DOUBLE', { min: '1.0', max: '1999.0' }),
    column('created_at', 'TIMESTAMP WITH TIME ZONE', { min: '2024-01-01 08:30:00+08', max: '2024-11-30 22:10:00+08' }),
    column('pay_paid_at', 'TIMESTAMP WITH TIME ZONE', { nullRate: 0.12, min: '2024-01-01 08:31:00+08', max: '2024-11-30 22:11:00+08' }),
    column('updated_at', 'TIMESTAMP WITH TIME ZONE', { min: '2024-01-01 08:31:00+08', max: '2024-12-01 08:00:00+08' }),
  ])),

  golden('chinese-header-code-status', ['rename', 'cents', 'status_enum'], 'order', table('dy_orders', [
    column('订单编号', 'BIGINT', { min: '6900000000000000001', max: '6900000000000001000' }),
    column('买家openid', 'VARCHAR', { distinct: 700, length: { min: 28, max: 28 }, formats: [] }),
    column('订单状态', 'BIGINT', { distinct: 6, min: '1', max: '21' }),
    column('实付金额（分）', 'BIGINT', { min: '100', max: '199900' }),
    column('下单时间', 'TIMESTAMP', { min: '2024-01-01 10:00:00', max: '2024-11-30 23:00:00' }),
    column('支付时间', 'TIMESTAMP', { nullRate: 0.1, min: '2024-01-01 10:01:00', max: '2024-11-30 23:01:00' }),
    column('更新时间', 'TIMESTAMP', { min: '2024-01-01 10:01:00', max: '2024-12-01 10:00:00' }),
  ], [], ['订单编号'])),

  golden('custom-store', ['custom_entity'], 'custom_store', table('stores', [
    column('store_id', 'VARCHAR', { distinct: 12, length: { min: 5, max: 5 }, top: top('SH001', 'SH002', 'BJ001', 'HZ001', 'GZ001', 'SZ001') }),
    column('store_name', 'VARCHAR', { distinct: 12, length: { min: 4, max: 10 }, top: top('上海南京西路店', '上海徐家汇店', '北京三里屯店', '杭州湖滨店', '广州天河店', '深圳万象城店') }),
    column('region_id', 'VARCHAR', { distinct: 4, length: { min: 2, max: 2 }, top: top('EC', 'NC', 'SC', 'SW') }),
  ], ['store_id']), CUSTOM_STORE),

  golden('event-type-column', ['event_type', 'rename'], 'event', table('events', [
    column('event_id', 'VARCHAR', { length: { min: 32, max: 32 }, formats: [] }),
    column('user_id', 'VARCHAR', { nullRate: 0.4, distinct: 600, length: { min: 8, max: 8 }, formats: [] }),
    column('device_id', 'VARCHAR', { distinct: 900, length: { min: 36, max: 36 }, formats: [] }),
    column('event_name', 'VARCHAR', { distinct: 3, top: top('view', 'add_to_cart', 'login') }),
    column('ts_ms', 'BIGINT', { min: '1704038400000', max: '1733011200000' }),
    column('page', 'VARCHAR', { distinct: 8, top: top('/home', '/product', '/cart', '/search', '/login', '/order') }),
  ], [], ['event_id'])),

  golden('event-type-constant', ['event_type'], 'event', table('chats', [
    column('chat_id', 'VARCHAR', { length: { min: 20, max: 20 }, formats: [] }),
    column('external_userid', 'VARCHAR', { distinct: 400, length: { min: 32, max: 32 }, formats: [] }),
    column('guide_id', 'VARCHAR', { distinct: 20, length: { min: 6, max: 6 }, top: top('G00001', 'G00002', 'G00003', 'G00004', 'G00005', 'G00006') }),
    column('msg_count', 'INTEGER', { distinct: 40, min: '1', max: '60' }),
    column('chat_time', 'TIMESTAMP', { min: '2024-01-01 09:00:00', max: '2024-11-30 22:00:00' }),
  ], [], ['chat_id'])),

  golden('touch-constant-channel', ['status_enum', 'rename'], 'touch', table('mass_sends', [
    column('send_id', 'VARCHAR', { length: { min: 16, max: 16 }, formats: [] }),
    column('external_userid', 'VARCHAR', { distinct: 400, length: { min: 32, max: 32 }, formats: [] }),
    column('campaign_id', 'VARCHAR', { distinct: 8, length: { min: 6, max: 6 }, top: top('CMP001', 'CMP002', 'CMP003', 'CMP004', 'CMP005', 'CMP006') }),
    column('result', 'VARCHAR', { distinct: 4, top: top('送达', '已读', '点击', '失败') }),
    column('send_time', 'TIMESTAMP', { min: '2024-01-05 10:00:00', max: '2024-11-28 20:00:00' }),
  ], ['send_id'])),

  golden('coupon-status', ['rename', 'status_enum'], 'coupon', table('coupons', [
    column('coupon_code', 'VARCHAR', { length: { min: 12, max: 12 }, formats: [] }),
    column('template_id', 'VARCHAR', { distinct: 6, length: { min: 4, max: 4 }, top: top('T001', 'T002', 'T003', 'T004', 'T005', 'T006') }),
    column('campaign_id', 'VARCHAR', { nullRate: 0.2, distinct: 8, length: { min: 6, max: 6 }, top: top('CMP001', 'CMP002', 'CMP003', 'CMP004', 'CMP005', 'CMP006') }),
    column('member_id', 'VARCHAR', { distinct: 600, length: { min: 8, max: 8 }, formats: [] }),
    column('status', 'VARCHAR', { distinct: 4, top: top('UNUSED', 'USED', 'EXPIRED', 'VOID') }),
    column('issued_at', 'TIMESTAMP WITH TIME ZONE', { min: '2024-01-01 10:00:00+08', max: '2024-11-30 20:00:00+08' }),
    column('used_at', 'TIMESTAMP WITH TIME ZONE', { nullRate: 0.6, min: '2024-01-02 12:00:00+08', max: '2024-11-30 21:00:00+08' }),
    column('discount_amount', 'NUMERIC(10,2)', { nullRate: 0.6, min: '5.00', max: '100.00' }),
    column('expires_at', 'TIMESTAMP WITH TIME ZONE', { min: '2024-02-01 00:00:00+08', max: '2025-03-01 00:00:00+08' }),
    column('updated_at', 'TIMESTAMP WITH TIME ZONE', { min: '2024-01-01 10:00:00+08', max: '2024-12-01 08:00:00+08' }),
  ], ['coupon_code'])),

  golden('product-rename', ['rename'], 'product', table('products', [
    column('sku', 'VARCHAR', { length: { min: 10, max: 10 }, formats: [] }),
    column('title', 'VARCHAR', { distinct: 980, length: { min: 4, max: 30 }, formats: [] }),
    column('category', 'VARCHAR', { distinct: 6, top: top('服装', '鞋靴', '美妆', '箱包', '配饰', '家居') }),
    column('brand', 'VARCHAR', { distinct: 6, top: top('品牌A', '品牌B', '品牌C', '品牌D', '品牌E', '品牌F') }),
    column('list_price', 'NUMERIC(10,2)', { min: '19.90', max: '2999.00' }),
  ], ['sku'])),

  golden('membership-status', ['rename', 'status_enum'], 'membership', table('memberships', [
    column('card_no', 'VARCHAR', { length: { min: 8, max: 8 }, formats: [] }),
    column('member_id', 'VARCHAR', { length: { min: 8, max: 8 }, formats: [] }),
    column('tier', 'VARCHAR', { distinct: 4, top: top('silver', 'gold', 'platinum', 'diamond') }),
    column('points_balance', 'INTEGER', { min: '0', max: '99000' }),
    column('status', 'VARCHAR', { distinct: 3, top: top('正常', '冻结', '注销') }),
    column('joined_at', 'TIMESTAMP WITH TIME ZONE', { min: '2022-01-01 10:00:00+08', max: '2024-11-30 20:00:00+08' }),
    column('expires_at', 'TIMESTAMP WITH TIME ZONE', { nullRate: 0.3, min: '2025-01-01 00:00:00+08', max: '2027-12-31 00:00:00+08' }),
  ], ['card_no'])),
];

/** 发给模型的固定目录（产品带本租户的语义目录，ADR-0041）：标准实体、自定义实体门店、实体行数与两条业务说明，纯函数构造，不连库 */
export const CATALOG_INPUT: CatalogInput = {
  entityStats: [
    { entity: 'customer', rows: 5000, at: '2024-12-01T00:00:00.000Z' },
    { entity: 'order', rows: 32000, at: '2024-12-01T00:00:00.000Z' },
    { entity: 'event', rows: 420000, at: '2024-12-01T00:00:00.000Z' },
  ],
  customEntities: [CUSTOM_STORE],
  notes: new Map([
    [noteKey('order', 'status'), '已支付是 paid；发货后是 shipped，确认收货后是 completed，退款后是 refunded'],
    [noteKey('event', 'event_type'), '浏览是 view，加购是 add_to_cart，登录是 login'],
  ]),
};

export const CATALOG = buildCatalog(CATALOG_INPUT);
