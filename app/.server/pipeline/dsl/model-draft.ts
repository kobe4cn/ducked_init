// app/.server/pipeline/dsl/model-draft.ts —— 用模型按自然语言需求生成定义草稿（ADR-0035，纯函数，不读库、不发请求）：
// 每种可生成的定义给出模型必须遵守的输出 Schema（直接用该种类的定义 Schema）、调用用途、提示词与给模型的上下文；
// 上下文取自语义目录（ADR-0041）：system 是简短的角色说明加该种类的能力说明，user 是目录总览、用需求原文搜出的条目与需求原文。
// 目录里本就没有敏感字段、哈希列与明细行（ADR-0005），统计只有 ADR-0016 的常见取值。
// 模型输出转成 YAML（首行注释提示核对）后仍要过该种类的校验（DSL_KINDS[kind].check），保存与双人发布照旧
import { Document } from 'yaml';
import { CAPABILITIES } from '../../catalog/capabilities';
import { estimateTokens, overview, toMarkdown, type Catalog } from '../../catalog';
import { deriveProjection } from '../../catalog/projection';
import { rank } from '../../catalog/rank';
import type { LlmMessage, LlmPurpose } from '../../llm';
import { CONSUMER_ENTITY, METRIC_SCHEMA, type MetricSpec, type RatioPart } from './metric-spec';
import type { DslKind } from './index';
import { SINGLE_TAG_SCHEMA } from './tag-spec';

/** 按需求搜出的条目最多几条 */
const SEARCH_LIMIT = 15;
/** 搜出的条目估算最多多少 token，超过时减少条数 */
const SEARCH_TOKENS = 6000;

const capability = (id: string) => toMarkdown(CAPABILITIES.find(c => c.id === id)!);

/** 指标能力说明（怎么写指标定义，含 YAML 示例），起草与一句话解析共用 */
const METRIC_CAPABILITY = capability('capability:metric-dsl');

/** 怎么写指标（起草与一句话解析共用）：只用目录里的东西、类型与取值规则 */
const METRIC_RULES = [
  '规则：',
  '- 只用目录里列出的实体、字段与关系，不要编造；目录里没有的字段（包括敏感字段）一律不要用。',
  '- sum / avg 只能用整数或小数字段；过滤取值按字段类型写，有取值列表的字段只能用其中的取值。',
  `- filter、measure、window 的字段也能写维度路径，但不能写 ${CONSUMER_ENTITY}.字段。`,
  '- count 数的是基础实体的行数：base 为 order_item 时数的是明细行，要数订单写 { "agg": "count_distinct", "field": "order_id" }。',
  '- 需求没提到的部分不要加；不要输出 device_attribution。',
];

const METRIC_SYSTEM = [
  '你是 CRM 数据平台的指标助手：按成员的需求写一个指标定义，只输出一个符合给定 JSON Schema 的 JSON 对象（与下面 YAML 示例同样的结构），不要输出别的文字。',
  '成员的消息里依次是语义目录总览、按需求搜出的目录条目与需求原文。',
  ...METRIC_RULES,
  '',
  METRIC_CAPABILITY,
].join('\n');

/** 一句话解析（#516）：spec 是指标定义，另有逐项说明、认不出的词与不支持的说法 */
const METRIC_PARSE_SYSTEM = [
  '你是 CRM 数据平台的指标助手：把成员的一句话解析成一个指标定义，只输出一个符合给定 JSON Schema 的 JSON 对象（spec 是指标定义，与下面 YAML 示例同样的结构），不要输出别的文字。',
  '成员的消息里依次是语义目录总览、按句子搜出的目录条目与句子原文。',
  ...METRIC_RULES,
  '解析说明：',
  '- items 逐项说明 spec 的每个部分是怎么从句子来的：path 用它在 spec 里的位置（如 measure.field、filter.0、window），reason 一句话。',
  '- 句子里认不出的词照原话进 unknowns（如目录里没有的字段、对应不上的说法），不要猜。',
  '- 「或」只在同一字段的不同取值时改写成一个 in 过滤（value 是列表）；跨字段的「或」表达不了，整句原话进 unsupported，不写进 spec。',
  '- 时间只认「近 N 天」，写成 window；「上个月」「今年」等其他时间说法整句原话进 unsupported，不写进 spec。',
  '- 「分母为 0 时算 0」整句原话进 unsupported：编译用 NULLIF，分母为 0 时结果是空，不是 0。',
  '- 句子支撑不了的写法不要写进 spec；unsupported 里的说法一律不进 spec。',
  '',
  METRIC_CAPABILITY,
].join('\n');

