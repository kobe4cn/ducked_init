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
