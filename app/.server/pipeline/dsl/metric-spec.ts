// app/.server/pipeline/dsl/metric-spec.ts —— 指标定义（YAML，ADR-0025）：基础实体上的一个度量，可带过滤、时间窗口与最多 3 个维度。
// 先按 JSON Schema（METRIC_SCHEMA）校验结构，再对照标准模型、已发布的自定义实体登记与已发布映射的扩展字段做语义校验：
// 基础实体要能关联到消费者（customer 本身，或有指向 customer 的 customer_id），字段要存在、类型合用、不能是敏感字段；
// 维度路径沿关系走到头：每一跳都是指向下一实体单列主键的关系，最多 3 跳，不能成环。每个问题都带 YAML 里的行列位置。
// 校验通过后编译成 SQL：基础实体经 silver._identities 关联到 consumer_id，维度路径编译成链式 LEFT JOIN，关联不到或为空记「未关联」。
// 纯函数：不碰平台库与数据湖，同样的定义与 asOf 编译出同样的 SQL
import { Ajv } from 'ajv';
import { LineCounter, parseDocument } from 'yaml';
import { CANONICAL_ENTITIES, entityOf, isCustomEntity, type EntityRelation, type FieldType } from '../../../lib/canonical-model';
import { IDENTITIES } from '../identity-engine';
import { describeSchemaError, locator, type Path, type RegisteredEntities } from '../mapping-spec';
import { ident, lit, silverTable, type MergeMappingParam } from '../merge-engine';

export const AGGS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const;
export const FILTER_OPS = ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null'] as const;
type Scalar = string | number | boolean;

export interface MetricSpec {
  /** 基础实体：customer，或有指向 customer 的 customer_id 的实体 */
  base: string;
  measure: { agg: (typeof AGGS)[number]; field?: string };
  /** 基础实体字段上的过滤，全部满足才计入 */
  filter?: { field: string; op: (typeof FILTER_OPS)[number]; value?: Scalar | Scalar[] }[];
  /** 时间窗口：field（时间或日期）落在 (asOf - days, asOf] 里才计入 */
  window?: { field: string; days: number };
  /** 维度：path 形如 order.store_id -> custom_store.region_id -> custom_region.name；as_of 只支持 current */
  dimensions?: { name: string; path: string; as_of?: string }[];
}

/** 校验与编译要用的租户上下文：已发布的自定义实体登记，与已发布映射的合并计划（扩展字段的类型与敏感性只来自它们） */
export interface DslContext { published: RegisteredEntities; plans: readonly MergeMappingParam[] }

/** 定义里的一个问题：行列从 1 起，path 是出问题的位置（如 dimensions.0.path） */
export interface DslIssue { line: number; col: number; path: string; message: string }

export type DslCheck<S> = { ok: true; spec: S } | { ok: false; issues: DslIssue[] };

/** 维度最多几个、维度路径最多几跳 */
export const MAX_DIMENSIONS = 3;
export const MAX_HOPS = 3;
/** 关联不到或为空的维度取值 */
export const UNLINKED = '未关联';

const scalar = { type: ['string', 'number', 'boolean'] };

/** 指标定义的 JSON Schema */
export const METRIC_SCHEMA = {
  type: 'object',
  required: ['base', 'measure'],
  additionalProperties: false,
  properties: {
    base: { type: 'string', minLength: 1 },
    measure: {
      type: 'object',
      required: ['agg'],
      additionalProperties: false,
      properties: { agg: { enum: AGGS }, field: { type: 'string', minLength: 1 } },
    },
    filter: {
      type: 'array',
      items: {
        type: 'object',
        required: ['field', 'op'],
        additionalProperties: false,
        properties: { field: { type: 'string', minLength: 1 }, op: { enum: FILTER_OPS }, value: { anyOf: [scalar, { type: 'array', items: scalar }] } },
      },
    },
    window: {
      type: 'object',
      required: ['field', 'days'],
      additionalProperties: false,
      properties: { field: { type: 'string', minLength: 1 }, days: { type: 'integer', minimum: 1 } },
    },
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'path'],
        additionalProperties: false,
        properties: { name: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' }, path: { type: 'string', minLength: 1 }, as_of: { type: 'string' } },
      },
    },
  },
} as const;

const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(METRIC_SCHEMA);

const BUILTIN_RELATIONS: EntityRelation[] = CANONICAL_ENTITIES.flatMap(e => e.fields.flatMap(f => (f.ref ? [{ from: { entity: e.name, field: f.name }, ref: f.ref }] : [])));
const NUMERIC: readonly FieldType[] = ['integer', 'decimal'];
const TEMPORAL: readonly FieldType[] = ['timestamp', 'date'];
/** 维度名不能与输出的其他列重名 */
const RESERVED_COLUMNS = ['consumer_id', 'value'];

