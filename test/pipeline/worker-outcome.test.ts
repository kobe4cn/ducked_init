// test/pipeline/worker-outcome.test.ts —— 工作进程把异常折算成回传结果（纯函数，不连库）：
// MsgError 带句式（errorMsg，纯 JSON 可过 IPC；MsgError 实例过 IPC 会丢类型，所以在 worker 里就转），
// params 里的字符串值逐个抹凭据，error 列仍是代入参数后的中文；普通 Error 不带 errorMsg
import { describe, expect, it } from 'vitest';
import { MsgError, msg } from '../../app/lib/i18n';
import { errorOutcome } from '../../app/.server/pipeline/worker-outcome';

const redact = (s: string) => s.replaceAll('s3cr3t', '***');

describe('errorOutcome', () => {
  it('MsgError：errorMsg 是句式和参数、参数里的字符串值过 redact，error 是中文原文（同样过 redact）', () => {
    const outcome = errorOutcome(
      new MsgError(msg('挂载数据湖失败：{error}', { error: '连不上 s3cr3t 桶' })),
      redact,
    );
    expect(outcome).toEqual({
      error: '挂载数据湖失败：连不上 *** 桶',
      errorMsg: { key: '挂载数据湖失败：{error}', params: { error: '连不上 *** 桶' } },
    });
  });

  it('MsgError 不带参数：errorMsg 只有 key；参数里的非字符串值原样保留', () => {
    expect(errorOutcome(new MsgError(msg('缺少服务库密钥')), redact))
      .toEqual({ error: '缺少服务库密钥', errorMsg: { key: '缺少服务库密钥' } });
    expect(errorOutcome(new MsgError(msg('超过 {minutes} 分钟', { minutes: 30 })), redact))
      .toEqual({ error: '超过 30 分钟', errorMsg: { key: '超过 {minutes} 分钟', params: { minutes: 30 } } });
  });

  it('普通 Error 只带 error（过 redact），不带 errorMsg；非 Error 按 String(e)', () => {
    expect(errorOutcome(new Error('读取 s3cr3t 失败'), redact)).toEqual({ error: '读取 *** 失败' });
    expect(errorOutcome('奇怪的抛出值', redact)).toEqual({ error: '奇怪的抛出值' });
  });
});
