// app/.server/interpretation-numbers.ts —— 结果解读的数字核对（#1218，ADR-0043）：解读里的数字必须能在发给模型的 user 消息里找到出处。
// 出处只来自发出去的内容（开关关闭时没发行，不能拿结果行当出处，否则返回值会间接泄露取值），另加 facts 的 maxShare / minShare
// 与出处里数值两两之比（只用于百分比与「N 分之一」）。只核对数值，抓不住「区间说错」这类语义错误。
// 不带 % 或万 / 亿的 0–10 整数（序号、小个数）与日期成分不核对；容差见 matchesNumber，阈值以后可以调

/** 最多报几个找不到出处的数字 */
const MAX_UNCITED = 20;
/** 出处数字超过这么多时，两两之比只用 facts 里的数，免得组合爆炸、比例也几乎什么都能对上 */
const MAX_RATIO_SOURCES = 200;
const EPS = 1e-9;

const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 二十: 20, 百: 100 };

/**
 * 解读里的数字记号，按出现顺序取：日期（整段跳过）、「N 分之一」、「1/N」、数字（可带 % / 万 / 亿，或紧跟年月日号时）。
 * 「分之一」前不能紧挨别的中文数字（「三十分之一」不会被读成十分之一）；数字前不能紧挨字母、下划线或小数点（revenue_365d、v1.2 不算）
 */
const TOKEN = new RegExp([
  String.raw`(?<date>\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?(?![\d.]))`,
  String.raw`(?<![一二三四五六七八九十百千万\d])(?<frac>(?:\d+|二十|[一二三四五六七八九十百])分之一)`,
  String.raw`(?<![\d.])(?<slash>1\s*\/\s*(?<den>\d+))(?![\d.])`,
  String.raw`(?<![A-Za-z_\d.])(?<num>-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s*(?<unit>[%％万亿年月日号时]))?`,
].join('|'), 'g');

type Claim =
  | { kind: 'number'; raw: string; value: number; tol: number }
  | { kind: 'percent'; raw: string; percent: number; decimals: number }
  | { kind: 'fraction'; raw: string; n: number };

const MULTIPLIER: Record<string, number> = { 万: 1e4, 亿: 1e8 };

/** 写出来的数字的容差：最后一位非零数字的半个单位与值的 5% 取小，但不小于最后一位写出数字的半个单位（「2100」±50、「2000」±100、「3606」±0.5） */
function tolerance(digits: string, multiplier: number): number {
  const [intPart = '', frac = ''] = digits.replace(/^-/, '').split('.');
  const lastDigitUnit = 10 ** -frac.length;
  const all = intPart + frac;
  const lastNonzero = all.search(/0*$/) - 1;
  const value = Math.abs(Number(digits));
  if (lastNonzero < 0) return (lastDigitUnit / 2) * multiplier;
  const nonzeroUnit = 10 ** (intPart.length - 1 - lastNonzero);
  return Math.max(Math.min(nonzeroUnit / 2, value * 0.05), lastDigitUnit / 2) * multiplier;
}

/** 解读里要核对的数字；跳过的（日期、不带单位的 0–10 整数、粘在标识符上的数字）不在里面 */
function claims(text: string): Claim[] {
  const out: Claim[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const g = m.groups ?? {};
    if (g.date) continue;
    if (g.frac) {
      const head = g.frac.slice(0, -3);
      const n = /^\d+$/.test(head) ? Number(head) : CN_DIGITS[head];
      if (n) out.push({ kind: 'fraction', raw: g.frac, n });
      continue;
    }
    if (g.slash) {
      const n = Number(g.den);
      if (n > 0) out.push({ kind: 'fraction', raw: g.slash, n });
      continue;
    }
    const num = g.num;
    if (!num) continue;
    const unit = g.unit;
    const digits = num.replace(/,/g, '');
    if (unit === '%' || unit === '％') {
      out.push({ kind: 'percent', raw: m[0].replace(/\s+/g, ''), percent: Math.abs(Number(digits)), decimals: digits.split('.')[1]?.length ?? 0 });
      continue;
    }
    if (unit && !(unit in MULTIPLIER)) continue; // 年 / 月 / 日 / 号 / 时：日期成分
    const next = text[(m.index ?? 0) + m[0].length];
    if (!unit && next !== undefined && /[A-Za-z_]/.test(next)) continue;
    const value = Math.abs(Number(digits));
    if (!unit && !digits.includes('.') && value <= 10) continue;
    const multiplier = unit ? MULTIPLIER[unit]! : 1;
    out.push({ kind: 'number', raw: unit ? m[0].replace(/\s+/g, '') : num, value: value * multiplier, tol: tolerance(digits, multiplier) });
  }
  return out;
}

