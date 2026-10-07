// app/lib/mapping-form.ts —— 映射表单与 YAML 互转（客户端用，不做校验；校验见 .server/pipeline/mapping-spec.ts）：从映射 YAML 读出每个标准字段的
// 表单状态（源列、常用转换与参数、枚举字段的值对照与兜底、依据），改单个字段时直接改原 Document 上的节点，注释与顺序都保留（ADR-0017）。
// 表单不认识的写法（非枚举字段的值字典或兜底值、解析不了的表达式、其他结构）只读、原样保留，到 YAML 里改。
// 改了表达式时清掉该字段的行尾注释：草稿写在那里的依据（同名、单位、时区）对新写法不一定成立。
// 扩展字段：列出还没被任何字段用到的源列，勾选即按列推断名字与类型加上（列名或格式像敏感信息的默认标成敏感）；已有的扩展字段可改名、类型、中文名
// 与是否敏感，取消勾选即删除，值字典与兜底原样保留。标准字段是否敏感由标准模型决定，YAML 里照写的 sensitive 原样保留。
// 身份打通（只用于 customer）：从已映射的敏感字段里选匹配字段并排序，写成 identity.match，全部去掉时删掉 identity。
// 键空间（ADR-0024）：映射顶层的 key_space 可填可清空；引用字段的 key_space 随字段写成对象写法 { expr, key_space }，
// 没写时按同一数据源里目标实体已发布映射声明的键空间预填（只在写这个字段时一并写进 YAML）
import { isMap, isScalar, isSeq, YAMLMap, YAMLSeq, type Document, type Scalar } from 'yaml';
import { EXTENSION_PATTERN, FIELD_TYPE_NAMES, type CanonicalEntity, type CanonicalField, type FieldType } from './canonical-model';
import { extensionName, standardValue } from './field-synonyms';
import { ExprError, extensionSpec, lit, parseExpression, ref, referencedColumns, type Expr } from './mapping-expr';

export type TransformId = 'direct' | 'cents' | 'text' | 'timezone' | 'parse' | 'epoch' | 'concat' | 'fixed' | 'custom';

export interface TransformArg {
  label: string;
  hint?: string;
  optional?: true;
  /** 只能从中选一个时的取值与名称 */
  options?: readonly { value: string; label: string }[];
}

export interface Transform {
  id: TransformId;
  label: string;
  /** 是否要选一个源列（拼接用 parts，固定值与自定义表达式不用） */
  column: boolean;
  args: readonly TransformArg[];
}

/** 表单里的常用转换（业务名称与参数说明），其余写法落到自定义表达式 */
export const TRANSFORMS: readonly Transform[] = [
  { id: 'direct', label: '直接取值', column: true, args: [] },
  { id: 'cents', label: '分换成元（除以 100）', column: true, args: [] },
  { id: 'text', label: '转为文本', column: true, args: [] },
  { id: 'timezone', label: '按时区解读时间', column: true, args: [{ label: '源端时区', hint: 'IANA 时区名，如 Asia/Shanghai' }] },
  { id: 'parse', label: '解析日期 / 时间', column: true, args: [{ label: '格式', hint: '如 %Y/%m/%d、%Y-%m-%d %H:%M；不填时按标准写法解析', optional: true }] },
  {
    id: 'epoch', label: 'Unix 时间戳转为时间', column: true,
    args: [{ label: '单位', options: [{ value: 'seconds', label: '秒' }, { value: 'millis', label: '毫秒' }] }],
  },
  { id: 'concat', label: '拼接多列与文本', column: false, args: [] },
  { id: 'fixed', label: '固定值', column: false, args: [{ label: '值' }] },
  { id: 'custom', label: '自定义表达式', column: false, args: [] },
];

/** 拼接的一段：源列或一段文本 */
export type Part = { column: string } | { text: string };

/** 值对照的一条：源值对应的标准值，null 是还没对应（不写进 YAML） */
export interface DictionaryEntry { from: string; to: string | null }

/** 表单上对一个字段的选择；交给 writeField 写回 YAML */
export interface FieldChoice {
  transform: TransformId;
  column?: string | null;
  /** 参数，按 TRANSFORMS 里的 args 顺序 */
  args?: string[];
  /** 拼接的各段 */
  parts?: Part[];
  /** 自定义表达式的原文 */
  raw?: string;
  /** 枚举字段的值对照（没有时不写值字典） */
  dictionary?: DictionaryEntry[];
  /** 兜底值：null 是记为空；undefined 是不写（没对上的取值让合并失败） */
  otherwise?: string | null;
  /** 引用字段的键空间；空时不写 key_space */
  keySpace?: string | null;
}

