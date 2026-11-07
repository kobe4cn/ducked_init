// scripts/eval-requirements/plan-modes.ts —— 黄金集每条的期望计划模式（#423，ADR-0050）：eval:requirements 的「计划模式」列
// 拿模型选的模式（runPlanCase 用 validatePlan 解析出的 plan.mode）与这里的标注比对。集中写在这张表里，不给 40 份 YAML 逐个加字段。
// 标注规则（ADR-0050 的五种模式，按顺序取第一个命中的）：
// 1. failure_type 为 d（超出能力）→ unsupported（unsupported 不只来自 d 类，见规则 4 的查看者问血缘）；
// 2. 其余 clarify 不为 null（需求有歧义，要先追问）→ clarify；
// 3. 有 kind（黄金集里有期望的指标或标签定义，要新起草）→ draft_definition；
// 4. 剩下的逐条标：RETRIEVAL_CATALOG 里已有发布的指标或标签能直接回答的 → reuse_result（查看者只看 viewerView 里的），
//    否则 → draft_query（查源表、看血缘、按消费者属性分组数人数这类，起草工作台 SQL）；
//    查看者问血缘 / 源表属于权限做不到（目录里看不到），标 unsupported（看血缘只对能看源表的角色走 draft_query）。
// 纯数据，不读库、不走模型
import type { PlanMode } from '../../app/.server/catalog/plan';
import type { GoldenEntry } from './golden';

export const PLAN_MODE_BY_ID: Record<string, PlanMode> = {
  // 1. d 类：平台做不到（预测、推荐、同比、逐小时、越权看源表）
  'churn-forecast': 'unsupported',
  'hourly-orders': 'unsupported',
  'next-product-recommend': 'unsupported',
  'revenue-yoy': 'unsupported',
  'viewer-source-tables': 'unsupported',
  // 2. 标注了追问的：口径不明，先 clarify
  'active-ambiguous': 'clarify',
  'aov-ambiguous': 'clarify',
  'channel-ambiguous': 'clarify',
  'dormant-alias': 'clarify',
  'points-ambiguous': 'clarify',
  'purchase-frequency-alias': 'clarify',
  'revenue-ambiguous': 'clarify',
  'sales-amount-alias': 'clarify',
  // 3. 有期望定义的：目录里没有能直接回答的，要 draft_definition
  'add-to-cart-7d': 'draft_definition',
  'aov-per-order': 'draft_definition',
  'avg-completed-order-amount': 'draft_definition',
  'churn-risk': 'draft_definition',
  'days-since-last-order': 'draft_definition',
  'distinct-products-180d': 'draft_definition',
  'frequent-buyer': 'draft_definition',
  'item-revenue-30d': 'draft_definition',
  'login-count-30d': 'draft_definition',
  'order-count-90d': 'draft_definition',
  'orders-by-channel-30d': 'draft_definition',
  'paid-order-count-365d': 'draft_definition',
  'paid-revenue-by-city': 'draft_definition',
  'pv-7d-alias': 'draft_definition',
  'refund-rate': 'draft_definition',
  'revenue-by-paid-time': 'draft_definition',
  'revenue-with-refund': 'draft_definition',
  'spend-tier': 'draft_definition',
  'touch-by-channel-30d': 'draft_definition',
  // 4. 其余：已有发布指标直接回答的 reuse_result，要查源表 / 血缘 / 属性分组的 draft_query；
  //    其中查看者问血缘的是手工标的 unsupported（目录不带血缘、没有源表，权限做不到）
  'gmv-alias': 'reuse_result', // gross_revenue_30d 挂着 GMV 别名，口径就是按下单时间含退款的营收
  'viewer-paid-revenue': 'reuse_result', // revenue_paid_30d，查看者目录里也有
  'analyst-pos-sales': 'draft_query', // 看 pos_sales 源表，不是指标
  'analyst-source-tables': 'draft_query', // 列商城数据源的源表
  'region-alias': 'draft_query', // 各地区消费者人数：没有现成指标，按属性分组数人数走工作台 SQL
  'vip-level-alias': 'draft_query', // gold 等级消费者人数：同上
  'viewer-amount-lineage': 'unsupported', // 订单实付金额的血缘（来自哪个源表）：问的是血缘，写 SQL 回答不了；查看者目录不带血缘、没有源表，权限做不到（同 viewer-source-tables）
  'viewer-store-orders': 'draft_query', // 门店成交归属，看 order.store_id
};

/** 一条的期望模式；表里漏了这条 id 会直接抛错（test/eval-requirements-metrics.test.ts 保证覆盖全部条目，黄金集加了 YAML 忘了标注在这里暴露） */
export const expectedMode = (g: GoldenEntry): PlanMode => {
  const mode = PLAN_MODE_BY_ID[g.id];
  if (!mode) throw new Error(`黄金集条目 ${g.id} 没有标注期望计划模式，补进 scripts/eval-requirements/plan-modes.ts`);
  return mode;
};