interface FieldInfo { type: FieldType; sensitive: boolean; enum?: readonly string[] }

/** 实体在租户里的样子：字段（标准实体另加已发布映射的扩展字段）与单列主键；不能用时返回原因 */
function entityIn(name: string, ctx: DslContext): { fields: Map<string, FieldInfo>; key: string | undefined } | string {
  if (isCustomEntity(name)) {
    const e = ctx.published.get(name);
    if (!e) return `自定义实体 ${name} 没有发布或登记还未确认`;
    return { fields: new Map(e.fields.map(f => [f.name, { type: f.type, sensitive: f.sensitive }])), key: e.primaryKey.length === 1 ? e.primaryKey[0] : undefined };
  }
  const e = entityOf(name);
  if (!e) return `没有实体 ${name}`;
  const fields = new Map<string, FieldInfo>(e.fields.map(f => [f.name, { type: f.type, sensitive: !!f.pii, ...(f.enum && { enum: f.enum }) }]));
  for (const p of ctx.plans) {
    if (p.entity !== name) continue;
    for (const c of p.columns) {
      if (!c.name.startsWith('x_')) continue;
      const known = fields.get(c.name);
      fields.set(c.name, { type: c.type, sensitive: !!c.sensitive || !!known?.sensitive });
    }
  }
  return { fields, key: e.key.length === 1 ? e.key[0] : undefined };
}

const relationsOf = (ctx: DslContext) => [...BUILTIN_RELATIONS, ...[...ctx.published.values()].flatMap(e => e.relations ?? [])];

/**
 * 维度路径的一段：实体.字段。不是终点时 join 是这一段怎样关联到下一实体：下一实体的单列主键，
 * bySource 为真时还要按数据源关联（customer 本身，或主键指向 customer 的实体，只在同一数据源内唯一，ADR-0024）
 */
export interface Step { entity: string; field: string; join?: { key: string; bySource: boolean } }

/** 解析并检查维度路径：从基础实体出发，每一跳是指向下一实体单列主键的关系，最多 MAX_HOPS 跳，不能成环，终点不能是敏感字段 */
export function resolvePath(path: string, base: string, ctx: DslContext): { steps: Step[]; type: FieldType } | string {
  const parts = path.split('->').map(s => s.trim());
  const steps: Step[] = [];
  for (const part of parts) {
    const m = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(part);
    if (!m) return `维度路径的每一段要写成 实体.字段，${part || '（空）'} 不是`;
    steps.push({ entity: m[1]!, field: m[2]! });
  }
  if (steps[0]!.entity !== base) return `维度路径要从基础实体 ${base} 出发`;
  if (steps.length - 1 > MAX_HOPS) return `维度路径最多 ${MAX_HOPS} 跳，这里有 ${steps.length - 1} 跳`;
  const relations = relationsOf(ctx);
  const seen: string[] = [];
  let type: FieldType = 'string';
  for (const [i, step] of steps.entries()) {
    if (seen.includes(step.entity)) return `维度路径成环：${[...seen, step.entity].join(' → ')}`;
    seen.push(step.entity);
    const e = entityIn(step.entity, ctx);
    if (typeof e === 'string') return e;
    const f = e.fields.get(step.field);
    if (!f) return `${step.entity} 没有字段 ${step.field}`;
    const next = steps[i + 1];
    if (!next) {
      if (f.sensitive) return `维度不能用敏感字段 ${step.entity}.${step.field}`;
      type = f.type;
      break;
    }
    const target = entityIn(next.entity, ctx);
    if (typeof target === 'string') return target;
    const key = target.key;
    if (!key || !relations.some(r => r.from.entity === step.entity && r.from.field === step.field && r.ref.entity === next.entity && r.ref.field === key)) return `${step.entity}.${step.field} 没有指向 ${next.entity} 主键的关系`;
    const bySource = next.entity === 'customer'
      || relations.some(r => r.from.entity === next.entity && r.from.field === key && r.ref.entity === 'customer');
    step.join = { key, bySource };
  }
  return { steps, type };
}

/** 过滤取值按字段类型检查：返回问题说明，合规时返回 null */
function valueProblem(name: string, f: FieldInfo, v: Scalar): string | null {
  switch (f.type) {
    case 'integer': return typeof v === 'number' && Number.isInteger(v) ? null : `${name} 是整数，取值要写整数`;
    case 'decimal': return typeof v === 'number' ? null : `${name} 是小数，取值要写数字`;
    case 'boolean': return typeof v === 'boolean' ? null : `${name} 是布尔，取值要写 true 或 false`;
    case 'date': return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : `${name} 是日期，取值要写成 2024-01-31 这样`;
    case 'timestamp': return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? null : `${name} 是时间，取值要写成 2024-01-31T08:00:00Z 这样`;
    case 'string': return f.enum && !f.enum.includes(String(v)) ? `${name} 的取值应为以下之一：${f.enum.join('、')}` : null;
  }
}

