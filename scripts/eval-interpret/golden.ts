// scripts/eval-interpret/golden.ts —— 工作台结果解读评测的黄金集（ADR-0043）：手写的合成 WorkbenchResult，分组汇总与明细、样本开关开 / 关都有。
// 这是四项评测里唯一会把结果行发给模型的，所以只用合成数据：姓名带「合成」、手机号是 139000000xx，不用种子库里的真实 ID、手机号、openid（审计 §2.5）。
// 标签列叫 city / category 且放第一列：列名含 name 会被当敏感列剔除，叫 *_id 会被判成明细（workbench-ai 的 DETAIL_NAME）
import type { WorkbenchResult } from '../../app/.server/pipeline/workbench-engine';

export interface InterpretCase {
  name: string;
  sql: string;
  result: WorkbenchResult;
  /** 租户是否打开「发送脱敏样本」 */
  samples: boolean;
  /**
   * 除「引用的数字都有出处」（每例都算）外的期望：
   * maxAt 解读要点名的最大值所在组；noValues 解读里不能出现的串（合成姓名、号码等敏感取值）；
   * noNumbers 结果里没有可下结论的数字（facts 为空），期望解读不编造数字
   */
  expect: { maxAt?: string; noValues?: string[]; noNumbers?: true };
}

/** 15 城扫码次数（照审计现场样本的形状：苏州 3606 最大，其余 13 城 2032–2232，无锡 122） */
const CITY_SCANS: WorkbenchResult = {
  columns: [{ name: 'city', type: 'VARCHAR' }, { name: 'scans', type: 'BIGINT' }],
  rows: [
    ['苏州', 3606], ['杭州', 2232], ['南京', 2210], ['宁波', 2195], ['合肥', 2180], ['常州', 2166], ['南通', 2150],
    ['嘉兴', 2131], ['绍兴', 2118], ['扬州', 2102], ['镇江', 2090], ['温州', 2071], ['台州', 2054], ['湖州', 2032], ['无锡', 122],
  ],
  truncated: false,
};
const CITY_SCANS_SQL = 'SELECT city, count(*) AS scans FROM lake.silver.scan GROUP BY city ORDER BY scans DESC';

/** 明细：每行一位客户，name / mobile 是敏感列 */
const CUSTOMER_ORDERS: WorkbenchResult = {
  columns: [
    { name: 'customer_id', type: 'VARCHAR' }, { name: 'name', type: 'VARCHAR' }, { name: 'mobile', type: 'VARCHAR' },
    { name: 'city', type: 'VARCHAR' }, { name: 'amount', type: 'DECIMAL(18,2)' },
  ],
  rows: [
    ['c-syn-001', '张合成', '13900000001', '苏州', 1280.5],
    ['c-syn-002', '李合成', '13900000002', '杭州', 860],
    ['c-syn-003', '王合成', '13900000003', '南京', 432.25],
    ['c-syn-004', '赵合成', '13900000004', '苏州', 2150],
    ['c-syn-005', '钱合成', '13900000005', '无锡', 95.75],
  ],
  truncated: false,
};

export const INTERPRET_GOLDEN: InterpretCase[] = [
  { name: 'city-scans', sql: CITY_SCANS_SQL, result: CITY_SCANS, samples: true, expect: { maxAt: '苏州' } },
  // 样本关时 facts 不带 maxAt / minAt，也不发行，解读点不出最大组
  { name: 'city-scans-no-samples', sql: CITY_SCANS_SQL, result: CITY_SCANS, samples: false, expect: {} },
  {
    name: 'customer-detail',
    sql: 'SELECT customer_id, name, mobile, city, amount FROM lake.silver.customer_order ORDER BY amount DESC',
    result: CUSTOMER_ORDERS,
    samples: true,
    expect: { noValues: ['张合成', '李合成', '王合成', '赵合成', '钱合成', '13900000001', '13900000002', '13900000003', '13900000004', '13900000005', 'c-syn-00'] },
  },
  {
    name: 'customer-detail-no-samples',
    sql: 'SELECT customer_id, name, mobile, city, amount FROM lake.silver.customer_order ORDER BY amount DESC',
    result: CUSTOMER_ORDERS,
    samples: false,
    expect: { noValues: ['张合成', '李合成', '王合成', '赵合成', '钱合成', '13900000001', 'c-syn-00'] },
  },
  {
    name: 'category-revenue',
    sql: 'SELECT category, sum(amount) AS revenue FROM lake.silver.order_item GROUP BY category ORDER BY revenue DESC',
    result: {
      columns: [{ name: 'category', type: 'VARCHAR' }, { name: 'revenue', type: 'DOUBLE' }],
      rows: [['饮料', 48200], ['零食', 31500], ['日化', 12800], ['生鲜', 7500]],
      truncated: false,
    },
    samples: true,
    expect: { maxAt: '饮料' },
  },
  {
    name: 'single-total',
    sql: 'SELECT sum(amount) AS total FROM lake.silver."order"',
    result: { columns: [{ name: 'total', type: 'DOUBLE' }], rows: [[186420.5]], truncated: false },
    samples: true,
    expect: {},
  },
  {
    name: 'no-numbers',
    sql: 'SELECT city, status FROM lake.silver.store ORDER BY city',
    result: {
      columns: [{ name: 'city', type: 'VARCHAR' }, { name: 'status', type: 'VARCHAR' }],
      rows: [['苏州', '营业'], ['杭州', '装修'], ['南京', '营业'], ['无锡', '停业']],
      truncated: false,
    },
    samples: true,
    expect: { noNumbers: true },
  },
];
