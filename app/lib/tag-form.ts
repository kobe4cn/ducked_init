// app/lib/tag-form.ts —— 标签表单 ↔ TagSpec YAML 的互转（纯函数，前后端共用；校验在 .server/pipeline/dsl/tag-spec.ts 的 checkTag，
// 这里不重复校验语义，只保证表单生成的 YAML 结构合法）。表单只有一层 all / any（ADR-0025）：单指标写法（顶层 metric）在表单里是
// 每条规则一个 item、指标取顶层；多指标写法每条规则选 all 或 any，item 是「指标 + 比较」，同一 item 的多个比较是 AND。
// YAML → 表单：认不出的写法（all 与 any 同写、未知键、嵌套、比较值不是数字、when 不是对象、不认识的顶层键）把整条规则或整个键
// 标成只读并说明原因，原始值原样保存在 readonly[].raw 里，formToYaml 原样写回，保证往返不丢信息（ADR-0017：YAML 仍是唯一格式）。
// 表单 → YAML 前先规整：丢掉空规则（取值为空或没有留下 item）、空 item（没选指标或没有一个比较）、NaN 比较；
// value / default 是纯数字字符串时写成 number，否则 string；missing 只写规则里引用到的指标（写了未引用的会被 checkTag 拦）。
// 只能 import app/lib 里的东西（.server 的只能 import type）
import { parseDocument, stringify } from 'yaml';
import type { ReadonlyItem } from './metric-form';
import { TAG_CONDITIONS, type TagCondition } from './tag-vocab';

/** 一条规则的条件行：指标与它上面的比较（至少一个；同一行多个比较是 AND） */
export interface TagItem { metric: string; cmp: { op: TagCondition; value: number }[] }

/** 一条规则：命中时给出的取值与条件（多指标时选 all 全部满足 / any 任一满足，只一层） */
export interface TagRule { value: string | number; combinator: 'all' | 'any'; items: TagItem[] }

/** 标签表单的状态：single 时每条规则只有一个 item、指标取顶层 metric；readonly 是表单表达不了的写法 */
export interface TagForm {
  single: boolean;
  /** 单指标写法引用的指标键 */
  metric?: string;
  rules: TagRule[];
  /** 每个被引用指标的缺值策略：不写（缺省）、数字（按数值）或 null（记空） */
  missing: Record<string, number | null>;
  default: string | number | '';
  description?: string;
  readonly: ReadonlyItem[];
}

const UNKNOWN = '这种写法表单不认识，请在 YAML 里修改';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCondition = (v: unknown): v is TagCondition => typeof v === 'string' && (TAG_CONDITIONS as readonly string[]).includes(v);
/** 取值或默认值为空（checkTag 的 blank：字符串去空白后是空串） */
const blank = (v: string | number | '') => String(v).trim() === '';
/** 纯数字的输入（`/^-?\d+(\.\d+)?$/`）写成 number，其余（如 007、高）保持 string */
const numOf = (v: string | number): string | number => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v);

/** 一段比较（when 平铺或 item 里除 metric 外的部分）：键都在词表里、取值都是数字才算认得；认得的比较按词表顺序读回 */
function readCmp(v: unknown): { op: TagCondition; value: number }[] | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const entries = Object.entries(v as Record<string, unknown>);
  if (!entries.length || entries.some(([k, val]) => !isCondition(k) || typeof val !== 'number')) return undefined;
  return TAG_CONDITIONS.flatMap(op => {
    const val = (v as Record<string, unknown>)[op];
    return typeof val === 'number' ? [{ op, value: val }] : [];
  });
}

/** 多指标写法的一个 item：metric 是非空字符串 + 认得的比较 */
function readItem(v: unknown): TagItem | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const { metric, ...cmp } = v as Record<string, unknown>;
  if (typeof metric !== 'string' || metric === '') return undefined;
  const read = readCmp(cmp);
  return read === undefined ? undefined : { metric, cmp: read };
}

