// app/lib/metric-form.ts —— 指标表单 ↔ MetricSpec YAML 的互转与四句摘要（纯函数，前后端共用；校验在 .server/pipeline/dsl/metric-spec.ts 的 checkMetric，
// 这里不重复校验语义，只保证表单生成的 YAML 结构合法）。字段按类型给出可用的过滤运算，指标表单没有 OR / any（Conditions 本身就是全部满足的平铺数组）。
// 表单 → YAML：基础实体上的字段写裸字段名，取值按字段类型转换（数字字段写数字、布尔写真布尔值、日期与时间写 YYYY… 字符串，is_null / not_null 不写 value，
// in / not_in 写列表），只写当前 agg 适用的键（切换 agg 后不适用的键自然丢掉，METRIC_SCHEMA 的 allOf），维度最多 MAX_DIMENSIONS 个。
// YAML → 表单：认不出的写法（consumer_via、device_attribution、维度的 as_of、含 -> 或 consumer. 前缀的路径、Schema 之外的键或非标量取值、不认识的顶层键）
// 标成只读并说明原因，原始值原样保存在 readonly[].raw 里，formToYaml 原样写回，保证往返不丢信息（ADR-0017：YAML 仍是唯一格式）。
// summarize 是四句摘要：计算什么 / 排除什么 / 按什么时间 / ratio 时分母为 0 或为空怎么办（ADR-0025，措辞参考 .server/knowledge/derive.ts 的口径文字，那是 .server 的不能 import）。
// 只能 import app/lib 里的东西（.server 的只能 import type）
import { parseDocument, stringify } from 'yaml';
import type { FieldType } from './canonical-model';
import { AGGS, FILTER_OPS, FILTER_OP_TEXT, MAX_DIMENSIONS, NUMERIC_TYPES, RATIO_AGGS } from './metric-vocab';

/** 表单认识的字段：调用方传进来（服务端用 fieldsFor(entity, ctx)，metric-spec.ts）；不接收 DslContext——它带服务端的已发布实体与计划，前端拿不到 */
export interface FormField { name: string; type: FieldType; label?: string; enum?: readonly string[] }

/** 表单里的过滤条件：取值一律是字符串（in / not_in 为字符串数组），写 YAML 时按字段类型转回 */
export interface Cond { field: string; op: (typeof FILTER_OPS)[number]; value?: string | string[] }

/** ratio 的分子或分母在表单里的样子 */
export interface RatioForm { agg: (typeof RATIO_AGGS)[number]; field?: string; filter: Cond[] }

/** 表单表达不了的写法：key 是它在定义里的位置（顶层键名、measure.field、measure.numerator、filter.1、dimensions.0，整个定义读不了是 $yaml），raw 是原始值 */
export interface ReadonlyItem { key: string; reason: string; raw: unknown }

/** 指标表单的状态 */
export interface MetricForm {
  base: string;
  agg: (typeof AGGS)[number];
  field?: string;
  /** latest / earliest 按哪个时间或日期字段取行 */
  by?: string;
  numerator?: RatioForm;
  denominator?: RatioForm;
  filter: Cond[];
  window?: { field: string; days: number };
  dimensions: { name: string; path: string }[];
  description?: string;
  readonly: ReadonlyItem[];
}

/** 按字段类型可用的过滤运算（label 取词汇表的中文说明）：boolean 只有等于 / 不等于 / 判空，string 没有大小比较，数字与时间全部 */
export function opsFor(type: FieldType): { op: (typeof FILTER_OPS)[number]; label: string }[] {
  const ops: Partial<Record<FieldType, readonly (typeof FILTER_OPS)[number][]>> = {
    boolean: ['eq', 'ne', 'is_null', 'not_null'],
    string: ['eq', 'ne', 'in', 'not_in', 'is_null', 'not_null'],
  };
  return (ops[type] ?? FILTER_OPS).map(op => ({ op, label: FILTER_OP_TEXT[op] }));
}

const UNKNOWN = '这种写法表单不认识，请在 YAML 里修改';
const PATH_REASON = '字段是路径（沿关系走到别的实体，ADR-0038），请在 YAML 里修改';
const DIM_PATH_REASON = '维度路径沿关系走（-> 或 consumer.），请在 YAML 里修改';

