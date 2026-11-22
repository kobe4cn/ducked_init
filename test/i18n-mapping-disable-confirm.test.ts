// test/i18n-mapping-disable-confirm.test.ts —— 映射详情页停用确认弹窗的英文句子（#1039，ADR-0060，纯函数，不连库）：
// confirm() 的文字 SSR 不渲染，这里用词典直接拼出组件里的整句，断言问句与「停用后…」之间有空格；中文逐字与改造前一致
import { describe, expect, it } from 'vitest';
import enClient from '../app/i18n/en.client.json';
import { makeT } from '../app/lib/i18n';

const WARNING = '{question}停用后合并撤下它写进标准层的行。';

describe('停用确认弹窗：问句和后果说明是一个整句词条', () => {
  it('英文界面下问句（? / .）后面有空格', () => {
    const t = makeT('en', enClient as Record<string, string>);
    const propose = t(WARNING, { question: t('提议停用这个映射？需由另一位数据工程师或管理员确认后生效。') });
    expect(propose).toBe('Propose disabling this mapping? It takes effect only after another data engineer or administrator confirms it. Once disabled, merges remove the rows it wrote to the Silver layer.');
    const confirmText = t(WARNING, { question: t('确认停用这个映射（{name} 提议）？', { name: 'de@acme.com' }) });
    expect(confirmText).toBe('Confirm disabling this mapping (proposed by de@acme.com)? Once disabled, merges remove the rows it wrote to the Silver layer.');
  });

  it('中文界面输出与改造前一致（问句和后果说明直接相连）', () => {
    const t = makeT('zh-CN', null);
    expect(t(WARNING, { question: t('确认停用这个映射（{name} 提议）？', { name: 'de@acme.com' }) }))
      .toBe('确认停用这个映射（de@acme.com 提议）？停用后合并撤下它写进标准层的行。');
  });
});

describe('合并记录：高频匹配值提示的英文单复数', () => {
  const HOT = '{count} 个匹配值各连了 {threshold} 条以上记录，可能是占位号或代填号。';
  it('count=1 用单数句，count>1 用复数句', () => {
    const t = makeT('en', enClient as Record<string, string>);
    expect(t(HOT, { count: 1, threshold: 10 })).toBe('1 matching value links 10 or more records; it may be a placeholder or filler number.');
    expect(t(HOT, { count: 2, threshold: 10 })).toBe('2 matching values each link 10 or more records; they may be placeholder or filler numbers.');
  });
});

describe('键空间跟随提示：改成哪种写法是 ICU select，中文与改造前逐字一致', () => {
  const KEY_SPACE = '同一数据源里这些已发布映射的引用字段还按旧的键空间写，关系会对不上。请把它们改成{declared, select, yes { key_space: {keySpace}} other {不写键空间}}，与本映射一起改、一起发布（本映射先发布）：';
  it('中文：声明了键空间时前面带空格，不写键空间时不带', () => {
    const t = makeT('zh-CN', null);
    expect(t(KEY_SPACE, { declared: 'yes', keySpace: 'store' })).toContain('请把它们改成 key_space: store，与本映射');
    expect(t(KEY_SPACE, { declared: 'no', keySpace: '' })).toContain('请把它们改成不写键空间，与本映射');
  });
  it('英文两支', () => {
    const t = makeT('en', enClient as Record<string, string>);
    expect(t(KEY_SPACE, { declared: 'yes', keySpace: 'store' })).toContain('Change them to key_space: store and');
    expect(t(KEY_SPACE, { declared: 'no', keySpace: '' })).toContain('Change them to no key space and');
  });
});
