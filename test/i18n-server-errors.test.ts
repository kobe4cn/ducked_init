// test/i18n-server-errors.test.ts —— MsgError 基类与 errorText / errorTextFor（#1079，ADR-0060，纯函数，不连库）：
// 服务端业务错误带句式和参数（Msg），message 固定中文（/mcp 与日志读它），errorText 按界面语言出报错文字——
// 英文界面查 en.server.json，中文界面回退 message；不带句式的错误（普通 Error、字符串）原样返回
import { describe, expect, it } from 'vitest';
import { errorText } from '../app/.server/i18n';
import { msg, MsgError } from '../app/lib/i18n';

const tooLong = () => new MsgError(msg('名称不能超过 {max} 个字', { max: 100 }));

describe('MsgError', () => {
  it('message 是中文且代入了参数', () => {
    expect(tooLong().message).toBe('名称不能超过 100 个字');
  });
});

describe('errorText', () => {
  it('错误带句式时按界面语言格式化：英文是英文', () => {
    expect(errorText('en', tooLong())).toBe('Names cannot exceed 100 characters.');
  });

  it('中文界面等于 message', () => {
    const e = tooLong();
    expect(errorText('zh-CN', e)).toBe(e.message);
  });

  it('不带句式的错误返回原 message，非 Error 返回 String(e)', () => {
    expect(errorText('en', new Error('x'))).toBe('x');
    expect(errorText('zh-CN', new Error('x'))).toBe('x');
    expect(errorText('en', '兜底文案')).toBe('兜底文案');
  });
});