/** 表单表达不了、但认识的顶层键 */
const TOP_REASON: Record<string, string> = {
  consumer_via: '基础实体经哪个字段一跳关联消费者（consumer_via），请在 YAML 里修改',
  device_attribution: '匿名事件的设备归属（device_attribution），请在 YAML 里修改',
};

/** measure / filter / window 的字段里含 . 或 -> 就是路径，不是基础实体上的裸字段名 */
const fieldIsPath = (s: string) => s.includes('.') || s.includes('->');
/** 维度路径表单只能写一段（实体.字段）：多跳（->）或统一消费者的属性（consumer.）要在 YAML 里写 */
const dimIsPath = (s: string) => s.includes('->') || s.startsWith('consumer.');
const isOps = (v: unknown): v is (typeof FILTER_OPS)[number] => typeof v === 'string' && (FILTER_OPS as readonly string[]).includes(v);
const noValue = (op: (typeof FILTER_OPS)[number]) => op === 'is_null' || op === 'not_null';

/** 一条过滤条件的表单状态；表单表达不了时返回原因 */
function readCond(v: unknown): Cond | string {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return UNKNOWN;
  const { field, op, value, ...rest } = v as Record<string, unknown>;
  if (Object.keys(rest).length || typeof field !== 'string') return UNKNOWN;
  if (fieldIsPath(field)) return PATH_REASON;
  if (!isOps(op)) return UNKNOWN;
  if (value === undefined) return { field, op };
  const scalar = (x: unknown): string | undefined => (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean') ? String(x) : undefined;
  const one = scalar(value);
  if (one !== undefined) return noValue(op) ? `${op} 不用写 value，请在 YAML 里修改` : { field, op, value: one };
  if (Array.isArray(value) && value.every(x => scalar(x) !== undefined)) return { field, op, value: value.map(x => scalar(x)!) };
  return '取值不是标量或标量列表，请在 YAML 里修改';
}

/** 过滤列表（顶层 filter 与 ratio 分子、分母的 filter）的表单状态；认不出的条目按原下标记只读，写回时原样放回那个位置 */
function readFilter(list: unknown, at: string, readonly: ReadonlyItem[]): Cond[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    readonly.push({ key: at, reason: UNKNOWN, raw: list });
    return [];
  }
  const conds: Cond[] = [];
  list.forEach((v, i) => {
    const read = readCond(v);
    if (typeof read === 'string') readonly.push({ key: `${at}.${i}`, reason: read, raw: v });
    else conds.push(read);
  });
  return conds;
}

/** ratio 分子 / 分母的表单状态；没写或写法不认识时整个记只读（分子字段的路径单独记） */
function readPart(part: unknown, at: 'numerator' | 'denominator', readonly: ReadonlyItem[]): RatioForm {
  const whole = `${at === 'numerator' ? '分子' : '分母'}（measure.${at}）`;
  const fail = (reason: string): RatioForm => {
    readonly.push({ key: `measure.${at}`, reason, raw: part });
    return { agg: 'count', filter: [] };
  };
  if (typeof part !== 'object' || part === null || Array.isArray(part)) return fail(part === undefined ? `ratio 要写${whole}，请在 YAML 里修改` : UNKNOWN);
  const { agg, field, filter, ...rest } = part as Record<string, unknown>;
  if (Object.keys(rest).length || typeof agg !== 'string' || !(RATIO_AGGS as readonly string[]).includes(agg)) return fail(UNKNOWN);
  const form: RatioForm = { agg: agg as RatioForm['agg'], filter: readFilter(filter, `measure.${at}.filter`, readonly) };
  if (field !== undefined) {
    if (typeof field === 'string' && !fieldIsPath(field)) form.field = field;
    else readonly.push({ key: `measure.${at}.field`, reason: typeof field === 'string' ? PATH_REASON : UNKNOWN, raw: field });
  }
  return form;
}

/** 一条维度的表单状态；表单表达不了（as_of、多跳或 consumer. 路径、超上限、别的写法）时返回原因 */
function readDimension(d: unknown, i: number): { name: string; path: string } | string {
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return UNKNOWN;
  const item = d as Record<string, unknown>;
  if ('as_of' in item) return '维度按时间点关联（as_of），请在 YAML 里修改';
  if (!('name' in item) || !('path' in item) || Object.keys(item).some(k => k !== 'name' && k !== 'path')) return UNKNOWN;
  const { name, path } = item;
  if (typeof name !== 'string' || typeof path !== 'string') return UNKNOWN;
  if (i >= MAX_DIMENSIONS) return `维度最多 ${MAX_DIMENSIONS} 个，请在 YAML 里修改`;
  return dimIsPath(path) ? DIM_PATH_REASON : { name, path };
}