const ISSUE_ORDER = (a: DslIssue, b: DslIssue) => a.line - b.line || a.col - b.col;

/**
 * 校验指标定义：YAML 语法、JSON Schema，再对照租户上下文做语义检查。
 * 通过时返回定义，否则返回全部问题（按位置排序）
 */
export function checkMetric(text: string, ctx: DslContext): DslCheck<MetricSpec> {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  if (doc.errors.length) {
    return {
      ok: false,
      issues: doc.errors.map(e => {
        const { line, col } = lines.linePos(e.pos[0]);
        return { line, col, path: '', message: `YAML 语法错误：${e.message.split('\n')[0]}` };
      }),
    };
  }
  const at = locator(doc, lines);
  const issues: DslIssue[] = [];
  const issue = (path: Path, message: string) => {
    const { line, col } = at(path);
    issues.push({ line, col, path: path.join('.'), message });
  };

  const value = doc.toJS() as unknown;
  if (!validateSchema(value)) {
    for (const e of validateSchema.errors ?? []) {
      const d = describeSchemaError(e);
      if (d) issue(d.path, d.message);
    }
    return { ok: false, issues: dedupe(issues).sort(ISSUE_ORDER) };
  }
  const spec = value as MetricSpec;

  const base = entityIn(spec.base, ctx);
  if (typeof base === 'string') {
    issue(['base'], base);
    return { ok: false, issues };
  }
  if (spec.base !== 'customer') {
    const linked = base.fields.has('customer_id')
      && relationsOf(ctx).some(r => r.from.entity === spec.base && r.from.field === 'customer_id' && r.ref.entity === 'customer' && r.ref.field === 'customer_id');
    if (!linked) issue(['base'], `基础实体 ${spec.base} 要有指向 customer.customer_id 的 customer_id，才能关联到消费者`);
  }

  /** 基础实体上的字段：不存在或敏感时报问题并返回 undefined */
  const baseField = (path: Path, name: string, use: string) => {
    const f = base.fields.get(name);
    if (!f) issue(path, `${spec.base} 没有字段 ${name}`);
    else if (f.sensitive) issue(path, `${use}不能用敏感字段 ${name}`);
    else return f;
    return undefined;
  };

  const { agg, field } = spec.measure;
  if (field === undefined) {
    if (agg !== 'count') issue(['measure', 'agg'], `agg 为 ${agg} 时要写 field`);
  } else {
    const f = baseField(['measure', 'field'], field, '度量');
    if (f && (agg === 'sum' || agg === 'avg') && !NUMERIC.includes(f.type)) issue(['measure', 'field'], `${agg} 只能用整数或小数字段，${field} 不是`);
  }

  for (const [i, cond] of (spec.filter ?? []).entries()) {
    const f = baseField(['filter', i, 'field'], cond.field, '过滤');
    const valueAt = ['filter', i, 'value'];
    if (cond.op === 'is_null' || cond.op === 'not_null') {
      if (cond.value !== undefined) issue(valueAt, `${cond.op} 不用写 value`);
      continue;
    }
    if (cond.value === undefined) {
      issue(['filter', i], `op 为 ${cond.op} 时要写 value`);
      continue;
    }
    const list = cond.op === 'in' || cond.op === 'not_in';
    if (list !== Array.isArray(cond.value)) {
      issue(valueAt, list ? `${cond.op} 的取值要写列表` : `${cond.op} 的取值不能是列表`);
      continue;
    }
    if (!f) continue;
    const problem = [cond.value].flat().map(v => valueProblem(cond.field, f, v)).find(p => p);
    if (problem) issue(valueAt, problem);
  }

  if (spec.window) {
    const f = baseField(['window', 'field'], spec.window.field, '时间窗口');
    if (f && !TEMPORAL.includes(f.type)) issue(['window', 'field'], `时间窗口要用时间或日期字段，${spec.window.field} 不是`);
  }

  const dimensions = spec.dimensions ?? [];
  if (dimensions.length > MAX_DIMENSIONS) issue(['dimensions'], `维度最多 ${MAX_DIMENSIONS} 个，这里有 ${dimensions.length} 个`);
  const names = new Set<string>();
  for (const [i, d] of dimensions.entries()) {
    if (RESERVED_COLUMNS.includes(d.name)) issue(['dimensions', i, 'name'], `维度不能叫 ${d.name}`);
    else if (names.has(d.name)) issue(['dimensions', i, 'name'], `维度名 ${d.name} 重复`);
    names.add(d.name);
    if (d.as_of !== undefined && d.as_of !== 'current') issue(['dimensions', i, 'as_of'], '暂不支持按时间点关联，as_of 只能写 current');
    const resolved = resolvePath(d.path, spec.base, ctx);
    if (typeof resolved === 'string') issue(['dimensions', i, 'path'], resolved);
  }

  return issues.length ? { ok: false, issues: issues.sort(ISSUE_ORDER) } : { ok: true, spec };
}

