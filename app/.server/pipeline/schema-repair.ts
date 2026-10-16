// app/.server/pipeline/schema-repair.ts —— 源列改名后按规则起草修复（ADR-0034）：对照被删除的列（改名前的采集结果）与本次新增的列
// （改名后的采集结果）的列统计猜测改名，再把映射 YAML 里引用旧列名的表达式改成新列名并加注释写明依据。纯函数，不调用模型、不读平台库；
// 依据只写种类（类型相同、取值范围相同等），不写取值
import { isMap, isScalar, parseDocument, type Scalar, type YAMLMap } from 'yaml';
import { ExprError, parseExpression, ref, referencedColumns } from '../../lib/mapping-expr';
import type { ColumnProfile } from './source-engine';

/** 猜出的一次改名：依据（几项相近的种类）与其余候选列名 */
export interface Rename { from: string; to: string; reason: string; others: string[] }

/** 两个取值按数值比较（都是数值时），否则按文本比较（时间是 ISO 文本，按文本比较即按时间先后） */
function compare(a: string, b: string) {
  const x = Number(a), y = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 新增的列 b 与被删除的列 a 相近的几项与得分；类型不同或没有一项相近时为 null */
function similarity(a: ColumnProfile, b: ColumnProfile): { score: number; reasons: string[] } | null {
  if (a.type !== b.type) return null;
  const reasons: string[] = [];
  let score = 0;
  if (a.top?.length && b.top?.length) {
    const values = new Set(a.top.map(t => t.value));
    const share = b.top.filter(t => values.has(t.value)).length / Math.min(a.top.length, b.top.length);
    if (share >= 0.5) {
      score += 2 * share;
      reasons.push(share === 1 ? '常见取值相同' : '常见取值大部分相同');
    }
  }
  if (a.min !== null && a.max !== null && b.min !== null && b.max !== null) {
    if (a.min === b.min && a.max === b.max) {
      score += 2;
      reasons.push('取值范围相同');
    } else if (compare(a.min, b.max) <= 0 && compare(b.min, a.max) <= 0) {
      score += 1;
      reasons.push('取值范围重叠');
    }
  }
  if (a.length && b.length) {
    if (a.length.min === b.length.min && a.length.max === b.length.max) {
      score += 1;
      reasons.push('长度范围相同');
    } else if (a.length.min <= b.length.max && b.length.min <= a.length.max) {
      score += 0.5;
      reasons.push('长度范围重叠');
    }
  }
  if (Math.abs(a.nullRate - b.nullRate) <= 0.1) {
    score += 0.5;
    reasons.push('空值率相近');
  }
  return reasons.length ? { score, reasons: [`类型相同（${a.type}）`, ...reasons] } : null;
}

/**
 * 猜测被删除的列各改名成了哪一列：候选只从新增的列里找，类型必须完全相同，且常见取值、取值范围、长度范围、空值率至少有一项相近。
 * 按得分从高到低配对，一列新列只给一列旧列；一个候选也没有的旧列不在结果里
 */
export function guessRenames(removed: ColumnProfile[], added: ColumnProfile[]): Rename[] {
  const pairs = removed.flatMap(r => added.flatMap(a => {
    const s = similarity(r, a);
    return s ? [{ from: r.name, to: a.name, ...s }] : [];
  }));
  pairs.sort((x, y) => y.score - x.score);
  const taken = new Set<string>();
  const renames: Rename[] = [];
  for (const p of pairs) {
    if (taken.has(p.to) || renames.some(r => r.from === p.from)) continue;
    taken.add(p.to);
    renames.push({ from: p.from, to: p.to, reason: p.reasons.join('、'), others: pairs.filter(o => o.from === p.from && o.to !== p.to).map(o => o.to) });
  }
  return removed.flatMap(r => renames.filter(x => x.from === r.name));
}

/** 表达式里字段名记号在 offset 处的长度：带双引号时到配对的结束引号（内部的引号写两遍） */
function tokenLength(src: string, offset: number, name: string) {
  if (src[offset] !== '"') return name.length;
  let i = offset + 1;
  while (i < src.length) {
    if (src[i] === '"' && src[i + 1] === '"') i += 2;
    else if (src[i] === '"') return i + 1 - offset;
    else i++;
  }
  return src.length - offset;
}

/** 把表达式里引用的旧列名换成新列名，返回新表达式与用到的改名；解析不了的表达式不改 */
function rewriteExpression(src: string, renames: Rename[]): { text: string; used: Rename[] } {
  let refs: { name: string; offset: number }[];
  try {
    refs = referencedColumns(parseExpression(src));
  } catch (e) {
    if (e instanceof ExprError) return { text: src, used: [] };
    throw e;
  }
  let text = src;
  const used = new Set<Rename>();
  for (const c of [...refs].sort((x, y) => y.offset - x.offset)) {
    const rename = renames.find(r => r.from === c.name);
    if (!rename) continue;
    text = text.slice(0, c.offset) + ref(rename.to) + text.slice(c.offset + tokenLength(text, c.offset, c.name));
    used.add(rename);
  }
  return { text, used: renames.filter(r => used.has(r)) };
}

/** 改名的依据与其余候选（草稿注释与邮件共用） */
export const describeRename = (r: Rename) => `${r.reason}${r.others.length ? `；其他候选：${r.others.join('、')}` : ''}`;

const comment = (used: Rename[]) => ` ${used.map(r => `平台猜测 ${r.from} 改名为 ${r.to}：${describeRename(r)}`).join('；')}`;

/**
 * 把映射 YAML 里 fields（字符串写法或 expr）、extensions 的 expr 与 where 中引用的旧列名换成新列名，被改的表达式加行尾注释写明依据与其余候选（原有的行尾注释保留在后面）。
 * 流式写法（{ expr: … }）的注释加在整行末尾
 */
export function rewriteMappingYaml(yaml: string, renames: Rename[]): string {
  const doc = parseDocument(yaml);
  const rewrite = (node: unknown, commentOn?: { comment?: string | null }) => {
    if (!isScalar(node) || typeof node.value !== 'string') return;
    const { text, used } = rewriteExpression(node.value, renames);
    if (!used.length) return;
    (node as Scalar).value = text;
    // 原有的行尾注释（如模板里的「标准枚举：…」）接在后面，不覆盖
    const target = commentOn ?? node;
    target.comment = target.comment?.trim() ? `${comment(used)}；${target.comment.trim()}` : comment(used);
  };
  const rewriteField = (value: unknown) => {
    if (isMap(value)) rewrite(value.get('expr', true), (value as YAMLMap).flow ? value : undefined);
    else rewrite(value);
  };
  for (const key of ['fields', 'extensions']) {
    const section = doc.get(key, true);
    if (isMap(section)) for (const pair of section.items) rewriteField(pair.value);
  }
  rewrite(doc.get('where', true));
  return doc.toString();
}