/** 字符串里的数字（带万 / 亿时乘上去，带 % 时另记比例），不跳过任何数字：出处宁多勿少 */
function scanSources(s: string, plain: number[], ratios: number[]): void {
  for (const m of s.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*([%％万亿]))?/g)) {
    const value = Number(m[0].replace(/[,\s%％万亿]/g, ''));
    if (!Number.isFinite(value)) continue;
    const unit = m[2];
    plain.push(value * (unit && unit in MULTIPLIER ? MULTIPLIER[unit]! : 1));
    if (unit === '%' || unit === '％') ratios.push(value / 100);
  }
}

interface Sources { plain: number[]; ratios: number[] }

/** sentContent 是发给模型的 user 消息（JSON）；解析不了时整段按字符串扫 */
function sources(sentContent: string): Sources {
  const plain: number[] = [];
  const ratios: number[] = [];
  const jsonNumbers: number[] = [];
  const factNumbers: number[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(sentContent);
  } catch {
    scanSources(sentContent, plain, ratios);
  }
  const walk = (v: unknown): void => {
    if (typeof v === 'number') jsonNumbers.push(v);
    else if (typeof v === 'string') scanSources(v, plain, ratios);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(parsed);
  if (parsed && typeof parsed === 'object' && 'facts' in parsed && Array.isArray(parsed.facts)) {
    for (const fact of parsed.facts as unknown[]) {
      if (!fact || typeof fact !== 'object') continue;
      for (const [key, v] of Object.entries(fact)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        if (key === 'maxShare' || key === 'minShare') ratios.push(v);
        else factNumbers.push(Math.abs(v));
      }
    }
  }
  const distinct = (xs: number[]) => [...new Set(xs.filter(Number.isFinite).map(Math.abs))];
  const absolute = distinct([...plain, ...jsonNumbers]);
  // 两两之比只用 JSON 里的数值（解析不了时用扫出来的数）：字符串里的数（SQL、分组名里的编号）多是小整数，两两一比几乎什么比例都能对上
  const ratioBase = distinct(parsed === undefined ? plain : jsonNumbers);
  const base = (ratioBase.length > MAX_RATIO_SOURCES ? distinct(factNumbers) : ratioBase).filter(v => v > 0).sort((a, b) => a - b);
  for (let i = 0; i < base.length; i++) {
    for (let j = i + 1; j < base.length; j++) ratios.push(base[i]! / base[j]!);
  }
  ratios.push(...absolute.filter(v => v > 0 && v <= 1));
  return { plain: absolute, ratios };
}

function cited(claim: Claim, { plain, ratios }: Sources): boolean {
  switch (claim.kind) {
    case 'number':
      return plain.some(s => Math.abs(s - claim.value) <= claim.tol + EPS);
    case 'percent': {
      const half = 10 ** -claim.decimals / 2;
      const near = (v: number) => Math.abs(v - claim.percent) <= half + EPS;
      return ratios.some(r => near(r * 100)) || plain.some(near);
    }
    case 'fraction': {
      const lo = 1 / (claim.n + 0.5);
      const hi = claim.n > 0.5 ? 1 / (claim.n - 0.5) : Infinity;
      return ratios.some(r => r >= lo - EPS && r <= hi + EPS);
    }
  }
}

/**
 * 解读 text 里在 sentContent（这次发给模型的 user 消息原文）中找不到出处的数字，返回原文片段（按出现顺序、去重，最多 MAX_UNCITED 个）。
 * 百分比按写出来的位数四舍五入后与某个比例相等才算；「N 分之一」要有比例落在 [1/(N+0.5), 1/(N−0.5)]；写了「约」也不放宽
 */
export function uncitedNumbers(text: string, sentContent: string): string[] {
  const found = claims(text);
  if (!found.length) return [];
  const src = sources(sentContent);
  const out: string[] = [];
  for (const claim of found) {
    if (out.length >= MAX_UNCITED) break;
    if (!out.includes(claim.raw) && !cited(claim, src)) out.push(claim.raw);
  }
  return out;
}