export interface FieldForm {
  field: string;
  /** 去重键里的字段（未对应时校验不通过） */
  required: boolean;
  /** null：YAML 里没有对应 */
  transform: TransformId | null;
  column: string | null;
  args: string[];
  parts?: Part[];
  /** YAML 里的表达式原文（没有对应时为空串） */
  raw: string;
  /** 枚举字段（有标准枚举的文本字段）的值对照，按 YAML 里的顺序；其他字段没有 */
  dictionary?: DictionaryEntry[];
  /** 兜底值，只在 YAML 里写了时有这一项（null 是记为空） */
  otherwise?: string | null;
  /** 键空间，只在 YAML 里写了时有这一项 */
  keySpace?: string;
  readonly: boolean;
  /** 只读的原因 */
  reason?: string;
  /** 草稿写在行尾注释里的依据（同名、同义词、格式等） */
  basis?: string;
}

const UNKNOWN = '这种写法表单不认识，请在 YAML 里修改';

/** 解析后的表达式对应到常用转换；对不上的是自定义表达式 */
function recognize(e: Expr): Pick<FieldForm, 'transform' | 'column' | 'args' | 'parts'> {
  const of = (transform: TransformId, column: string | null = null, args: string[] = []) => ({ transform, column, args });
  const text = (a: Expr) => (a.kind === 'literal' ? a.text : undefined);
  if (e.kind === 'column') return of('direct', e.name);
  if (e.kind === 'literal' && e.text !== undefined) return of('fixed', null, [e.text]);
  if (e.kind === 'binary' && e.op === '/' && e.left.kind === 'column' && e.right.kind === 'literal' && e.right.sql === '100') return of('cents', e.left.name);
  if (e.kind !== 'call') return of('custom');
  if (e.fn === 'concat' && e.args.every(a => a.kind === 'column' || text(a) !== undefined)) {
    return { ...of('concat'), parts: e.args.map(a => (a.kind === 'column' ? { column: a.name } : { text: text(a)! })) };
  }
  const [first, ...rest] = e.args;
  if (first.kind !== 'column') return of('custom');
  // 时区与格式参数由 parseExpression 保证是字符串字面量
  switch (e.fn) {
    case 'string': return of('text', first.name);
    case 'from_timezone': return of('timezone', first.name, [text(rest[0])!]);
    case 'date':
    case 'timestamp': return of('parse', first.name, rest.map(a => text(a)!));
    case 'from_epoch_seconds': return of('epoch', first.name, ['seconds']);
    case 'from_epoch_millis': return of('epoch', first.name, ['millis']);
    default: return of('custom');
  }
}

/** 表单上的选择写成表达式；日期解析按字段类型用 date 或 timestamp */
export function expressionOf(choice: FieldChoice, type?: FieldType): string {
  const { transform, args = [] } = choice;
  const def = TRANSFORMS.find(t => t.id === transform);
  if (!def) throw new Error(`不认识的转换：${transform}`);
  if (def.column && !choice.column) throw new Error(`${def.label}要选一个源列`);
  const col = choice.column ? ref(choice.column) : '';
  switch (transform) {
    case 'direct': return col;
    case 'cents': return `${col} / 100`;
    case 'text': return `string(${col})`;
    case 'timezone': return `from_timezone(${col}, ${lit(args[0] ?? '')})`;
    case 'parse': return `${type === 'timestamp' ? 'timestamp' : 'date'}(${[col, ...(args[0] ? [lit(args[0])] : [])].join(', ')})`;
    case 'epoch': return `from_epoch_${args[0] === 'millis' ? 'millis' : 'seconds'}(${col})`;
    case 'concat': return `concat(${(choice.parts ?? []).map(p => ('column' in p ? ref(p.column) : lit(p.text))).join(', ')})`;
    case 'fixed': return lit(args[0] ?? '');
    case 'custom': {
      const raw = (choice.raw ?? '').trim();
      if (!raw) throw new Error('自定义表达式不能为空');
      return raw;
    }
  }
}

/** 有标准枚举的文本字段：表单给它值对照与兜底 */
export const isEnumField = (field?: CanonicalField) => field?.type === 'string' && !!field.enum;