const dedupe = (issues: DslIssue[]) => issues.filter((x, i) => issues.findIndex(y => y.path === x.path && y.message === x.message) === i);

/** 定义用到的实体（基础实体与维度路径经过的实体），排好序 */
export function metricEntities(spec: MetricSpec): string[] {
  const all = new Set([spec.base]);
  for (const d of spec.dimensions ?? []) for (const part of d.path.split('->')) all.add(part.trim().split('.')[0]!);
  return [...all].sort();
}

/** 过滤取值写成 SQL 字面量 */
function sqlValue(f: FieldInfo, v: Scalar) {
  switch (f.type) {
    case 'integer': case 'decimal': return String(Number(v));
    case 'boolean': return v ? 'TRUE' : 'FALSE';
    case 'date': return `DATE ${lit(String(v))}`;
    case 'timestamp': return `TIMESTAMPTZ ${lit(String(v))}`;
    case 'string': return lit(String(v));
  }
}

const COMPARE = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

/**
 * 编译校验通过的指标定义：每个消费者（与维度取值）一行，列为 consumer_id、各维度、value。
 * asOf 是统计日（YYYY-MM-DD），时间窗口取 (asOf - days, asOf]，时间按 UTC 取日期
 */
export function compileMetric(spec: MetricSpec, ctx: DslContext, asOf: string): string {
  const base = entityIn(spec.base, ctx);
  if (typeof base === 'string') throw new Error(base);
  const col = (name: string) => `b.${ident(name)}`;

  const joins: string[] = [];
  const dims: string[] = [];
  for (const [i, d] of (spec.dimensions ?? []).entries()) {
    const resolved = resolvePath(d.path, spec.base, ctx);
    if (typeof resolved === 'string') throw new Error(resolved);
    let prev = 'b';
    for (const [j, step] of resolved.steps.slice(0, -1).entries()) {
      const next = resolved.steps[j + 1]!;
      const { key, bySource } = step.join!;
      const alias = `d${i}_${j + 1}`;
      const source = bySource ? ` AND ${alias}._source = ${prev}._source` : '';
      joins.push(`LEFT JOIN ${silverTable(next.entity)} ${alias} ON ${alias}.${ident(key)} = ${prev}.${ident(step.field)}${source}`);
      prev = alias;
    }
    const end = resolved.steps.at(-1)!;
    dims.push(`COALESCE(NULLIF(CAST(${prev}.${ident(end.field)} AS VARCHAR), ''), ${lit(UNLINKED)}) AS ${ident(d.name)}`);
  }

  const { agg, field } = spec.measure;
  const measure = field === undefined ? 'COUNT(*)'
    : agg === 'count_distinct' ? `COUNT(DISTINCT ${col(field)})`
    : `${agg.toUpperCase()}(${col(field)})`;

  const where: string[] = [];
  for (const cond of spec.filter ?? []) {
    const f = base.fields.get(cond.field)!;
    const c = col(cond.field);
    switch (cond.op) {
      case 'is_null': where.push(`${c} IS NULL`); break;
      case 'not_null': where.push(`${c} IS NOT NULL`); break;
      case 'in': case 'not_in': {
        const values = [cond.value!].flat().map(v => sqlValue(f, v)).join(', ');
        where.push(`${c} ${cond.op === 'in' ? 'IN' : 'NOT IN'} (${values})`);
        break;
      }
      default: where.push(`${c} ${COMPARE[cond.op]} ${sqlValue(f, cond.value as Scalar)}`);
    }
  }
  if (spec.window) {
    const f = base.fields.get(spec.window.field)!;
    const day = f.type === 'timestamp' ? `(${col(spec.window.field)} AT TIME ZONE 'UTC')::DATE` : col(spec.window.field);
    where.push(`${day} > DATE ${lit(asOf)} - ${spec.window.days}`, `${day} <= DATE ${lit(asOf)}`);
  }

  return [
    `SELECT i.consumer_id, ${[...dims, `${measure} AS value`].join(', ')}`,
    `FROM ${silverTable(spec.base)} b`,
    `INNER JOIN ${IDENTITIES} i ON i._source = b._source AND i.customer_id = b.customer_id`,
    ...joins,
    ...(where.length ? [`WHERE ${where.join('\n  AND ')}`] : []),
    'GROUP BY ALL',
    'ORDER BY ALL',
  ].join('\n');
}
