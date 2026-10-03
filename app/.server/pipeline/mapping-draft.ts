// app/.server/pipeline/mapping-draft.ts —— 按规则生成映射草稿：源表的列统计 + 目标实体 → 映射 YAML，不调用模型、不从历史映射里学（ADR-0017）。
// 列名规范化后按同名与同义词对应到标准字段，再用类型与格式特征校验；按需加上分转元、毫秒时间戳、时区解读等转换，枚举字段按常见取值生成值字典骨架。
// 每条对应的依据写在行尾注释里，没对应上的标准字段与没用到的源列列在文末。生成的只是草稿，仍要保存校验、双人发布（ADR-0015）
import { Document, Scalar, YAMLMap } from 'yaml';
import { MODEL_MAJOR, type CanonicalEntity, type CanonicalField } from '../../lib/canonical-model';
import { CENTS_SUFFIX, extensionName, fieldsForColumn, normalizeName, standardValue } from '../../lib/field-synonyms';
import { extensionSpec, kindOf, ref } from '../../lib/mapping-expr';
import type { ColumnProfile, TableProfile, TextFormat } from './source-engine';

export interface DraftOptions {
  /** 不带时区的时间按哪个时区解读（默认 Asia/Shanghai） */
  timezone?: string;
  /** 源表没有主键时成员声明的业务主键 */
  key?: string[];
}

/** 要求列有相应格式特征的字段（敏感信息对错了就打通错人） */
const REQUIRED_FORMAT: Record<string, { format: TextFormat; label: string }> = {
  phone: { format: 'mobile', label: '手机号' },
  email: { format: 'email', label: '邮箱' },
};
const FORMAT_LABELS: Partial<Record<TextFormat, string>> = { integer: '整数', decimal: '小数', date: '日期', datetime: '时间' };

/** Unix 毫秒与秒时间戳的合理取值范围（2000 年到 2100 年） */
const MILLIS = [946_684_800_000, 4_102_444_800_000];
const SECONDS = [946_684_800, 4_102_444_800];

const hasFormat = (c: ColumnProfile, format: TextFormat) => !!c.formats?.some(f => f.format === format);
const within = (c: ColumnProfile, [lo, hi]: number[]) => {
  const min = Number(c.min);
  const max = Number(c.max);
  return c.min !== null && c.max !== null && min >= lo && max <= hi;
};

type Converted = { expr: string; notes: string[] } | { rejected: string };

/** 源列转成标准字段的表达式与依据；类型或格式对不上时给出原因 */
function convert(field: CanonicalField, c: ColumnProfile, tz: string): Converted {
  const col = ref(c.name);
  const kind = kindOf(c.type);
  const notes: string[] = [];
  const required = REQUIRED_FORMAT[field.name];
  if (required) {
    if (!hasFormat(c, required.format)) return { rejected: `列 ${c.name} 的格式特征不是${required.label}（可能带空格、区号或不足一半的样本符合），请确认后手动对应` };
    notes.push(`格式：${required.label}`);
  }
  const fromText = (format: TextFormat, expr: string) =>
    (kind === 'text' && hasFormat(c, format) ? { expr, notes: [...notes, `格式：${FORMAT_LABELS[format]}`] } : null);
  const local = (expr: string): Converted => ({ expr: `from_timezone(${expr}, '${tz}')`, notes: [...notes, `不带时区，按 ${tz} 解读，请确认源端时区`] });
  const cents = CENTS_SUFFIX.test(normalizeName(c.name));
  const rejected = { rejected: `列 ${c.name}（${c.type}）与${field.label}的类型对不上` };

  switch (field.type) {
    case 'string':
      return { expr: kind === 'text' ? col : `string(${col})`, notes };
    case 'integer':
      if (kind === 'int') return { expr: col, notes };
      return fromText('integer', `integer(${col})`) ?? rejected;
    case 'decimal': {
      const inYuan = (expr: string, n: string[]): Converted => (cents ? { expr: `${expr} / 100`, notes: [...n, '单位：分，除以 100 换成元'] } : { expr, notes: n });
      if (kind === 'int' || kind === 'decimal') return inYuan(col, notes);
      const text = fromText('decimal', `decimal(${col})`) ?? fromText('integer', `decimal(${col})`);
      return text ? inYuan(text.expr, text.notes) : rejected;
    }
    case 'timestamp':
      if (kind === 'tstz') return { expr: col, notes };
      if (kind === 'timestamp' || kind === 'date') return local(col);
      if (kind === 'int' && within(c, MILLIS)) return { expr: `from_epoch_millis(${col})`, notes: [...notes, '取值是 Unix 毫秒时间戳'] };
      if (kind === 'int' && within(c, SECONDS)) return { expr: `from_epoch_seconds(${col})`, notes: [...notes, '取值是 Unix 秒时间戳'] };
      if (kind === 'text' && (hasFormat(c, 'datetime') || hasFormat(c, 'date'))) return local(col);
      return { rejected: `列 ${c.name}（${c.type}）的取值不像时间` };
    case 'date':
      if (kind === 'date') return { expr: col, notes };
      if (kind === 'timestamp' || kind === 'tstz') return { expr: `date(${col})`, notes };
      return fromText('date', `date(${col})`) ?? rejected;
    case 'boolean':
      return kind === 'bool' ? { expr: col, notes } : rejected;
  }
}