/** 对象写法里的值字典与兜底值；写法表单不认识时是原因 */
function readDictionary(value: YAMLMap): Pick<FieldForm, 'dictionary' | 'otherwise'> | string {
  const node = value.get('dictionary', true);
  const dictionary: DictionaryEntry[] = [];
  if (isMap(node)) {
    for (const p of node.items) {
      const to = isScalar(p.value) ? p.value.value : p.value;
      if (!isScalar(p.key) || p.key.value == null || (to != null && typeof to !== 'string')) return UNKNOWN;
      dictionary.push({ from: String(p.key.value), to: to ?? null });
    }
  } else if (node != null && !(isScalar(node) && node.value == null)) return UNKNOWN;
  if (!value.has('otherwise')) return { dictionary };
  const otherwise = value.get('otherwise', true);
  const v = isScalar(otherwise) ? otherwise.value : otherwise;
  if (v != null && typeof v !== 'string') return UNKNOWN;
  return { dictionary, otherwise: v ?? null };
}

/** 字段在 YAML 里的表单状态，以及可写时表达式所在的节点、对象写法的节点 */
function locate(doc: Document, standard: CanonicalField | undefined, field: string, required: boolean): { form: FieldForm; node?: Scalar; spec?: YAMLMap } {
  const form: FieldForm = { field, required, transform: null, column: null, args: [], raw: '', readonly: false, ...(isEnumField(standard) && { dictionary: [] }) };
  const fields = doc.get('fields', true);
  if (fields != null && !isMap(fields) && !(isScalar(fields) && fields.value == null)) {
    return { form: { ...form, readonly: true, reason: 'fields 下不是字段表，请在 YAML 里修改' } };
  }
  const value = isMap(fields) ? fields.items.find(p => isScalar(p.key) && p.key.value === field)?.value : undefined;
  if (value == null || (isScalar(value) && value.value == null)) return { form };

  let node: unknown = value;
  let reason: string | undefined;
  // 对象写法里表达式之外表单认识的项：值对照、兜底与键空间
  let extras: Pick<FieldForm, 'dictionary' | 'otherwise' | 'keySpace'> = {};
  if (isMap(value)) {
    const keys = value.items.map(p => (isScalar(p.key) ? p.key.value : null));
    node = value.get('expr', true);
    const keySpace = value.get('key_space');
    if (keys.some(k => k !== 'expr' && k !== 'dictionary' && k !== 'otherwise' && k !== 'sensitive' && k !== 'key_space')) reason = UNKNOWN;
    else if (keys.includes('key_space') && typeof keySpace !== 'string') reason = UNKNOWN;
    else if (keys.includes('dictionary') || keys.includes('otherwise')) {
      const read = isEnumField(standard) ? readDictionary(value) : '非枚举字段带值字典或兜底值（dictionary / otherwise），请在 YAML 里修改';
      if (typeof read === 'string') reason = read;
      else extras = read;
    }
    if (typeof keySpace === 'string') extras = { ...extras, keySpace };
  }
  if (!isScalar(node) || typeof node.value !== 'string') return { form: { ...form, readonly: true, reason: reason ?? UNKNOWN } };

  const raw = node.value;
  const basis = node.comment?.trim() || undefined;
  try {
    const spec = isMap(value) ? value : undefined;
    return { form: { ...form, ...recognize(parseExpression(raw)), raw, ...extras, readonly: !!reason, reason, basis }, ...(!reason && { node, spec }) };
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    return { form: { ...form, transform: 'custom', raw, readonly: true, reason: reason ?? `表达式有误（${e.message}），请在 YAML 里修改`, basis } };
  }
}

/** 必填字段：dedupe.key 声明的，没有声明时是实体的主键（与映射校验的规则一致） */
function requiredFields(doc: Document, entity: CanonicalEntity) {
  const key = doc.getIn(['dedupe', 'key'], true);
  return isSeq(key) ? key.items.flatMap(i => (isScalar(i) ? [String(i.value)] : [])) : [...entity.key];
}

/** 实体的全部标准字段（按实体字段顺序）在 YAML 里的表单状态 */
export function readForm(doc: Document, entity: CanonicalEntity): FieldForm[] {
  const required = requiredFields(doc, entity);
  return entity.fields.map(f => locate(doc, f, f.name, required.includes(f.name)).form);
}

