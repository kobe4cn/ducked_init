// app/.server/pipeline/mapping-spec.ts —— 映射文档（YAML）：一张源表（或一个已发布的源视图）→ 一个标准实体（或自定义实体）。
// 先按 JSON Schema（MAPPING_SCHEMA）校验结构，再对照标准模型与源表的字段做语义校验：字段表达式只能用白名单函数、只能引用源表里有的字段，
// 值字典与兜底值只能对应到标准枚举，去重键与取最新字段必须是映射出来的字段，身份打通的匹配字段（只用于 customer）必须是映射出来的敏感字段；扩展字段可标成敏感（只能是文本），内置敏感字段不能取消敏感标记。每个问题都带 YAML 里的行列位置，常见错误还附上改好的写法（hint）。
// 映射可以声明键空间（ADR-0024）：单列文本主键在标准层写成 <键空间>:<原值>，指向别的实体的字段（内置 ref 与已登记关系的起点）可以在字段上写同样的键空间。
// 映射可以写行过滤 where（ADR-0024）：返回布尔的表达式，不满足（含取值为空）的源记录不进标准层。
// 校验通过后得到合并计划（MergePlan）：标准层的列、每列的表达式与值字典、去重键与取最新字段、身份打通的匹配规则，交给工作进程编译执行（ADR-0015）
import { Ajv, type ErrorObject } from 'ajv';
import { Document, isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type YAMLMap } from 'yaml';
import {
  CANONICAL_ENTITIES, CUSTOM_FIELD_PATTERN, entityOf, EXTENSION_PATTERN, FIELD_TYPE_NAMES, FIELD_TYPES, isCustomEntity, KEY_SPACE_PATTERN, MODEL_MAJOR,
  type CanonicalEntity, type CanonicalField, type EntityRelation, type FieldType,
} from '../../lib/canonical-model';
import { fieldsForColumn, normalizeName, similarFields, similarNames, standardValue } from '../../lib/field-synonyms';
import { ExprError, FUNCTIONS, KIND_FIELD_TYPES, kindOf, parseExpression, ref, referencedColumns, type Expr } from '../../lib/mapping-expr';

/** 字段的写法：表达式本身，或带值字典（与兜底值）、键空间的对象 */
export type FieldSpec = string | { expr: string; dictionary?: Record<string, string>; otherwise?: string | null; sensitive?: boolean; key_space?: string };

export interface MappingSpec {
  /** 标准模型的大版本 */
  model: number;
  entity: string;
  /** 源表（数据源里的表名，与同步范围里的一致）；与 view 二选一，校验通过后为源表或源视图的名字 */
  table: string;
  /** 已发布的源视图（ADR-0022）；与 table 二选一 */
  view?: string;
  /** 源视图里标识一条记录的列（通常是主表的主键）；不写时按整行区分记录。只能用于源视图 */
  view_key?: string[];
  description?: string;
  /** 键空间（ADR-0024）：单列文本主键在标准层写成 <键空间>:<原值> */
  key_space?: string;
  fields?: Record<string, FieldSpec>;
  /** 扩展字段（标准实体上以 x_ 开头）或自定义实体的全部字段：带类型；sensitive 为真时标准层只存加盐哈希 */
  extensions?: Record<string, { type: FieldType; expr: string; label?: string; dictionary?: Record<string, string>; otherwise?: string | null; sensitive?: boolean; key_space?: string }>;
  /** 去重键与取最新规则：同一去重键的多行只留一行，取最新字段最大的那行。不写时按实体主键去重 */
  dedupe?: { key: string[]; latest?: string };
  /** 身份打通的匹配字段（只用于 customer）：本映射映射出来的敏感字段，数组顺序即优先级。不写时用平台默认规则 */
  identity?: IdentityRules;
  /** 行过滤（ADR-0024）：返回布尔的表达式，不满足（含取值为空）的源记录不进标准层 */
  where?: string;
}

