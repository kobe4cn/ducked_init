// app/.server/pipeline/dsl/model-draft.ts —— 用模型按自然语言需求生成定义草稿（ADR-0035，纯函数，不读库、不发请求）：
// 每种可生成的定义给出模型必须遵守的输出 Schema（指标沿用一句话解析的输出形状，#1162：宽松 Schema 放行，调用方收拢后严格校验；标签另有「做不到」的出口，#1165）、调用用途、提示词与给模型的上下文；
// 上下文取自语义目录（ADR-0041）：system 是简短的角色说明加该种类的能力说明，user 是目录分层上下文（第一层分组、相关分组的组内列表，#855）、
// 按需求检索出的条目与需求原文。检索在 catalog/draft-search.ts（与助手同一条路，#827），排好的条目由调用方传入，这里只管截断与拼消息。
// 目录里本就没有敏感字段、哈希列与明细行（ADR-0005），统计只有 ADR-0016 的常见取值。
// 模型输出转成 YAML（首行注释提示核对）后仍要过该种类的校验（DSL_KINDS[kind].check），保存与双人发布照旧
import { Document } from 'yaml';
import { CAPABILITIES } from '../../catalog/capabilities';
import { estimateTokens, layeredContext, OVERVIEW_TOKENS, toMarkdown, type Catalog, type CatalogEntry } from '../../catalog';
import type { LlmMessage, LlmPurpose } from '../../llm';
import { CONSUMER_ENTITY, METRIC_SCHEMA, type MetricSpec, type RatioPart } from './metric-spec';
import type { DslKind } from './index';
import { TAG_SCHEMA } from './tag-spec';

/** 按需求搜出的条目最多几条（起草与一句话解析的检索都由 catalog/draft-search.ts 取，这里是截断上限） */
export const SEARCH_LIMIT = 15;
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
  '- 时间（timestamp）字段不能做维度：DSL 没有时间分桶；需求要按小时 / 天 / 月分组或取峰值时，说明做不到，不要用时间字段凑维度。',
  '- 需求没提到的部分不要加；不要输出 device_attribution。',
];

/** 输出格式与逐项说明的规则（起草与一句话解析共用，#1162）：来源词是「需求」还是「句子」，只替换它，其余逐字相同 */
const metricOutputLines = (source: string) => [
  '输出格式：',
  '{ "spec": { "base": 基础实体, "measure": 度量, "filter"?: 过滤条件数组, "window"?: 时间窗口, … },',
  '  "items": [{ "path": 在 spec 里的位置, "reason": 一句话说明 }], "unknowns": [], "unsupported": [] }',
  '四个键都必须有，没有内容给空列表；下面 YAML 示例是 spec 里面的写法，不要把定义平铺到顶层。',
  '解析说明：',
  `- items 逐项说明 spec 的每个部分是怎么从${source}来的：path 用它在 spec 里的位置（如 measure.field、filter.0、window），reason 一句话。`,
  `- ${source}里认不出的词照原话进 unknowns（如目录里没有的字段、对应不上的说法），不要猜。`,
  '- 「或」只在同一字段的不同取值时改写成一个 in 过滤（value 是列表）；跨字段的「或」表达不了，整句原话进 unsupported，不写进 spec。',
  '- 时间只认「近 N 天」，写成 window；「上个月」「今年」等其他时间说法整句原话进 unsupported，不写进 spec；按小时 / 天 / 月分组、取峰值的说法也整句原话进 unsupported。',
  '- 「分母为 0 时算 0」整句原话进 unsupported：编译用 NULLIF，分母为 0 时结果是空，不是 0。',
  `- ${source}支撑不了的写法不要写进 spec；unsupported 里的说法一律不进 spec。`,
];

/** 指标的 system 提示词（起草与一句话解析共用，#1162）：task 是角色说明里的任务，source 是来源词（「需求」或「句子」），其余逐字相同 */
const metricSystem = (task: string, source: string) => [
  `你是 CRM 数据平台的指标助手：${task}，只输出一个符合给定 JSON Schema 的 JSON 对象（顶层是 spec、items、unknowns、unsupported 四个键，指标定义只放在 spec 里），不要输出别的文字。`,
  `成员的消息里依次是语义目录的第一层分组、相关分组的组内列表、按${source}搜出的目录条目与${source}原文。`,
  ...METRIC_RULES,
  ...metricOutputLines(source),
  '',
  METRIC_CAPABILITY,
].join('\n');

