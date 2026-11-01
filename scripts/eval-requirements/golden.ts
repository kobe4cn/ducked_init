// scripts/eval-requirements/golden.ts —— 需求黄金集（ADR-0041 的评测，与 ADR-0035 的映射黄金集并列）：每个样例是一条中文需求与期望的指标或标签定义
// （golden/<id>.yaml 的 { kind, request, expected }）。目录与校验上下文是固定的：只有标准实体（敏感字段本就不进目录），
// 加上几个已发布的指标（供标签引用）、业务说明与实体行数；纯函数构造，不连库。
// 每条另带检索标注（#317，ADR-0047）：失败类型、角色、覆盖的难点、正确候选、不能选的近义项、是否歧义与期望的追问，
// 供 test/retrieval-golden.test.ts 对着 retrieval-catalog.ts 的目录跑确定性检索；GOLDEN 只含有 expected 的条目，给模型评测
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { noteKey } from '../../app/lib/business-note-key';
import { cmp } from '../../app/lib/compare';
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

/** 失败类型：a 召回失败、b 选错口径、c 知识缺失（如靠别名才找得到）、d 超出能力 */
export const FAILURE_TYPES = ['a', 'b', 'c', 'd'] as const;
/** 覆盖的难点：same-name 同名不同主题、alias 多义别名、role 跨角色可见性 */
export const COVERS = ['same-name', 'alias', 'role'] as const;
/** 在哪种成员的目录上检索：viewer 没有 sources:read（见 catalogFor） */
export const ROLES = ['analyst', 'viewer'] as const;

/** 一条检索标注：query 缺省用 request；candidates 是正确候选集合，forbidden 是不能选的近义项（都是目录条目 id） */
export interface GoldenRetrieval { query: string; candidates: string[]; forbidden: string[]; ambiguous: boolean }

/** 黄金集的一条：没有合法 DSL 可写的（多为 c、d 类，或要先追问的）没有 kind / expected；clarify 是期望的追问，不需要追问为 null */
export interface GoldenEntry {
  id: string;
  kind?: DslKind;
  request: string;
  expected?: MetricSpec | TagSpec;
  failure_type: (typeof FAILURE_TYPES)[number];
  role: (typeof ROLES)[number];
  covers: (typeof COVERS)[number][];
  retrieval: GoldenRetrieval;
  clarify: string | null;
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

export const CATALOG_INPUT: CatalogInput = {
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

type GoldenFile = Omit<GoldenEntry, 'id' | 'role' | 'covers' | 'retrieval'> & {
  role?: GoldenEntry['role']; covers?: GoldenEntry['covers']; retrieval: Omit<GoldenRetrieval, 'query'> & { query?: string };
};

/** 全部条目（按文件名排），带检索标注 */
export const GOLDEN_ALL: GoldenEntry[] = readdirSync(dir).filter(f => f.endsWith('.yaml')).sort(cmp).map(f => {
  const file = parse(readFileSync(join(dir, f), 'utf8')) as GoldenFile;
  return {
    id: f.replace(/\.yaml$/, ''), request: file.request,
    ...(file.kind && { kind: file.kind }), ...(file.expected && { expected: file.expected }),
    failure_type: file.failure_type, role: file.role ?? 'analyst', covers: file.covers ?? [],
    retrieval: { ...file.retrieval, query: file.retrieval.query ?? file.request },
    clarify: file.clarify,
  };
});

/** 模型评测用的样例：有 kind 与 expected 的条目 */
export const GOLDEN: GoldenCase[] = GOLDEN_ALL.flatMap(({ id, kind, request, expected }) => (kind && expected ? [{ id, kind, request, expected }] : []));
