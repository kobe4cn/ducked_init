// test/i18n.test.ts —— translate：英文界面查英文词典（单复数按 en 的规则），中文界面或缺键回退中文原文（ADR-0060）
import { describe, expect, it } from 'vitest';
import enServer from '../app/i18n/en.server.json';
import { makeT, msg, translate } from '../app/lib/i18n';

const limited = '申请过于频繁，请 {minutes} 分钟后再试。';

describe('translate', () => {
  it('英文界面查词典，单复数随数字变化：1 minute / 5 minutes', () => {
    expect(translate('en', enServer, limited, { minutes: 1 })).toBe('Too many requests. Please try again in 1 minute.');
    expect(translate('en', enServer, limited, { minutes: 5 })).toBe('Too many requests. Please try again in 5 minutes.');
  });

  it('中文界面输出与原模板字符串逐字一致（{minutes} 两侧的空格保留）', () => {
    for (const minutes of [1, 5, 15]) {
      expect(translate('zh-CN', null, limited, { minutes })).toBe(`申请过于频繁，请 ${minutes} 分钟后再试。`);
    }
  });

  it('词典缺键时回退中文原文，变量照常代入', () => {
    expect(translate('en', { 别的句子: 'Other' }, '映射 {id} 不存在', { id: 'x1' })).toBe('映射 x1 不存在');
  });

  it('英文界面但词典未下发（messages 为 null）时输出中文', () => {
    expect(translate('en', null, limited, { minutes: 1 })).toBe('申请过于频繁，请 1 分钟后再试。');
  });
});

describe('msg / makeT', () => {
  it('msg 只返回描述对象，出字符串交给 formatServer / translate', () => {
    expect(msg(limited)).toEqual({ key: limited });
    expect(msg(limited, { minutes: 1 })).toEqual({ key: limited, params: { minutes: 1 } });
  });

  it('makeT 固定语言与词典', () => {
    const t = makeT('en', enServer);
    expect(t(limited, { minutes: 5 })).toBe('Too many requests. Please try again in 5 minutes.');
    expect(makeT('zh-CN', null)('请查收邮件')).toBe('请查收邮件');
  });
});