/** 指标起草（#1162）：输出形状与一句话解析相同（spec 加逐项说明、认不出的词与不支持的说法），由调用方收拢平铺输出后严格校验、带回说明 */
const METRIC_DRAFT_SYSTEM = metricSystem('按成员的需求写一个指标定义', '需求');

/** 一句话解析（#516）：spec 是指标定义，另有逐项说明、认不出的词与不支持的说法；提示词要写出输出骨架——
 *  模型看不到 METRIC_PARSE_SCHEMA（callModel 只发 response_format: json_object），不写骨架时模型会照 YAML 示例把定义平铺到顶层（#959） */
const METRIC_PARSE_SYSTEM = metricSystem('把成员的一句话解析成一个指标定义', '句子');

const TAG_SYSTEM = [
  '你是 CRM 数据平台的标签助手：按成员的需求写一个标签定义，只输出一个符合给定 JSON Schema 的 JSON 对象，不要输出别的文字。',
  '成员的消息里依次是语义目录的第一层分组、相关分组的组内列表、按需求搜出的目录条目与需求原文。',
  '规则：',
  '- 引用的指标只能是目录里没有维度的已发布指标（metric:<键> 条目里的键），不要编造；不写 missing。',
  '- 需求只涉及一个指标时用单指标写法：顶层写 metric，每条规则的 when 里直接写比较（gte / gt / lte / lt / eq）。',
  '- 需求涉及多个指标时用多指标写法：不写顶层 metric，每条规则的 when 写 { "all": [...] }（全部满足）或 { "any": [...] }（任一满足），只一层、不嵌套，每项是 { "metric": 指标键, 比较 }。',
  '- rules 按顺序取第一条命中的，至少写一条规则、每条至少一个条件；都没命中的取 default。',
  '- 阈值与取值按需求写，需求没提到的部分不要加。',
  '- 需求用上面的写法和目录里的指标做不到时（如缺少需要的指标、要按小时等目录没有的粒度），不要硬凑、不要只引用其中一部分指标，只输出 unsupported：每条写一句做不到的原因和需要补充什么；unsupported 不要和 rules 放在同一个对象里。',
  '输出格式（三选一）：',
  '- 单指标：{ "metric": 指标键, "rules": [{ "value": 取值, "when": { "gte": 数字 } }], "default": 取值, "description"?: 说明 }',
  '- 多指标：{ "rules": [{ "value": 取值, "when": { "all": [{ "metric": 指标键, "gte": 数字 }, { "metric": 指标键, "eq": 数字 }] } }], "default": 取值, "description"?: 说明 }',
  '- 做不到：{ "unsupported": ["原因…"] }',
  '',
  capability('capability:tag-dsl'),
].join('\n');

/** 标签要有能引用的指标：目录里没有维度的已发布指标（是否数值型由校验把关） */
const tagUnavailable = (catalog: Catalog) =>
  catalog.entries.some(e => e.kind === 'metric' && !e.dimensions.length) ? null : '本租户还没有标签能引用的指标：请先发布一个数值型指标（没有维度）';

/** 一句话解析的输出 Schema（#516）：spec 是指标定义（METRIC_SCHEMA），另有逐项说明、认不出的词与不支持的说法，四个键都必填；指标起草沿用这个形状（#1162） */
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

/** 宽松 Schema（#959 兜底）：callModel 只发 response_format: json_object、模型看不到上面的 Schema，常把定义平铺在顶层
 *  （qwen-plus 必现），严格 Schema 会让一句话解析必然失败——也接受顶层有 base 或 measure 的平铺输出，收拢
 *  （normalizeParseOutput）后再按 METRIC_PARSE_SCHEMA 严格校验。必须是模块级常量：validatorFor 用 WeakMap 按对象缓存
 *  编译结果，每次调用新建对象会反复编译；指标起草也走它（#1162），定义在 DRAFTS 之前免得撞 TDZ */
export const METRIC_PARSE_LENIENT_SCHEMA = {
  anyOf: [METRIC_PARSE_SCHEMA, { type: 'object', anyOf: [{ required: ['base'] }, { required: ['measure'] }] }],
} as const;

