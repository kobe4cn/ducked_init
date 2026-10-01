// app/.server/pipeline/mapping-spec.ts —— 映射文档（YAML）：一张源表 → 一个标准实体（或自定义实体）。
// 先按 JSON Schema（MAPPING_SCHEMA）校验结构，再对照标准模型与源表的字段做语义校验：字段表达式只能用白名单函数、只能引用源表里有的字段，
// 值字典只能对应到标准枚举，去重键与取最新字段必须是映射出来的字段。每个问题都带 YAML 里的行列位置。
// 校验通过后得到合并计划（MergePlan）：标准层的列、每列的表达式与值字典、去重键与取最新字段，交给工作进程编译执行（ADR-0015）
import { Ajv, type ErrorObject } from 'ajv';
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document, type Node } from 'yaml';
import {
  CANONICAL_ENTITIES, CUSTOM_FIELD_PATTERN, entityOf, EXTENSION_PATTERN, FIELD_TYPE_NAMES, FIELD_TYPES, isCustomEntity, MODEL_MAJOR, type FieldType,
} from '../../lib/canonical-model';
import { ExprError, parseExpression, referencedColumns } from './mapping-expr';

/** 字段的写法：表达式本身，或带值字典的对象 */
export type FieldSpec = string | { expr: string; dictionary?: Record<string, string> };

export interface MappingSpec {
  /** 标准模型的大版本 */
  model: number;
  entity: string;
  /** 源表（数据源里的表名，与同步范围里的一致） */
  table: string;
  description?: string;
  fields?: Record<string, FieldSpec>;
  /** 扩展字段（标准实体上以 x_ 开头）或自定义实体的全部字段：带类型 */
  extensions?: Record<string, { type: FieldType; expr: string; label?: string; dictionary?: Record<string, string> }>;
  /** 去重键与取最新规则：同一去重键的多行只留一行，取最新字段最大的那行。不写时按实体主键去重 */
  dedupe?: { key: string[]; latest?: string };
}

const fieldSpec = {
  type: ['string', 'object'],
  minLength: 1,
  if: { type: 'object' },
  then: {
    required: ['expr'],
    additionalProperties: false,
    properties: {
      expr: { type: 'string', minLength: 1 },
      dictionary: { type: 'object', minProperties: 1, additionalProperties: { type: 'string', minLength: 1 } },
    },
  },
};

/** 映射文档的 JSON Schema（模型起草映射时也用它约束输出） */
export const MAPPING_SCHEMA = {
  type: 'object',
  required: ['model', 'entity', 'table'],
  additionalProperties: false,
  properties: {
    model: { const: MODEL_MAJOR },
    entity: { type: 'string', minLength: 1 },
    table: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    fields: { type: 'object', additionalProperties: fieldSpec },
    extensions: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['type', 'expr'],
        additionalProperties: false,
        properties: {
          type: { enum: FIELD_TYPE_NAMES },
          expr: { type: 'string', minLength: 1 },
          label: { type: 'string' },
          dictionary: { type: 'object', minProperties: 1, additionalProperties: { type: 'string', minLength: 1 } },
        },
      },
    },
    dedupe: {
      type: 'object',
      required: ['key'],
      additionalProperties: false,
      properties: {
        key: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
        latest: { type: 'string', minLength: 1 },
      },
    },
  },
} as const;

const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(MAPPING_SCHEMA);

/** 映射里的一个问题：行列从 1 起（YAML 解析失败时也有），path 是出问题的位置（如 fields.status.dictionary） */
export interface MappingIssue { line: number; col: number; path: string; message: string }

/** 标准层里的一列：类型、表达式、值字典与标准枚举 */
export interface PlanColumn { name: string; type: FieldType; expr: string; dictionary?: Record<string, string>; enum?: readonly string[] }

/** 合并计划：工作进程据此把源表的变更批次合并到标准层（MergeMappingParam 再加上映射与版本） */
export interface MergePlan {
  entity: string;
  table: string;
  /** 映射出来的列 */
  columns: PlanColumn[];
  /** 标准层表应有的全部列：标准实体的全部字段（没映射的为空）加上本映射的扩展字段 */
  entityColumns: { name: string; type: FieldType }[];
  /** 去重键（映射出来的列） */
  key: string[];
  /** 取最新字段：同一去重键取它最大的一行；为空时取最近同步到的一行 */
  latest: string | null;
}

export type MappingCheck = { ok: true; spec: MappingSpec; plan: MergePlan } | { ok: false; issues: MappingIssue[] };

/**
 * 源表的字段：表不能用于映射时返回原因（不在同步范围、还没采集等）。
 * 不给时不检查源表（工作进程里只编译，不再对照）
 */
export type SourceColumns = (table: string) => string[] | string;

type Path = (string | number)[];