/** 指标定义 YAML → 表单状态：认不出的写法只读并说明原因，原始值原样保留（fields 与 formToYaml 对称；读出取值都按字符串收，不需要字段表） */
export function yamlToForm(text: string, fields: FormField[]): MetricForm {
  void fields;
  const whole = (reason: string): MetricForm => ({ base: '', agg: 'count', filter: [], dimensions: [], readonly: [{ key: '$yaml', reason, raw: text }] });
  const doc = parseDocument(text);
  if (doc.errors.length) return whole(`YAML 语法错误：${doc.errors[0]!.message.split('\n')[0]}，请在 YAML 里修改`);
  const v = doc.toJS();
  const baseName = (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>).base : undefined);
  if (typeof baseName !== 'string') return whole('定义要写成带 base（基础实体）的对象，请在 YAML 里修改');
  const top = v as Record<string, unknown>;
  const readonly: ReadonlyItem[] = [];
  const form: MetricForm = { base: baseName, agg: 'count', filter: [], dimensions: [], readonly };
  for (const [k, val] of Object.entries(top)) {
    if (['base', 'measure', 'filter', 'window', 'dimensions', 'description'].includes(k)) continue;
    readonly.push({ key: k, reason: TOP_REASON[k] ?? `不认识的键 ${k}，请在 YAML 里修改`, raw: val });
  }
  const m = top.measure;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    readonly.push({ key: 'measure', reason: m === undefined ? '没有度量（measure），请在 YAML 里修改' : UNKNOWN, raw: m });
  } else {
    const { agg, field, by, numerator, denominator, ...rest } = m as Record<string, unknown>;
    if (Object.keys(rest).length || typeof agg !== 'string' || !(AGGS as readonly string[]).includes(agg)) {
      readonly.push({ key: 'measure', reason: UNKNOWN, raw: m });
    } else {
      form.agg = agg as MetricForm['agg'];
      if (agg === 'ratio') {
        form.numerator = readPart(numerator, 'numerator', readonly);
        form.denominator = readPart(denominator, 'denominator', readonly);
      } else {
        if (field !== undefined) {
          if (typeof field === 'string' && !fieldIsPath(field)) form.field = field;
          else readonly.push({ key: 'measure.field', reason: typeof field === 'string' ? PATH_REASON : UNKNOWN, raw: field });
        }
        if (by !== undefined) {
          if (typeof by === 'string' && !fieldIsPath(by)) form.by = by;
          else readonly.push({ key: 'measure.by', reason: typeof by === 'string' ? PATH_REASON : UNKNOWN, raw: by });
        }
      }
    }
  }
  form.filter = readFilter(top.filter, 'filter', readonly);
  const w = top.window;
  if (w !== undefined) {
    const item = typeof w === 'object' && w !== null && !Array.isArray(w) ? w as Record<string, unknown> : undefined;
    const { field: wf, days } = item ?? {};
    if (item && Object.keys(item).every(k => k === 'field' || k === 'days') && typeof wf === 'string' && !fieldIsPath(wf) && typeof days === 'number') form.window = { field: wf, days };
    else readonly.push({ key: 'window', reason: item && typeof wf === 'string' && fieldIsPath(wf) ? PATH_REASON : UNKNOWN, raw: w });
  }
  const ds = top.dimensions;
  if (ds !== undefined) {
    if (!Array.isArray(ds)) readonly.push({ key: 'dimensions', reason: UNKNOWN, raw: ds });
    else for (const [i, d] of ds.entries()) {
      const read = readDimension(d, i);
      if (typeof read === 'string') readonly.push({ key: `dimensions.${i}`, reason: read, raw: d });
      else form.dimensions.push(read);
    }
  }
  if (top.description !== undefined) {
    if (typeof top.description === 'string') form.description = top.description;
    else readonly.push({ key: 'description', reason: UNKNOWN, raw: top.description });
  }
  return form;
}

