// app/.server/pipeline/mapping-spec.ts —— 映射文档（YAML）：一张源表 → 一个标准实体（或自定义实体）。
// 先按 JSON Schema（MAPPING_SCHEMA）校验结构，再对照标准模型与源表的字段做语义校验：字段表达式只能用白名单函数、只能引用源表里有的字段，
// 值字典与兜底值只能对应到标准枚举，去重键与取最新字段必须是映射出来的字段。每个问题都带 YAML 里的行列位置，常见错误还附上改好的写法（hint）。
// 校验通过后得到合并计划（MergePlan）：标准层的列、每列的表达式与值字典、去重键与取最新字段，交给工作进程编译执行（ADR-0015）
import { Ajv, type ErrorObject } from 'ajv';
import { Document, isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLMap } from 'yaml';
import {
  CANONICAL_ENTITIES, CUSTOM_FIELD_PATTERN, entityOf, EXTENSION_PATTERN, FIELD_TYPE_NAMES, FIELD_TYPES, isCustomEntity, MODEL_MAJOR,
  type CanonicalEntity, type CanonicalField, type FieldType,
} from '../../lib/canonical-model';
import { fieldsForColumn, normalizeName, similarFields, similarNames, standardValue } from '../../lib/field-synonyms';
import { ExprError, FUNCTIONS, KIND_FIELD_TYPES, kindOf, parseExpression, ref, referencedColumns, type Expr } from '../../lib/mapping-expr';

/** 字段的写法：表达式本身，或带值字典（与兜底值）的对象 */
export type FieldSpec = string | { expr: string; dictionary?: Record<string, string>; otherwise?: string | null };

export interface MappingSpec {
  /** 标准模型的大版本 */
  model: number;
  entity: string;
  /** 源表（数据源里的表名，与同步范围里的一致） */
  table: string;
  description?: string;
  fields?: Record<string, FieldSpec>;
  /** 扩展字段（标准实体上以 x_ 开头）或自定义实体的全部字段：带类型 */
  extensions?: Record<string, { type: FieldType; expr: string; label?: string; dictionary?: Record<string, string>; otherwise?: string | null }>;
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
      otherwise: { type: ['string', 'null'], minLength: 1 },
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
          otherwise: { type: ['string', 'null'], minLength: 1 },
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

/**
 * 映射里的一个问题：行列从 1 起（YAML 解析失败时也有），path 是出问题的位置（如 fields.status.dictionary）；
 * hint 是改好的写法（可直接粘贴的 YAML，可能多行），能给出时才有
 */
export interface MappingIssue { line: number; col: number; path: string; message: string; hint?: string }

/**
 * 标准层里的一列：类型、表达式、值字典与标准枚举。
 * otherwise 是兜底值：值字典里没有（或没有值字典时不是标准枚举）的取值写成它，null 表示写成空；不写时这样的取值让合并失败
 */
export interface PlanColumn { name: string; type: FieldType; expr: string; dictionary?: Record<string, string>; enum?: readonly string[]; otherwise?: string | null }

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
export type SourceColumns = (table: string) => SourceColumn[] | string;

/** 源表的一列：名称与源端类型（DuckDB 类型名，如 BIGINT、VARCHAR） */
export interface SourceColumn { name: string; type: string }

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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 扩展字段的类型：标准层的类型名原样返回，源端的数据库类型（DECIMAL(12,2)、VARCHAR）换算成标准层的类型 */
function fieldTypeOf(type: unknown): FieldType {
  const t = String(type ?? '').trim();
  return (FIELD_TYPE_NAMES as string[]).includes(t.toLowerCase()) ? (t.toLowerCase() as FieldType) : KIND_FIELD_TYPES[kindOf(t)];
}

/** 按扩展字段的写法整理（只留 type、expr、label、dictionary、otherwise；有值字典时只能是文本） */
function asExtension(raw: Record<string, unknown>) {
  const dictionary = isRecord(raw.dictionary) ? raw.dictionary : undefined;
  return {
    type: dictionary ? 'string' : fieldTypeOf(raw.type),
    expr: typeof raw.expr === 'string' ? raw.expr : '源列',
    ...(typeof raw.label === 'string' && { label: raw.label }),
    ...(dictionary && { dictionary }),
    ...((typeof raw.otherwise === 'string' || raw.otherwise === null) && { otherwise: raw.otherwise }),
  };
}

/** 改好的写法：flow 里的路径写成行内形式（如 { type: string, expr: x }） */
function snippet(value: Record<string, unknown>, flow: Path[] = []) {
  const doc = new Document(value);
  for (const p of flow) (doc.getIn(p, true) as YAMLMap).flow = true;
  return doc.toString({ lineWidth: 0, singleQuote: true }).trimEnd();
}

/** 推断表达式的类型（给扩展字段的写法填类型）：源列按源端类型，函数按返回值，四则运算按数字 */
function inferType(expr: Expr, columnType: (name: string) => string | undefined): FieldType {
  switch (expr.kind) {
    case 'column': {
      const t = columnType(expr.name);
      return t ? KIND_FIELD_TYPES[kindOf(t)] : 'string';
    }
    case 'literal':
      if (expr.text !== undefined || expr.sql === 'NULL') return 'string';
      if (/^(TRUE|FALSE)$/i.test(expr.sql)) return 'boolean';
      return /^\d+$/.test(expr.sql) ? 'integer' : 'decimal';
    case 'call':
      return FUNCTIONS[expr.fn]?.returns ?? (expr.args[0] ? inferType(expr.args[0], columnType) : 'string');
    case 'neg':
      return inferType(expr.arg, columnType);
    case 'binary': {
      if (expr.op === '/') return 'decimal';
      const both = [inferType(expr.left, columnType), inferType(expr.right, columnType)];
      return both.every(t => t === 'integer') ? 'integer' : 'decimal';
    }
  }
}

/** 字段的写法拆成表达式、值字典与兜底值 */
const fieldParts = (raw: FieldSpec): Exclude<FieldSpec, string> => (typeof raw === 'string' ? { expr: raw } : raw);

/** 写了兜底值时（包括写成 null）带进合并计划；YAML 里的 null 要保留，不能与没写混为一谈 */
const otherwiseOf = (raw: { otherwise?: string | null }) => (Object.hasOwn(raw, 'otherwise') ? { otherwise: raw.otherwise! } : {});

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
  const issue = (path: Path, message: string, { atKey = false, offset = 0, hint }: { atKey?: boolean; offset?: number; hint?: string } = {}) => {
    const { line, col } = at(path, atKey);
    issues.push({ line, col: col + offset, path: path.join('.'), message, ...(hint && { hint }) });
  };