/** 身份打通的匹配规则：按优先级排列的匹配字段 */
export interface IdentityRules { match: string[] }

/** 键空间名（KEY_SPACE_PATTERN） */
const keySpace = { type: 'string', pattern: KEY_SPACE_PATTERN };

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
      sensitive: { type: 'boolean' },
      key_space: keySpace,
    },
  },
};

/** 映射文档的 JSON Schema（模型起草映射时也用它约束输出） */
export const MAPPING_SCHEMA = {
  type: 'object',
  required: ['model', 'entity'],
  additionalProperties: false,
  properties: {
    model: { const: MODEL_MAJOR },
    entity: { type: 'string', minLength: 1 },
    table: { type: 'string', minLength: 1 },
    view: { type: 'string', minLength: 1 },
    view_key: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    description: { type: 'string' },
    key_space: keySpace,
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
          sensitive: { type: 'boolean' },
          key_space: keySpace,
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
    identity: {
      type: 'object',
      required: ['match'],
      additionalProperties: false,
      properties: {
        match: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
      },
    },
    where: { type: 'string', minLength: 1 },
  },
} as const;

/** table 与 view 都没写：Schema 里两者都是选填，另行检查 */
const MISSING_INPUT = '缺少 table（源表）或 view（源视图）';

const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(MAPPING_SCHEMA);

/**
 * 映射里的一个问题：行列从 1 起（YAML 解析失败时也有），path 是出问题的位置（如 fields.status.dictionary）；
 * hint 是改好的写法（可直接粘贴的 YAML，可能多行），能给出时才有
 */
export interface MappingIssue { line: number; col: number; path: string; message: string; hint?: string }

/**
 * 标准层里的一列：类型、表达式、值字典与标准枚举。
 * otherwise 是兜底值：值字典里没有（或没有值字典时不是标准枚举）的取值写成它，null 表示写成空；不写时这样的取值让合并失败。
 * sensitive：敏感字段（内置的与标成敏感的扩展字段），标准层只存加盐哈希。
 * keySpace：键空间（主键列取映射的键空间，引用列取字段上写的），标准层写成 <键空间>:<值>
 */
export interface PlanColumn {
  name: string; type: FieldType; expr: string; dictionary?: Record<string, string>; enum?: readonly string[]; otherwise?: string | null; sensitive?: true; keySpace?: string;
}

/** 合并计划：工作进程据此把源表的变更批次合并到标准层（MergeMappingParam 再加上映射与版本） */
export interface MergePlan {
  entity: string;
  /** 源表或源视图的名字 */
  table: string;
  /** 输入是源视图时才有：key 是视图里标识一条记录的列，为空时按整行区分记录 */
  view?: { key: string[] };
  /** 映射出来的列 */
  columns: PlanColumn[];
  /** 标准层表应有的全部列：标准实体的全部字段（没映射的为空）加上本映射的扩展字段 */
  entityColumns: { name: string; type: FieldType }[];
  /** 去重键（映射出来的列） */
  key: string[];
  /** 取最新字段：同一去重键取它最大的一行；为空时取最近同步到的一行 */
  latest: string | null;
  /** 身份打通的匹配规则（只有配置了的 customer 映射才有） */
  identity?: IdentityRules;
  /** 映射声明的键空间，写进标准层的 _key_space */
  keySpace?: string;
  /** 行过滤：返回布尔的表达式，不满足（含取值为空）的源记录视为不存在 */
  where?: string;
}

export type MappingCheck = { ok: true; spec: MappingSpec; plan: MergePlan } | { ok: false; issues: MappingIssue[] };

/**
 * 源表（view 为真时是已发布的源视图）的字段：不能用于映射时返回原因（不在同步范围、还没采集、没有发布等）。
 * 不给时不检查源表（工作进程里只编译，不再对照）
 */
export type SourceColumns = (name: string, view?: boolean) => SourceColumn[] | string;