/** 写进 YAML 的值字典（按表单上的顺序）：去掉还没对应的条目；没有条目时为 undefined */
export function writtenDictionary(entries: DictionaryEntry[] = []) {
  const written = entries.filter((e): e is { from: string; to: string } => e.to !== null && e.from !== '');
  return written.length ? written : undefined;
}

const sameDictionary = (a?: DictionaryEntry[], b?: DictionaryEntry[]) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** 值字典节点；不经过对象，数字样的源值（如 '2'）也保持表单上的顺序。没变的条目沿用原节点，行尾注释保留 */
function dictionaryNode(doc: Document, entries: DictionaryEntry[], before?: unknown) {
  const map = new YAMLMap();
  const old = isMap(before) ? before.items : [];
  for (const e of entries) {
    const same = old.find(p => isScalar(p.key) && String(p.key.value) === e.from && isScalar(p.value) && p.value.value === e.to);
    map.items.push(same ?? doc.createPair(e.from, e.to));
  }
  return map;
}

/** 新建值对照：源值按标准值同名或近义词预填（同值也要写上，合并时只认字典里的源值），对不上的待对应 */
export function seedDictionary(entityName: string, fieldName: string, values: string[]): DictionaryEntry[] {
  return [...new Set(values)].map(from => ({ from, to: standardValue(entityName, fieldName, from) ?? null }));
}

/** 对照表的一行；extra 是不在对照里、来自常见取值或落入兜底的源值，suggestion 是未对应时能确定的标准值 */
export interface DictionaryRow extends DictionaryEntry { extra: boolean; suggestion?: string }

/** 对照表的行：已有的对照，后面接上 values（常见取值、落入兜底的取值）里还没对照的源值，作为未对应的行 */
export function dictionaryRows(entityName: string, fieldName: string, entries: DictionaryEntry[], values: string[]): DictionaryRow[] {
  const known = new Set(entries.map(e => e.from));
  const row = (e: DictionaryEntry, extra: boolean): DictionaryRow => {
    const suggestion = e.to === null ? standardValue(entityName, fieldName, e.from) : undefined;
    return { ...e, extra, ...(suggestion && { suggestion }) };
  };
  return [...entries.map(e => row(e, false)), ...[...new Set(values)].filter(v => !known.has(v)).map(from => row({ from, to: null }, true))];
}

/**
 * 把一个字段的选择写回原 Document（null 表示去掉对应）。表达式没变时不动；变了时只改那个节点，清掉行尾的依据注释；
 * YAML 里没有的字段插在实体字段顺序里的位置。只读的字段抛错
 */
export function writeField(doc: Document, entity: CanonicalEntity, field: string, choice: FieldChoice | null): void {
  const standard = entity.fields.find(f => f.name === field);
  const { form, node, spec } = locate(doc, standard, field, false);
  if (form.readonly) throw new Error(`${field}：${form.reason}`);
  const fields = doc.get('fields', true);
  if (!choice) {
    if (isMap(fields)) fields.delete(field);
    return;
  }
  const type = standard?.type;
  const expr = expressionOf(choice, type);
  // 值对照与兜底只写在枚举字段上
  const dictionary = isEnumField(standard) ? writtenDictionary(choice.dictionary) : undefined;
  const otherwise = isEnumField(standard) ? choice.otherwise : undefined;
  // 与 YAML 里原样的条目比：草稿里待填（null）的条目在写这个字段时一并去掉，否则校验不通过
  const dictionaryChanged = !sameDictionary(dictionary, form.dictionary?.length ? form.dictionary : undefined);
  const otherwiseChanged = otherwise !== form.otherwise;
  const keySpace = choice.keySpace?.trim() || undefined;
  const keySpaceChanged = keySpace !== form.keySpace;
  if (node) {
    if (!form.transform || expressionOf({ ...form, transform: form.transform }, type) !== expr) {
      node.value = expr;
      node.type = undefined;
      node.comment = undefined;
    }
    if (!dictionaryChanged && !otherwiseChanged && !keySpaceChanged) return;
    if (spec) {
      if (dictionaryChanged) {
        if (dictionary) setKey(doc, spec, 'dictionary', dictionaryNode(doc, dictionary, spec.get('dictionary', true)));
        else spec.delete('dictionary');
      }
      if (otherwise === undefined) spec.delete('otherwise');
      else if (otherwiseChanged) setKey(doc, spec, 'otherwise', otherwise);
      if (!keySpace) spec.delete('key_space');
      else if (keySpaceChanged) setKey(doc, spec, 'key_space', keySpace);
      // 对照、兜底与键空间都去掉了：变回标量写法
      const pair = isMap(fields) ? fields.items.find(p => p.value === spec) : undefined;
      if (pair && spec.items.length === 1) pair.value = node;
      return;
    }
  }
  // 表达式节点（带依据注释）原样放进对象写法
  const value = dictionary || otherwise !== undefined || keySpace ? specNode(doc, node ?? expr, dictionary, otherwise, keySpace) : (node ?? expr);
  if (!isMap(fields)) {
    doc.set('fields', doc.createNode({ [field]: value }));
    return;
  }
  const order = entity.fields.map(f => f.name);
  const at = order.indexOf(field);
  // 写成 `field:`（值为空）的字段直接填上
  const existing = fields.items.findIndex(p => isScalar(p.key) && p.key.value === field);
  if (existing >= 0) {
    fields.items[existing].value = doc.createNode(value);
    return;
  }
  const next = fields.items.findIndex(p => isScalar(p.key) && order.indexOf(String(p.key.value)) > at);
  const pair = doc.createPair(field, value);
  if (next < 0) fields.items.push(pair);
  else fields.items.splice(next, 0, pair);
}