  const value = doc.toJS() as unknown;
  if (!validateSchema(value)) {
    // 两种常见写错先整条给出改法，不再逐项报 Schema 的错（行内写法里 DECIMAL(12,2) 的逗号还会拆出一个叫 2) 的键）：
    // fields 下写了带 type 的扩展字段；扩展字段的 type 写成了源端的数据库类型
    const rewritten: string[] = [];
    const root = isRecord(value) ? value : {};
    for (const [name, raw] of Object.entries(isRecord(root.fields) ? root.fields : {})) {
      if (!isRecord(raw) || !('type' in raw)) continue;
      rewritten.push(`fields.${name}`);
      const extName = name.startsWith('x_') ? name : `x_${normalizeName(name)}`;
      issue(['fields', name], `${name} 带了类型，是扩展字段：请移到 extensions 下${extName === name ? '' : '，以 x_ 开头'}`, {
        atKey: true, hint: snippet({ extensions: { [extName]: asExtension(raw) } }, [['extensions', extName]]),
      });
    }
    for (const [name, raw] of Object.entries(isRecord(root.extensions) ? root.extensions : {})) {
      if (!isRecord(raw) || raw.type === undefined || (FIELD_TYPE_NAMES as unknown[]).includes(raw.type)) continue;
      rewritten.push(`extensions.${name}`);
      const types = FIELD_TYPE_NAMES.map(t => `${t}（${FIELD_TYPES[t].label}）`).join('、');
      issue(['extensions', name, 'type'], `类型要写标准层的类型：${types}，不是源端的数据库类型；这里应为 ${fieldTypeOf(raw.type)}`, {
        hint: snippet({ [name]: asExtension(raw) }, [[name]]),
      });
    }
    const seen = new Set<string>();
    for (const e of validateSchema.errors ?? []) {
      const d = describeSchemaError(e);
      const at = d?.path.join('.');
      if (!d || rewritten.some(p => at === p || at!.startsWith(`${p}.`)) || seen.has(`${at}|${d.message}`)) continue;
      seen.add(`${at}|${d.message}`);
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
  let columns: Map<string, string> | null = null;
  if (sourceColumns) {
    const listed = sourceColumns(spec.table);
    if (typeof listed === 'string') issue(['table'], listed);
    else columns = new Map(listed.map(c => [c.name, c.type]));
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
  /** 值字典：只能用于文本字段，标准字段的只能对应到标准枚举。fixedType 是用于非文本字段时改好的写法（扩展字段改成文本，标准字段去掉值字典） */
  const checkDictionary = (path: Path, type: FieldType, dictionary: Record<string, string> | undefined, fixedType: () => string, standard?: CanonicalField) => {
    if (!dictionary) return;
    if (type !== 'string') issue([...path, 'dictionary'], '值字典只能用于文本字段', { atKey: true, hint: fixedType() });
    const allowed = standard?.enum;
    for (const [from, to] of Object.entries(dictionary)) {
      if (!allowed || allowed.includes(to)) continue;
      const value = standardValue(spec.entity, standard.name, to) ?? standardValue(spec.entity, standard.name, from);
      issue([...path, 'dictionary', from], `${to} 不是标准枚举值（可选：${allowed.join('、')}）`, { hint: value && snippet({ [from]: value }) });
    }
  };
  /** 兜底值：只有值字典或标准枚举能判断“没对应上”的取值；标准字段的兜底值只能是标准枚举（或 null） */
  const checkOtherwise = (path: Path, raw: { otherwise?: string | null }, dictionary: Record<string, string> | undefined, standard?: CanonicalField) => {
    if (!Object.hasOwn(raw, 'otherwise')) return;
    const otherwise = raw.otherwise!;
    const allowed = standard?.enum;
    if (!dictionary && !allowed) {
      issue([...path, 'otherwise'], '兜底值只能用于有值字典或标准枚举的字段：这个字段没有值字典，不知道哪些取值算没对应上', { atKey: true });
    } else if (otherwise !== null && allowed && !allowed.includes(otherwise)) {
      const value = standardValue(spec.entity, standard.name, otherwise);
      issue([...path, 'otherwise'], `${otherwise} 不是标准枚举值（可选：${allowed.join('、')}，或 null）`, { hint: value && snippet({ otherwise: value }) });
    }
  };

  /** fields 下写了标准模型里没有的字段：按右边的源列名、去掉 x_ 的名字（同名、同义词、相近）猜该写的标准字段，x_ 开头的附上扩展字段的写法 */
  const reportUnknownField = (entity: CanonicalEntity, name: string, raw: FieldSpec) => {
    const parts = fieldParts(raw);
    const { expr, dictionary } = parts;
    let parsed: Expr | null = null;
    try { parsed = parseExpression(expr); } catch (e) { if (!(e instanceof ExprError)) throw e; }
    const refs = parsed ? referencedColumns(parsed).map(c => c.name) : [];
    const bare = name.replace(/^x_/, '');
    const guess = [
      ...refs.flatMap(c => fieldsForColumn(entity.name, c)).map(m => m.field),
      ...fieldsForColumn(entity.name, bare).map(m => m.field),
      ...similarFields(entity.name, bare),
      ...refs.flatMap(c => similarFields(entity.name, c)),
    ].find(f => !(f in spec.fields!));
    const extension = name.startsWith('x_');
    const extName = extension ? name : `x_${normalizeName(name)}`;
    const type = dictionary ? 'string' : parsed ? inferType(parsed, c => columns?.get(c)) : 'string';
    const asExtension = snippet({
      extensions: { [extName]: { type, expr, ...(dictionary && { dictionary, ...otherwiseOf(parts) }) } },
    }, [['extensions', extName]]);
    const prefix = `${entity.label}（${entity.name}）没有标准字段 ${name}`;
    if (guess) {
      const label = entity.fields.find(f => f.name === guess)!.label;
      const asField = snippet({ [guess]: raw }, typeof raw === 'string' ? [] : [[guess]]);
      issue(['fields', name], extension
        ? `${prefix}：是不是想写 ${guess}（${label}）？若是租户特有的字段，请移到 extensions 下并带类型`
        : `${prefix}：是不是想写 ${guess}（${label}）？`, { atKey: true, hint: extension ? `${asField}\n# 或作为扩展字段：\n${asExtension}` : asField });
    } else if (extension) {
      issue(['fields', name], `${prefix}；以 x_ 开头的扩展字段请移到 extensions 下并带类型`, { atKey: true, hint: asExtension });
    } else {
      issue(['fields', name], `${prefix}；租户特有的字段请写在 extensions 里，以 x_ 开头`, { atKey: true, hint: asExtension });
    }
  };

  /** 源表里能对应到标准字段 name 的列（按同名、同义词优先级），写成该字段的表达式 */
  const columnFor = (entity: CanonicalEntity, name: string) => {
    if (!columns) return undefined;
    const [best] = [...columns]
      .flatMap(([col, type]) => fieldsForColumn(entity.name, col).filter(m => m.field === name).map(m => ({ col, type, rank: m.rank })))
      .sort((a, b) => a.rank - b.rank);
    if (!best) return undefined;
    const field = entity.fields.find(f => f.name === name)!;
    return field.type === 'string' && kindOf(best.type) !== 'text' ? `string(${ref(best.col)})` : ref(best.col);
  };

  if (custom && spec.fields && Object.keys(spec.fields).length) {
    issue(['fields'], '自定义实体没有标准字段，请把字段写在 extensions 里（带类型）', { atKey: true });
  }
  for (const [name, raw] of Object.entries(spec.fields ?? {})) {
    const field = entity?.fields.find(f => f.name === name);
    if (!field) {
      if (entity) reportUnknownField(entity, name, raw);
      continue;
    }
    const parts = fieldParts(raw);
    const { expr, dictionary } = parts;
    checkExpr(typeof raw === 'string' ? ['fields', name] : ['fields', name, 'expr'], expr);
    checkDictionary(['fields', name], field.type, dictionary, () => snippet({ [name]: expr }), field);
    checkOtherwise(['fields', name], parts, dictionary, field);
    planned.push({ name, type: field.type, expr, ...(dictionary && { dictionary }), ...(field.enum && { enum: field.enum }), ...otherwiseOf(parts) });
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
    checkDictionary(['extensions', name], ext.type, ext.dictionary, () => snippet({ [name]: { ...ext, type: 'string' } }, [[name]]));
    checkOtherwise(['extensions', name], ext, ext.dictionary);
    planned.push({ name, type: ext.type, expr: ext.expr, ...(ext.dictionary && { dictionary: ext.dictionary }), ...otherwiseOf(ext) });
  }
  if (!planned.length) issue(spec.fields ? ['fields'] : [], '至少要映射一个字段');

  // 去重键与取最新字段：必须是映射出来的字段
  const mapped = new Map(planned.map(c => [c.name, c]));
  const key = [...(spec.dedupe?.key ?? entity?.key ?? [])];
  if (!spec.dedupe && custom) {
    issue([], '自定义实体必须声明去重键 dedupe.key', { hint: 'dedupe:\n  key: [能唯一标识一行的字段]' });
  }
  key.forEach((k, i) => {
    if (mapped.has(k)) return;
    if (spec.dedupe) {
      const [near] = similarNames(k, [...mapped.keys()]);
      issue(['dedupe', 'key', i], `去重键 ${k} 不是本映射映射出来的字段`, { hint: near && `key: [${key.map(x => (x === k ? near : x)).join(', ')}]` });
    } else {
      const expr = columnFor(entity!, k);
      const hint = expr ? snippet({ [k]: expr }) : `${k}: 源表里能唯一标识一行的列\n# 或者\ndedupe:\n  key: [能唯一标识一行的字段]`;
      issue(['fields'], `没有映射${entity!.label}的主键 ${k}：请映射它，或在 dedupe.key 里声明去重键`, { atKey: true, hint });
    }
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