interface Mapped { expr: string; reason: string[]; column?: ColumnProfile }

/**
 * 没用到的列写成扩展字段（注释掉放在文末，去掉注释即可保存）：类型按源列换算，不带时区的时间按时区解读；
 * 列名或格式像敏感信息的标成敏感（文本）。列名做不成扩展字段名（中文、特殊字符）时用 x_col_<列序号>
 */
function extensionLines(columns: ColumnProfile[], all: ColumnProfile[], tz: string) {
  const used = new Set<string>();
  const extensions = new YAMLMap();
  for (const c of columns) {
    const name = extensionName(c.name, all.indexOf(c) + 1, used);
    used.add(name);
    const { type, expr, sensitive } = extensionSpec(c, tz);
    const spec = new YAMLMap();
    spec.flow = true;
    spec.set('type', type);
    spec.set('expr', expr);
    if (sensitive) spec.set('sensitive', true);
    extensions.set(name, spec);
  }
  return new Document({ extensions }).toString({ lineWidth: 0, singleQuote: true }).trimEnd().split('\n');
}

/**
 * 按规则生成映射草稿（YAML 文本）。去重：实体主键没有对应上时用源表主键（没有时用成员声明的业务主键，再没有就用整行）拼出来；
 * 源表主键对应到别的字段时声明 dedupe.key
 */