/** 对象写法 { expr, dictionary, otherwise, key_space }；只带键空间、表达式没有行尾注释时写成行内 */
function specNode(doc: Document, expr: Scalar | string, dictionary: DictionaryEntry[] | undefined, otherwise: string | null | undefined, keySpace?: string) {
  const spec = new YAMLMap();
  spec.flow = !dictionary && otherwise === undefined && !(typeof expr !== 'string' && expr.comment);
  setKey(doc, spec, 'expr', expr);
  if (dictionary) setKey(doc, spec, 'dictionary', dictionaryNode(doc, dictionary));
  if (otherwise !== undefined) setKey(doc, spec, 'otherwise', otherwise);
  if (keySpace) setKey(doc, spec, 'key_space', keySpace);
  return spec;
}

/**
 * 引用字段（标准模型内置 ref）表单上的键空间：YAML 里写了的照写，没写时是 keySpaces（同一数据源里各实体已发布映射声明的键空间）里
 * 目标实体的键空间，都没有时为空串；不是引用字段时为 null（不显示键空间）
 */
export function keySpaceOf(form: FieldForm, standard: CanonicalField, keySpaces: Readonly<Record<string, string>>): string | null {
  if (!standard.ref) return null;
  return form.keySpace ?? keySpaces[standard.ref.entity] ?? '';
}

/** 设置对象写法里的一项；新加的键也是 Scalar 节点（YAMLMap.set 加的是字符串键，原地再读时认不出） */
function setKey(doc: Document, map: YAMLMap, key: string, value: unknown) {
  const pair = map.items.find(p => isScalar(p.key) && p.key.value === key);
  if (pair) pair.value = doc.createNode(value);
  else map.items.push(doc.createPair(key, value));
}

/** 扩展字段在 YAML 里的表单状态 */
export interface ExtensionForm {
  name: string;
  /** 不是标准层的类型时为 null（只读） */
  type: FieldType | null;
  expr: string;
  /** 中文名，没写时为空串 */
  label: string;
  /** 带值字典或兜底：类型只能是文本，对照与兜底原样保留，到 YAML 里改 */
  dictionary: boolean;
  /** 标成敏感：标准层只存加盐哈希，类型只能是文本 */
  sensitive: boolean;
  readonly: boolean;
  reason?: string;
}

/** 表单上对一个扩展字段的选择（name 是改名后的名字）；交给 writeExtension 写回 YAML */
export interface ExtensionChoice { name: string; type: FieldType; expr: string; label?: string; sensitive?: boolean }

const EXTENSION_KEYS = ['type', 'expr', 'label', 'dictionary', 'otherwise', 'sensitive'];

/** extensions 下的字段表；没写时都没有，写的不是字段表时是原因 */
function extensionsMap(doc: Document): { map?: YAMLMap; reason?: string } {
  const node = doc.get('extensions', true);
  if (node == null || (isScalar(node) && node.value == null)) return {};
  return isMap(node) ? { map: node } : { reason: 'extensions 下不是字段表，请在 YAML 里修改' };
}