const TAG_SYSTEM = [
  '你是 CRM 数据平台的标签助手：按成员的需求写一个标签定义，只输出一个符合给定 JSON Schema 的 JSON 对象，不要输出别的文字。',
  '成员的消息里依次是语义目录总览、按需求搜出的目录条目与需求原文。',
  '规则：',
  '- 只用单指标写法：metric 是目录里一个没有维度的已发布指标（metric:<键> 条目里的键），不要编造；不写 missing，when 里直接写比较。',
  '- rules 按顺序取第一条命中的，when 里的条件全部满足才算命中，至少写一个条件；都没命中的取 default。',
  '- 阈值与取值按需求写，需求没提到的部分不要加。',
  '',
  capability('capability:tag-dsl'),
].join('\n');

/** 标签要有能引用的指标：目录里没有维度的已发布指标（是否数值型由校验把关） */
const tagUnavailable = (catalog: Catalog) =>
  catalog.entries.some(e => e.kind === 'metric' && !e.dimensions.length) ? null : '本租户还没有标签能引用的指标：请先发布一个数值型指标（没有维度）';

/** 可由模型生成的定义：输出 Schema、调用用途、system 提示词与目录里没东西可用时给成员的提示 */
const DRAFTS = {
  metric: { schema: METRIC_SCHEMA, purpose: 'metric_draft', system: METRIC_SYSTEM, unavailable: () => null },
  tag: { schema: SINGLE_TAG_SCHEMA, purpose: 'tag_draft', system: TAG_SYSTEM, unavailable: tagUnavailable },
} satisfies Record<DslKind, { schema: object; purpose: LlmPurpose; system: string; unavailable: (catalog: Catalog) => string | null }>;

/** 模型输出必须符合的 JSON Schema 与调用用途 */
export const definitionDraftSchema = (kind: DslKind) => DRAFTS[kind].schema;
export const definitionDraftPurpose = (kind: DslKind) => DRAFTS[kind].purpose;

/** 用需求原文排序（rank，内存里派生的 full 投影）出的条目的 Markdown，估算超过 SEARCH_TOKENS 时减少条数；能力说明已在 system 里，排序前就去掉它的投影行，不占依赖展开的名额 */
function relevantMarkdown(catalog: Catalog, request: string): string {
  const hits = rank(deriveProjection(catalog, 'full').filter(r => !r.entryId.startsWith('capability:')), catalog, request, {}, SEARCH_LIMIT).map(r => r.entry);
  for (let n = hits.length; n > 0; n--) {
    const md = toMarkdown(hits.slice(0, n));
    if (estimateTokens(md) <= SEARCH_TOKENS) return md;
  }
  return toMarkdown([]);
}

/**
 * 发给模型的消息：system 是角色说明与该种类的能力说明，user 依次是目录总览、按需求搜出的条目与需求原文；
 * 目录里没有可用的东西时（如标签没有可引用的指标）返回提示，调用方不发请求
 */
