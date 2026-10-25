// app/.server/pipeline/model-draft.ts —— 用模型生成映射草稿（ADR-0035，纯函数，不读库、不发请求）：给模型的提示词（表上下文 + 规则草稿作参考）、
// 模型必须遵守的输出 Schema（字段对应、值字典、去重键、身份打通规则，每项带置信度与理由），以及把模型输出转成映射 YAML：
// 以规则草稿为底，保留 table / entity / extensions 等其他顶层键，fields / dedupe / identity 整体换成模型给的，理由写成行尾注释。
// 转出的 YAML 仍要过映射校验（checkMappingDraft），保存、空跑与双人发布照旧。
// 传了语义目录（ADR-0041）时，user 前面加上目录总览、目标实体与它的各字段条目、按表名与列名搜出的条目，字段口径以目录为准；
// 不传时消息与原来一致（scripts/eval-mapping 照旧）。
// 另有断言建议：把表上下文与当前映射 YAML 发给模型，模型返回自定义断言列表（每条带置信度与理由），只换掉 YAML 的 assertions 块
import { Document, isCollection, isScalar, parseDocument, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { FUNCTIONS } from '../../lib/mapping-expr';
import { CAPABILITIES } from '../catalog/capabilities';
import { estimateTokens, expand, overview, search, toMarkdown, type Catalog, type CatalogEntry } from '../catalog';
import type { LlmMessage } from '../llm';
import type { AssertionLevel } from './assertions';
import { CUSTOM_CHECKS, type CustomAssertion } from './custom-assertions';
import type { TableContext } from './llm-context';

/** 每一项都带的置信度（0..1）与理由 */
interface Reasoned { confidence: number; reason: string }

export interface ModelField extends Reasoned {
  field: string;
  expr: string;
  dictionary?: { from: string; to: string }[];
  otherwise?: string | null;
  sensitive?: boolean;
}

export interface ModelDraft {
  fields: ModelField[];
  dedupe?: Reasoned & { key: string[]; latest?: string };
  identity?: Reasoned & { match: string[] };
}

/** 生成记录里的一项：path 是 fields.<字段>、dedupe、identity，断言建议时是 assertions.<序号> */
export interface DraftItem { path: string; confidence: number; reason: string }

const reasoned = {
  confidence: { type: 'number', minimum: 0, maximum: 1 },
  reason: { type: 'string', maxLength: 200 },
};
const names = { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } };

/** 模型输出必须符合的 JSON Schema（chatJson 按它校验） */
export const MODEL_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fields'],
  properties: {
    fields: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'expr', 'confidence', 'reason'],
        properties: {
          field: { type: 'string', minLength: 1 },
          expr: { type: 'string', minLength: 1 },
          dictionary: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } },
          },
          otherwise: { type: ['string', 'null'] },
          sensitive: { type: 'boolean' },
          ...reasoned,
        },
      },
    },
    dedupe: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'confidence', 'reason'],
      properties: { key: names, latest: { type: 'string', minLength: 1 }, ...reasoned },
    },
    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['match', 'confidence', 'reason'],
      properties: { match: names, ...reasoned },
    },
  },
} as const;

const SYSTEM = [
  '你是 CRM 数据平台的映射助手：把一张源表对应到一个目标实体，只输出一个 JSON 对象，不要输出别的文字。',
  '输入：entity 是目标实体名；table 是源表的结构与列统计（可能带几行敏感列已哈希的样本）；rulesDraft 是按规则生成的映射草稿（YAML），作为参考。',
  '输出格式：',
  '{ "fields": [{ "field": 目标字段名, "expr": 表达式, "dictionary"?: [{ "from": 源取值, "to": 标准取值 }], "otherwise"?: 兜底标准取值或 null, "sensitive"?: 布尔, "confidence": 0 到 1, "reason": 不超过 200 字的依据 }],',
  '  "dedupe"?: { "key": [字段名], "latest"?: 字段名, "confidence", "reason" },',
  '  "identity"?: { "match": [字段名，按优先级], "confidence", "reason" } }',
  '规则：',
  '- 表达式只能引用 table.columns 里的列名，写法与 rulesDraft 一致；只能用这些函数：',
  ...Object.values(FUNCTIONS).map(f => `  ${f.signature}：${f.label}`),
  '- 字段名用 rulesDraft 与目标实体里的字段名；拿不准的字段不要输出。',
  '- dictionary 只用于枚举字段，to 必须是该字段的标准取值；rulesDraft 里 sensitive: true 的列与敏感字段不要给 dictionary。',
  '- dedupe 只在去重键不是实体主键时给出，key 与 latest 必须是 fields 里的字段。',
  '- identity 只用于 customer 实体，match 必须是 fields 里映射出来的敏感字段（如 email、phone）。',
  '- confidence 表示你对这一项的把握，reason 用中文简要说明依据。',
].join('\n');

const CATALOG_SYSTEM = [
  '- 成员的消息里先是语义目录：总览、目标实体与它的各字段条目、按表名与列名搜出的条目，最后一行是上面说的输入（JSON）。',
  '- 字段口径以目录为准：字段的含义、标准取值与业务说明看目录里的字段条目；目录里没有的字段（包括敏感字段）照 rulesDraft 写。',
].join('\n');