function readExtension(name: string, value: unknown): ExtensionForm {
  const form: ExtensionForm = { name, type: null, expr: '', label: '', dictionary: false, sensitive: false, readonly: false };
  if (!isMap(value)) return { ...form, expr: isScalar(value) && typeof value.value === 'string' ? value.value : '', readonly: true, reason: UNKNOWN };
  const get = (key: string) => {
    const node = value.get(key, true);
    return isScalar(node) ? node.value : node;
  };
  const [type, expr, label, sensitive] = [get('type'), get('expr'), get('label'), get('sensitive')];
  const read: ExtensionForm = {
    ...form,
    type: FIELD_TYPE_NAMES.find(t => t === type) ?? null,
    expr: typeof expr === 'string' ? expr : '',
    label: typeof label === 'string' ? label : '',
    dictionary: value.has('dictionary') || value.has('otherwise'),
    sensitive: sensitive === true,
  };
  const keys = value.items.map(p => (isScalar(p.key) ? p.key.value : null));
  if (keys.some(k => !EXTENSION_KEYS.includes(String(k))) || typeof expr !== 'string' || (label != null && typeof label !== 'string')
    || (sensitive != null && typeof sensitive !== 'boolean')) {
    return { ...read, readonly: true, reason: UNKNOWN };
  }
  if (!read.type) return { ...read, readonly: true, reason: `类型 ${String(type)} 不是标准层的类型，请在 YAML 里修改` };
  return read;
}

const pairName = (key: unknown) => (isScalar(key) ? String(key.value) : '');

/** YAML 里的扩展字段（按 YAML 里的顺序）；extensions 写的不是字段表时只有原因 */
export function readExtensions(doc: Document): { extensions: ExtensionForm[]; reason?: string } {
  const { map, reason } = extensionsMap(doc);
  return { extensions: map?.items.map(p => readExtension(pairName(p.key), p.value)) ?? [], ...(reason && { reason }) };
}

const nameTaken = (name: string) => `扩展字段 ${name} 已有，换一个名字`;

/** 扩展字段名的问题；合格时为 null。others 是其他扩展字段的名字 */
export function extensionNameProblem(name: string, others: readonly string[]): string | null {
  if (!new RegExp(EXTENSION_PATTERN).test(name)) return '名字要以 x_ 开头，只用小写字母、数字与下划线';
  return others.includes(name) ? nameTaken(name) : null;
}

/**
 * 勾选源列时的扩展字段：名字 x_<列名>（做不成或与 taken 重名时 x_col_<列序号>），类型按列推断，不带时区的时间按 Asia/Shanghai 解读；
 * 列名或格式（采集到的 formats）像敏感信息的标成敏感，类型为文本
 */
export function newExtension(
  table: { columns: readonly { name: string; type: string; formats?: readonly { format: string }[] }[] }, column: string, taken: readonly string[],
): ExtensionChoice {
  const at = table.columns.findIndex(c => c.name === column);
  if (at < 0) throw new Error(`源表里没有列 ${column}`);
  return { name: extensionName(column, at + 1, taken), ...extensionSpec(table.columns[at]) };
}

/** 还没被任何标准字段或扩展字段的表达式用到的源列（按源表的列顺序）；解析不了的表达式不算用到 */
export function unusedColumns<C extends { name: string }>(doc: Document, table: { columns: readonly C[] }): C[] {
  const used = new Set<string>();
  for (const key of ['fields', 'extensions']) {
    const node = doc.get(key, true);
    if (!isMap(node)) continue;
    for (const p of node.items) {
      const expr = isMap(p.value) ? p.value.get('expr', true) : p.value;
      if (!isScalar(expr) || typeof expr.value !== 'string') continue;
      try {
        for (const c of referencedColumns(parseExpression(expr.value))) used.add(c.name);
      } catch (e) {
        if (!(e instanceof ExprError)) throw e;
      }
    }
  }
  return table.columns.filter(c => !used.has(c.name));
}

/**
 * 把一个扩展字段的选择写回原 Document（null 表示删掉）。已有的改名时原位改键，类型、表达式、中文名、敏感只改变了的项，值字典、兜底与注释保留；
 * 新的以 { type, expr, label, sensitive } 追加在 extensions 末尾（不敏感时不写 sensitive），删光时去掉 extensions。只读的扩展字段、改名与已有的重名时抛错
 */