export function draftMapping(table: TableProfile, entity: CanonicalEntity, opts: DraftOptions = {}): string {
  const tz = opts.timezone ?? 'Asia/Shanghai';
  const primaryKey = table.primaryKey?.length ? table.primaryKey : [];
  const sourceKey = primaryKey.length ? primaryKey : (opts.key ?? []);
  const keyLabel = primaryKey.length ? '源表主键' : '业务主键（成员声明）';

  // 同名优先，再按同义词的优先级；每个字段、每个源列只用一次
  const candidates = table.columns
    .flatMap(c => fieldsForColumn(entity.name, c.name).map(m => ({ ...m, column: c })))
    .sort((a, b) => a.rank - b.rank);
  const mapped = new Map<string, Mapped>();
  const used = new Set<string>();
  const rejected = new Map<string, string>();
  for (const { field: name, by, column } of candidates) {
    if (mapped.has(name) || used.has(column.name)) continue;
    const field = entity.fields.find(f => f.name === name)!;
    const result = convert(field, column, tz);
    if ('rejected' in result) {
      if (!rejected.has(name)) rejected.set(name, result.rejected);
      continue;
    }
    mapped.set(name, { expr: result.expr, reason: [by === 'same' ? '同名' : `同义词：${column.name}`, ...result.notes], column });
    used.add(column.name);
  }

  // 实体主键：没对应上时拼出来
  const tail: string[] = [];
  const [entityKey] = entity.key;
  if (entity.key.length === 1 && !mapped.has(entityKey)) {
    const parts = sourceKey.length ? sourceKey : table.columns.map(c => c.name);
    const sep = sourceKey.length ? '-' : '|';
    const expr = parts.length === 1
      ? (kindOf(table.columns.find(c => c.name === parts[0])?.type ?? '') === 'text' ? ref(parts[0]) : `string(${ref(parts[0])})`)
      : `concat(${parts.map(ref).join(`, '${sep}', `)})`;
    const keyHint = table.keyCandidates?.length ? `（可作业务主键的列：${table.keyCandidates.join('、')}）` : '';
    mapped.set(entityKey, {
      expr,
      reason: sourceKey.length
        ? [`${keyLabel} ${sourceKey.join(' + ')}`]
        : [`源表没有主键：用整行拼出，完全相同的行会去重；请确认，或在数据源页声明业务主键${keyHint}`],
    });
    // 整行拼出的键不算用到了各列，其余列仍列在文末
    sourceKey.forEach(p => used.add(p));
  }

  // 源表主键对应到的字段：与实体主键一致时不用声明去重键
  const keyFields = sourceKey.map(k => [...mapped].find(([, m]) => m.column?.name === k)?.[0]);
  let dedupe: string[] | null = null;
  if (sourceKey.length && keyFields.every(Boolean)) {
    if (keyFields.join() !== entity.key.join()) dedupe = keyFields as string[];
    else if (keyFields.length === 1) mapped.get(keyFields[0]!)!.reason.push(keyLabel);
  } else if (sourceKey.length && !mapped.get(entityKey)?.reason[0]?.startsWith(keyLabel)) {
    tail.push(`去重：${keyLabel} ${sourceKey.join(' + ')} 没有都对应到字段，按 ${entity.key.join(' + ')} 去重，请确认它唯一`);
  } else if (!sourceKey.length && mapped.get(entityKey)?.column) {
    tail.push(`去重：源表没有主键，按 ${entity.key.join(' + ')} 去重，请确认它唯一`);
  }

  const doc = new Document({ model: MODEL_MAJOR, entity: entity.name, table: table.name });
  doc.commentBefore = ` 按规则生成的草稿：源表 ${table.name} → ${entity.label}（${entity.name}）。行尾注释是每条对应的依据，请逐项确认后保存`;
  const fields = new YAMLMap();
  for (const field of entity.fields) {
    const m = mapped.get(field.name);
    if (!m) continue;
    const expr = new Scalar(m.expr);
    const top = m.column?.top;
    if (!field.enum) {
      expr.comment = ` ${m.reason.join('；')}`;
      fields.set(field.name, expr);
    } else if (!top?.length) {
      expr.comment = ` ${[...m.reason, `没有常见取值，请补上值字典（标准值：${field.enum.join('、')}）`].join('；')}`;
      fields.set(field.name, expr);
    } else {
      expr.comment = ` ${[...m.reason, '值字典按常见取值生成'].join('；')}`;
      const dictionary = new YAMLMap();
      for (const { value } of top) {
        const to = new Scalar(standardValue(entity.name, field.name, value) ?? null);
        if (to.value === null) to.comment = ` 待填：${field.enum.join('、')}`;
        dictionary.set(value, to);
      }
      const spec = new YAMLMap();
      spec.set('expr', expr);
      spec.set('dictionary', dictionary);
      fields.set(field.name, spec);
    }
  }
  (doc.contents as YAMLMap).set('fields', fields);
  if (dedupe) {
    const key = doc.createNode(dedupe);
    key.flow = true;
    (doc.contents as YAMLMap).set('dedupe', doc.createNode({ key }));
  }

  const unmapped = entity.fields.filter(f => !mapped.has(f.name));
  if (unmapped.length) {
    tail.push('没有对应上的标准字段：');
    for (const f of unmapped) tail.push(`  ${f.name}（${f.label}）${rejected.has(f.name) ? `：${rejected.get(f.name)}` : ''}`);
  }
  const extra = table.columns.filter(c => !used.has(c.name));
  if (extra.length) {
    tail.push(`源表里没用到的列：${extra.map(c => `${c.name}（${c.type}）`).join('、')}。要保留时去掉下面的注释（扩展字段，类型已按源列换算）：`);
    tail.push(...extensionLines(extra, table.columns, tz));
  }
  if (tail.length) doc.comment = tail.map(l => ` ${l}`).join('\n');
  return doc.toString({ nullStr: '', lineWidth: 0 });
}
