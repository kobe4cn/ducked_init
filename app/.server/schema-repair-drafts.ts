// app/.server/schema-repair-drafts.ts —— 源列改名后平台按规则起草修复草稿（ADR-0034）：alertSchemaBreak 发现已发布映射引用的列被删除时
// 入队带 repairFor（同步任务 ID）的采集，采集成功后调度器调用这里。对每个受影响的映射，用被删除的列在本次之前的采集结果与新增的列在
// 本次的采集结果猜改名（schema-repair.ts），改写最新已发布版本的 YAML，以平台身份存成草稿（不发布，仍要空跑与双人发布），记审计，
// 最后给能改映射的成员发一封带草稿链接的邮件。只改被删除的列；破坏性改类型的列留给人改，邮件里写明。邮件只写列名与依据的种类，不写取值
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from './db/client';
import { mappingVersions, sources, tasks } from './db/schema';
import { MappingError, publishedPlans, savePlatformDraft } from './mappings';
import { referencedSourceColumns } from './pipeline/mapping-spec';
import { isBreaking, type SchemaDiff } from './pipeline/schema-diff';
import { appLink, mailSourceWriters } from './schema-alerts';
import { describeRename, guessRenames, type Rename, rewriteMappingYaml } from './pipeline/schema-repair';
import type { ColumnProfile, TableProfile } from './pipeline/source-engine';
import type { SyncRecord } from './pipeline/sync-engine';
import { entityLabel } from '../lib/canonical-model';

/** 一个受影响映射的起草结果，邮件按它逐个列出 */
type RepairOutcome =
  | { kind: 'drafted'; version: number; renames: Rename[] }
  | { kind: 'skipped' }
  | { kind: 'no_candidate'; unmatched: string[] }
  | { kind: 'invalid'; renames: Rename[]; unmatched: string[]; message: string };

/** 这张表在发现删列的同步开始（before）之前最近一次成功采集到的列统计：之后的采集（含本次）已看不到被删除的列 */
async function previousProfile(tenantId: string, sourceId: string, table: string, before: Date) {
  const { rows } = await getDb().execute<{ profile: TableProfile }>(sql`
    SELECT p AS profile
    FROM ${tasks} t CROSS JOIN LATERAL jsonb_array_elements(t.result->'tables') p
    WHERE t.tenant_id = ${tenantId} AND t.kind = 'source.profile' AND t.status = 'succeeded' AND t.params->>'sourceId' = ${sourceId}
      AND t.finished_at < ${before.toISOString()} AND p->>'name' = ${table}
    ORDER BY t.finished_at DESC, t.id DESC
    LIMIT 1`);
  return rows[0]?.profile;
}

