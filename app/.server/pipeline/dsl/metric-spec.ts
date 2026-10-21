// app/.server/pipeline/dsl/metric-spec.ts —— 指标定义（YAML，ADR-0025）：基础实体上的一个度量，可带过滤、时间窗口与最多 3 个维度。
// 先按 JSON Schema（METRIC_SCHEMA）校验结构，再对照标准模型、已发布的自定义实体登记与已发布映射的扩展字段做语义校验：
// 基础实体要能关联到消费者（customer 本身，或有指向 customer 的 customer_id），字段要存在、类型合用、不能是敏感字段；
// 度量除普通聚合外还有 ratio（分子 / 分母各带过滤）、latest / earliest（按 by 取最新 / 最早一行）与 days_since（asOf 减最近一天）；
// 维度路径沿关系走到头：每一跳都是指向下一实体单列主键的关系，最多 3 跳，不能成环；filter、measure、window 的字段也能写维度路径（ADR-0038）。每个问题都带 YAML 里的行列位置。
// 校验通过后编译成 SQL：基础实体经 silver._identities 关联到 consumer_id（event 的匿名事件缺省再经 silver._device_owner 按设备归属，ADR-0019），
// 维度路径编译成链式 LEFT JOIN，关联不到或为空记「未关联」；字段路径复用维度连过的前缀，取终点原值（关联不到为 NULL）；consumer.<字段> 的维度取统一消费者的属性（silver._consumer，ADR-0027），一个人只有一个取值。
// 这里也放各种定义共用的部分：租户上下文 DslContext、问题 DslIssue 与校验结果 DslCheck、YAML 与 JSON Schema 的第一步 parseDsl、说明 description 的 Schema 片段 DESCRIPTION_SCHEMA。
// 纯函数：不碰平台库与数据湖，同样的定义与 asOf 编译出同样的 SQL
import { Ajv, type ValidateFunction } from 'ajv';
import { LineCounter, parseDocument } from 'yaml';
import { CANONICAL_ENTITIES, entityOf, isCustomEntity, type EntityRelation, type FieldType } from '../../../lib/canonical-model';
import { CONSUMER, DEVICE_OWNER, IDENTITIES } from '../identity-engine';
import { describeSchemaError, locator, type Path, type RegisteredEntities } from '../mapping-spec';
import { ident, lit, silverTable, type MergeMappingParam } from '../merge-engine';
import { customerSourceColumn } from '../../../lib/customer-source';

export const AGGS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'ratio', 'latest', 'earliest', 'days_since'] as const;
/** ratio 的分子、分母能用的聚合 */
export const RATIO_AGGS = ['count', 'count_distinct', 'sum'] as const;
export const FILTER_OPS = ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'not_null'] as const;
type Scalar = string | number | boolean;
type Conditions = { field: string; op: (typeof FILTER_OPS)[number]; value?: Scalar | Scalar[] }[];
/** ratio 的分子或分母：自己的 filter 与顶层 filter、window 叠加 */
export interface RatioPart { agg: (typeof RATIO_AGGS)[number]; field?: string; filter?: Conditions }

export interface MetricSpec {
  /** 基础实体：customer，或有指向 customer 的 customer_id 的实体 */
  base: string;
  /**
   * agg 为 ratio 时写 numerator / denominator（不写 field）；latest / earliest 按 by（时间或日期）取最新 / 最早一行的 field（数字）；
   * days_since 是 asOf 减 field（时间或日期）最近一天的天数
   */
  measure: { agg: (typeof AGGS)[number]; field?: string; by?: string; numerator?: RatioPart; denominator?: RatioPart };
  /** 基础实体字段上的过滤，全部满足才计入 */
  filter?: Conditions;
  /** 时间窗口：field（时间或日期）落在 (asOf - days, asOf] 里才计入 */
  window?: { field: string; days: number };
  /**
   * 维度：path 形如 order.store_id -> custom_store.region_id -> custom_region.name，或 consumer.city（统一消费者的属性）；
   * as_of 只支持 current
   */
  dimensions?: { name: string; path: string; as_of?: string }[];
  /** 只有 base 为 event 时能写：customer_id 为空的匿名事件经 device_id 按设备归属计入，缺省为 true */
  device_attribution?: boolean;
  /** 说明（可选，最多 500 字），目录接口返回 */
  description?: string;
}