/** 标签草稿的输出 Schema：标签定义（单指标或多指标写法），或「做不到」的原因（形状同一句话解析的 unsupported）；
 *  TAG_SCHEMA 不认额外键、必须有 rules / default，两支互斥。必须是模块级常量：validatorFor 用 WeakMap 按对象缓存编译结果 */
export const TAG_DRAFT_SCHEMA = {
  oneOf: [
    TAG_SCHEMA,
    {
      type: 'object',
      required: ['unsupported'],
      additionalProperties: false,
      properties: { unsupported: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } },
    },
  ],
} as const;

/** 可由模型生成的定义：输出 Schema、调用用途、system 提示词与目录里没东西可用时给成员的提示；
 *  指标走一句话解析的输出形状（#1162）：宽松 Schema 放行平铺输出，由调用方（dsl-definitions.ts）收拢后严格校验 */
const DRAFTS = {
  metric: { schema: METRIC_PARSE_LENIENT_SCHEMA, purpose: 'metric_draft', system: METRIC_DRAFT_SYSTEM, unavailable: () => null },
  tag: { schema: TAG_DRAFT_SCHEMA, purpose: 'tag_draft', system: TAG_SYSTEM, unavailable: tagUnavailable },
} satisfies Record<DslKind, { schema: object; purpose: LlmPurpose; system: string; unavailable: (catalog: Catalog) => string | null }>;

/** 模型输出必须符合的 JSON Schema 与调用用途 */
export const definitionDraftSchema = (kind: DslKind) => DRAFTS[kind].schema;
export const definitionDraftPurpose = (kind: DslKind) => DRAFTS[kind].purpose;

/** 排序出的条目的 Markdown，估算超过 SEARCH_TOKENS 时减少条数 */
function relevantMarkdown(hits: CatalogEntry[]): string {
  for (let n = hits.length; n > 0; n--) {
    const md = toMarkdown(hits.slice(0, n));
    if (estimateTokens(md) <= SEARCH_TOKENS) return md;
  }
  return toMarkdown([]);
}

/**
 * 发给模型的消息：system 是角色说明与该种类的能力说明，user 依次是目录分层上下文（第一层分组、相关分组的组内列表）、按需求搜出的条目与需求原文；
 * 条目由调用方经 catalog/draft-search.ts 排好传入（这里保持纯函数，不读库），只按 SEARCH_TOKENS 截断；
 * 目录里没有可用的东西时（如标签没有可引用的指标）返回提示，调用方不发请求
 */
export function definitionDraftMessages(kind: DslKind, request: string, catalog: Catalog, ranked: CatalogEntry[]): LlmMessage[] | { unavailable: string } {
  const { system, unavailable } = DRAFTS[kind];
  const hint = unavailable(catalog);
  if (hint) return { unavailable: hint };
  const user = [layeredContext(catalog, ranked, OVERVIEW_TOKENS), `# 与需求相关的条目\n\n${relevantMarkdown(ranked)}`, `# 需求\n\n${request}`].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 收拢平铺的解析输出（#959 兜底，纯函数、不校验）：有 spec 键原样返回；否则模型是把定义平铺在顶层，
 * 把 items / unknowns / unsupported 以外的键收进 spec、缺的列表补 []，由调用方再按 METRIC_PARSE_SCHEMA 严格校验
 */
export function normalizeParseOutput(raw: Record<string, unknown>): { output: unknown; normalized: boolean } {
  if ('spec' in raw) return { output: raw, normalized: false };
  const { items, unknowns, unsupported, ...spec } = raw;
  return { output: { spec, items: items ?? [], unknowns: unknowns ?? [], unsupported: unsupported ?? [] }, normalized: true };
}

/**
 * 一句话解析成指标表单（#516）发给模型的消息，结构与 definitionDraftMessages 相同：
 * system 是指标规则（共用）加解析说明，user 依次是目录分层上下文（第一层分组、相关分组的组内列表）、按句子搜出的条目与句子原文；
 * 条目由调用方经 catalog/draft-search.ts 排好传入（#853，与起草同一条检索），这里只按 SEARCH_TOKENS 截断
 */
export function metricParseMessages(sentence: string, catalog: Catalog, ranked: CatalogEntry[]): LlmMessage[] {
  const user = [layeredContext(catalog, ranked, OVERVIEW_TOKENS), `# 与需求相关的条目\n\n${relevantMarkdown(ranked)}`, `# 句子\n\n${sentence}`].join('\n\n');
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
