// app/lib/mapping-expr.ts —— 映射里的字段表达式：平台自己解析的小语言，只允许白名单函数（类型转换、单位换算、COALESCE、
// 时区转换等）与四则运算，由平台编译成 DuckDB SQL，成员写不进任意 SQL（ADR-0015）。
// 语法：源表字段（标识符，或用双引号括起的任意字段名）、单引号字符串、数字、null / true / false、+ - * /、括号与函数调用；
// 返回布尔的写法（映射的行过滤 where，ADR-0024）：比较 = <> != < <= > >=、and / or / not、is [not] null、[not] in (…, …)。
// 平台进程（保存与发布时校验）、工作进程（合并时编译）与映射表单（客户端读写表达式）共用
import type { FieldType } from './canonical-model';
import { looksSensitive } from './sensitive';

export type Expr =
  | { kind: 'column'; name: string; offset: number }
  | { kind: 'literal'; sql: string; text?: string; offset: number }
  | { kind: 'call'; fn: string; args: Expr[]; offset: number }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr; offset: number }
  | { kind: 'neg'; arg: Expr; offset: number }
  | { kind: 'compare'; op: CompareOp; left: Expr; right: Expr; offset: number }
  | { kind: 'logic'; op: 'and' | 'or'; left: Expr; right: Expr; offset: number }
  | { kind: 'not'; arg: Expr; offset: number }
  | { kind: 'isnull'; arg: Expr; negated: boolean; offset: number }
  | { kind: 'in'; arg: Expr; list: Expr[]; negated: boolean; offset: number };

export type CompareOp = '=' | '<>' | '<' | '<=' | '>' | '>=';

/** 关键字：作字段名时要加双引号 */
const KEYWORDS = ['and', 'or', 'not', 'is', 'in'];

/** 表达式里的错误：offset 是在表达式文本里的位置（从 0 起） */
export class ExprError extends Error {
  constructor(message: string, readonly offset: number) { super(message); }
}

/** 源列类型的大类 */
export type Kind = 'int' | 'decimal' | 'tstz' | 'timestamp' | 'date' | 'bool' | 'text' | 'other';
export function kindOf(type: string): Kind {
  const t = type.toUpperCase();
  if (/^U?(TINY|SMALL|BIG|HUGE)?INT(EGER|\d)?\b/.test(t)) return 'int';
  if (/^(DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL)/.test(t)) return 'decimal';
  if (/^TIMESTAMP(TZ| WITH TIME ZONE)/.test(t)) return 'tstz';
  if (/^(TIMESTAMP|DATETIME)/.test(t)) return 'timestamp';
  if (t === 'DATE') return 'date';
  if (t.startsWith('BOOL')) return 'bool';
  if (/^(VARCHAR|TEXT|STRING|CHAR|BPCHAR|UUID)/.test(t)) return 'text';
  return 'other';
}

/** 源列大类对应的字段类型（扩展字段的类型据此推断） */
export const KIND_FIELD_TYPES: Record<Kind, FieldType> = {
  int: 'integer', decimal: 'decimal', tstz: 'timestamp', timestamp: 'timestamp', date: 'date', bool: 'boolean', text: 'string', other: 'string',
};

/**
 * 源列做成扩展字段时的类型与表达式：类型按源列大类推断，不带时区的时间按 tz 解读，认不出的类型转为文本。
 * 列名或格式像敏感信息的标成敏感：标准层只存哈希，类型是文本，不是文本的列转为文本
 */
export function extensionSpec(
  column: { name: string; type: string; formats?: readonly { format: string }[] }, tz = 'Asia/Shanghai',
): { type: FieldType; expr: string; sensitive?: true } {
  if (looksSensitive(column)) return { type: 'string', expr: textExpr(column), sensitive: true };
  return extensionExpr(column, tz);
}

/** 源列转为文本的表达式：本来就是文本时直接引用 */
export function textExpr(column: { name: string; type: string }) {
  const col = ref(column.name);
  return kindOf(column.type) === 'text' ? col : `string(${col})`;
}

/** 源列按大类推断的字段类型与表达式（不看是否敏感）：不带时区的时间按 tz 解读，认不出的类型转为文本 */
export function extensionExpr(column: { name: string; type: string }, tz = 'Asia/Shanghai'): { type: FieldType; expr: string } {
  const kind = kindOf(column.type);
  const col = ref(column.name);
  return { type: KIND_FIELD_TYPES[kind], expr: kind === 'timestamp' ? `from_timezone(${col}, ${lit(tz)})` : kind === 'other' ? `string(${col})` : col };
}

