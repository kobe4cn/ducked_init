// scripts/eval-requirements/golden.ts —— 需求黄金集（ADR-0041 的评测，与 ADR-0035 的映射黄金集并列）：每个样例是一条中文需求与期望的指标或标签定义
// （golden/<id>.yaml 的 { kind, request, expected }）。目录与校验上下文是固定的：只有标准实体（敏感字段本就不进目录），
// 加上几个已发布的指标（供标签引用）、业务说明与实体行数；纯函数构造，不连库
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { noteKey } from '../../app/lib/business-note-key';
import { buildCatalog, type CatalogInput } from '../../app/.server/catalog';
import type { DslKind } from '../../app/.server/pipeline/dsl';
import { checkMetric, type DslCheck, type DslContext, type MetricSpec } from '../../app/.server/pipeline/dsl/metric-spec';
import type { TagSpec } from '../../app/.server/pipeline/dsl/tag-spec';

export interface GoldenCase {
  id: string;
  kind: DslKind;
  request: string;
  expected: MetricSpec | TagSpec;
}

/** 已发布的指标：标签样例只引用它们 */
const PUBLISHED_METRICS: Record<string, string> = {
  revenue_30d: `base: order
measure: { agg: sum, field: amount }
filter:
  - { field: status, op: in, value: [paid, shipped, completed] }
window: { field: created_at, days: 30 }
description: 近 30 天消费金额（已支付、已发货、已完成的订单）
`,
  order_count_365d: `base: order
measure: { agg: count }
window: { field: created_at, days: 365 }
description: 近 365 天下单次数
`,
  days_since_last_order: `base: order
measure: { agg: days_since, field: created_at }
description: 距最近一次下单的天数
`,
};

const CATALOG_INPUT: CatalogInput = {
  definitions: Object.entries(PUBLISHED_METRICS).map(([key, yaml]) => ({ kind: 'metric' as const, key, version: 1, yaml })),
  entityStats: [
    { entity: 'customer', rows: 5000, at: '2024-12-01T00:00:00.000Z' },
    { entity: 'order', rows: 32000, at: '2024-12-01T00:00:00.000Z' },
    { entity: 'order_item', rows: 81000, at: '2024-12-01T00:00:00.000Z' },
    { entity: 'event', rows: 420000, at: '2024-12-01T00:00:00.000Z' },
  ],
  notes: new Map([
    [noteKey('order', 'status'), '已支付是 paid；发货后是 shipped，确认收货后是 completed，退款后是 refunded'],
    [noteKey('order', 'channel'), '取值有 store（门店）、miniapp（小程序）、tmall（天猫）'],
    [noteKey('event', 'event_type'), '浏览是 view，加购是 add_to_cart，登录是 login'],
  ]),
};

export const CATALOG = buildCatalog(CATALOG_INPUT);

const empty: DslContext = { published: new Map(), plans: [], metrics: new Map() };
/** 校验上下文：没有自定义实体与映射，指标是上面已发布的那几个 */
export const CONTEXT: DslContext = {
  ...empty,
  metrics: new Map(Object.entries(PUBLISHED_METRICS).map(([key, yaml]): [string, DslCheck<MetricSpec>] => [key, checkMetric(yaml, empty)])),
};

const dir = join(import.meta.dirname, 'golden');

export const GOLDEN: GoldenCase[] = readdirSync(dir).filter(f => f.endsWith('.yaml')).sort().map(f => {
  const { kind, request, expected } = parse(readFileSync(join(dir, f), 'utf8')) as Omit<GoldenCase, 'id'>;
  return { id: f.replace(/\.yaml$/, ''), kind, request, expected };
});