/**
 * 自定义实体已发布的登记（ADR-0019，custom-entities.ts 的 RegisteredEntity 里校验要用的部分），按实体名；没登记或只有草稿的不在里面。
 * 不给时不对照登记（工作进程里只编译，不再对照）
 */
export type RegisteredEntities = ReadonlyMap<string, RegisteredEntity>;
export interface RegisteredEntity {
  name: string; fields: readonly { name: string; type: FieldType; sensitive: boolean }[]; primaryKey: readonly string[]; relations?: readonly EntityRelation[];
}

/** 源表的一列：名称与源端类型（DuckDB 类型名，如 BIGINT、VARCHAR） */
export interface SourceColumn { name: string; type: string }

export type Path = (string | number)[];

const TYPE_LABELS: Record<string, string> = { string: '文本', object: '对象（键: 值）', array: '列表', number: '数字', integer: '整数', boolean: '布尔' };

/** 把 Ajv 的错误译成中文，返回出问题的路径与说明 */
export function describeSchemaError(e: ErrorObject): { path: Path; message: string } | null {
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
    case 'minimum': return { path, message: `应不小于 ${p.limit}` };
    case 'pattern': return { path, message: path.at(-1) === 'key_space' ? '键空间只能用小写字母、数字与下划线' : `应符合 ${p.pattern}` };
    default: return { path, message: e.message ?? e.keyword };
  }
}

/** 行列定位：path 指向的节点（键不存在时退到最近的上级）；atKey 为真时指向键而不是值 */
export function locator(doc: Document, lines: LineCounter) {
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

/** 按扩展字段的写法整理（只留 type、expr、label、dictionary、otherwise、sensitive；有值字典或敏感时只能是文本） */
function asExtension(raw: Record<string, unknown>) {
  const dictionary = isRecord(raw.dictionary) ? raw.dictionary : undefined;
  return {
    type: dictionary || raw.sensitive === true ? 'string' : fieldTypeOf(raw.type),
    expr: typeof raw.expr === 'string' ? raw.expr : '源列',
    ...(typeof raw.label === 'string' && { label: raw.label }),
    ...(dictionary && { dictionary }),
    ...((typeof raw.otherwise === 'string' || raw.otherwise === null) && { otherwise: raw.otherwise }),
    ...(raw.sensitive === true && { sensitive: true }),
  };
}

/** 改好的写法：flow 里的路径写成行内形式（如 { type: string, expr: x }） */
function snippet(value: Record<string, unknown>, flow: Path[] = []) {
  const doc = new Document(value);
  for (const p of flow) (doc.getIn(p, true) as YAMLMap).flow = true;
  return doc.toString({ lineWidth: 0, singleQuote: true }).trimEnd();
}

/** 推断表达式的类型（给扩展字段的写法填类型）：源列按源端类型，函数按返回值，四则运算按数字，比较与逻辑运算按布尔 */
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
    case 'compare': case 'logic': case 'not': case 'isnull': case 'in':
      return 'boolean';
  }
}

/** 字段的写法拆成表达式、值字典与兜底值 */
const fieldParts = (raw: FieldSpec): Exclude<FieldSpec, string> => (typeof raw === 'string' ? { expr: raw } : raw);

/** 写了兜底值时（包括写成 null）带进合并计划；YAML 里的 null 要保留，不能与没写混为一谈 */
const otherwiseOf = (raw: { otherwise?: string | null }) => (Object.hasOwn(raw, 'otherwise') ? { otherwise: raw.otherwise! } : {});

const ISSUE_ORDER = (a: MappingIssue, b: MappingIssue) => a.line - b.line || a.col - b.col;

/**
 * 校验映射文档：YAML 语法、JSON Schema、对照标准模型、源表字段与自定义实体登记的语义检查。
 * 通过时返回规范化后的文档与合并计划，否则返回全部问题（按位置排序）
 */