/**
 * 标签定义 YAML → 表单状态：认不出的写法只读并说明原因，原始值原样保留（与 formToYaml 对称）；
 * 规则里任何一处认不出就把整条规则记只读（raw 是整条规则），写回时按原下标放回
 */
export function yamlToForm(text: string): TagForm {
  const whole = (reason: string): TagForm => ({ single: true, rules: [], missing: {}, default: '', readonly: [{ key: '$yaml', reason, raw: text }] });
  const doc = parseDocument(text);
  if (doc.errors.length) return whole(`YAML 语法错误：${doc.errors[0]!.message.split('\n')[0]}，请在 YAML 里修改`);
  const v = doc.toJS();
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return whole('定义要写成带 rules（规则）的对象，请在 YAML 里修改');
  const top = v as Record<string, unknown>;
  const readonly: ReadonlyItem[] = [];
  const form: TagForm = { single: typeof top.metric === 'string', rules: [], missing: {}, default: '', readonly };
  for (const [k, val] of Object.entries(top)) {
    if (!['metric', 'rules', 'missing', 'default', 'description'].includes(k)) readonly.push({ key: k, reason: `不认识的键 ${k}，请在 YAML 里修改`, raw: val });
  }
  if (top.metric !== undefined && typeof top.metric !== 'string') readonly.push({ key: 'metric', reason: UNKNOWN, raw: top.metric });
  else if (typeof top.metric === 'string') form.metric = top.metric;
  if (top.rules === undefined) readonly.push({ key: 'rules', reason: '没有规则（rules），请在 YAML 里修改', raw: top.rules });
  else if (!Array.isArray(top.rules)) readonly.push({ key: 'rules', reason: UNKNOWN, raw: top.rules });
  else top.rules.forEach((rule, i) => {
    const read = ((): TagRule | string => {
      if (typeof rule !== 'object' || rule === null || Array.isArray(rule)) return UNKNOWN;
      const { value, when, ...rest } = rule as Record<string, unknown>;
      if (Object.keys(rest).length || typeof value !== 'string' && typeof value !== 'number' || typeof when !== 'object' || when === null) return UNKNOWN;
      if (form.single) {
        const cmp = readCmp(when);
        return cmp === undefined ? UNKNOWN : { value, combinator: 'all', items: [{ metric: form.metric ?? '', cmp }] };
      }
      const { all, any, ...whenRest } = when as Record<string, unknown>;
      if (Object.keys(whenRest).length || all !== undefined && any !== undefined) return UNKNOWN;
      const items = (all !== undefined ? all : any);
      if (items === undefined || !Array.isArray(items)) return UNKNOWN;
      const read = items.map(readItem);
      return read.some(item => item === undefined) ? UNKNOWN : { value, combinator: all !== undefined ? 'all' : 'any', items: read as TagItem[] };
    })();
    if (typeof read === 'string') readonly.push({ key: `rules.${i}`, reason: read, raw: rule });
    else form.rules.push(read);
  });
  if (top.missing !== undefined) {
    const ok = typeof top.missing === 'object' && top.missing !== null && !Array.isArray(top.missing)
      && Object.values(top.missing as Record<string, unknown>).every(x => x === null || typeof x === 'number');
    if (ok) form.missing = top.missing as Record<string, number | null>;
    else readonly.push({ key: 'missing', reason: UNKNOWN, raw: top.missing });
  }
  if (top.default === undefined) readonly.push({ key: 'default', reason: '没有 default（都没命中时的取值），请在 YAML 里修改', raw: top.default });
  else if (typeof top.default === 'string' || typeof top.default === 'number') form.default = top.default;
  else readonly.push({ key: 'default', reason: UNKNOWN, raw: top.default });
  if (top.description !== undefined) {
    if (typeof top.description === 'string') form.description = top.description;
    else readonly.push({ key: 'description', reason: UNKNOWN, raw: top.description });
  }
  return form;
}

