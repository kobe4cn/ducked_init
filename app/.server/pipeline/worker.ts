// app/.server/pipeline/worker.ts —— 工作进程入口：由调度器为每个任务单独启动，执行完即退出（ADR-0001）。
// 通过 IPC 收到任务（类型、参数、本租户数据湖的凭据、配额），回传结果或错误。环境变量里没有平台 PG 的连接串
import { HANDLERS, PartialFailure, type TaskKind } from './handlers';
import { openTenantLake, redactLakeSecrets, type EngineLimits, type LakeSpec } from './lake-engine';
import { redactSourceSecrets, type SourceSpec } from './source-engine';

/** source 是任务涉及的数据源（参数带 sourceId 时），凭据已由调度器解密，只在内存里使用 */
export interface WorkerInput { kind: TaskKind; params: Record<string, unknown>; lake: LakeSpec; limits: EngineLimits; source?: SourceSpec }
/** 任务部分完成时既有错误也有结果 */
export type WorkerOutcome = { result: Record<string, unknown> } | { error: string; result?: Record<string, unknown> };

const redactor = (input: WorkerInput) => (message: string) => {
  const redacted = redactLakeSecrets(message, input.lake);
  return input.source ? redactSourceSecrets(redacted, input.source) : redacted;
};

async function run(input: WorkerInput): Promise<WorkerOutcome> {
  const handler = HANDLERS[input.kind];
  const attach = 'attachSource' in handler && handler.attachSource ? input.source : undefined;
  const session = await openTenantLake(input.lake, input.limits, attach).catch(e => {
    throw new Error(`挂载${attach ? '数据湖与数据源' : '数据湖'}失败：${(e as Error).message}`);
  });
  try {
    const [engine] = (await session.con.runAndReadAll(
      `SELECT current_setting('memory_limit') AS "memoryLimit", current_setting('threads')::INT AS threads`,
    )).getRowObjectsJson();
    const ctx = { limits: input.limits, source: input.source, session, redact: redactor(input) };
    try {
      return { result: { ...(await handler.run(session.con, input.params, ctx)), engine } };
    } catch (e) {
      if (e instanceof PartialFailure) return { error: e.message, result: { ...e.result, engine } };
      throw e;
    }
  } finally {
    session.close();
  }
}

// 调度器退出（IPC 断开）时随之退出：没人记录结果的任务不该继续写数据湖
process.once('disconnect', () => process.exit(1));

process.once('message', (input: WorkerInput) => {
  run(input)
    .catch((e): WorkerOutcome => ({ error: redactor(input)((e as Error).message) }))
    .then(outcome => process.send!(outcome, () => process.exit('error' in outcome ? 1 : 0)));
});
