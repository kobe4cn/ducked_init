// scripts/eval-workbench-draft/golden.ts —— 工作台 SQL 起草黄金集（ADR-0043 的评测）：一份手写的固定目录（只有 silver 四张表，没有结果层、沙箱、分享与原始层，
// 与产品一样只有表、字段与类型，不含取值），每例写明需求与期望：引用的表（schema.table，小写）、SQL 里必须含的片段（不区分大小写），或期望模型回答做不到
import type { CatalogEntry, WorkbenchCatalog } from '../../app/.server/workbench';

export interface WorkbenchDraftExpect {
  /** 必须引用的表，schema.table 小写，如 silver.order */
  tables?: string[];
  /** SQL 里必须含的片段，不区分大小写 */
  contains?: string[];
  /** 期望模型回答做不到（需要的表不在目录里、要写数据） */
  unsupported?: true;
}

export interface WorkbenchDraftCase { name: string; request: string; expect: WorkbenchDraftExpect }

const silver = (name: string, rows: number, columns: [string, string][]): CatalogEntry => ({
  schema: 'silver', name, rows, columns: columns.map(([n, type]) => ({ name: n, type })),
  ref: `lake.silver."${name}"`, location: `silver/${name}`,
});

export const WORKBENCH_CATALOG: WorkbenchCatalog = {
  silver: [
    silver('order', 12_000, [['order_id', 'VARCHAR'], ['customer_id', 'VARCHAR'], ['status', 'VARCHAR'], ['amount', 'DECIMAL(18,2)'],
      ['created_at', 'TIMESTAMP WITH TIME ZONE'], ['paid_at', 'TIMESTAMP WITH TIME ZONE']]),
    silver('customer', 3_000, [['customer_id', 'VARCHAR'], ['name', 'VARCHAR'], ['city', 'VARCHAR'], ['created_at', 'TIMESTAMP WITH TIME ZONE']]),
    silver('order_item', 30_000, [['order_id', 'VARCHAR'], ['product_id', 'VARCHAR'], ['quantity', 'INTEGER'], ['price', 'DECIMAL(18,2)']]),
    silver('product', 500, [['product_id', 'VARCHAR'], ['name', 'VARCHAR'], ['category', 'VARCHAR']]),
  ],
  gold: [],
  mine: [],
  shared: [],
  raw: [],
};

export const WORKBENCH_DRAFT_GOLDEN: WorkbenchDraftCase[] = [
  { name: 'orders-by-status', request: '按订单状态统计订单数和总金额',
    expect: { tables: ['silver.order'], contains: ['GROUP BY', 'status', 'amount'] } },
  { name: 'orders-per-customer', request: '每个客户的订单数，带上客户名称，按订单数从多到少排',
    expect: { tables: ['silver.order', 'silver.customer'], contains: ['JOIN', 'GROUP BY', 'ORDER BY'] } },
  { name: 'top-products', request: '销量（件数）最高的 10 个商品及其品类',
    expect: { tables: ['silver.order_item', 'silver.product'], contains: ['quantity', 'LIMIT 10'] } },
  { name: 'monthly-paid', request: '每个月已支付订单的金额合计，按支付时间算',
    expect: { tables: ['silver.order'], contains: ['paid_at', 'GROUP BY'] } },
  { name: 'customers-by-city', request: '每个城市有多少客户',
    expect: { tables: ['silver.customer'], contains: ['city', 'GROUP BY'] } },
  // 做不到：库存表不在目录里
  { name: 'missing-inventory', request: '统计每个门店当前的库存数量', expect: { unsupported: true } },
  // 做不到：工作台只读
  { name: 'delete-cancelled', request: '把所有已取消的订单删掉', expect: { unsupported: true } },
];
