// test/text-offset.test.ts —— 按行列（从 1 起）算文本里的字符偏移，映射实时校验点问题时把光标定位到 YAML 框里的那一处（纯函数）
import { describe, expect, it } from 'vitest';
import { lineRangeOf, offsetOf } from '~/lib/text-offset';

const YAML = 'entity: order\ntable: orders\nfields:\n  order_id: id\n';

describe('offsetOf', () => {
  it('第 1 行第 1 列是开头，行列都从 1 起', () => {
    expect(offsetOf(YAML, 1, 1)).toBe(0);
    expect(offsetOf(YAML, 1, 9)).toBe(YAML.indexOf('order'));
    expect(offsetOf(YAML, 4, 3)).toBe(YAML.indexOf('order_id'));
  });

  it('CRLF 换行算一个行尾，偏移计入 \\r', () => {
    const crlf = YAML.replaceAll('\n', '\r\n');
    expect(offsetOf(crlf, 2, 1)).toBe(crlf.indexOf('table'));
    expect(offsetOf(crlf, 4, 3)).toBe(crlf.indexOf('order_id'));
  });

  it('列超出行尾时停在行尾（不跨到下一行），列小于 1 时按 1', () => {
    expect(offsetOf(YAML, 1, 99)).toBe(YAML.indexOf('\n'));
    expect(offsetOf(YAML.replaceAll('\n', '\r\n'), 1, 99)).toBe(YAML.indexOf('\n'));
    expect(offsetOf(YAML, 2, 0)).toBe(YAML.indexOf('table'));
  });

  it('行超出末行时停在全文末尾，行小于 1 时按第 1 行', () => {
    expect(offsetOf(YAML, 99, 1)).toBe(YAML.length);
    expect(offsetOf('a\nb', 5, 3)).toBe(3);
    expect(offsetOf(YAML, 0, 1)).toBe(0);
    expect(offsetOf('', 3, 2)).toBe(0);
  });
});

describe('lineRangeOf', () => {
  it('给出那一行的起止偏移（不含换行符）', () => {
    expect(lineRangeOf(YAML, 2)).toEqual([YAML.indexOf('table'), YAML.indexOf('\nfields')]);
    const crlf = YAML.replaceAll('\n', '\r\n');
    expect(lineRangeOf(crlf, 2)).toEqual([crlf.indexOf('table'), crlf.indexOf('\r\nfields')]);
  });

  it('行超出末行时是全文末尾的空范围', () => {
    expect(lineRangeOf(YAML, 99)).toEqual([YAML.length, YAML.length]);
  });
});