/** 表达式里引用源列：不是普通标识符（或是 null / true / false 与关键字）时加双引号 */
export const ref = (name: string) =>
  /^[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*$/.test(name) && !['null', 'true', 'false', ...KEYWORDS].includes(name.toLowerCase()) ? name : `"${name.replace(/"/g, '""')}"`;

/** 表达式里的字符串字面量（单引号，内部的单引号写两遍） */
export const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** 参数里要求是字符串字面量的位置（时区、时间格式），返回其文本 */
function textArg(call: Extract<Expr, { kind: 'call' }>, i: number, what: string) {
  const arg = call.args[i];
  if (arg.kind !== 'literal' || arg.text === undefined) throw new ExprError(`${call.fn} 的第 ${i + 1} 个参数（${what}）必须是单引号括起的字符串`, arg.offset);
  return arg.text;
}

interface FunctionDef {
  label: string;
  /** 写法（参数用中文说明，方括号里的可省略），对照面板与标准模型页展示 */
  signature: string;
  /** 返回值的字段类型（报错给扩展字段的写法时据此推断类型）；不写时同第一个参数 */
  returns?: FieldType;
  /** 参数个数的下限与上限（上限为 Infinity 表示不限） */
  arity: [number, number];
  /** 校验字面量参数（如时区名） */
  check?(call: Extract<Expr, { kind: 'call' }>): void;
  sql(args: string[], call: Extract<Expr, { kind: 'call' }>): string;
}

/** 白名单函数：名称、说明与编译方式。新增函数只改这里 */
export const FUNCTIONS: Record<string, FunctionDef> = {
  string: { signature: 'string(x)', returns: 'string', label: '转为文本', arity: [1, 1], sql: ([a]) => `CAST(${a} AS VARCHAR)` },
  integer: { signature: 'integer(x)', returns: 'integer', label: '转为整数', arity: [1, 1], sql: ([a]) => `CAST(${a} AS BIGINT)` },
  decimal: { signature: 'decimal(x)', returns: 'decimal', label: '转为小数', arity: [1, 1], sql: ([a]) => `CAST(${a} AS DOUBLE)` },
  boolean: { signature: 'boolean(x)', returns: 'boolean', label: '转为布尔', arity: [1, 1], sql: ([a]) => `CAST(${a} AS BOOLEAN)` },
  date: {
    signature: "date(x[, '格式'])", returns: 'date',
    label: '转为日期；第二个参数为格式时按格式解析（如 \'%Y/%m/%d\'）',
    arity: [1, 2],
    check: call => { if (call.args.length === 2) textArg(call, 1, '格式'); },
    sql: (args, call) => (args.length === 2 ? `CAST(strptime(CAST(${args[0]} AS VARCHAR), ${lit(textArg(call, 1, '格式'))}) AS DATE)` : `CAST(${args[0]} AS DATE)`),
  },
  timestamp: {
    signature: "timestamp(x[, '格式'])", returns: 'timestamp',
    label: '转为时间（不带时区的按 UTC）；第二个参数为格式时按格式解析（如 \'%Y-%m-%d %H:%M\'）',
    arity: [1, 2],
    check: call => { if (call.args.length === 2) textArg(call, 1, '格式'); },
    sql: (args, call) => (args.length === 2 ? `strptime(CAST(${args[0]} AS VARCHAR), ${lit(textArg(call, 1, '格式'))})` : `CAST(${args[0]} AS TIMESTAMP)`),
  },
  from_timezone: {
    signature: "from_timezone(x, '时区')", returns: 'timestamp',
    label: '把源端的本地时间（不带时区）按给定时区解读，如 from_timezone(created_at, \'Asia/Shanghai\')',
    arity: [2, 2],
    check: call => {
      const tz = textArg(call, 1, '时区');
      if (!isTimeZone(tz)) throw new ExprError(`不认识的时区：${tz}（请用 IANA 时区名，如 Asia/Shanghai）`, call.args[1].offset);
    },
    sql: (args, call) => `timezone(${lit(textArg(call, 1, '时区'))}, CAST(${args[0]} AS TIMESTAMP))`,
  },
  from_epoch_seconds: { signature: 'from_epoch_seconds(x)', returns: 'timestamp', label: 'Unix 秒转为时间', arity: [1, 1], sql: ([a]) => `to_timestamp(CAST(${a} AS DOUBLE))` },
  from_epoch_millis: { signature: 'from_epoch_millis(x)', returns: 'timestamp', label: 'Unix 毫秒转为时间', arity: [1, 1], sql: ([a]) => `to_timestamp(CAST(${a} AS DOUBLE) / 1000)` },
  coalesce: { signature: 'coalesce(x, y, ...)', label: '取第一个非空值', arity: [2, Infinity], sql: args => `coalesce(${args.join(', ')})` },
  nullif: { signature: 'nullif(x, y)', label: '与第二个参数相等时为空', arity: [2, 2], sql: ([a, b]) => `nullif(${a}, ${b})` },
  lower: { signature: 'lower(x)', returns: 'string', label: '转小写', arity: [1, 1], sql: ([a]) => `lower(CAST(${a} AS VARCHAR))` },
  upper: { signature: 'upper(x)', returns: 'string', label: '转大写', arity: [1, 1], sql: ([a]) => `upper(CAST(${a} AS VARCHAR))` },
  trim: { signature: 'trim(x)', returns: 'string', label: '去掉首尾空白', arity: [1, 1], sql: ([a]) => `trim(CAST(${a} AS VARCHAR))` },
  concat: { signature: 'concat(x, y, ...)', returns: 'string', label: '拼接文本（空值当作空串）', arity: [1, Infinity], sql: args => `concat(${args.join(', ')})` },
  substr: { signature: 'substr(x, 起始[, 长度])', returns: 'string', label: '截取文本：substr(x, 起始位置从 1 起, 长度)', arity: [2, 3], sql: args => `substring(CAST(${args[0]} AS VARCHAR), ${args.slice(1).join(', ')})` },
  round: { signature: 'round(x[, 小数位])', returns: 'decimal', label: '四舍五入到给定小数位（默认 0）', arity: [1, 2], sql: args => `round(${args.join(', ')})` },
  abs: { signature: 'abs(x)', label: '绝对值', arity: [1, 1], sql: ([a]) => `abs(${a})` },
};

/** 白名单函数的名称、写法与说明（交给页面展示） */
export const functionList = () => Object.entries(FUNCTIONS).map(([name, f]) => ({ name, signature: f.signature, label: f.label }));

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_\u0080-￿]/;

