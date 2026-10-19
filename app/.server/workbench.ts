// app/.server/workbench.ts —— 数据查询工作台：分析师、数据工程师在 web 请求内对本租户只读挂载的数据湖执行一条只读 SQL（ADR-0036）。
// 只能读标准层 silver 与结果层 gold（白名单见 pipeline/workbench-engine.ts），最多给出 WORKBENCH_ROWS 行、不导出。
// 每个租户同时只有一个交互查询（PG 事务级 advisory lock，持有到查询结束），不经任务队列、不占正式任务名额；
// 超时或客户端中止请求时 interrupt 本进程里的这个查询。每次查询都记审计（SQL、耗时、行数，失败时加原因），不记查询结果
import { sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { lakeReady, lakeRow, lakeSpecOf } from './lake';
import { openTenantLake, redactLakeSecrets, type TenantLakeSession } from './pipeline/lake-engine';
import { checkWorkbenchSql, normalizeWorkbenchSql, runWorkbenchQuery, WorkbenchSqlError, type WorkbenchResult } from './pipeline/workbench-engine';

/** 可以展示给成员的错误 */
export class WorkbenchError extends Error {
  constructor(message: string, readonly status: 400 | 429 = 400) { super(message); }
}

/** 最多给出的行数、默认超时与所用的计算资源 */
export const WORKBENCH_ROWS = 10_000;
export const WORKBENCH_TIMEOUT_MS = 60_000;
const WORKBENCH_LIMITS = { memoryLimitMb: 1024, threads: 2 };

export interface QueryOutcome extends WorkbenchResult { durationMs: number }

/** 查询被打断的原因与报给成员的说法 */
type Stop = 'timeout' | 'cancel';
const STOP_MESSAGES: Record<Stop, (timeoutMs: number) => string> = {
  timeout: timeoutMs => `查询超过 ${timeoutMs / 1000} 秒，已中断`,
  cancel: () => '查询已取消',
};

/**
 * 在本租户只读挂载的数据湖上执行 SQL，返回列、前 WORKBENCH_ROWS 行、是否截断与耗时。
 * 本租户已有查询在运行时抛出 429；SQL 不合规、执行出错、超时（timeoutMs）或 signal 中止时抛出 WorkbenchError（报错里抹掉凭据）
 */
export async function runQuery(
  actor: CurrentMember, rawSql: string, signal?: AbortSignal, { timeoutMs = WORKBENCH_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<QueryOutcome> {
  assertCan(actor, 'sandbox');
  const tenantId = actor.tenant.id;
  const lake = await lakeRow(tenantId);
  if (!lake || !lakeReady(lake)) throw new WorkbenchError('本租户的数据湖还没有初始化');
  const spec = lakeSpecOf(lake);
  const query = normalizeWorkbenchSql(rawSql);
  const outcome = await getDb().transaction(async tx => {
    const { rows: [{ locked }] } = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtext(${`workbench:${tenantId}`})) AS locked`);
    if (!locked) return { kind: 'busy' as const };
    const started = Date.now();
    let result: QueryOutcome | undefined;
    let error: string | undefined;
    let stopped: Stop | undefined;
    let session: TenantLakeSession | undefined;
    const interrupt = (why: Stop) => { stopped ??= why; session?.con.interrupt(); };
    const onAbort = () => interrupt('cancel');
    const timer = setTimeout(() => interrupt('timeout'), timeoutMs);
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) onAbort();
    try {
      session = await openTenantLake(spec, WORKBENCH_LIMITS, undefined, { readOnly: true });
      // 挂载或校验期间到了超时、被中止：interrupt 打断不到还没开始的查询，在这里停下
      if (stopped) throw new Error(stopped);
      const checked = await checkWorkbenchSql(session.con, query);
      if (stopped) throw new Error(stopped);
      const read = await runWorkbenchQuery(session.con, checked, { limit: WORKBENCH_ROWS });
      result = { ...read, durationMs: Date.now() - started };
    } catch (e) {
      error = stopped ? STOP_MESSAGES[stopped](timeoutMs)
        : e instanceof WorkbenchSqlError ? e.message
          : `查询出错：${redactLakeSecrets((e as Error).message, spec)}`;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      session?.close();
    }
    const durationMs = result?.durationMs ?? Date.now() - started;
    await recordAudit(tx, {
      tenantId, actor, action: 'workbench.query', targetType: 'workbench',
      detail: { sql: query, durationMs, rows: result?.rows.length ?? 0, truncated: result?.truncated ?? false, ...(error && { error }) },
    });
    return result ? { kind: 'ok' as const, result } : { kind: 'failed' as const, error: error! };
  });
  if (outcome.kind === 'busy') throw new WorkbenchError('本租户已有查询在运行，请等它结束后再试', 429);
  if (outcome.kind === 'failed') throw new WorkbenchError(outcome.error);
  return outcome.result;
}