const TYPE_LABELS: Record<string, string> = { string: '文本', object: '对象（键: 值）', array: '列表', number: '数字', integer: '整数', boolean: '布尔' };

/** 把 Ajv 的错误译成中文，返回出问题的路径与说明 */
function describeSchemaError(e: ErrorObject): { path: Path; message: string } | null {
  const path: Path = e.instancePath.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case 'if': return null;
    case 'required': return { path, message: `缺少 ${p.missingProperty}` };
    case 'additionalProperties': return { path: [...path, String(p.additionalProperty)], message: `不认识的项 ${p.additionalProperty}` };
    case 'type': return { path, message: `应为${String(p.type).split(',').map(t => TYPE_LABELS[t] ?? t).join('或')}` };
    case 'const': return { path, message: `应为 ${p.allowedValue}（标准模型 v${MODEL_MAJOR}）` };
    case 'enum': return { path, message: `应为以下之一：${(p.allowedValues as string[]).join('、')}` };
    case 'minLength': case 'minItems': case 'minProperties': return { path, message: '不能为空' };
    case 'uniqueItems': return { path, message: '不能有重复项' };
    default: return { path, message: e.message ?? e.keyword };
  }
}

/** 行列定位：path 指向的节点（键不存在时退到最近的上级）；atKey 为真时指向键而不是值 */
function locator(doc: Document, lines: LineCounter) {
  return (path: Path, atKey = false) => {
    let node: unknown = doc.contents;
    let at: [number, number] | undefined = (doc.contents as Node | null)?.range?.slice(0, 2) as [number, number] | undefined;
    for (let i = 0; i < path.length; i++) {
      const last = i === path.length - 1;
      if (isMap(node)) {
        const pair = node.items.find(it => (isScalar(it.key) ? String(it.key.value) : String(it.key)) === String(path[i]));
        if (!pair) break;
        const target = last && atKey ? pair.key : pair.value;
        const range = (target as Node | null)?.range ?? (pair.key as Node | null)?.range;
        if (range) at = [range[0], range[1]];
        node = pair.value;
      } else if (isSeq(node)) {
        const item = node.items[Number(path[i])] as Node | undefined;
        if (!item) break;
        if (item.range) at = [item.range[0], item.range[1]];
        node = item;
      } else {
        break;
      }
    }
    return lines.linePos(at?.[0] ?? 0);
  };
}

const ISSUE_ORDER = (a: MappingIssue, b: MappingIssue) => a.line - b.line || a.col - b.col;

/**
 * 校验映射文档：YAML 语法、JSON Schema、对照标准模型与源表字段的语义检查。
 * 通过时返回规范化后的文档与合并计划，否则返回全部问题（按位置排序）
 */