/** 采集任务 task（params.repairFor 是发现删列的同步任务）成功后，为受影响的已发布映射起草修复草稿并通知。出错只记日志 */
export async function draftSchemaRepairs(tenantId: string, task: { id: string; params: Record<string, unknown> }) {
  const sourceId = String(task.params.sourceId);
  const [profiled] = await getDb().select({ result: tasks.result }).from(tasks).where(and(eq(tasks.id, task.id), eq(tasks.tenantId, tenantId)));
  const [synced] = await getDb().select({ result: tasks.result, createdAt: tasks.createdAt }).from(tasks)
    .where(and(eq(tasks.id, String(task.params.repairFor)), eq(tasks.tenantId, tenantId)));
  if (!synced) return;
  const changes = new Map<string, SchemaDiff>();
  for (const r of ((synced.result as { tables?: SyncRecord[] } | null)?.tables) ?? []) {
    if ('schema' in r && r.schema?.changed) changes.set(r.table, r.schema);
  }
  const current = new Map(((profiled?.result as { tables?: TableProfile[] } | null)?.tables ?? []).map(t => [t.name, t]));
  const previous = new Map<string, TableProfile | undefined>();
  const results: { mapping: string; entity: string; table: string; typeChanged: string[]; outcome: RepairOutcome }[] = [];
  for (const plan of await publishedPlans(getDb(), tenantId)) {
    const diff = changes.get(plan.table);
    const profile = current.get(plan.table);
    if (plan.sourceId !== sourceId || plan.view || !diff || !profile) continue;
    const used = referencedSourceColumns(plan);
    const removed = diff.removed.filter(c => used.has(c));
    if (!removed.length) continue;
    const typeChanged = diff.typeChanged.filter(c => used.has(c.name) && isBreaking(c.from, c.to)).map(c => c.name);
    if (!previous.has(plan.table)) previous.set(plan.table, await previousProfile(tenantId, sourceId, plan.table, synced.createdAt));
    const before = previous.get(plan.table)?.columns ?? [];
    const pick = (columns: ColumnProfile[], names: string[]) => columns.filter(c => names.includes(c.name));
    const renames = guessRenames(pick(before, removed), pick(profile.columns, diff.added));
    const unmatched = removed.filter(c => !renames.some(r => r.from === c));
    const entry = { mapping: plan.mapping, entity: plan.entity, table: plan.table, typeChanged };
    if (!renames.length) {
      results.push({ ...entry, outcome: { kind: 'no_candidate', unmatched } });
      continue;
    }
    const [published] = await getDb().select({ yaml: mappingVersions.yaml }).from(mappingVersions)
      .where(and(eq(mappingVersions.mappingId, plan.mapping), eq(mappingVersions.version, plan.version)));
    try {
      const saved = await savePlatformDraft(tenantId, plan.mapping, rewriteMappingYaml(published.yaml, renames), renames);
      results.push({ ...entry, outcome: saved ? { kind: 'drafted', version: saved.version, renames } : { kind: 'skipped' } });
    } catch (e) {
      // 还有没猜出的列、改类型的列等：改写后的文档过不了校验，不存
      if (!(e instanceof MappingError)) throw e;
      results.push({ ...entry, outcome: { kind: 'invalid', renames, unmatched, message: e.message } });
    }
  }
  if (!results.length) return;

  const [source] = await getDb().select({ name: sources.name }).from(sources).where(and(eq(sources.id, sourceId), eq(sources.tenantId, tenantId)));
  const sourceName = source?.name ?? sourceId;
  const renameList = (renames: Rename[]) => renames.map(r => `    ${r.from} → ${r.to}（${describeRename(r)}）`);
  const lines = results.flatMap(({ mapping, entity, table, typeChanged, outcome }) => {
    const head = `- ${table} → ${entityLabel(entity)}（映射 ${mapping}）：`;
    const manual = typeChanged.length ? [`  ${typeChanged.join('、')} 改了类型，平台不改写，请人工修改`] : [];
    const missing = 'unmatched' in outcome && outcome.unmatched.length ? [`  ${outcome.unmatched.join('、')} 没有找到改名的候选，请人工修改`] : [];
    switch (outcome.kind) {
      case 'drafted':
        return [`${head}已起草第 ${outcome.version} 版草稿 ${appLink(`/mappings/${mapping}?version=${outcome.version}`)}`, ...renameList(outcome.renames), ...manual];
      case 'skipped':
        return [`${head}已有成员在改的草稿，平台没有起草，请在那份草稿里修改`, ...manual];
      case 'no_candidate':
        return [`${head}新增的列里没有类型相同、统计相近的候选，平台没有起草`, ...missing, ...manual];
      case 'invalid':
        return [`${head}按猜测改写后没通过校验（${outcome.message}），平台没有起草`, ...renameList(outcome.renames), ...missing, ...manual];
    }
  });
  const text = [
    `数据源「${sourceName}」的源表删了已发布映射引用的列（同步任务 ${String(task.params.repairFor)}）。平台按规则猜测这些列是否改了名（不调用模型）：`,
    '',
    ...lines,
    '',
    '草稿不会自动发布，映射的合并在发布修复版本前仍会失败。请打开草稿核对平台的猜测（YAML 里的注释写明了依据），空跑后由另一位有发布权限的成员发布。',
  ].join('\n');
  await mailSourceWriters(tenantId, `映射修复草稿：${sourceName}`, text);
}