/** 解析表达式；不合法时抛出 ExprError（带位置） */
export function parseExpression(src: string): Expr {
  let i = 0;
  const skip = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const peek = () => { skip(); return src[i]; };
  /** 下一个标识符（小写）；不是标识符时为空串 */
  const word = () => {
    skip();
    let j = i;
    if (!IDENT_START.test(src[j] ?? '')) return '';
    while (j < src.length && IDENT_PART.test(src[j])) j++;
    return src.slice(i, j).toLowerCase();
  };
  /** 下一个标识符是关键字 w 时吃掉它 */
  const keyword = (w: string) => {
    if (word() !== w) return false;
    i += w.length;
    return true;
  };

  function quoted(close: string, what: string) {
    const start = i;
    i++;
    let text = '';
    for (;;) {
      if (i >= src.length) throw new ExprError(`${what}没有结束的 ${close}`, start);
      if (src[i] === close) {
        if (src[i + 1] === close) { text += close; i += 2; continue; }
        i++;
        return text;
      }
      text += src[i++];
    }
  }

  function primary(): Expr {
    skip();
    const start = i;
    const c = src[i];
    if (c === undefined) throw new ExprError('表达式不完整', i);
    if (c === '(') {
      i++;
      const e = or();
      if (peek() !== ')') throw new ExprError('缺少右括号', i);
      i++;
      return e;
    }
    if (c === "'") {
      const text = quoted("'", '字符串');
      return { kind: 'literal', sql: lit(text), text, offset: start };
    }
    if (c === '"') return { kind: 'column', name: quoted('"', '字段名'), offset: start };
    if (/[0-9.]/.test(c)) {
      const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)/.exec(src.slice(i));
      if (!m) throw new ExprError(`无法识别的数字`, i);
      i += m[0].length;
      return { kind: 'literal', sql: m[0], offset: start };
    }
    if (IDENT_START.test(c)) {
      while (i < src.length && IDENT_PART.test(src[i])) i++;
      const name = src.slice(start, i);
      if (peek() === '(') {
        const fn = name.toLowerCase();
        const def = FUNCTIONS[fn];
        if (!def) throw new ExprError(`函数 ${name} 不在白名单内（可用：${Object.keys(FUNCTIONS).join('、')}）`, start);
        i++;
        const args: Expr[] = [];
        if (peek() !== ')') {
          for (;;) {
            args.push(or());
            if (peek() === ',') { i++; continue; }
            break;
          }
        }
        if (peek() !== ')') throw new ExprError(`函数 ${fn} 的参数缺少右括号`, i);
        i++;
        const [min, max] = def.arity;
        if (args.length < min || args.length > max) {
          const expected = min === max ? `${min} 个` : max === Infinity ? `至少 ${min} 个` : `${min} 到 ${max} 个`;
          throw new ExprError(`函数 ${fn} 需要${expected}参数，实际 ${args.length} 个`, start);
        }
        const call = { kind: 'call' as const, fn, args, offset: start };
        def.check?.(call);
        return call;
      }
      const lower = name.toLowerCase();
      if (lower === 'null') return { kind: 'literal', sql: 'NULL', offset: start };
      if (lower === 'true' || lower === 'false') return { kind: 'literal', sql: lower.toUpperCase(), offset: start };
      if (KEYWORDS.includes(lower)) throw new ExprError(`${name} 是关键字，作字段名时请加双引号："${name}"`, start);
      return { kind: 'column', name, offset: start };
    }
    throw new ExprError(`无法识别的字符 ${c}`, i);
  }

  function unary(): Expr {
    if (peek() === '-') {
      const start = i++;
      return { kind: 'neg', arg: unary(), offset: start };
    }
    return primary();
  }

  function binary(next: () => Expr, ops: string[]) {
    return (): Expr => {
      let left = next();
      for (;;) {
        const c = peek();
        if (!ops.includes(c)) return left;
        const offset = i++;
        left = { kind: 'binary', op: c as '+', left, right: next(), offset };
      }
    };
  }
  const multiplicative = binary(unary, ['*', '/']);
  const additive = binary(multiplicative, ['+', '-']);

  /** 比较、is [not] null 与 [not] in (…)：两边都是四则运算，不连写 */
  function comparison(): Expr {
    const left = additive();
    skip();
    const offset = i;
    const op = /^(<=|>=|<>|!=|=|<|>)/.exec(src.slice(i))?.[0];
    if (op) {
      i += op.length;
      return { kind: 'compare', op: op === '!=' ? '<>' : (op as CompareOp), left, right: additive(), offset };
    }
    if (keyword('is')) {
      const negated = keyword('not');
      if (!keyword('null')) throw new ExprError('is 后面只能是 null 或 not null', i);
      return { kind: 'isnull', arg: left, negated, offset };
    }
    const negated = keyword('not');
    if (keyword('in')) {
      if (peek() !== '(') throw new ExprError("in 后面要用括号列出取值，如 in ('a', 'b')", i);
      i++;
      const list: Expr[] = [];
      for (;;) {
        list.push(or());
        if (peek() === ',') { i++; continue; }
        break;
      }
      if (peek() !== ')') throw new ExprError('in 的取值缺少右括号', i);
      i++;
      return { kind: 'in', arg: left, list, negated, offset };
    }
    if (negated) throw new ExprError('not 放在这里只能接 in', i);
    return left;
  }

  function not(): Expr {
    skip();
    const offset = i;
    return keyword('not') ? { kind: 'not', arg: not(), offset } : comparison();
  }

  function logic(next: () => Expr, op: 'and' | 'or') {
    return (): Expr => {
      let left = next();
      for (;;) {
        skip();
        const offset = i;
        if (!keyword(op)) return left;
        left = { kind: 'logic', op, left, right: next(), offset };
      }
    };
  }
  const and = logic(not, 'and');
  const or = logic(and, 'or');

  if (!src.trim()) throw new ExprError('表达式为空', 0);
  const expr = or();
  skip();
  if (i < src.length) throw new ExprError(`多余的内容：${src.slice(i, i + 20)}`, i);
  return expr;
}

