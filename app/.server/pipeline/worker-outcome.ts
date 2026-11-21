// app/.server/pipeline/worker-outcome.ts —— 把工作进程里的异常折算成回传给调度器的结果（ADR-0060）：
// MsgError 转成纯 JSON 的 errorMsg（句式和参数；MsgError 实例过 IPC 会丢类型，所以在 worker 里就转换），
// message（error 列，中文）与 params 里的字符串值都在这里抹凭据。单独成文件：worker.ts 一导入就挂 process.once，测试不能 import 它
import { MsgError } from '../../lib/i18n';
import type { WorkerOutcome } from './worker';

export function errorOutcome(e: unknown, redact: (s: string) => string): WorkerOutcome {
  if (e instanceof MsgError) {
    // params 里的字符串值可能带着外部报错原文（如挂载失败的原因），逐个抹凭据；其他类型的值原样保留
    const params = e.detail.params && Object.fromEntries(
      Object.entries(e.detail.params).map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v]),
    );
    return { error: redact(e.message), errorMsg: { key: e.detail.key, ...(params && { params }) } };
  }
  return { error: redact(e instanceof Error ? e.message : String(e)) };
}