export function definitionDraftMessages(kind: DslKind, request: string, catalog: Catalog): LlmMessage[] | { unavailable: string } {
  const { system, unavailable } = DRAFTS[kind];
  const hint = unavailable(catalog);
  if (hint) return { unavailable: hint };
  const user = [toMarkdown(overview(catalog)), `# 与需求相关的条目\n\n${relevantMarkdown(catalog, request)}`, `# 需求\n\n${request}`].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 一句话解析的输出 Schema（#516）：spec 是指标定义（METRIC_SCHEMA），另有逐项说明、认不出的词与不支持的说法，四个键都必填 */
export const METRIC_PARSE_SCHEMA = {
  type: 'object',
  required: ['spec', 'items', 'unknowns', 'unsupported'],
  additionalProperties: false,
  properties: {
    spec: METRIC_SCHEMA,
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'reason'],
        additionalProperties: false,
        properties: { path: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 } },
      },
    },
    unknowns: { type: 'array', items: { type: 'string' } },
    unsupported: { type: 'array', items: { type: 'string' } },
  },
} as const;

/**
 * 一句话解析成指标表单（#516）发给模型的消息，结构与 definitionDraftMessages 相同：
 * system 是指标规则（共用）加解析说明，user 依次是目录总览、按句子搜出的条目与句子原文
 */
export function metricParseMessages(sentence: string, catalog: Catalog): LlmMessage[] {
  const user = [toMarkdown(overview(catalog)), `# 与需求相关的条目\n\n${relevantMarkdown(catalog, sentence)}`, `# 句子\n\n${sentence}`].join('\n\n');
  return [
    { role: 'system', content: METRIC_PARSE_SYSTEM },
    { role: 'user', content: user },
  ];
}

/** `->` 路径首段没写实体名时补成 <base>.<字段>；首段已有 `.`、不含 `->` 的裸字段原样返回（留给校验） */
function completePath(base: string, p: string): string {
  if (!p.includes('->')) return p;
  const parts = p.split('->').map(s => s.trim());
  if (parts[0]!.includes('.')) return p;
  parts[0] = `${base}.${parts[0]}`;
  return parts.join(' -> ');
}

/**
 * 模型起草的指标里 `->` 路径首段常漏写实体名（customer_id -> customer.city），按 base 补全后再转 YAML；返回新对象，不改传入的。
 * 补 filter / window / dimensions 的路径、measure 与 ratio 分子分母的字段与过滤字段；consumer_via 是字段名不是路径，不动。
 * 只改模型输出这一侧，校验不放宽（人手写的定义照旧报错）；标签原样返回。
 * output 已按 METRIC_SCHEMA 校验过，形状就是 MetricSpec；没写的键不补成 undefined
 */
export function completeDraftPaths(kind: DslKind, output: object): object {
  if (kind !== 'metric') return output;
  const spec = output as MetricSpec;
  const fix = (p: string) => completePath(spec.base, p);
  const fields = <T extends { field?: string }>(o: T): T => (o.field === undefined ? { ...o } : { ...o, field: fix(o.field) });
  const conditions = (cs: MetricSpec['filter']) => cs?.map(fields);
  const part = (p: RatioPart | undefined) => p && { ...fields(p), ...(p.filter && { filter: conditions(p.filter) }) };
  const m = spec.measure;
  const measure: MetricSpec['measure'] = {
    ...fields(m),
    ...(m.by !== undefined && { by: fix(m.by) }),
    ...(m.numerator && { numerator: part(m.numerator) }),
    ...(m.denominator && { denominator: part(m.denominator) }),
  };
  return {
    ...spec,
    measure,
    ...(spec.filter && { filter: conditions(spec.filter) }),
    ...(spec.window && { window: fields(spec.window) }),
    ...(spec.dimensions && { dimensions: spec.dimensions.map(d => ({ ...d, path: fix(d.path) })) }),
  };
}

/** 模型输出（已按 Schema 校验）补全路径首段的实体名后转成定义 YAML，首行注释提示核对 */
export function definitionOutputToYaml(kind: DslKind, output: object): string {
  const doc = new Document(completeDraftPaths(kind, output));
  doc.commentBefore = ' 模型根据需求生成，请核对';
  return doc.toString();
}
