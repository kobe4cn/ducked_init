// app/.server/pipeline/dsl/model-draft.ts —— 用模型按自然语言需求生成定义草稿（ADR-0035，纯函数，不读库、不发请求）：
// 每种可生成的定义给出模型必须遵守的输出 Schema（直接用该种类的定义 Schema）、调用用途、提示词与给模型的上下文；
// 指标的上下文只列租户里能用的实体、非敏感字段与关系（与校验同源，敏感字段不进上下文，ADR-0005）；
// 标签的上下文只列标签能引用的指标：已发布、通过校验、没有维度、取值为数字（与 checkTag 同用 metricOf）。
// 模型输出转成 YAML（首行注释提示核对）后仍要过该种类的校验（DSL_KINDS[kind].check），保存与双人发布照旧
import { Document } from 'yaml';
import { CANONICAL_ENTITIES, relationText } from '../../../lib/canonical-model';
import type { LlmMessage, LlmPurpose } from '../../llm';
import { AGGS, CONSUMER_ENTITY, FILTER_OPS, fieldsFor, linksToConsumer, MAX_DIMENSIONS, MAX_HOPS, METRIC_SCHEMA, RATIO_AGGS, relationsOf, type DslContext, type MetricSpec } from './metric-spec';
import type { DslKind } from './index';
import { metricOf, SINGLE_TAG_SCHEMA, TAG_CONDITIONS } from './tag-spec';

/** 指标的上下文：各实体能用的字段（已剔除敏感字段）、能做基础实体的实体与实体间的关系 */
export interface MetricDraftContext {
  entities: { name: string; base: boolean; fields: { name: string; type: string; enum?: readonly string[] }[] }[];
  relations: string[];
}

/** 指标上下文：标准实体与已发布的自定义实体；能做基础实体的是 customer 与有指向 customer.customer_id 的 customer_id 的实体（与校验同一规则） */
function metricContext(ctx: DslContext): MetricDraftContext {
  const names = [...CANONICAL_ENTITIES.map(e => e.name), ...ctx.published.keys()];
  const entities = names.flatMap(name => {
    const fields = fieldsFor(name, ctx);
    if (!fields) return [];
    return [{ name, base: linksToConsumer(name, new Set(fields.map(f => f.name)), ctx), fields }];
  });
  return { entities, relations: relationsOf(ctx).map(relationText) };
}

const METRIC_SYSTEM = [
  '你是 CRM 数据平台的指标助手：按成员的需求写一个指标定义，只输出一个符合给定 JSON Schema 的 JSON 对象，不要输出别的文字。',
  '输入：request 是成员用自然语言写的需求；context.entities 是能用的实体与字段（base 为 true 的才能做基础实体），context.relations 是实体间的关系（实体.字段 → 实体.主键）。',
  '输出格式：',
  `{ "base": 基础实体, "measure": { "agg": ${AGGS.join(' | ')}, "field"?: 基础实体的字段（count 可不写）, "by"?: 时间或日期字段（只用于 latest / earliest）,`,
  `    "numerator"?: 分子, "denominator"?: 分母（只用于 ratio，各为 { "agg": ${RATIO_AGGS.join(' | ')}, "field"?: 字段, "filter"?: 写法同下面的 filter }） },`,
  `  "filter"?: [{ "field": 基础实体的字段, "op": ${FILTER_OPS.join(' | ')}, "value"?: 取值或取值列表（in / not_in 写列表，is_null / not_null 不写） }],`,
  '  "window"?: { "field": 基础实体的时间或日期字段, "days": 正整数 },',
  `  "dimensions"?: [{ "name": 小写字母开头的列名, "path": 维度路径 }]（最多 ${MAX_DIMENSIONS} 个）,`,
  '  "description"?: 不超过 500 字的中文说明 }',
  '规则：',
  '- 只用 context 里给出的实体与字段，不要编造；context 里没有的字段（包括敏感字段）一律不要用。',
  '- sum / avg 只能用整数或小数字段；过滤取值按字段类型写，有 enum 的字段只能用其中的取值。',
  `- 比率（如核销率、客单价）用 ratio：写 numerator 与 denominator，不写 field；分子、分母的 agg 只能是 ${RATIO_AGGS.join(' / ')}，各自的 filter 与顶层 filter、window 同时生效。`,
  '- latest / earliest 按 by 取最新 / 最早一行的 field，field 只能是整数或小数字段；距今天数（如最近一次购买距今几天）用 days_since，field 是时间或日期字段。',
  `- 维度路径从基础实体出发，写成 实体.字段 -> 实体.字段，每一跳要沿 context.relations 里的一条关系走到下一实体的主键，最多 ${MAX_HOPS} 跳；`,
  `  或者写一段 ${CONSUMER_ENTITY}.字段，取统一消费者的属性（字段是 customer 的字段，基础实体要有 customer_id）。`,
  '- 需求没提到的部分不要加；不要输出 device_attribution。',
].join('\n');