/** 按表名与列名搜出的条目最多几条 */
const SEARCH_LIMIT = 10;
/** 搜出的条目估算最多多少 token，超过时减少条数 */
const SEARCH_TOKENS = 4000;

/** 目录各段：总览、目标实体与它的各字段条目、按「实体名 + 表名 + 列名」搜出的其余条目（不含能力说明，估算超过 SEARCH_TOKENS 时减少条数） */
function catalogMarkdown(catalog: Catalog, context: TableContext, entity: string): string {
  const target = [expand(catalog, `entity:${entity}`), ...catalog.entries.filter(e => e.kind === 'field' && e.entity === `entity:${entity}`)]
    .filter((e): e is CatalogEntry => e !== null);
  const shown = new Set(target.map(e => e.id));
  const query = [entity, context.table, ...context.columns.map(c => c.name)].join(' ');
  const related = search(catalog, query, SEARCH_LIMIT + shown.size + CAPABILITIES.length)
    .filter(e => e.kind !== 'capability' && !shown.has(e.id)).slice(0, SEARCH_LIMIT);
  let n = related.length;
  while (n > 0 && estimateTokens(toMarkdown(related.slice(0, n))) > SEARCH_TOKENS) n--;
  return [toMarkdown(overview(catalog)), `# 目标实体\n\n${toMarkdown(target)}`, `# 与源表相关的条目\n\n${toMarkdown(related.slice(0, n))}`].join('\n\n');
}

/**
 * 发给模型的消息：system 讲清输出格式与规则，user 是目标实体、表上下文与规则草稿（JSON）；
 * 传了目录时 system 加上以目录为准，user 前面加上目录各段，JSON 放在最后一行
 */
export function modelDraftMessages(context: TableContext, entity: string, rulesYaml: string, catalog?: Catalog): LlmMessage[] {
  const input = JSON.stringify({ entity, table: context, rulesDraft: rulesYaml });
  if (!catalog) return [{ role: 'system', content: SYSTEM }, { role: 'user', content: input }];
  return [
    { role: 'system', content: `${SYSTEM}\n${CATALOG_SYSTEM}` },
    { role: 'user', content: `${catalogMarkdown(catalog, context, entity)}\n\n# 起草输入\n${input}` },
  ];
}

/** 行尾注释：一行，去掉换行 */
const lineComment = (reason: string) => ` ${reason.replace(/\s+/g, ' ').trim()}`;

/** 一个字段的 YAML 节点：只有表达式时是标量，带值字典、兜底值或敏感标记时是对象；理由写在表达式的行尾注释（表单显示为「依据」） */
function fieldNode(doc: Document, f: ModelField) {
  const expr = new Scalar(f.expr);
  if (f.reason.trim()) expr.comment = lineComment(f.reason);
  if (!f.dictionary && f.otherwise === undefined && f.sensitive === undefined) return expr;
  const spec = new YAMLMap();
  spec.set('expr', expr);
  if (f.dictionary) spec.set('dictionary', doc.createNode(Object.fromEntries(f.dictionary.map(d => [d.from, d.to]))));
  if (f.otherwise !== undefined) spec.set('otherwise', f.otherwise);
  if (f.sensitive !== undefined) spec.set('sensitive', f.sensitive);
  return spec;
}

/** 字段名列表的节点：单行写法，理由写在行尾 */
function namesNode(doc: Document, list: string[], reason: string) {
  const node = doc.createNode(list);
  node.flow = true;
  if (reason.trim()) node.comment = lineComment(reason);
  return node;
}

/**
 * 模型输出 → 映射 YAML 与生成记录的各项。以规则草稿为底：保留 fields / dedupe / identity 以外的顶层键（table、entity、extensions 等），
 * 这三项整体换成模型给的（没给 dedupe / identity 时删掉）；dictionary 数组转成 { 源取值: 标准取值 }。
 * 规则草稿的首尾注释讲的是规则的依据，换成模型草稿的说明
 */
export function modelOutputToYaml(rulesYaml: string, out: ModelDraft): { yaml: string; items: DraftItem[] } {
  const doc = parseDocument(rulesYaml);
  const items: DraftItem[] = [];
  const fields = new YAMLMap();
  for (const f of out.fields) {
    fields.set(f.field, fieldNode(doc, f));
    items.push({ path: `fields.${f.field}`, confidence: f.confidence, reason: f.reason });
  }
  doc.set('fields', fields);

  if (out.dedupe) {
    const dedupe = new YAMLMap();
    dedupe.set('key', namesNode(doc, out.dedupe.key, out.dedupe.reason));
    if (out.dedupe.latest) dedupe.set('latest', out.dedupe.latest);
    doc.set('dedupe', dedupe);
    items.push({ path: 'dedupe', confidence: out.dedupe.confidence, reason: out.dedupe.reason });
  } else doc.delete('dedupe');

  if (out.identity) {
    const identity = new YAMLMap();
    identity.set('match', namesNode(doc, out.identity.match, out.identity.reason));
    doc.set('identity', identity);
    items.push({ path: 'identity', confidence: out.identity.confidence, reason: out.identity.reason });
  } else doc.delete('identity');

  // 规则草稿的头注释重新解析后可能挂在文档、根节点或第一个键上
  const root = doc.contents as YAMLMap;
  root.commentBefore = null;
  const first = root.items[0]?.key;
  if (isScalar(first)) first.commentBefore = null;
  doc.commentBefore = ' 模型生成的草稿：行尾注释是模型给的依据，请逐项确认后保存';
  doc.comment = null;
  return { yaml: doc.toString({ nullStr: 'null', lineWidth: 0 }), items };
}

