// app/.server/pipeline/worker.ts —— 工作进程入口：由调度器为每个任务单独启动，执行完即退出（ADR-0001）。
// 通过 IPC 收到任务（类型、参数、本租户数据湖的凭据、配额），回传结果或错误。环境变量里没有平台 PG 的连接串
import { HANDLERS, type TaskKind } from './handlers';
import { CONTRACTS, type TaskContract } from './task-contracts';
import { PartialFailure } from './partial-failure';
import { openTenantLake, redactLakeSecrets, type EngineLimits, type LakeSpec } from './lake-engine';
import { redactSourceSecrets, type SourceSpec } from './source-engine';
import { MsgError, msg, type Msg } from '../../lib/i18n';
import { errorOutcome } from './worker-outcome';

/**
 * source 是任务涉及的数据源（参数带 sourceId 时），凭据已由调度器解密；piiSalt 是合并到标准层时给敏感字段加盐的租户盐；
 * servingKey 是生成服务库时加密文件的租户密钥（ADR-0033）。都只在内存里使用；taskId 用来给结果层的快照表命名
 */
export interface WorkerInput { taskId: string; kind: TaskKind; params: Record<string, unknown>; lake: LakeSpec; limits: EngineLimits; source?: SourceSpec; piiSalt?: string; servingKey?: string }
/** 任务部分完成时既有错误也有结果。失败另带句式（errorMsg，ADR-0060）：MsgError 折算而来，纯 JSON 可过 IPC；其余失败路径只有中文 error */
export type WorkerOutcome = { result: Record<string, unknown> } | { error: string; result?: Record<string, unknown>; errorMsg?: Msg };

const redactor = (input: WorkerInput) => (message: string) => {
  let redacted = redactLakeSecrets(message, input.lake);
  if (input.source) redacted = redactSourceSecrets(redacted, input.source);
  for (const secret of [input.piiSalt, input.servingKey]) if (secret) redacted = redacted.replaceAll(secret, '***');
  return redacted;
};

async function run(input: WorkerInput): Promise<WorkerOutcome> {
  const handler = HANDLERS[input.kind];
  // 挂载标志读契约：attachSource 的任务数据源与数据湖挂同一个 DuckDB，readOnlyLake 只读挂载数据湖，servingFile 另挂本机库 serving
  const contract: TaskContract<unknown, unknown> = CONTRACTS[input.kind];
  const attach = contract.attachSource ? input.source : undefined;
  const readOnly = contract.readOnlyLake === true;
  const servingFile = contract.servingFile === true;
  // 没拿到密钥就不挂 serving：不写未加密的服务库文件
  if (servingFile && !input.servingKey) throw new MsgError(msg('缺少服务库密钥'));
  const servingKey = servingFile ? input.servingKey : undefined;
  const session = await openTenantLake(input.lake, input.limits, attach, { readOnly, servingKey }).catch(e => {
    // 完整句式而不是碎片拼接（ADR-0060）：外部报错原文作为参数，展示时按界面语言出
    throw new MsgError(attach
      ? msg('挂载数据湖与数据源失败：{error}', { error: (e as Error).message })
      : msg('挂载数据湖失败：{error}', { error: (e as Error).message }));
  });
  try {
    const [engine] = (await session.con.runAndReadAll(
      `SELECT current_setting('memory_limit') AS "memoryLimit", current_setting('threads')::INT AS threads`,
    )).getRowObjectsJson();
    const ctx = { taskId: input.taskId, limits: input.limits, source: input.source, piiSalt: input.piiSalt, session, redact: redactor(input) };
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
    .catch((e): WorkerOutcome => errorOutcome(e, redactor(input)))
    .then(outcome => process.send!(outcome, () => process.exit('error' in outcome ? 1 : 0)));
});