/** 标签的上下文：标签能引用的指标（按键排序），各带说明与度量；一个都没有时返回提示 */
export interface TagDraftContext {
  metrics: { key: string; description?: string; measure: MetricSpec['measure'] }[];
}

function tagContext(ctx: DslContext): TagDraftContext | string {
  const metrics = [...ctx.metrics.keys()].flatMap(key => {
    const spec = metricOf(key, ctx);
    return typeof spec === 'string' ? [] : [{ key, description: spec.description, measure: spec.measure }];
  });
  if (!metrics.length) return '本租户还没有标签能引用的指标：请先发布一个数值型指标（没有维度）';
  return { metrics: metrics.sort((a, b) => a.key.localeCompare(b.key)) };
}

const TAG_SYSTEM = [
  '你是 CRM 数据平台的标签助手：按成员的需求写一个标签定义，只输出一个符合给定 JSON Schema 的 JSON 对象，不要输出别的文字。',
  '输入：request 是成员用自然语言写的需求；context.metrics 是能引用的指标（每个消费者一个数值），各带键、说明与度量。',
  '输出格式：',
  `{ "metric": 指标键, "rules": [{ "value": 标签取值（字符串或数字）, "when": { ${TAG_CONDITIONS.map(c => `"${c}"?: 数字`).join(', ')} } }],`,
  '  "default": 没命中任何规则时的取值, "description"?: 不超过 500 字的中文说明 }',
  '规则：',
  '- metric 只能是 context.metrics 里的一个键，不要编造。',
  '- rules 按顺序取第一条命中的，when 里的条件全部满足才算命中（gte ≥、gt >、lte ≤、lt <、eq =），至少写一个条件；都没命中的取 default。',
  '- 阈值与取值按需求写，需求没提到的部分不要加。',
].join('\n');

/** 可由模型生成的定义：输出 Schema、调用用途、system 提示词与上下文（上下文里没东西可用时是给成员的提示） */
const DRAFTS = {
  metric: { schema: METRIC_SCHEMA, purpose: 'metric_draft', system: METRIC_SYSTEM, context: metricContext },
  tag: { schema: SINGLE_TAG_SCHEMA, purpose: 'tag_draft', system: TAG_SYSTEM, context: tagContext },
} satisfies Record<DslKind, { schema: object; purpose: LlmPurpose; system: string; context: (ctx: DslContext) => object | string }>;

/** 模型输出必须符合的 JSON Schema 与调用用途 */
export const definitionDraftSchema = (kind: DslKind) => DRAFTS[kind].schema;
export const definitionDraftPurpose = (kind: DslKind) => DRAFTS[kind].purpose;

/**
 * 发给模型的消息：system 讲清输出格式与只用给出的字段，user 是需求原文与上下文；
 * 上下文里没有可用的东西时（如标签没有可引用的指标）返回提示，调用方不发请求
 */
export function definitionDraftMessages(kind: DslKind, request: string, ctx: DslContext): LlmMessage[] | { unavailable: string } {
  const { system, context: contextOf } = DRAFTS[kind];
  const context = contextOf(ctx);
  if (typeof context === 'string') return { unavailable: context };
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ request, context }) },
  ];
}

/** 模型输出（已按 Schema 校验）转成定义 YAML，首行注释提示核对 */
export function definitionOutputToYaml(_kind: DslKind, output: object): string {
  const doc = new Document(output);
  doc.commentBefore = ' 模型根据需求生成，请核对';
  return doc.toString();
}
