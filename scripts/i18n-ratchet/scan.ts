// scripts/i18n-ratchet/scan.ts —— 未接入翻译的中文文案扫描与棘轮比较（ADR-0060，#929）：纯函数，不读文件系统，
// CLI（scripts/i18n-ratchet.ts，pnpm i18n:ratchet）与 test/i18n-ratchet.test.ts 共用。
// 计数口径（票里已拍板）：app/**/*.{ts,tsx} 里含汉字（\p{Script=Han}）的非注释行，按行计（一行几处都算 1）；
// 字符串、模板、JSX 文本、正则里的汉字都算，console.*、内部 throw、助手提示词、同义词表不豁免；
// // 行注释（含行尾）、/* */ 块注释（含 JSX 的 {/* */}）与 t()/msg() 第一个参数的字符串字面量（翻译键）不计。
// 手写逐字符状态机，不引解析器依赖（typescript ^7 没有 JS 编译器 API）：JSX 文本里的英文撇号（Don't）会误入
// 字符串、正则里的 // 会当除法，都有少量误计——基线与实际用同一扫描器，误差不影响棘轮。
// SQL 模板里的 -- 不当注释处理（会计入），是有意的简单化。
import { cmp } from '../../app/lib/compare';

/** 一行未接入翻译的中文：line 从 1 开始，text 是该行 trim 后的内容 */
export interface UntranslatedLine { line: number; text: string }

const HAN = /\p{Script=Han}/u;
/** 字符串字面量紧前的代码文本以此结尾，这个字面量就是 t()/msg() 的翻译键（与 test/i18n-catalog.test.ts 的 checkUsages 同口径） */
const KEY_CALL = /\b(?:t|msg)\(\s*$/;

type State = 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template';

/**
 * 扫描一段源码，返回计入棘轮的行（按行号升序）。
 * 状态机：code / 行注释 / 块注释 / '…' / "…" / `…`；模板里 ${ 回到 code，用栈记每个插值的花括号深度，
 * \ 转义在字符串里跳过下一字符。进字符串时看此前的代码文本是不是刚开了 t(/msg(，是则整个字面量（含插值）不计。
 */
export function untranslatedLines(source: string): UntranslatedLine[] {
  const lines = source.split('\n');
  const found = new Map<number, string>();
  const mark = (line: number): void => { if (!found.has(line)) found.set(line, (lines[line - 1] ?? '').trim()); };
  let state: State = 'code';
  let line = 1;
  /** 最近一段代码文本（不含字符串、模板体与注释；跨行保留），进字符串时只用它的结尾判断翻译键 */
  let codeTail = '';
  /** 当前字符串字面量是不是翻译键；${ 回到 code 时存进 frameKeys，} 回模板时恢复 */
  let stringKey = false;
  /** 每个 open 的 ${ 插值的花括号深度（栈底是最外层模板），frameKeys 平行存对应模板是不是翻译键 */
  const frames: number[] = [];
  const frameKeys: boolean[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '\n') { line++; codeTail += ch; continue; }
      if (ch === "'" || ch === '"' || ch === '`') {
        stringKey = KEY_CALL.test(codeTail);
        if (ch === "'") state = 'single';
        else if (ch === '"') state = 'double';
        else state = 'template';
      } else if (ch === '/' && next === '/') { state = 'line-comment'; i++; }
      else if (ch === '/' && next === '*') { state = 'block-comment'; i++; }
      else if (ch === '{' && frames.length > 0) { frames[frames.length - 1]++; codeTail += ch; }
      else if (ch === '}' && frames.length > 0) {
        if (frames[frames.length - 1] > 0) frames[frames.length - 1]--;
        else { frames.pop(); stringKey = frameKeys.pop()!; state = 'template'; }
      } else {
        if (HAN.test(ch)) mark(line);
        codeTail += ch;
        if (codeTail.length > 128) codeTail = codeTail.slice(-64);
      }
    } else if (state === 'line-comment') {
      if (ch === '\n') state = 'code';
    } else if (state === 'block-comment') {
      if (ch === '*' && next === '/') { state = 'code'; i++; }
    } else if (state === 'single' || state === 'double') {
      if (ch === '\\') i++;
      else if (ch === (state === 'single' ? "'" : '"')) state = 'code';
      else if (HAN.test(ch) && !stringKey) mark(line);
    } else { // template
      if (ch === '\\') i++;
      else if (ch === '`') state = 'code';
      else if (ch === '$' && next === '{') { frames.push(0); frameKeys.push(stringKey); state = 'code'; i++; }
      else if (HAN.test(ch) && !stringKey) mark(line);
    }
    if (ch === '\n') line++;
  }
  return [...found].map(([line, text]) => ({ line, text }));
}