export function checkMapping(text: string, sourceColumns?: SourceColumns): MappingCheck {
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
  const issues: MappingIssue[] = [];
  const issue = (path: Path, message: string, { atKey = false, offset = 0 } = {}) => {
    const { line, col } = at(path, atKey);
    issues.push({ line, col: col + offset, path: path.join('.'), message });
  };

  const value = doc.toJS() as unknown;
  if (!validateSchema(value)) {
    const seen = new Set<string>();
    for (const e of validateSchema.errors ?? []) {
      const d = describeSchemaError(e);
      if (!d || seen.has(`${d.path.join('.')}|${d.message}`)) continue;
      seen.add(`${d.path.join('.')}|${d.message}`);
      issue(d.path, d.message, { atKey: e.keyword === 'additionalProperties' });
    }
    return { ok: false, issues: issues.sort(ISSUE_ORDER) };
  }
  const spec = value as MappingSpec;
  const entity = entityOf(spec.entity);
  const custom = isCustomEntity(spec.entity);
  if (!entity && !custom) {
    issue(['entity'], `不认识的实体 ${spec.entity}（标准实体：${CANONICAL_ENTITIES.map(e => e.name).join('、')}；自定义实体以 custom_ 开头）`);
    return { ok: false, issues };
  }

  // 源表与它的字段
  let columns: Set<string> | null = null;
  if (sourceColumns) {
    const listed = sourceColumns(spec.table);
    if (typeof listed === 'string') issue(['table'], listed);
    else columns = new Set(listed);
  }

  /** 校验一个表达式，返回其文本；表达式在 YAML 字符串里的位置按引号偏移一列 */
  const checkExpr = (path: Path, expr: string) => {
    const node = doc.getIn(path, true) as { type?: string } | undefined;
    const quote = node?.type === 'QUOTE_DOUBLE' || node?.type === 'QUOTE_SINGLE' ? 1 : 0;
    try {
      const parsed = parseExpression(expr);
      for (const c of referencedColumns(parsed)) {
        if (columns && !columns.has(c.name)) issue(path, `源表 ${spec.table} 中没有字段 ${c.name}`, { offset: quote + c.offset });
      }
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      issue(path, `表达式错误：${e.message}`, { offset: quote + e.offset });
    }
  };

  const planned: PlanColumn[] = [];
  const checkDictionary = (path: Path, type: FieldType, dictionary: Record<string, string> | undefined, allowed?: readonly string[]) => {
    if (!dictionary) return;
    if (type !== 'string') issue([...path, 'dictionary'], '值字典只能用于文本字段', { atKey: true });
    for (const [from, to] of Object.entries(dictionary)) {
      if (allowed && !allowed.includes(to)) issue([...path, 'dictionary', from], `${to} 不是标准枚举值（可选：${allowed.join('、')}）`);
    }
  };

  if (custom && spec.fields && Object.keys(spec.fields).length) {
    issue(['fields'], '自定义实体没有标准字段，请把字段写在 extensions 里（带类型）', { atKey: true });
  }
  for (const [name, raw] of Object.entries(spec.fields ?? {})) {
    const field = entity?.fields.find(f => f.name === name);
    if (!field) {
      if (entity) issue(['fields', name], `${entity.label}（${entity.name}）没有标准字段 ${name}；租户特有的字段请写在 extensions 里，以 x_ 开头`, { atKey: true });
      continue;
    }
    const { expr, dictionary } = typeof raw === 'string' ? { expr: raw, dictionary: undefined } : raw;
    checkExpr(typeof raw === 'string' ? ['fields', name] : ['fields', name, 'expr'], expr);
    checkDictionary(['fields', name], field.type, dictionary, field.enum);
    planned.push({ name, type: field.type, expr, ...(dictionary && { dictionary }), ...(field.enum && { enum: field.enum }) });
  }
  const extensionName = new RegExp(custom ? CUSTOM_FIELD_PATTERN : EXTENSION_PATTERN);
  for (const [name, ext] of Object.entries(spec.extensions ?? {})) {
    if (!extensionName.test(name)) {
      issue(['extensions', name], custom
        ? `字段名 ${name} 只能用小写字母、数字与下划线，以字母开头`
        : `扩展字段 ${name} 必须以 x_ 开头（只用小写字母、数字与下划线），避免与标准字段重名`, { atKey: true });
      continue;
    }
    checkExpr(['extensions', name, 'expr'], ext.expr);
    checkDictionary(['extensions', name], ext.type, ext.dictionary);
    planned.push({ name, type: ext.type, expr: ext.expr, ...(ext.dictionary && { dictionary: ext.dictionary }) });
  }
  if (!planned.length) issue(spec.fields ? ['fields'] : [], '至少要映射一个字段');

  // 去重键与取最新字段：必须是映射出来的字段
  const mapped = new Map(planned.map(c => [c.name, c]));
  const key = [...(spec.dedupe?.key ?? entity?.key ?? [])];
  if (!spec.dedupe && custom) issue([], '自定义实体必须声明去重键 dedupe.key');
  key.forEach((k, i) => {
    if (mapped.has(k)) return;
    if (spec.dedupe) issue(['dedupe', 'key', i], `去重键 ${k} 不是本映射映射出来的字段`);
    else issue(['fields'], `没有映射${entity!.label}的主键 ${k}：请映射它，或在 dedupe.key 里声明去重键`, { atKey: true });
  });
  const latest = spec.dedupe?.latest ?? null;
  if (latest) {
    const c = mapped.get(latest);
    if (!c) issue(['dedupe', 'latest'], `取最新字段 ${latest} 不是本映射映射出来的字段`);
    else if (c.type === 'string' || c.type === 'boolean') issue(['dedupe', 'latest'], `取最新字段 ${latest} 应为时间、日期或数字`);
  }

  if (issues.length) return { ok: false, issues: issues.sort(ISSUE_ORDER) };
  const extensions = Object.entries(spec.extensions ?? {}).map(([name, e]) => ({ name, type: e.type }));
  return {
    ok: true,
    spec,
    plan: {
      entity: spec.entity,
      table: spec.table,
      columns: planned,
      entityColumns: [...(entity?.fields.map(f => ({ name: f.name, type: f.type })) ?? []), ...extensions],
      key,
      latest,
    },
  };
}

/** 标准层列的 DuckDB 类型 */
export const sqlType = (type: FieldType) => FIELD_TYPES[type].sql;

/** 新建映射时的样例文档 */
export function mappingTemplate(entityName: string, table: string) {
  const entity = entityOf(entityName) ?? CANONICAL_ENTITIES[0];
  const fields = entity.fields.slice(0, 4).map(f => `  ${f.name}: ${f.name}${f.enum ? `  # 标准枚举：${f.enum.join('、')}` : ''}`).join('\n');
  return `# 映射：源表 ${table} → ${entity.label}（${entity.name}）
model: ${MODEL_MAJOR}
entity: ${entity.name}
table: ${table}
fields:
${fields}
dedupe:
  key: [${entity.key.join(', ')}]
`;
}