/** 表达式引用的源表字段（按出现顺序，可能重复） */
export function referencedColumns(expr: Expr): { name: string; offset: number }[] {
  switch (expr.kind) {
    case 'column': return [{ name: expr.name, offset: expr.offset }];
    case 'literal': return [];
    case 'call': return expr.args.flatMap(referencedColumns);
    case 'binary': case 'compare': case 'logic': return [...referencedColumns(expr.left), ...referencedColumns(expr.right)];
    case 'neg': case 'not': case 'isnull': return referencedColumns(expr.arg);
    case 'in': return [expr.arg, ...expr.list].flatMap(referencedColumns);
  }
}

/** 编译成 DuckDB SQL：源表字段写成 alias."字段名" */
export function compileExpression(expr: Expr, alias: string): string {
  switch (expr.kind) {
    case 'column': return `${alias}.${ident(expr.name)}`;
    case 'literal': return expr.sql;
    case 'call': return FUNCTIONS[expr.fn].sql(expr.args.map(a => compileExpression(a, alias)), expr);
    case 'binary': case 'compare': return `(${compileExpression(expr.left, alias)} ${expr.op} ${compileExpression(expr.right, alias)})`;
    case 'neg': return `(-${compileExpression(expr.arg, alias)})`;
    case 'logic': return `(${compileExpression(expr.left, alias)} ${expr.op.toUpperCase()} ${compileExpression(expr.right, alias)})`;
    case 'not': return `(NOT ${compileExpression(expr.arg, alias)})`;
    case 'isnull': return `(${compileExpression(expr.arg, alias)} IS ${expr.negated ? 'NOT ' : ''}NULL)`;
    case 'in': {
      const list = expr.list.map(e => compileExpression(e, alias)).join(', ');
      return `(${compileExpression(expr.arg, alias)} ${expr.negated ? 'NOT ' : ''}IN (${list}))`;
    }
  }
}