/**
 * 实际计数对基线：某文件比基线多（含基线里没有的新文件）时，increased 先给一条汇总再列出该文件全部计数行
 * （file:line 文本）；比基线少（含计数归零与文件已删）时，decreased 给一条汇总。actual 的键序决定 increased 的顺序。
 */
export function compare(baseline: Record<string, number>, actual: Map<string, UntranslatedLine[]>): { increased: string[]; decreased: string[] } {
  const increased: string[] = [];
  for (const [file, lines] of actual) {
    const base = baseline[file] ?? 0;
    if (lines.length > base) {
      increased.push(`${file} 基线 ${base}，实际 ${lines.length}`);
      for (const { line, text } of lines) increased.push(`${file}:${line} ${text}`);
    }
  }
  const decreased = Object.entries(baseline)
    .filter(([file, base]) => base > (actual.get(file)?.length ?? 0))
    .map(([file, base]) => `${file} 基线 ${base}，实际 ${actual.get(file)?.length ?? 0}`);
  return { increased, decreased };
}

/** --update 算出的新基线：只列计数 > 0 的文件，键按字母序。有增加而不允许时拒绝（increased 与 compare 同格式） */
export function updatedBaseline(
  baseline: Record<string, number>,
  actual: Map<string, UntranslatedLine[]>,
  allowIncrease: boolean,
): { ok: true; files: Record<string, number> } | { ok: false; increased: string[] } {
  const { increased } = compare(baseline, actual);
  if (increased.length && !allowIncrease) return { ok: false, increased };
  const files: Record<string, number> = {};
  for (const [file, lines] of [...actual.entries()].sort(([a], [b]) => cmp(a, b))) {
    if (lines.length > 0) files[file] = lines.length;
  }
  return { ok: true, files };
}

/** 单独成组的 ops 页面：ops 首页、各 ops 子页、外壳与运营者登录（ADR-0060：/ops 在正式开放之后单独完成） */
const OPS_FILES = new Set(['app/routes/ops.tsx', 'app/components/ops-shell.tsx', 'app/.server/ops-auth.ts']);

/** 文件所属的目录组（file 相对仓库根、/ 分隔）：/ops 一组，其余按 app/ 下前两级目录，根上的文件归 app */
export function bucketOf(file: string): string {
  if (OPS_FILES.has(file) || file.startsWith('app/routes/ops.')) return '/ops';
  const dirs = file.split('/').slice(1, -1); // 去掉开头的 app 与文件名，剩下目录
  return ['app', ...dirs.slice(0, 2)].join('/');
}

/** 按目录汇总文件数与行数（组名排序），末尾附「/ops 以外合计」与「总计」，看剩余量是否达到开放标准 */
export function summarize(actual: Map<string, UntranslatedLine[]>): { bucket: string; files: number; lines: number }[] {
  const byBucket = new Map<string, { files: number; lines: number }>();
  for (const [file, lines] of actual) {
    const bucket = byBucket.get(bucketOf(file)) ?? { files: 0, lines: 0 };
    bucket.files++;
    bucket.lines += lines.length;
    byBucket.set(bucketOf(file), bucket);
  }
  const rows = [...byBucket.entries()].map(([bucket, { files, lines }]) => ({ bucket, files, lines }))
    .sort((a, b) => cmp(a.bucket, b.bucket));
  const sum = (pick: typeof rows): { files: number; lines: number } =>
    ({ files: pick.reduce((n, r) => n + r.files, 0), lines: pick.reduce((n, r) => n + r.lines, 0) });
  const nonOps = sum(rows.filter((r) => r.bucket !== '/ops'));
  const total = sum(rows); // 此刻 rows 还只有目录组
  rows.push({ bucket: '/ops 以外合计', ...nonOps });
  rows.push({ bucket: '总计', ...total });
  return rows;
}