/** 只读规则 raw 里能读到的指标键：when.all / when.any 里各 item 的 metric（读不出的跳过） */
function rawMetricsOf(raw: unknown): string[] {
  const when = isObj(raw) ? raw.when : undefined;
  if (!isObj(when)) return [];
  return [when.all, when.any].flatMap(list => (Array.isArray(list) ? list : []))
    .flatMap(item => (isObj(item) && typeof item.metric === 'string' ? [item.metric] : []));
}

/** 表单里留下来的条件行（比较的取值是有限数字）；NaN / Infinity 丢掉 */
const cmpOf = (cmp: readonly TagItem['cmp'][number][]) => cmp.filter(c => isCondition(c.op) && typeof c.value === 'number' && Number.isFinite(c.value));

/**
 * 表单 → 标签定义 YAML：先规整（空规则、空 item、空比较丢掉，value / default 纯数字写 number，missing 只写引用到的指标），
 * 只读项用 raw 原样写回（整条规则只读的按原下标放回 rules）
 */
export function formToYaml(form: TagForm): string {
  if (form.readonly.some(r => r.key === '$yaml')) return String(form.readonly.find(r => r.key === '$yaml')!.raw);
  const clean = form.rules.flatMap(rule => {
    if (typeof rule.value !== 'string' && typeof rule.value !== 'number') return [];
    if (blank(rule.value)) return [];
    const items = rule.items.flatMap(item => {
      const metric = form.single ? form.metric : item.metric;
      const cmp = cmpOf(item.cmp);
      return metric && cmp.length ? [{ metric, cmp }] : [];
    });
    // 单指标写法每条规则只有一个 item（指标取顶层 metric），多出来的不写
    const kept = form.single ? items.slice(0, 1) : items;
    return kept.length ? [{ value: numOf(rule.value), combinator: rule.combinator, items: kept }] : [];
  });
  const cmpObj = (item: TagItem) => Object.fromEntries(item.cmp.map(c => [c.op, c.value]));
  const referenced = new Set(clean.flatMap(rule => rule.items.map(item => item.metric)));
  // 只读的整条规则也可能引用指标（单指标看顶层 metric，多指标看 when.all / when.any 里各 item 的 metric），它们的 missing 不能丢
  for (const r of form.readonly) {
    if (!/^rules\.\d+$/.test(r.key)) continue;
    if (form.single) { if (form.metric) referenced.add(form.metric); continue; }
    for (const metric of rawMetricsOf(r.raw)) referenced.add(metric);
  }
  const missing = Object.fromEntries(Object.entries(form.missing).filter(([key]) => referenced.has(key)));
  const spec: Record<string, unknown> = {
    ...(form.single ? { metric: form.metric ?? '' } : {}),
    rules: clean.map(rule => ({
      value: rule.value,
      when: form.single ? cmpObj(rule.items[0]!) : { [rule.combinator]: rule.items.map(item => ({ metric: item.metric, ...cmpObj(item) })) },
    })),
    ...(Object.keys(missing).length ? { missing } : {}),
    default: numOf(form.default),
    ...(form.description !== undefined ? { description: form.description } : {}),
  };
  // 只读的整条规则按原下标放回，表单里的规则按顺序填进剩下的位置
  const raws = new Map<number, unknown>();
  for (const r of form.readonly) {
    const i = r.key.startsWith('rules.') ? r.key.slice('rules.'.length) : '';
    if (/^\d+$/.test(i)) raws.set(Number(i), r.raw);
  }
  if (raws.size) {
    const built = spec.rules as unknown[];
    const out: unknown[] = [];
    for (let i = 0; i <= Math.max(...raws.keys()); i++) {
      const raw = raws.get(i);
      if (raw !== undefined) out.push(raw);
      else if (built.length) out.push(built.shift()!);
    }
    spec.rules = [...out, ...built];
  }
  // 其余只读项是顶层键，原样写回（源定义里没写的键不补）
  for (const r of form.readonly) {
    if (r.key === '$yaml' || /^rules\.\d+$/.test(r.key) || r.raw === undefined) continue;
    spec[r.key] = r.raw;
  }
  return stringify(spec);
}