/** 表单里的取值按字段类型写成 YAML 的值：数字字段写数字，布尔写 true / false，日期、时间与文本写字符串；is_null / not_null 不写 value */
function valueOf(cond: Cond, fields: Map<string, FormField>): string | number | boolean | (string | number | boolean)[] | undefined {
  if (noValue(cond.op)) return undefined;
  const type = fields.get(cond.field)?.type;
  const one = (v: string): string | number | boolean => {
    if (type !== undefined && NUMERIC_TYPES.includes(type) && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    if (type === 'boolean' && (v === 'true' || v === 'false')) return v === 'true';
    return v;
  };
  if (Array.isArray(cond.value)) return cond.value.map(one);
  return cond.value === undefined ? undefined : one(cond.value);
}

/** 过滤列表写成 YAML：每条 field、op，要写 value 的按字段类型转换后带上 */
const condsOut = (conds: readonly Cond[], fields: Map<string, FormField>) => conds.map(c => {
  const value = valueOf(c, fields);
  return { field: c.field, op: c.op, ...(value !== undefined ? { value } : {}) };
});

/** 列表里只读的条目（key 为 `${at}.<下标>`）按原下标放回 holder[key]，表单里的条目按顺序填进剩下的位置 */
function placeBack(holder: Record<string, unknown>, key: string, at: string, readonly: readonly ReadonlyItem[]): void {
  const raws = new Map<number, unknown>();
  for (const r of readonly) {
    const i = r.key.startsWith(`${at}.`) ? r.key.slice(at.length + 1) : '';
    if (/^\d+$/.test(i)) raws.set(Number(i), r.raw);
  }
  if (!raws.size) return;
  const built = ((holder[key] as unknown[] | undefined) ?? []).slice();
  const out: unknown[] = [];
  for (let i = 0; i <= Math.max(...raws.keys()); i++) {
    const raw = raws.get(i);
    if (raw !== undefined) out.push(raw);
    else if (built.length) out.push(built.shift()!);
  }
  holder[key] = [...out, ...built];
}

/** 表单 → 指标定义 YAML：只写当前 agg 适用的键（切换 agg 后不适用的键自然丢掉），只读项用 raw 原样写回 */
export function formToYaml(form: MetricForm, fields: FormField[]): string {
  const whole = form.readonly.find(r => r.key === '$yaml');
  if (whole) return String(whole.raw);
  const byName = new Map(fields.map(f => [f.name, f]));
  const ratioOf = (p: RatioForm | undefined): Record<string, unknown> => p === undefined
    ? { agg: 'count' }
    : { agg: p.agg, ...(p.field !== undefined ? { field: p.field } : {}), ...(p.filter.length ? { filter: condsOut(p.filter, byName) } : {}) };
  const measure: Record<string, unknown> = form.agg === 'ratio'
    ? { agg: form.agg, numerator: ratioOf(form.numerator), denominator: ratioOf(form.denominator) }
    : { agg: form.agg, ...(form.field !== undefined ? { field: form.field } : {}), ...((form.agg === 'latest' || form.agg === 'earliest') ? { by: form.by } : {}) };
  const spec: Record<string, unknown> = {
    base: form.base,
    measure,
    ...(form.filter.length ? { filter: condsOut(form.filter, byName) } : {}),
    ...(form.window ? { window: { field: form.window.field, days: form.window.days } } : {}),
    ...(form.dimensions.length ? { dimensions: form.dimensions.map(d => ({ name: d.name, path: d.path })) } : {}),
    ...(form.description !== undefined ? { description: form.description } : {}),
  };
  for (const key of ['filter', 'dimensions'] as const) placeBack(spec, key, key, form.readonly);
  // measure 里的只读项放回：整个 measure 只读时直接写回；否则只放当前 agg 还用得上的位置（ratio 放分子、分母，别的放 field / by）
  const find = (key: string) => form.readonly.find(r => r.key === key);
  const wholeMeasure = find('measure');
  if (wholeMeasure) spec.measure = wholeMeasure.raw;
  else if (form.agg === 'ratio') {
    for (const at of ['numerator', 'denominator'] as const) {
      const wholePart = find(`measure.${at}`);
      if (wholePart) {
        measure[at] = wholePart.raw;
        continue;
      }
      const part = measure[at] as Record<string, unknown>;
      for (const k of ['field', 'filter'] as const) {
        const r = find(`measure.${at}.${k}`);
        if (r) part[k] = r.raw;
      }
      placeBack(part, 'filter', `measure.${at}.filter`, form.readonly);
    }
  } else {
    const field = find('measure.field');
    if (field) measure.field = field.raw;
    const by = find('measure.by');
    if (by && (form.agg === 'latest' || form.agg === 'earliest')) measure.by = by.raw;
  }
  // 其余只读项是顶层键，原样写回
  for (const r of form.readonly) {
    if (r.key === '$yaml' || r.key === 'measure' || r.key.startsWith('measure.') || /^(filter|dimensions)\.\d+$/.test(r.key)) continue;
    spec[r.key] = r.raw;
  }
  return stringify(spec);
}

/** 字段的中文名（没有就用字段名） */
const labelOf = (name: string, fields: readonly FormField[]) => fields.find(f => f.name === name)?.label ?? name;

/** 取值在摘要里的显示：列表用「、」连接 */
const show = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join('、') : (v ?? ''));

