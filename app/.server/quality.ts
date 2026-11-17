// app/.server/quality.ts —— 数据质量告警（ADR-0026）：结果层任务因 error 级断言失败时，给租户管理员发邮件并记审计。
// 邮件与审计只写断言名、实体与不合格行数，不写行内容。数据质量页只读挂载本租户数据湖，读最近的断言运行记录与隔离区样本（只来自标准层，敏感字段只有哈希）；
// 顶部「最近一次」统计取平台库里最近一次结果层任务的断言结果（合并任务也写运行记录，且 error 失败时回滚不留记录，不能拿湖里最近一条当准）。
// readQuality 可按任务 ID 过滤（#838，定义页的失败提示与告警链到 /quality?task=）；隔离区行 JSON 里的 _mapping 是映射 ID，mappingLabels 给出「源 · 表 → 实体」
import { and, desc, eq, inArray, isNotNull, like, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import { getDb } from './db/client';
import { mappings, members, sources, tasks } from './db/schema';
import { lakeReady, lakeRow, lakeSpecOf } from './lake';
import { getMailer } from './mailer';
import { openTenantLake } from './pipeline/lake-engine';
import { describeAssertion, failedErrors, type AssertionLevel, type AssertionResult } from './pipeline/assertions';
import { CONTRACTS, readResult, type TaskKind } from './pipeline/task-contracts';
import { lit } from '../lib/mapping-expr';

/** 任务结果里有失败的 error 级断言时告警；没有时什么也不做。单个管理员发信失败只记日志，不影响其他人 */
export async function alertAssertionFailure(tenantId: string, task: { id: string; kind: TaskKind }, result: Record<string, unknown> | undefined) {
  const failed = failedErrors((result?.assertions as AssertionResult[] | undefined) ?? []);
  if (!failed.length) return;
  const { label } = CONTRACTS[task.kind];
  const summaries = failed.map(describeAssertion);
  await recordAudit(getDb(), {
    tenantId, system: true, action: 'assertion.failed', targetType: 'task', targetId: task.id,
    detail: { task: label, summaries, assertions: failed },
  });
  const admins = await getDb().select({ email: members.email }).from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.role, 'admin')));
  const text = [
    `「${label}」任务（${task.id}）计算前的数据检查没有通过，本次没有产出新快照，分析页继续使用上一版：`,
    '',
    ...summaries.map(s => `- ${s}`),
    '',
    '请检查对应映射的源数据，修正后重新合并并重算。',
  ].join('\n');
  for (const { email } of admins) {
    await getMailer().send({ to: email, subject: `数据检查未通过：${label}`, text })
      .catch(e => console.error(`[告警] 给 ${email} 发断言失败邮件出错`, e));
  }
}

/** 最近一次跑过断言的结果层任务（gold.*，结果里有 assertions）的任务 ID 与断言结果；还没有时为 undefined */
export async function latestResultCheck(tenantId: string): Promise<{ taskId: string; assertions: AssertionResult[] } | undefined> {
  const [task] = await getDb().select({ id: tasks.id, result: tasks.result }).from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), like(tasks.kind, 'gold.%'), isNotNull(tasks.finishedAt), sql`${tasks.result} -> 'assertions' IS NOT NULL`))
    .orderBy(desc(tasks.finishedAt)).limit(1);
  // 查询按 gold.% 匹配，模板任务（gold.rfm/…）与 gold.expire 也会进来：只借 gold.dsl 的结果类型读，不带 kind（#477）
  return task && { taskId: task.id, assertions: readResult('gold.dsl', { result: task.result })!.assertions };
}

const READ_LIMITS = { memoryLimitMb: 256, threads: 1 };
/** 数据质量页读的运行记录条数与隔离区行数 */
export const QUALITY_RUNS = 20;
export const QUALITY_QUARANTINE = 200;

export interface AssertionRun { taskId: string; entity: string; rows: number; assertions: AssertionResult[]; at: string }
export interface QuarantineRow { assertion: string; level: AssertionLevel; entity: string; key: string; row: string; /** 行 JSON 里的 _mapping：写进标准层时的映射 ID，早于该列的行里没有 */ mappingId: string | null; taskId: string; at: string }

/** 本租户最近的断言运行记录与隔离区样本，都按时间倒序；数据湖没初始化或还没跑过断言时为空。
 *  给 taskId 时只看这一次任务（两条查询都按 task_id 过滤，别的租户的任务在本租户的湖里自然查不到） */
export async function readQuality(tenantId: string, opts: { taskId?: string } = {}): Promise<{ runs: AssertionRun[]; quarantine: QuarantineRow[] }> {
  const lake = await lakeRow(tenantId);
  if (!lake || !lakeReady(lake)) return { runs: [], quarantine: [] };
  const session = await openTenantLake(lakeSpecOf(lake), READ_LIMITS, undefined, { readOnly: true });
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const tables = new Set((await read<{ name: string }>(`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_catalog = 'lake' AND table_schema = 'silver' AND table_name IN ('_assertion_runs', '_quarantine')`)).map(t => t.name));
    const byTask = opts.taskId ? ` WHERE task_id = ${lit(opts.taskId)}` : '';
    const runs = tables.has('_assertion_runs') ? await read<{ task_id: string; entity: string; rows: string; assertions: string; at: string }>(`
      SELECT task_id, entity, rows::VARCHAR AS rows, assertions::VARCHAR AS assertions, epoch_ms("at")::VARCHAR AS "at"
      FROM silver._assertion_runs${byTask} ORDER BY "at" DESC, entity LIMIT ${QUALITY_RUNS}`) : [];
    const quarantine = tables.has('_quarantine') ? await read<{ assertion: string; level: AssertionLevel; entity: string; key: string; row: string; mapping_id: string | null; task_id: string; at: string }>(`
      SELECT assertion, level, entity, "key", "row"::VARCHAR AS "row", json_extract_string("row", '_mapping') AS mapping_id, task_id, epoch_ms("at")::VARCHAR AS "at"
      FROM silver._quarantine${byTask} ORDER BY "at" DESC, assertion, "key" LIMIT ${QUALITY_QUARANTINE}`) : [];
    return {
      runs: runs.map(r => ({ taskId: r.task_id, entity: r.entity, rows: Number(r.rows), assertions: JSON.parse(r.assertions), at: new Date(Number(r.at)).toISOString() })),
      quarantine: quarantine.map(q => ({ assertion: q.assertion, level: q.level, entity: q.entity, key: q.key, row: q.row, mappingId: q.mapping_id, taskId: q.task_id, at: new Date(Number(q.at)).toISOString() })),
    };
  } finally {
    session.close();
  }
}

/** 这些映射 ID 的显示名「源 · 表 → 实体」（拼法与首页「待你发布」一致）：只查本租户的映射，已删除的不在返回的 Map 里，调用方改显映射 ID */
export async function mappingLabels(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await getDb().select({ id: mappings.id, sourceName: sources.name, tableName: mappings.tableName, entity: mappings.entity })
    .from(mappings).innerJoin(sources, eq(sources.id, mappings.sourceId))
    .where(and(eq(mappings.tenantId, tenantId), inArray(mappings.id, ids)));
  return new Map(rows.map(r => [r.id, `${r.sourceName} · ${r.tableName} → ${r.entity}`]));
}
