// test/builtin-names.test.ts —— 平台内置名称的翻译工具（#1011，ADR-0060 翻译边界）：名单内的名称按界面语言翻译，
// 名单外的名称（租户起的名称）原样返回、不经 ICU（带 {、' 也不抛错不吞字符）；中文界面一律原样
import { describe, expect, it } from 'vitest';
import { builtinName, CANONICAL_NAMES, ENUM_LABELS } from '../app/lib/builtin-names';
import enClient from '../app/i18n/en.client.json';
import { makeT } from '../app/lib/i18n';

const en = makeT('en', enClient);
const zh = makeT('zh-CN', null);

describe('平台内置名称的翻译', () => {
  it('名单内的名称在英文界面得到英文', () => {
    expect(builtinName(en, '消费者', CANONICAL_NAMES)).toBe('Customer');
    expect(builtinName(en, '实付金额', CANONICAL_NAMES)).toBe('Amount Paid');
    expect(builtinName(en, '小数（两位）', ENUM_LABELS)).toBe('Decimal (2 places)');
    expect(builtinName(en, '取最新', ENUM_LABELS)).toBe('Latest');
  });

  it('名单外的名称原样返回，带 { 或 \' 也不抛错', () => {
    expect(builtinName(en, '我的人群 {x}', CANONICAL_NAMES)).toBe('我的人群 {x}');
    expect(builtinName(en, "it's", ENUM_LABELS)).toBe("it's");
    expect(builtinName(en, '自定义实体甲', CANONICAL_NAMES)).toBe('自定义实体甲');
  });

  it('不给名单时照常翻译（代码里写死的常量名称），词典缺键回退中文', () => {
    expect(builtinName(en, '指标')).toBe(enClient['指标']);
    expect(builtinName(en, '不在词典里的常量')).toBe('不在词典里的常量');
  });

  it('中文界面下名单内外都原样返回', () => {
    for (const name of [...CANONICAL_NAMES, ...ENUM_LABELS]) {
      expect(builtinName(zh, name, CANONICAL_NAMES)).toBe(name);
      expect(builtinName(zh, name, ENUM_LABELS)).toBe(name);
    }
    expect(builtinName(zh, '我的人群 {x}', CANONICAL_NAMES)).toBe('我的人群 {x}');
  });
});
