// app/.server/pipeline/worker.ts —— 工作进程入口：由调度器为每个任务单独启动，执行完即退出（ADR-0001）。
// 通过 IPC 收到任务（类型、参数、本租户数据湖的凭据、配额），回传结果或错误。环境变量里没有平台 PG 的连接串
import { HANDLERS, type TaskKind } from './handlers';
import { openTenantLake, redactLakeSecrets, type EngineLimits, type LakeSpec } from './lake-engine';
import { redactSourceSecrets, type SourceSpec } from './source-engine';

/** source 是任务涉及的数据源（参数带 sourceId 时），凭据已由调度器解密，只在内存里使用 */
export interface WorkerInput { kind: TaskKind; params: Record<string, unknown>; lake: LakeSpec; limits: EngineLimits; source?: SourceSpec }
export type WorkerOutcome = { result: Record<string, unknown> } | { error: string };

async function run(input: WorkerInput): Promise<WorkerOutcome> {
  const session = await openTenantLake(input.lake, input.limits).catch(e => {
    throw new Error(`挂载数据湖失败：${(e as Error).message}`);
  });
  try {
    const [engine] = (await session.con.runAndReadAll(
      `SELECT current_setting('memory_limit') AS "memoryLimit", current_setting('threads')::INT AS threads`,
    )).getRowObjectsJson();
    const result = await HANDLERS[input.kind].run(session.con, input.params, { limits: input.limits, source: input.source });
    return { result: { ...result, engine } };
  } finally {
    session.close();
  }
}

// 调度器退出（IPC 断开）时随之退出：没人记录结果的任务不该继续写数据湖
process.once('disconnect', () => process.exit(1));

process.once('message', (input: WorkerInput) => {
  run(input)
    .catch((e): WorkerOutcome => {
      const message = redactLakeSecrets((e as Error).message, input.lake);
      return { error: input.source ? redactSourceSecrets(message, input.source) : message };
    })
    .then(outcome => process.send!(outcome, () => process.exit('error' in outcome ? 1 : 0)));
});
