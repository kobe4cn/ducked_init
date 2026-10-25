// app/.server/pipeline/dsl/model-draft.ts —— 用模型按自然语言需求生成定义草稿（ADR-0035，纯函数，不读库、不发请求）：
// 每种可生成的定义给出模型必须遵守的输出 Schema（直接用该种类的定义 Schema）、调用用途、提示词与给模型的上下文；
// 上下文取自语义目录（ADR-0041）：system 是简短的角色说明加该种类的能力说明，user 是目录总览、用需求原文搜出的条目与需求原文。
// 目录里本就没有敏感字段、哈希列与明细行（ADR-0005），统计只有 ADR-0016 的常见取值。
// 模型输出转成 YAML（首行注释提示核对）后仍要过该种类的校验（DSL_KINDS[kind].check），保存与双人发布照旧
import { Document } from 'yaml';
import { CAPABILITIES } from '../../catalog/capabilities';
import { estimateTokens, overview, search, toMarkdown, type Catalog } from '../../catalog';
import type { LlmMessage, LlmPurpose } from '../../llm';
import { CONSUMER_ENTITY, METRIC_SCHEMA } from './metric-spec';
import type { DslKind } from './index';
import { SINGLE_TAG_SCHEMA } from './tag-spec';

/** 按需求搜出的条目最多几条 */
const SEARCH_LIMIT = 15;
/** 搜出的条目估算最多多少 token，超过时减少条数 */
const SEARCH_TOKENS = 6000;

const capability = (id: string) => toMarkdown(CAPABILITIES.find(c => c.id === id)!);

const METRIC_SYSTEM = [
  '你是 CRM 数据平台的指标助手：按成员的需求写一个指标定义，只输出一个符合给定 JSON Schema 的 JSON 对象（与下面 YAML 示例同样的结构），不要输出别的文字。',
  '成员的消息里依次是语义目录总览、按需求搜出的目录条目与需求原文。',
  '规则：',
  '- 只用目录里列出的实体、字段与关系，不要编造；目录里没有的字段（包括敏感字段）一律不要用。',
  '- sum / avg 只能用整数或小数字段；过滤取值按字段类型写，有取值列表的字段只能用其中的取值。',
  `- filter、measure、window 的字段也能写维度路径，但不能写 ${CONSUMER_ENTITY}.字段。`,
  '- count 数的是基础实体的行数：base 为 order_item 时数的是明细行，要数订单写 { "agg": "count_distinct", "field": "order_id" }。',
  '- 需求没提到的部分不要加；不要输出 device_attribution。',
  '',
  capability('capability:metric-dsl'),
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

/** 用需求原文搜出的条目（能力说明已在 system 里，不再给）的 Markdown，估算超过 SEARCH_TOKENS 时减少条数 */
function relevantMarkdown(catalog: Catalog, request: string): string {
  const hits = search(catalog, request, SEARCH_LIMIT + CAPABILITIES.length).filter(e => e.kind !== 'capability').slice(0, SEARCH_LIMIT);
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

/** 模型输出（已按 Schema 校验）转成定义 YAML，首行注释提示核对 */
export function definitionOutputToYaml(_kind: DslKind, output: object): string {
  const doc = new Document(output);
  doc.commentBefore = ' 模型根据需求生成，请核对';
  return doc.toString();
}