const FILTER_TEXT = {
  eq: (v: string) => `等于 ${v}`,
  ne: (v: string) => `不等于 ${v}`,
  in: (v: string) => `在 ${v} 中`,
  not_in: (v: string) => `不在 ${v} 中`,
  gt: (v: string) => `大于 ${v}`,
  gte: (v: string) => `大于等于 ${v}`,
  lt: (v: string) => `小于 ${v}`,
  lte: (v: string) => `小于等于 ${v}`,
  is_null: () => '为空',
  not_null: () => '不为空',
} satisfies Record<(typeof FILTER_OPS)[number], (v: string) => string>;

/** 过滤条件逐条中文化；mark 给 ratio 分子、分母自己的过滤加前缀 */
const filterTexts = (conds: readonly Cond[], fields: readonly FormField[], mark = '') =>
  conds.map(c => `${mark}${labelOf(c.field, fields)} ${FILTER_TEXT[c.op](show(c.value))}`.trim());

/** 第一句的主体：聚合与字段（用中文名）；ratio 写成「分子…÷ 分母…」 */
function measurePhrase(form: MetricForm, fields: readonly FormField[]): string {
  const label = (name: string | undefined) => name === undefined ? '' : labelOf(name, fields);
  const count = (field: string | undefined) => field === undefined ? '行数' : `${label(field)}不为空的行数`;
  if (form.agg === 'ratio') {
    const part = (p: RatioForm | undefined) => {
      if (p === undefined) return '';
      if (p.agg === 'count') return count(p.field);
      return p.agg === 'count_distinct' ? `${label(p.field)}的不同取值个数` : `${label(p.field)}求和`;
    };
    return `分子${part(form.numerator)} ÷ 分母${part(form.denominator)}`;
  }
  const phrase: Record<Exclude<(typeof AGGS)[number], 'ratio'>, () => string> = {
    count: () => count(form.field),
    count_distinct: () => `${label(form.field)}的不同取值个数`,
    sum: () => `${label(form.field)}求和`,
    avg: () => `${label(form.field)}平均值`,
    min: () => `${label(form.field)}最小值`,
    max: () => `${label(form.field)}最大值`,
    latest: () => `按${label(form.by)}取最新一行的${label(form.field)}`,
    earliest: () => `按${label(form.by)}取最早一行的${label(form.field)}`,
    days_since: () => `距${label(form.field)}最近一天的天数`,
  };
  return phrase[form.agg]();
}

/**
 * 指标表单的四句摘要：① 计算什么（聚合与字段）② 排除什么（顶层与 ratio 分子、分母的过滤逐条中文化，多条用「并且」，没有时「不排除任何记录」）
 * ③ 按什么时间（「近 N 天，按 xx 时间」，没有时「不限时间」）④ ratio 时「分母为 0 或为空时结果记为空」（与 compileMetric 的 NULLIF 一致）；非 ratio 时省略，返回三句
 */
export function summarize(form: MetricForm, fields: readonly FormField[]): string[] {
  const conds = [
    ...filterTexts(form.filter, fields),
    ...filterTexts(form.numerator?.filter ?? [], fields, '分子里 '),
    ...filterTexts(form.denominator?.filter ?? [], fields, '分母里 '),
  ];
  return [
    `计算${measurePhrase(form, fields)}。`,
    conds.length ? `排除${conds.join('并且')}的记录。` : '不排除任何记录。',
    form.window ? `近 ${form.window.days} 天，按${labelOf(form.window.field, fields)}。` : '不限时间。',
    ...(form.agg === 'ratio' ? ['分母为 0 或为空时结果记为空。'] : []),
  ];
}
