// app/.server/pipeline/model-draft.ts —— 用模型生成映射草稿（ADR-0035，纯函数，不读库、不发请求）：给模型的提示词（表上下文 + 规则草稿作参考）、
// 模型必须遵守的输出 Schema（字段对应、值字典、去重键、身份打通规则，每项带置信度与理由），以及把模型输出转成映射 YAML：
// 以规则草稿为底，保留 table / entity / extensions 等其他顶层键，fields / dedupe / identity 整体换成模型给的，理由写成行尾注释。
// 转出的 YAML 仍要过映射校验（checkMappingDraft），保存、空跑与双人发布照旧
import { Document, isScalar, parseDocument, Scalar, YAMLMap } from 'yaml';
import { FUNCTIONS } from '../../lib/mapping-expr';
import type { LlmMessage } from '../llm';
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

/** 生成记录里的一项：path 是 fields.<字段>、dedupe 或 identity */
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

/** 发给模型的消息：system 讲清输出格式与规则，user 是目标实体、表上下文与规则草稿 */
export function modelDraftMessages(context: TableContext, entity: string, rulesYaml: string): LlmMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify({ entity, table: context, rulesDraft: rulesYaml }) },
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