/**
 * 校验与编译要用的租户上下文：已发布的自定义实体登记，与已发布映射的合并计划（扩展字段的类型与敏感性只来自它们）；
 * metrics 是本租户各指标最新的已发布版本（键 → 对照登记与映射校验的结果），标签只引用它们
 */
export interface DslContext { published: RegisteredEntities; plans: readonly MergeMappingParam[]; metrics: ReadonlyMap<string, DslCheck<MetricSpec>> }

/** 定义里的一个问题：行列从 1 起，path 是出问题的位置（如 dimensions.0.path） */
export interface DslIssue { line: number; col: number; path: string; message: string }

export type DslCheck<S> = { ok: true; spec: S } | { ok: false; issues: DslIssue[] };

/** 维度最多几个、维度路径最多几跳 */
export const MAX_DIMENSIONS = 3;
export const MAX_HOPS = 3;
/** 关联不到或为空的维度取值 */
export const UNLINKED = '未关联';

const scalar = { type: ['string', 'number', 'boolean'] };
const nonEmpty = { type: 'string', minLength: 1 } as const;
const filterSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['field', 'op'],
    additionalProperties: false,
    properties: { field: nonEmpty, op: { enum: FILTER_OPS }, value: { anyOf: [scalar, { type: 'array', items: scalar }] } },
  },
} as const;
const ratioPart = {
  type: 'object',
  required: ['agg'],
  additionalProperties: false,
  properties: { agg: { enum: RATIO_AGGS }, field: nonEmpty, filter: filterSchema },
} as const;
/** agg 为 values 之一时 */
const aggIs = (...values: string[]) => ({ required: ['agg'], properties: { agg: { enum: values } } });

/** 定义的说明（指标、标签共用）：可选，最多 500 字 */
export const DESCRIPTION_SCHEMA = { type: 'string', maxLength: 500 } as const;

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
      properties: { agg: { enum: AGGS }, field: nonEmpty, by: nonEmpty, numerator: ratioPart, denominator: ratioPart },
      allOf: [
        { if: aggIs('ratio'), then: { required: ['numerator', 'denominator'], properties: { field: false, by: false } }, else: { properties: { numerator: false, denominator: false } } },
        { if: aggIs('latest', 'earliest'), then: { required: ['field', 'by'] }, else: { properties: { by: false } } },
        { if: aggIs('days_since'), then: { required: ['field'] } },
      ],
    },
    filter: filterSchema,
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
    device_attribution: { type: 'boolean' },
    description: DESCRIPTION_SCHEMA,
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

/**
 * 实体在租户里能给定义用的字段（名、类型、可选取值），剔除敏感字段（与校验同源，含 x_ 扩展字段与已发布自定义实体）；
 * 实体不存在或不能用时返回 undefined。给模型的上下文用它（ADR-0005、ADR-0035）
 */
export function fieldsFor(entity: string, ctx: DslContext): { name: string; type: FieldType; enum?: readonly string[] }[] | undefined {
  const e = entityIn(entity, ctx);
  if (typeof e === 'string') return undefined;
  return [...e.fields].filter(([, f]) => !f.sensitive).map(([name, f]) => ({ name, type: f.type, ...(f.enum && { enum: f.enum }) }));
}

export const relationsOf = (ctx: DslContext) => [...BUILTIN_RELATIONS, ...[...ctx.published.values()].flatMap(e => e.relations ?? [])];

/** 能做指标基础实体：customer 本身，或有指向 customer.customer_id 的 customer_id */
export const linksToConsumer = (name: string, fields: { has: (field: string) => boolean }, ctx: DslContext) => name === 'customer'
  || (fields.has('customer_id')
    && relationsOf(ctx).some(r => r.from.entity === name && r.from.field === 'customer_id' && r.ref.entity === 'customer' && r.ref.field === 'customer_id'));

