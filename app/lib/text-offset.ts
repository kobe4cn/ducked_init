// app/lib/text-offset.ts —— 按行列（从 1 起，同映射校验给出的位置）算文本里的字符偏移；映射实时校验点一条问题时，用它把 YAML 框的光标定位过去。
// \n 与 \r\n 都算换行，偏移按 JS 字符串下标计（含 \r）

/** 第 line 行的起止偏移（不含换行符）；行小于 1 时按第 1 行，超出末行时是全文末尾的空范围 */
export function lineRangeOf(text: string, line: number): [number, number] {
  let start = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', start);
    if (next < 0) return [text.length, text.length];
    start = next + 1;
  }
  const lf = text.indexOf('\n', start);
  const end = lf < 0 ? text.length : lf > start && text[lf - 1] === '\r' ? lf - 1 : lf;
  return [start, end];
}

/** 第 line 行第 col 列的偏移；列超出行尾时停在行尾，列小于 1 时按 1 */
export function offsetOf(text: string, line: number, col: number): number {
  const [start, end] = lineRangeOf(text, line);
  return Math.min(start + Math.max(col, 1) - 1, end);
}