export function checkMapping(text: string, sourceColumns?: SourceColumns, registered?: RegisteredEntities): MappingCheck {
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
    if (root.table === undefined && root.view === undefined) issue([], MISSING_INPUT);
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
  const isView = spec.view !== undefined;
  if (isView === (spec.table !== undefined)) {
    issue(isView ? ['view'] : [], isView ? 'table 与 view 只能写一个：源表写 table，源视图写 view' : MISSING_INPUT, { atKey: isView });
    return { ok: false, issues };
  }
  if (isView) spec.table = spec.view!;
  const inputLabel = isView ? '源视图' : '源表';
  const entity = entityOf(spec.entity);
  const custom = isCustomEntity(spec.entity);
  if (!entity && !custom) {
    issue(['entity'], `不认识的实体 ${spec.entity}（标准实体：${CANONICAL_ENTITIES.map(e => e.name).join('、')}；自定义实体以 custom_ 开头）`);
    return { ok: false, issues };
  }
  const registration = custom ? registered?.get(spec.entity) : undefined;
  if (custom && registered && !registration) {
    issue(['entity'], `自定义实体 ${spec.entity} 还没有登记并发布（草稿不算）：请先到「自定义实体」登记并发布`);
  }

  // 源表（或源视图）与它的字段
  let columns: Map<string, string> | null = null;
  if (sourceColumns) {
    const listed = sourceColumns(spec.table, isView);
    if (typeof listed === 'string') issue([isView ? 'view' : 'table'], listed);
    else columns = new Map(listed.map(c => [c.name, c.type]));
  }
  if (spec.view_key && !isView) issue(['view_key'], 'view_key 只能用于源视图（view）', { atKey: true });
  spec.view_key?.forEach((name, i) => {
    if (isView && columns && !columns.has(name)) issue(['view_key', i], `源视图 ${spec.table} 中没有字段 ${name}`);
  });

  /** 校验一个表达式，没有问题时返回解析结果；表达式在 YAML 字符串里的位置按引号偏移一列 */
  const checkExpr = (path: Path, expr: string): Expr | undefined => {
    const node = doc.getIn(path, true) as { type?: string } | undefined;
    const quote = node?.type === 'QUOTE_DOUBLE' || node?.type === 'QUOTE_SINGLE' ? 1 : 0;
    try {
      const parsed = parseExpression(expr);
      const missing = referencedColumns(parsed).filter(c => columns && !columns.has(c.name));
      for (const c of missing) issue(path, `${inputLabel} ${spec.table} 中没有字段 ${c.name}`, { offset: quote + c.offset });
      return missing.length ? undefined : parsed;
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

  /** 已登记关系里起点是本实体的字段（关系可以登记在终点实体上：标准实体的 x_ 字段指向自定义实体）；不给登记时为 null，不对照 */
  const relationOrigins = registered && new Set([...registered.values()]
    .flatMap(e => e.relations ?? []).filter(r => r.from.entity === spec.entity).map(r => r.from.field));
  /** 一列不能加键空间的原因（敏感字段存的是哈希，非文本列放不下前缀）；能加时为 null */
  const keySpaceRefusal = (c: Pick<PlanColumn, 'name' | 'type' | 'sensitive'>) => {
    if (c.type !== 'string') return `${c.name} 是 ${c.type}（${FIELD_TYPES[c.type].label}）：键空间只能用于文本`;
    return c.sensitive ? `${c.name} 是敏感字段，标准层存的是哈希，不能加键空间` : null;
  };
  /** 字段上的键空间：只能写在指向别的实体的字段上（内置 ref 或已登记关系的起点），且这一列能加键空间 */
  const checkFieldKeySpace = (path: Path, c: PlanColumn, builtinRef: boolean) => {
    if (c.keySpace === undefined) return;
    const refusal = !builtinRef && relationOrigins && !relationOrigins.has(c.name)
      ? `${c.name} 不指向别的实体：字段上的键空间只能写在标准模型内置的引用字段或已登记关系的起点上`
      : keySpaceRefusal(c);
    if (refusal) issue([...path, 'key_space'], refusal, { atKey: true });
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
    // 标准字段是否敏感由标准模型决定：可以照写 sensitive: true，不能取消，也不能把别的标准字段标成敏感
    if (parts.sensitive === false && field.pii) {
      issue(['fields', name, 'sensitive'], `${field.label}（${name}）是内置敏感字段，不能取消敏感标记`, { atKey: true });
    } else if (parts.sensitive === true && !field.pii) {
      issue(['fields', name, 'sensitive'], `${field.label}（${name}）不是敏感字段：只有扩展字段可以标成敏感`, { atKey: true });
    }
    const column: PlanColumn = {
      name, type: field.type, expr, ...(dictionary && { dictionary }), ...(field.enum && { enum: field.enum }), ...otherwiseOf(parts), ...(field.pii && { sensitive: true as const }),
      ...(parts.key_space && { keySpace: parts.key_space }),
    };
    checkFieldKeySpace(['fields', name], column, !!field.ref);
    planned.push(column);
  }
  const extensionName = new RegExp(custom ? CUSTOM_FIELD_PATTERN : EXTENSION_PATTERN);
  for (const [name, ext] of Object.entries(spec.extensions ?? {})) {
    if (!extensionName.test(name)) {
      issue(['extensions', name], custom
        ? `字段名 ${name} 只能用小写字母、数字与下划线，以字母开头`
        : `扩展字段 ${name} 必须以 x_ 开头（只用小写字母、数字与下划线），避免与标准字段重名`, { atKey: true });
      continue;
    }
    // 自定义实体的字段对照登记：类型与敏感标记要一致（同一列不能有的存哈希、有的存明文，ADR-0005）；没写敏感标记时采用登记的
    const registeredField = registration?.fields.find(f => f.name === name);
    if (registration && !registeredField) {
      const names = registration.fields.map(f => f.name).join('、');
      issue(['extensions', name], `${spec.entity} 没有登记字段 ${name}（已登记：${names}）：请先到「自定义实体」登记并发布这个字段`, { atKey: true });
      continue;
    }
    if (registeredField && registeredField.type !== ext.type) {
      const { type } = registeredField;
      issue(['extensions', name, 'type'], `字段 ${name} 登记的类型是 ${type}（${FIELD_TYPES[type].label}），映射里要写一样的类型`, { hint: `type: ${type}` });
    }
    if (registeredField && ext.sensitive !== undefined && ext.sensitive !== registeredField.sensitive) {
      issue(['extensions', name, 'sensitive'], registeredField.sensitive
        ? `字段 ${name} 登记为敏感字段：标准层只存哈希，映射里不能取消敏感标记`
        : `字段 ${name} 登记为不敏感字段：映射里不能标成敏感`, { hint: `sensitive: ${registeredField.sensitive}` });
    }
    const sensitive = ext.sensitive ?? registeredField?.sensitive;
    checkExpr(['extensions', name, 'expr'], ext.expr);
    checkDictionary(['extensions', name], ext.type, ext.dictionary, () => snippet({ [name]: { ...ext, type: 'string' } }, [[name]]));
    checkOtherwise(['extensions', name], ext, ext.dictionary);
    // 敏感字段在标准层存的是十六进制的哈希
    if (sensitive && !registeredField && ext.type !== 'string') {
      issue(['extensions', name, 'type'], '敏感字段在标准层只存哈希，类型只能是 string（文本）', { hint: snippet({ [name]: { ...ext, type: 'string' } }, [[name]]) });
    }
    if (sensitive && ext.sensitive === undefined && (ext.dictionary || Object.hasOwn(ext, 'otherwise'))) {
      // 敏感标记来自登记，映射里没写：报在值字典或兜底上
      issue(['extensions', name, ext.dictionary ? 'dictionary' : 'otherwise'], `字段 ${name} 登记为敏感字段，标准层只存源端取值的哈希，值字典与兜底对它不起作用：请去掉 dictionary / otherwise`, { atKey: true });
    } else if (sensitive && (ext.dictionary || Object.hasOwn(ext, 'otherwise'))) {
      issue(['extensions', name, 'sensitive'], '敏感字段在标准层只存源端取值的哈希，值字典与兜底对它不起作用：请去掉 dictionary / otherwise，或取消敏感标记', { atKey: true });
    }
    const column: PlanColumn = {
      name, type: ext.type, expr: ext.expr, ...(ext.dictionary && { dictionary: ext.dictionary }), ...otherwiseOf(ext), ...(sensitive && { sensitive: true as const }),
      ...(ext.key_space && { keySpace: ext.key_space }),
    };
    checkFieldKeySpace(['extensions', name], column, false);
    planned.push(column);
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

  // 键空间加在实体主键上（不是去重键）：只能是映射出来的、单列、不敏感的文本主键。自定义实体没给登记时不知道主键，不检查也不加（计划里也不带）
  const primaryKey = entity?.key ?? registration?.primaryKey;
  for (const c of planned) {
    if (c.keySpace && primaryKey?.includes(c.name)) {
      const path = spec.fields && Object.hasOwn(spec.fields, c.name) ? ['fields', c.name, 'key_space'] : ['extensions', c.name, 'key_space'];
      issue(path, `${c.name} 是主键：主键的键空间写在映射顶层的 key_space`, { atKey: true, hint: `key_space: ${c.keySpace}` });
    }
  }
  if (spec.key_space !== undefined && primaryKey) {
    const [k] = primaryKey;
    const c = mapped.get(k);
    if (primaryKey.length > 1) issue(['key_space'], `${spec.entity} 的主键有多列（${primaryKey.join(', ')}）：键空间只能用于单列主键，复合主键请在字段表达式里对齐`);
    else if (!c) issue(['key_space'], `没有映射主键 ${k}：键空间加在主键上，请先映射它`);
    else if (keySpaceRefusal(c)) issue(['key_space'], `主键 ${keySpaceRefusal(c)}`, { hint: c.type === 'string' ? undefined : `${k}: string(源列)` });
    else c.keySpace = spec.key_space;
  }

  // 行过滤：只能引用源表里有的字段，必须返回布尔（不知道源列类型时列都按文本推断，不检查）
  if (spec.where !== undefined) {
    const parsed = checkExpr(['where'], spec.where);
    if (parsed && columns && inferType(parsed, c => columns?.get(c)) !== 'boolean') issue(['where'], 'where 必须是返回布尔的表达式');
  }

  // 身份打通的匹配字段：只用于 customer，必须是映射出来的敏感字段（标准层里是可比对的哈希）
  if (spec.identity && spec.entity !== 'customer') {
    issue(['identity'], '只有消费者（customer）映射能配置身份打通的匹配规则', { atKey: true });
  } else {
    spec.identity?.match.forEach((name, i) => {
      const c = mapped.get(name);
      if (!c) issue(['identity', 'match', i], `匹配字段 ${name} 没有映射：只能选本映射映射出来的敏感字段`);
      else if (!c.sensitive) issue(['identity', 'match', i], `匹配字段 ${name} 不是敏感字段：只能按敏感字段的哈希匹配`);
    });
  }

  if (issues.length) return { ok: false, issues: issues.sort(ISSUE_ORDER) };
  const extensions = Object.entries(spec.extensions ?? {}).map(([name, e]) => ({ name, type: e.type }));
  return {
    ok: true,
    spec,
    plan: {
      entity: spec.entity,
      table: spec.table,
      ...(isView && { view: { key: [...(spec.view_key ?? [])] } }),
      columns: planned,
      entityColumns: [...(entity?.fields.map(f => ({ name: f.name, type: f.type })) ?? []), ...extensions],
      key,
      latest,
      ...(spec.identity && { identity: { match: [...spec.identity.match] } }),
      ...(spec.key_space && primaryKey && { keySpace: spec.key_space }),
      ...(spec.where && { where: spec.where }),
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