export function writeExtension(doc: Document, name: string, choice: ExtensionChoice | null): void {
  const { map, reason } = extensionsMap(doc);
  if (reason) throw new Error(reason);
  const pair = map?.items.find(p => pairName(p.key) === name);
  if (pair) {
    const form = readExtension(name, pair.value);
    if (form.readonly) throw new Error(`${name}：${form.reason}`);
  }
  if (!choice) {
    if (!map || !pair) return;
    map.items.splice(map.items.indexOf(pair), 1);
    if (!map.items.length) doc.delete('extensions');
    return;
  }
  if (choice.name !== name && map?.items.some(p => pairName(p.key) === choice.name)) throw new Error(nameTaken(choice.name));
  const label = choice.label?.trim();
  if (!pair) {
    const spec = new YAMLMap();
    spec.flow = true;
    setKey(doc, spec, 'type', choice.type);
    setKey(doc, spec, 'expr', choice.expr);
    if (label) setKey(doc, spec, 'label', label);
    if (choice.sensitive) setKey(doc, spec, 'sensitive', true);
    if (map) map.items.push(doc.createPair(choice.name, spec));
    else {
      const extensions = new YAMLMap();
      extensions.items.push(doc.createPair(choice.name, spec));
      doc.set('extensions', extensions);
    }
    return;
  }
  if (choice.name !== name) (pair.key as Scalar).value = choice.name;
  const spec = pair.value as YAMLMap;
  const set = (key: string, value: string | boolean) => {
    const old = spec.get(key, true);
    if (!(isScalar(old) && old.value === value)) setKey(doc, spec, key, value);
  };
  set('type', choice.type);
  set('expr', choice.expr);
  if (label) set('label', label);
  else spec.delete('label');
  if (choice.sensitive) set('sensitive', true);
  else spec.delete('sensitive');
}

/**
 * 身份打通可选的匹配字段：YAML 里已映射（有表达式）的敏感字段，标准字段按实体顺序，之后是标成敏感的扩展字段（按 YAML 里的顺序）
 */
export function identityCandidates(doc: Document, entity: CanonicalEntity): string[] {
  const fields = doc.get('fields', true);
  const mapped = (name: string) => {
    const value = isMap(fields) ? fields.get(name, true) : undefined;
    return value != null && !(isScalar(value) && value.value == null);
  };
  return [
    ...entity.fields.filter(f => f.pii && mapped(f.name)).map(f => f.name),
    ...readExtensions(doc).extensions.filter(e => e.sensitive).map(e => e.name),
  ];
}

/** YAML 里身份打通的匹配字段（按优先级）；没写时为空，写法表单不认识时带原因（只读） */
export function readIdentity(doc: Document): { match: string[]; reason?: string } {
  const node = doc.get('identity', true);
  if (node == null || (isScalar(node) && node.value == null)) return { match: [] };
  const match = isMap(node) ? node.get('match', true) : undefined;
  const keys = isMap(node) ? node.items.map(p => pairName(p.key)) : [];
  if (!isSeq(match) || keys.some(k => k !== 'match') || !match.items.every(i => isScalar(i) && typeof i.value === 'string')) {
    return { match: [], reason: 'identity 的写法表单不认识，请在 YAML 里修改' };
  }
  return { match: match.items.map(i => String((i as Scalar).value)) };
}

/** 把匹配字段（按优先级）写成 identity.match（行内列表），没有字段时删掉 identity。写法表单不认识时抛错 */
export function writeIdentity(doc: Document, match: string[]): void {
  const { reason } = readIdentity(doc);
  if (reason) throw new Error(reason);
  if (!match.length) {
    doc.delete('identity');
    return;
  }
  const seq = new YAMLSeq();
  seq.flow = true;
  seq.items.push(...match.map(m => doc.createNode(m)));
  const identity = new YAMLMap();
  setKey(doc, identity, 'match', seq);
  doc.set('identity', identity);
}

/** 映射顶层的键空间；没写或写的不是文本时为 null */
export function readKeySpace(doc: Document): string | null {
  const value = doc.get('key_space');
  return typeof value === 'string' ? value : null;
}

/** 写映射顶层的键空间，空时删掉 key_space */
export function writeKeySpace(doc: Document, keySpace: string | null): void {
  const value = keySpace?.trim();
  if (!value) doc.delete('key_space');
  else if (readKeySpace(doc) !== value) doc.set('key_space', value);
}
