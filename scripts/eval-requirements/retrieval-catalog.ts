// scripts/eval-requirements/retrieval-catalog.ts —— 检索黄金集的固定目录（#317，ADR-0047）：在需求评测的目录输入（CATALOG_INPUT）上
// 加几组近义的指标与标签（同为「营收」却按下单 / 支付时间、含不含退款、按订单还是明细金额；同为「客单价」「活跃次数」「下单次数」口径不同），
// 再加两个数据源与几张源表（有 source: / table: 条目，供跨角色可见性的条目用），并给 GMV、沉睡、购买频次、PV、地区、VIP 与近义组的销售额、客单价、活跃次数、积分挂上别名知识（指标名称是键名，中文只能靠别名命中）。
// 「营收」与触达渠道的「渠道」暂不挂：别名一路同分按标识排，会让不能选的近义项排第 1（#400 修好后挂回）
// 不改 PUBLISHED_METRICS：模型评测的上下文保持不变。纯函数构造，不连库
import { buildCatalog } from '../../app/.server/catalog';
import type { DslKind } from '../../app/.server/pipeline/dsl';
import { knowledgeKey } from '../../app/.server/knowledge/catalog';
import { CATALOG_INPUT, SPACE } from './golden';

/** 额外的已发布定义（键 → 种类与 YAML），都要能对着 CONTEXT 过校验（测试里断言） */
export const EXTRA_DEFINITIONS: Record<string, { kind: DslKind; yaml: string }> = {
  revenue_paid_30d: { kind: 'metric', yaml: `base: order
measure: { agg: sum, field: amount }
filter:
  - { field: status, op: in, value: [paid, shipped, completed] }
window: { field: paid_at, days: 30 }
description: 近 30 天营收（按支付时间；已支付、已发货、已完成的订单，不含退款）
` },
  gross_revenue_30d: { kind: 'metric', yaml: `base: order
measure: { agg: sum, field: amount }
filter:
  - { field: status, op: in, value: [paid, shipped, completed, refunded] }
window: { field: created_at, days: 30 }
description: 近 30 天营收（按下单时间；含已退款的订单）
` },
  item_revenue_30d: { kind: 'metric', yaml: `base: order_item
measure: { agg: sum, field: amount }
window: { field: order_item.order_id -> order.created_at, days: 30 }
description: 近 30 天营收（按订单明细金额合计，按下单时间）
` },
  aov_365d: { kind: 'metric', yaml: `base: order
measure: { agg: avg, field: amount }
filter:
  - { field: status, op: in, value: [paid, shipped, completed] }
window: { field: created_at, days: 365 }
description: 近 365 天客单价（每笔订单实付金额的平均）
` },
  item_aov_365d: { kind: 'metric', yaml: `base: order_item
measure: { agg: avg, field: amount }
window: { field: order_item.order_id -> order.created_at, days: 365 }
description: 近 365 天客单价（每个订单明细行金额的平均）
` },
  paid_order_count_365d: { kind: 'metric', yaml: `base: order
measure: { agg: count }
filter:
  - { field: status, op: in, value: [paid, shipped, completed] }
window: { field: paid_at, days: 365 }
description: 近 365 天下单次数（按支付时间，只算已支付、已发货、已完成的订单）
` },
  login_count_30d: { kind: 'metric', yaml: `base: event
measure: { agg: count }
filter:
  - { field: event_type, op: eq, value: login }
window: { field: occurred_at, days: 30 }
description: 近 30 天活跃次数（按登录事件计）
` },
  view_count_30d: { kind: 'metric', yaml: `base: event
measure: { agg: count }
filter:
  - { field: event_type, op: eq, value: view }
window: { field: occurred_at, days: 30 }
description: 近 30 天活跃次数（按浏览事件计）
` },
  high_spender: { kind: 'tag', yaml: `metric: revenue_30d
rules:
  - value: high
    when: { gte: 1000 }
default: normal
description: 高消费消费者：近 30 天消费金额 1000 元及以上
` },
};

/** 别名知识（ADR-0046）：目标 → 别名。PV 挂在浏览事件的事件类型上，不挂近 30 天浏览次数（它是 pv-7d-alias 不能选的近义项） */
export const ALIASES: Record<string, string[]> = {
  'metric:revenue_30d': ['销售额'],
  'metric:revenue_paid_30d': ['销售额'],
  'metric:gross_revenue_30d': ['GMV', '销售额'],
  'metric:item_revenue_30d': ['销售额'],
  'metric:aov_365d': ['客单价'],
  'metric:item_aov_365d': ['客单价'],
  'metric:login_count_30d': ['活跃次数'],
  'metric:view_count_30d': ['活跃次数'],
  'metric:days_since_last_order': ['沉睡'],
  'metric:order_count_365d': ['购买频次'],
  'metric:paid_order_count_365d': ['购买频次'],
  'field:event.event_type': ['PV'],
  'field:points_transaction.points_change': ['积分'],
  'field:customer.city': ['地区'],
  'field:membership.level': ['VIP'],
};

export const RETRIEVAL_CATALOG = buildCatalog({
  ...CATALOG_INPUT,
  knowledge: { byTarget: new Map(Object.entries(ALIASES).map(([id, aliases]) => [knowledgeKey(id), { aliases }])) },
  definitions: [
    ...CATALOG_INPUT.definitions!,
    ...Object.entries(EXTRA_DEFINITIONS).map(([key, d]) => ({ kind: d.kind, key, version: 1, yaml: d.yaml, spaceId: SPACE })),
  ],
  sources: [
    { id: 's-shop', name: '商城', kind: 'postgres' },
    { id: 's-pos', name: '门店POS', kind: 'mysql' },
  ],
  tables: [
    { sourceId: 's-shop', name: 'orders', view: false, columns: [{ name: 'order_no', type: 'VARCHAR' }, { name: 'pay_amount', type: 'DECIMAL(12,2)' }, { name: 'created', type: 'TIMESTAMP' }] },
    { sourceId: 's-shop', name: 'order_items', view: false, columns: [{ name: 'order_no', type: 'VARCHAR' }, { name: 'sku', type: 'VARCHAR' }, { name: 'qty', type: 'INTEGER' }] },
    { sourceId: 's-shop', name: 'members', view: false, columns: [{ name: 'member_no', type: 'VARCHAR' }, { name: 'level', type: 'VARCHAR' }] },
    { sourceId: 's-pos', name: 'pos_sales', view: false, columns: [{ name: 'ticket_no', type: 'VARCHAR' }, { name: 'store_code', type: 'VARCHAR' }, { name: 'total', type: 'DECIMAL(12,2)' }] },
  ],
});
