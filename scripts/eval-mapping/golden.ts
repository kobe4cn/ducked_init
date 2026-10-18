// scripts/eval-mapping/golden.ts —— 映射黄金集（ADR-0035 的评测）：每个样例是手写的表统计、目标实体与期望映射 YAML（golden/<name>.yaml，改写自种子映射）。
// 表统计照采集的写法：文本列才有 top，敏感列（手机号、邮箱）不给 top；列名与期望 YAML 引用的源列一致
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ColumnProfile, TableProfile } from '../../app/.server/pipeline/source-engine';

/** 样例要考的情形：字段改名、金额以分计、状态是中文或数字枚举、有重复行要去重 */
export type GoldenKind = 'rename' | 'cents' | 'status_enum' | 'dedupe';

export interface GoldenCase {
  name: string;
  kinds: GoldenKind[];
  entity: string;
  profile: TableProfile;
  expectedYaml: string;
}

const column = (name: string, type: string, extra: Partial<ColumnProfile> = {}): ColumnProfile =>
  ({ name, type, nullRate: 0, distinct: 1000, min: null, max: null, ...extra });
const table = (name: string, columns: ColumnProfile[], primaryKey: string[] = [], keyCandidates: string[] = []): TableProfile =>
  ({ name, rows: 1000, sampleRows: 1000, columns, watermarkCandidates: [], primaryKey, keyCandidates });
const top = (...values: string[]) => values.map((value, i) => ({ value, rows: 200 - i * 20 }));
const yaml = (name: string) => readFileSync(join(import.meta.dirname, 'golden', `${name}.yaml`), 'utf8');

const golden = (name: string, kinds: GoldenKind[], entity: string, profile: TableProfile): GoldenCase =>
  ({ name, kinds, entity, profile, expectedYaml: yaml(name) });

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
];