/**
 * 维度路径的一段：实体.字段。不是终点时 join 是这一段怎样关联到下一实体：下一实体的单列主键，
 * bySource 为真时还要按数据源关联（customer 本身，或主键指向 customer 的实体，只在同一数据源内唯一，ADR-0024）
 */
export interface Step { entity: string; field: string; join?: { key: string; bySource: boolean } }

/** 统一消费者属性的维度路径以它开头（silver._consumer，不是标准层实体） */
export const CONSUMER_ENTITY = 'consumer';

/** 路径写在哪里：维度，或 filter、measure、window 的字段（ADR-0038），报错时用它称呼 */
export type PathUse = '维度' | '过滤' | '度量' | '时间窗口';

/**
 * 解析并检查维度路径：从基础实体出发，每一跳是指向下一实体单列主键的关系，最多 MAX_HOPS 跳，不能成环，终点不能是敏感字段。
 * consumer.<字段> 只有一段，字段是 customer 的非敏感字段（customer_id 除外），基础实体要有 customer_id，只能用作维度。
 * 返回各段与终点字段（info 带 enum，过滤取值按它校验）
 */
export function resolvePath(path: string, base: string, ctx: DslContext, use: PathUse = '维度'): { steps: Step[]; type: FieldType; info: FieldInfo } | string {
  const label = use === '维度' ? '维度路径' : `${use}的路径`;
  const parts = path.split('->').map(s => s.trim());
  const steps: Step[] = [];
  for (const part of parts) {
    const m = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/.exec(part);
    if (!m) return `${label}的每一段要写成 实体.字段，${part || '（空）'} 不是`;
    steps.push({ entity: m[1]!, field: m[2]! });
  }
  if (steps[0]!.entity === CONSUMER_ENTITY) {
    if (use !== '维度') return `${CONSUMER_ENTITY}.${steps[0]!.field} 只能用作维度`;
    if (steps.length > 1) return `${CONSUMER_ENTITY} 维度只能写一段 ${CONSUMER_ENTITY}.字段`;
    const baseEntity = entityIn(base, ctx);
    if (base !== 'customer' && base !== 'event' && (typeof baseEntity === 'string' || !baseEntity.fields.has('customer_id'))) return `${base} 没有 customer_id，不能按 ${CONSUMER_ENTITY} 做维度`;
    const { field } = steps[0]!;
    const customer = entityIn('customer', ctx);
    const f = field === 'customer_id' || typeof customer === 'string' ? undefined : customer.fields.get(field);
    if (!f) return `${CONSUMER_ENTITY} 没有字段 ${field}`;
    if (f.sensitive) return `维度不能用敏感字段 ${CONSUMER_ENTITY}.${field}`;
    return { steps, type: f.type, info: f };
  }
  if (steps[0]!.entity !== base) return `${label}要从基础实体 ${base} 出发`;
  if (steps.length - 1 > MAX_HOPS) return `${label}最多 ${MAX_HOPS} 跳，这里有 ${steps.length - 1} 跳`;
  const relations = relationsOf(ctx);
  const seen: string[] = [];
  let info: FieldInfo | undefined;
  for (const [i, step] of steps.entries()) {
    if (seen.includes(step.entity)) return `${label}成环：${[...seen, step.entity].join(' → ')}`;
    seen.push(step.entity);
    const e = entityIn(step.entity, ctx);
    if (typeof e === 'string') return e;
    const f = e.fields.get(step.field);
    if (!f) return `${step.entity} 没有字段 ${step.field}`;
    const next = steps[i + 1];
    if (!next) {
      if (f.sensitive) return `${use}不能用敏感字段 ${step.entity}.${step.field}`;
      info = f;
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
  return { steps, type: info!.type, info: info! };
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

/** 解析好、结构合规的定义：value 是 YAML 的取值，issue 按路径记下语义问题（行列取自 YAML），done 给出校验结果 */
export interface ParsedDsl { value: unknown; issue: (path: Path, message: string) => void; done: <S>(spec: S) => DslCheck<S> }

/** 各种定义共用的第一步：YAML 语法与 JSON Schema。不通过时返回全部问题（按位置排序） */
export function parseDsl(text: string, validate: ValidateFunction): ParsedDsl | { ok: false; issues: DslIssue[] } {
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
  if (!validate(value)) {
    for (const e of validate.errors ?? []) {
      const d = describeSchemaError(e);
      if (d) issue(d.path, d.message);
    }
    return { ok: false, issues: dedupe(issues).sort(ISSUE_ORDER) };
  }
  return { value, issue, done: spec => (issues.length ? { ok: false, issues: issues.sort(ISSUE_ORDER) } : { ok: true, spec }) };
}

/**
 * 校验指标定义：YAML 语法、JSON Schema，再对照租户上下文做语义检查。
 * 通过时返回定义，否则返回全部问题（按位置排序）
 */
export function checkMetric(text: string, ctx: DslContext): DslCheck<MetricSpec> {
  const parsed = parseDsl(text, validateSchema);
  if ('ok' in parsed) return parsed;
  const { value, issue, done } = parsed;
  const spec = value as MetricSpec;

  const base = entityIn(spec.base, ctx);
  if (typeof base === 'string') {
    issue(['base'], base);
    return done(spec);
  }
  if (!linksToConsumer(spec.base, base.fields, ctx)) {
    issue(['base'], `基础实体 ${spec.base} 要有指向 customer.customer_id 的 customer_id，才能关联到消费者`);
  }
  if (spec.device_attribution !== undefined && spec.base !== 'event') issue(['device_attribution'], '只有基础实体为 event 时才能写 device_attribution');

  /** 基础实体上的字段，或从基础实体出发的路径（含 . 时，ADR-0038）的终点字段：不存在、敏感或路径不合规时报问题并返回 undefined */
  const fieldAt = (path: Path, name: string, use: PathUse) => {
    if (name.includes('.')) {
      const resolved = resolvePath(name, spec.base, ctx, use);
      if (typeof resolved === 'string') issue(path, resolved);
      else return resolved.info;
      return undefined;
    }
    const f = base.fields.get(name);
    if (!f) issue(path, `${spec.base} 没有字段 ${name}`);
    else if (f.sensitive) issue(path, `${use}不能用敏感字段 ${name}`);
    else return f;
    return undefined;
  };

  /** 普通聚合（或 ratio 的分子、分母）：at 是它在 YAML 里的位置 */
  const checkAggregate = (at: Path, agg: string, field: string | undefined) => {
    if (field === undefined) {
      if (agg !== 'count') issue([...at, 'agg'], `agg 为 ${agg} 时要写 field`);
      return;
    }
    const f = fieldAt([...at, 'field'], field, '度量');
    if (f && (agg === 'sum' || agg === 'avg') && !NUMERIC.includes(f.type)) issue([...at, 'field'], `${agg} 只能用整数或小数字段，${field} 不是`);
  };
  const checkTemporal = (at: Path, name: string, use: 'by' | 'days_since') => {
    const f = fieldAt(at, name, '度量');
    if (f && !TEMPORAL.includes(f.type)) issue(at, `${use} 要用时间或日期字段，${name} 不是`);
  };

  /** 过滤条件（顶层 filter 与 ratio 分子、分母的 filter 写法相同）：at 是 filter 数组的位置 */
  const checkFilter = (at: Path, conds: Conditions) => {
    for (const [i, cond] of conds.entries()) {
      const f = fieldAt([...at, i, 'field'], cond.field, '过滤');
      const valueAt = [...at, i, 'value'];
      if (cond.op === 'is_null' || cond.op === 'not_null') {
        if (cond.value !== undefined) issue(valueAt, `${cond.op} 不用写 value`);
        continue;
      }
      if (cond.value === undefined) {
        issue([...at, i], `op 为 ${cond.op} 时要写 value`);
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
  };

  const { agg, field, by } = spec.measure;
  switch (agg) {
    case 'ratio':
      for (const part of ['numerator', 'denominator'] as const) {
        const p = spec.measure[part]!;
        checkAggregate(['measure', part], p.agg, p.field);
        checkFilter(['measure', part, 'filter'], p.filter ?? []);
      }
      break;
    case 'latest': case 'earliest': {
      const f = fieldAt(['measure', 'field'], field!, '度量');
      if (f && !NUMERIC.includes(f.type)) issue(['measure', 'field'], `${agg} 只能用整数或小数字段，${field} 不是（要取时间本身请用 days_since）`);
      checkTemporal(['measure', 'by'], by!, 'by');
      break;
    }
    case 'days_since':
      checkTemporal(['measure', 'field'], field!, 'days_since');
      break;
    default:
      checkAggregate(['measure'], agg, field);
  }

  checkFilter(['filter'], spec.filter ?? []);

  if (spec.window) {
    const f = fieldAt(['window', 'field'], spec.window.field, '时间窗口');
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

  return done(spec);
}

const dedupe = (issues: DslIssue[]) => issues.filter((x, i) => issues.findIndex(y => y.path === x.path && y.message === x.message) === i);

/** 指标的取值是不是数字：min、max 看度量字段的类型，其余（含 ratio、latest、earliest、days_since）总是 */
export function isNumericMetric(spec: MetricSpec, ctx: DslContext): boolean {
  const { agg, field } = spec.measure;
  if (agg !== 'min' && agg !== 'max') return true;
  if (field === undefined) return false;
  let type: FieldType | undefined;
  if (field.includes('.')) {
    const resolved = resolvePath(field, spec.base, ctx, '度量');
    type = typeof resolved === 'string' ? undefined : resolved.type;
  } else {
    const base = entityIn(spec.base, ctx);
    type = typeof base === 'string' ? undefined : base.fields.get(field)?.type;
  }
  return !!type && NUMERIC.includes(type);
}

/** 定义的依赖（ADR-0025「依赖按需计算」）：引用的指标键、用到的实体与字段，各自去重排序 */
export interface Dependencies {
  metrics: string[];
  /** 基础实体与维度路径、字段路径经过的每个实体（consumer 维度记作 customer：它的属性来自 silver.customer） */
  entities: string[];
  /** 度量（含 by、ratio 分子分母的字段与过滤）、过滤、窗口的字段（裸字段在基础实体上），与维度路径、字段路径的各段 */
  fields: { entity: string; field: string }[];
}

/** 指标的依赖：只看结构（通过 JSON Schema 即可），不对照登记与映射 */
export function metricDependencies(spec: MetricSpec): Dependencies {
  const fields = new Map<string, { entity: string; field: string }>();
  const add = (entity: string, field: string | undefined) => {
    if (field !== undefined) fields.set(`${entity}.${field}`, { entity, field });
  };
  /** 裸字段记在基础实体上；路径（含 .）按 -> 拆段，每段 实体.字段 都计入。已发布版本的 YAML 不经 Schema 直接交来，不是字符串时跳过 */
  const addSteps = (path: string) => {
    for (const part of path.split('->')) {
      const [entity, field] = part.trim().split('.');
      add(entity === CONSUMER_ENTITY ? 'customer' : entity!, field);
    }
  };
  const addPath = (x: unknown) => {
    if (typeof x !== 'string') return;
    if (x.includes('.')) addSteps(x);
    else add(spec.base, x);
  };
  addPath(spec.measure.field);
  addPath(spec.measure.by);
  // 分子、分母与各自的 filter 都可能缺
  for (const part of [spec.measure.numerator, spec.measure.denominator]) {
    addPath(part?.field);
    for (const f of part?.filter ?? []) addPath(f?.field);
  }
  for (const f of spec.filter ?? []) addPath(f?.field);
  addPath(spec.window?.field);
  for (const d of spec.dimensions ?? []) addSteps(d.path);
  return {
    metrics: [],
    entities: [...new Set([spec.base, ...[...fields.values()].map(f => f.entity)])].sort(),
    fields: [...fields.keys()].sort().map(k => fields.get(k)!),
  };
}

/** 定义用到的实体（基础实体与维度路径经过的实体），排好序 */
export const metricEntities = (spec: MetricSpec): string[] => metricDependencies(spec).entities;

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

  // 设备归属（ADR-0019）：customer_id 有值只经 _identities 解析，为空才经 device_id 查 _device_owner，两边都查不到的不计入
  const byDevice = spec.base === 'event' && spec.device_attribution !== false;
  const consumer = byDevice ? 'COALESCE(i.consumer_id, o.consumer_id)' : 'i.consumer_id';

  const joins: string[] = [];
  /** 连上路径前缀（前 n 段 实体.字段 用 -> 连起来）的别名：维度各连一串，字段路径复用序号最小的维度的前缀（ADR-0038） */
  const prefixes = new Map<string, string>();
  const prefixKey = (steps: Step[], n: number) => steps.slice(0, n).map(s => `${s.entity}.${s.field}`).join(' -> ');
  /** 一段路径 step 从 prev 连到下一实体 next，别名 alias */
  const joinStep = (step: Step, next: Step, prev: string, alias: string) => {
    const { key, bySource } = step.join!;
    // 跳到 customer 时按引用列的数据源列找消费者记录（跨源引用，ADR-0030）
    const sourceOn = !bySource ? '' : ` AND ${alias}._source = ${prev}.${next.entity === 'customer' ? ident(customerSourceColumn(step.field)) : '_source'}`;
    return `LEFT JOIN ${silverTable(next.entity)} ${alias} ON ${alias}.${ident(key)} = ${prev}.${ident(step.field)}${sourceOn}`;
  };
  const dims: string[] = [];
  const dimension = (alias: string, field: string, name: string) => `COALESCE(NULLIF(CAST(${alias}.${ident(field)} AS VARCHAR), ''), ${lit(UNLINKED)}) AS ${ident(name)}`;
  for (const [i, d] of (spec.dimensions ?? []).entries()) {
    const resolved = resolvePath(d.path, spec.base, ctx);
    if (typeof resolved === 'string') throw new Error(resolved);
    if (resolved.steps[0]!.entity === CONSUMER_ENTITY) {
      const consumerJoin = `LEFT JOIN ${CONSUMER} cs ON cs.consumer_id = ${consumer}`;
      if (!joins.includes(consumerJoin)) joins.unshift(consumerJoin);
      dims.push(dimension('cs', resolved.steps[0]!.field, d.name));
      continue;
    }
    let prev = 'b';
    for (const [j, step] of resolved.steps.slice(0, -1).entries()) {
      const alias = `d${i}_${j + 1}`;
      joins.push(joinStep(step, resolved.steps[j + 1]!, prev, alias));
      const key = prefixKey(resolved.steps, j + 1);
      if (!prefixes.has(key)) prefixes.set(key, alias);
      prev = alias;
    }
    const end = resolved.steps.at(-1)!;
    dims.push(dimension(prev, end.field, d.name));
  }

  // filter、measure、window 的字段：裸字段取基础实体的列；路径取终点的原值（关联不上为 NULL，不记「未关联」），
  // 前缀已连过的复用别名，其余段新开 p<k>_<段>（k 是第几条要新开 JOIN 的字段路径），JOIN 紧跟维度之后
  const refs = new Map<string, { sql: string; info: FieldInfo }>();
  let newPathJoins = 0;
  const fieldRef = (name: string) => {
    const known = refs.get(name);
    if (known) return known;
    let ref: { sql: string; info: FieldInfo };
    if (!name.includes('.')) ref = { sql: col(name), info: base.fields.get(name)! };
    else {
      const resolved = resolvePath(name, spec.base, ctx);
      if (typeof resolved === 'string') throw new Error(resolved);
      const { steps } = resolved;
      const k = newPathJoins;
      let prev = 'b';
      for (const [j, step] of steps.slice(0, -1).entries()) {
        const key = prefixKey(steps, j + 1);
        let alias = prefixes.get(key);
        if (!alias) {
          alias = `p${k}_${j + 1}`;
          joins.push(joinStep(step, steps[j + 1]!, prev, alias));
          prefixes.set(key, alias);
          newPathJoins = k + 1;
        }
        prev = alias;
      }
      ref = { sql: steps.length === 1 ? col(steps[0]!.field) : `${prev}.${ident(steps.at(-1)!.field)}`, info: resolved.info };
    }
    refs.set(name, ref);
    return ref;
  };
  // 先按出现顺序收集字段路径、生成 JOIN，再拼 SELECT（ratio 分子分母的 FILTER 也要引用路径别名）
  const { agg, field, by, numerator, denominator } = spec.measure;
  const fieldsInOrder = [
    ...(spec.filter ?? []).map(c => c.field), field, by,
    numerator?.field, ...(numerator?.filter ?? []).map(c => c.field),
    denominator?.field, ...(denominator?.filter ?? []).map(c => c.field),
    spec.window?.field,
  ];
  for (const name of fieldsInOrder) if (name !== undefined) fieldRef(name);

  const conditions = (conds: Conditions) => conds.map(cond => {
    const { sql: c, info: f } = fieldRef(cond.field);
    switch (cond.op) {
      case 'is_null': return `${c} IS NULL`;
      case 'not_null': return `${c} IS NOT NULL`;
      case 'in': case 'not_in': {
        const values = [cond.value!].flat().map(v => sqlValue(f, v)).join(', ');
        return `${c} ${cond.op === 'in' ? 'IN' : 'NOT IN'} (${values})`;
      }
      default: return `${c} ${COMPARE[cond.op]} ${sqlValue(f, cond.value as Scalar)}`;
    }
  });
  // 时间按 UTC 取日期
  const day = (field: string) => {
    const { sql, info } = fieldRef(field);
    return info.type === 'timestamp' ? `(${sql} AT TIME ZONE 'UTC')::DATE` : sql;
  };
  const aggregate = (agg: string, field: string | undefined, filter: Conditions = []) => {
    const expr = field === undefined ? 'COUNT(*)'
      : agg === 'count_distinct' ? `COUNT(DISTINCT ${fieldRef(field).sql})`
      : `${agg.toUpperCase()}(${fieldRef(field).sql})`;
    const conds = conditions(filter);
    return conds.length ? `${expr} FILTER (WHERE ${conds.join(' AND ')})` : expr;
  };

  // ratio 只有分母为 0 或为空时记空：分子的 sum 过滤后没有行记 0
  const measure = agg === 'ratio' ? `CAST(COALESCE(${aggregate(numerator!.agg, numerator!.field, numerator!.filter)}, 0) AS DOUBLE) / NULLIF(${aggregate(denominator!.agg, denominator!.field, denominator!.filter)}, 0)`
    : agg === 'latest' || agg === 'earliest' ? `${agg === 'latest' ? 'arg_max' : 'arg_min'}(${fieldRef(field!).sql}, ${fieldRef(by!).sql})`
    : agg === 'days_since' ? `DATE ${lit(asOf)} - MAX(${day(field!)})`
    : aggregate(agg, field);

  const where = conditions(spec.filter ?? []);
  if (spec.window) {
    const d = day(spec.window.field);
    where.push(`${d} > DATE ${lit(asOf)} - ${spec.window.days}`, `${d} <= DATE ${lit(asOf)}`);
  }

  if (byDevice) where.unshift(`${consumer} IS NOT NULL`);
  // customer 记录就在行自己的数据源里；其他实体按 customer_id 的数据源列找消费者记录（跨源引用，ADR-0030）
  const identityOn = `i._source = b.${spec.base === 'customer' ? '_source' : customerSourceColumn('customer_id')} AND i.customer_id = b.customer_id`;
  return [
    `SELECT ${byDevice ? `${consumer} AS consumer_id` : consumer}, ${[...dims, `${measure} AS value`].join(', ')}`,
    `FROM ${silverTable(spec.base)} b`,
    ...(byDevice
      ? [`LEFT JOIN ${IDENTITIES} i ON ${identityOn}`,
        `LEFT JOIN ${DEVICE_OWNER} o ON b.customer_id IS NULL AND o.device_id = b.device_id`]
      : [`INNER JOIN ${IDENTITIES} i ON ${identityOn}`]),
    ...joins,
    ...(where.length ? [`WHERE ${where.join('\n  AND ')}`] : []),
    'GROUP BY ALL',
    'ORDER BY ALL',
  ].join('\n');
}
