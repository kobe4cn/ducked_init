// app/.server/quality.ts —— 数据质量告警（ADR-0026）：结果层任务因 error 级断言失败时，给租户管理员发邮件并记审计；
// 同一次入队的一组任务（参数里同一个 batchId）只告警一次、只记一条审计（#841），每个任务自己的报错文本照常写。
// 报错文本、邮件与审计写断言名、实体、不合格行数与来源映射名，并附数据质量页链接；不写键与行内容。数据质量页只读挂载本租户数据湖，读最近的断言运行记录与隔离区样本（只来自标准层，敏感字段只有哈希）；
// 顶部「最近一次」统计取平台库里每个结果层任务（每个定义、每个模板任务）最近一次运行的断言结果合并（合并任务也写运行记录，且 error 失败时回滚不留记录，不能拿湖里最近一条当准）。
// readQuality 可按任务 ID 过滤（#838，定义页的失败提示与告警链到 /quality?task=）；隔离区行 JSON 里的 _mapping 是映射 ID，mappingLabels 给出「源 · 表 → 实体」
import { and, desc, eq, inArray, isNotNull, like, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import { getDb } from './db/client';
import { auditLogs, dslDefinitions, mappings, members, sources, tasks } from './db/schema';
import { lakeReady, lakeRow, lakeSpecOf } from './lake';
import { getMailer } from './mailer';
import { openTenantLake } from './pipeline/lake-engine';
import { describeAssertion, failedErrors, type AssertionLevel, type AssertionResult } from './pipeline/assertions';
import { CONTRACTS, readResult, type TaskKind } from './pipeline/task-contracts';
import { appLink } from './schema-alerts';
import { lit } from '../lib/mapping-expr';

/**
 * 任务结果里有失败的 error 级断言时告警；没有时什么也不做。params 里的 batchId 把同一次入队的一组任务归成一批（一次发布、
 * 回刷、重新计算或一个定义的定时刷新；没有 batchId 的任务各自算一批）：一批只记一条审计、只发一封邮件，内容来自批里第一个
 * 失败的任务；每个任务自己的报错文本照常写（#840）。同租户的任务可能并发（max_concurrent_tasks 调大后两个钩子同时跑），
 * 先查后写挡不住，靠事务级 advisory lock 按批串行化后再查。发信在事务提交之后、不持锁：单个管理员发信失败只记日志，
 * 不影响其他人；发信失败（或进程在发信前退出）时同批后续任务不会补发——已接受的取舍
 */
export async function alertAssertionFailure(
  tenantId: string, task: { id: string; kind: TaskKind }, result: Record<string, unknown> | undefined, params: Record<string, unknown> | undefined,
) {
  const failed = failedErrors((result?.assertions as AssertionResult[] | undefined) ?? []);
  if (!failed.length) return;
  const { label } = CONTRACTS[task.kind];
  const batch = typeof params?.batchId === 'string' ? params.batchId : task.id;
  // 断言在工作进程里跑，结果里的 mappings 只有映射 ID（ADR-0008）：这里换成「源 · 表 → 实体」，已删除的映射查不到，原样写 ID
  const labels = await mappingLabels(tenantId, [...new Set(failed.flatMap(r => r.mappings ?? []))]);
  const sourcesOf = (r: AssertionResult) => (r.mappings ?? []).map(id => labels.get(id) ?? id);
  const summaries = failed.map(r => {
    const sources = sourcesOf(r);
    return `${describeAssertion(r)}${sources.length ? `，来源：${sources.join('、')}` : ''}`;
  });
  const link = appLink(`/quality?task=${task.id}`);
  // 任务页的报错文本换上带来源的摘要并附链接（本钩子在 finishTask 之后执行，不会随后者写库而被覆盖）：留在事务外，每个任务都写
  await getDb().update(tasks).set({ error: `断言失败：${summaries.join('；')}。查看样本：${link}` }).where(eq(tasks.id, task.id));
  // 拿锁后查这一批有没有告警过：有就不重复（审计与邮件都以这条审计为准，邮件在事务提交后才发）
  const first = await getDb().transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`assertion_alert:${tenantId}:${batch}`}, 0))`);
    const [alerted] = await tx.select({ id: auditLogs.id }).from(auditLogs).where(and(
      eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, 'assertion.failed'), sql`${auditLogs.detail} ->> 'batch' = ${batch}`,
    ));
    if (alerted) return false;
    await recordAudit(tx, {
      tenantId, system: true, action: 'assertion.failed', targetType: 'task', targetId: task.id,
      detail: { batch, task: label, summaries, mappings: [...new Set(failed.flatMap(sourcesOf))], link, assertions: failed },
    });
    return true;
  });
  if (!first) return;
  const admins = await getDb().select({ email: members.email }).from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.role, 'admin')));
  const text = [
    `「${label}」任务（${task.id}）计算前的数据检查没有通过，本次没有产出新快照，分析页继续使用上一版：`,
    '',
    ...summaries.map(s => `- ${s}`),
    '',
    '同一批重算的其他任务若也未通过，不再另发邮件，报错见各自的任务页。',
    '请检查对应映射的源数据，修正后重新合并并重算。',
    '',
    `查看样本：${link}`,
  ].join('\n');
  for (const { email } of admins) {
    await getMailer().send({ to: email, subject: `数据检查未通过：${label}`, text })
      .catch(e => console.error(`[告警] 给 ${email} 发断言失败邮件出错`, e));
  }
}

/** 每个结果层任务键（kind 加 params 里的 definitionId；模板任务没有 definitionId，就只按 kind）各自最近一次跑过断言（gold.*，
 *  结果里有 assertions）的运行。一次刷新会扇出很多 gold.dsl（一个定义一个任务），只看最后完成的一个会漏掉同批其他任务的失败（#1329）。
 *  已删除的定义不计入：deleteDefinition 是硬删除，删掉的定义不会再跑，它最后一次 gold.dsl 的失败不能一直留在统计里；
 *  gold.dsl 的 definitionId 要在本租户的 dsl_definitions 里还存在，模板任务（没有 definitionId）照旧只按 kind。
 *  返回覆盖的任务数、有失败断言的任务里最近完成的一个的任务 ID（提示链到 ?task= 用）与合并后的断言结果；还没有时为 undefined */
export async function latestResultCheck(tenantId: string): Promise<{ tasks: number; failedTaskId?: string; assertions: AssertionResult[] } | undefined> {
  // DISTINCT ON 的键：kind 加 params->>'definitionId'（模板任务的 params 里没有这一项，NULL 之间按相同处理，就只按 kind）；
  // orderBy 必须以 DISTINCT ON 的表达式开头，键内再按 finished_at 倒序：每个任务键各取最近一次完成的
  const rows = await getDb().selectDistinctOn([tasks.kind, sql`${tasks.params} ->> 'definitionId'`], { id: tasks.id, finishedAt: tasks.finishedAt, result: tasks.result })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), like(tasks.kind, 'gold.%'), isNotNull(tasks.finishedAt), sql`${tasks.result} -> 'assertions' IS NOT NULL`,
      sql`(${tasks.kind} <> 'gold.dsl' OR EXISTS (SELECT 1 FROM ${dslDefinitions} WHERE ${dslDefinitions.tenantId} = ${tasks.tenantId} AND ${dslDefinitions.id}::text = ${tasks.params} ->> 'definitionId'))`))
    .orderBy(tasks.kind, sql`${tasks.params} ->> 'definitionId'`, desc(tasks.finishedAt));
  if (!rows.length) return undefined;
  // 查询按 gold.% 匹配，模板任务（gold.rfm/…）与 gold.expire 也会进来：只借 gold.dsl 的结果类型读，不带 kind（#477）
  const runs = rows.map(r => ({ id: r.id, at: r.finishedAt!, assertions: readResult('gold.dsl', { result: r.result })!.assertions }));
  const failed = runs.filter(r => r.assertions.some(a => a.failed > 0));
  return {
    tasks: runs.length,
    failedTaskId: failed.length ? failed.reduce((a, b) => (a.at > b.at ? a : b)).id : undefined,
    assertions: runs.flatMap(r => r.assertions),
  };
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