/** 模型建议的一条断言：写法同映射 YAML 的 assertions，另带置信度与理由 */
export type ModelAssertion = CustomAssertion & Reasoned;
export interface AssertionDraft { assertions: ModelAssertion[] }

const LEVELS: AssertionLevel[] = ['error', 'warn'];

/** 断言建议的输出 Schema（chatJson 按它校验）；min / max / values 与检查是否相配、字段是否映射出来由映射校验把关 */
export const ASSERTION_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['assertions'],
  properties: {
    assertions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'check', 'level', 'confidence', 'reason'],
        properties: {
          field: { type: 'string', minLength: 1 },
          check: { enum: [...CUSTOM_CHECKS] },
          level: { enum: LEVELS },
          min: { type: ['number', 'string'] },
          max: { type: ['number', 'string'] },
          values: { type: 'array', minItems: 1, items: { type: 'string' } },
          ...reasoned,
        },
      },
    },
  },
} as const;

const ASSERTION_SYSTEM = [
  '你是 CRM 数据平台的数据质量助手：为一个映射建议自定义断言，只输出一个 JSON 对象，不要输出别的文字。',
  '输入：table 是源表的结构与列统计（nullRate 空值率、distinct 不同值个数、min / max、top 常见取值；可能带几行敏感列已哈希的样本）；mapping 是当前的映射 YAML。',
  '输出格式：',
  '{ "assertions": [{ "field": 目标字段名, "check": "not_null" | "unique" | "range" | "in", "level": "error" | "warn", "min"?: 下限, "max"?: 上限, "values"?: [取值], "confidence": 0 到 1, "reason": 不超过 200 字的依据 }] }',
  '规则：',
  '- field 只能用 mapping 的 fields 与 extensions 里映射出来的字段名；同一字段的同一种检查只写一条。',
  '- 敏感字段（sensitive: true，或 email、phone 等身份字段）标准层只存哈希，只能用 not_null 或 unique。',
  '- range 只用于数值、日期或时间字段，至少给 min 或 max；数值字段写数字，日期与时间字段写日期文本（如 2024-01-01），min 不大于 max。',
  '- in 只用于文本字段，values 是该字段的标准取值（枚举字段写标准取值，不是源取值）。',
  '- 优先依据列统计：空值率为 0 的列可以 not_null，distinct 等于行数的列可以 unique，min / max 给 range，top 覆盖了全部取值时给 in。',
  '- 拿不准的用 warn，确定违反就是数据错误的才用 error；拿不准的断言不要输出。',
  '- confidence 表示你对这一条的把握，reason 用中文简要说明依据。',
].join('\n');

/** 断言建议发给模型的消息：system 讲清输出格式与规则，user 是表上下文与当前映射 YAML */
export function assertionDraftMessages(context: TableContext, yaml: string): LlmMessage[] {
  return [
    { role: 'system', content: ASSERTION_SYSTEM },
    { role: 'user', content: JSON.stringify({ table: context, mapping: yaml }) },
  ];
}

/**
 * 模型建议的断言 → 映射 YAML 与生成记录的各项：只换掉 assertions 块（模型没给断言时删掉），其余键与注释原样保留；
 * 每条写成单行对象，理由写成行尾注释，不带置信度与理由字段
 */
export function assertionsToYaml(yaml: string, out: AssertionDraft): { yaml: string; items: DraftItem[] } {
  const doc = parseDocument(yaml);
  const items: DraftItem[] = [];
  const old = doc.get('assertions', true);
  // 文档末尾的注释可能挂在原来的 assertions 块上
  const trailing = isCollection(old) ? old.comment : null;
  if (out.assertions.length) {
    const seq = new YAMLSeq();
    out.assertions.forEach(({ confidence, reason, ...a }, i) => {
      const node = doc.createNode(a);
      node.flow = true;
      if (reason.trim()) node.comment = lineComment(reason);
      seq.items.push(node);
      items.push({ path: `assertions.${i}`, confidence, reason });
    });
    seq.comment = trailing ?? null;
    doc.set('assertions', seq);
  } else {
    doc.delete('assertions');
    if (trailing) doc.comment = doc.comment ? `${doc.comment}\n${trailing}` : trailing;
  }
  return { yaml: doc.toString({ nullStr: 'null', lineWidth: 0 }), items };
}
