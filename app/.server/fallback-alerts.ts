// app/.server/fallback-alerts.ts —— 新的兜底取值告警（ADR-0015）：值字典写了兜底值（otherwise）时，合并任务结束后把各映射各列落入兜底的取值
// 写进已通知集合（mapping_fallback_values），写进去的就是以前没出现过的新取值；有新取值时记一条平台审计，并给能改映射（sources:write）的成员发邮件。
// 「新」与映射版本无关，重建合并再报出旧取值不再通知。邮件只写映射、列与新取值的个数，取值到映射页去看。
// 合并每列只报出现最多的几个取值（merge-engine.ts checkUnknownValues），其余的新取值要到以后的合并报出来才通知
import { and, eq, inArray } from 'drizzle-orm';
import { recordAudit } from './audit';
import { getDb } from './db/client';
import { mappingFallbackValues, mappings } from './db/schema';
import type { FallbackStat, MergeRecord } from './pipeline/merge-engine';
import { appLink, mailSourceWriters } from './schema-alerts';
import { entityLabel } from '../lib/canonical-model';

/** 一个映射这次出现的新兜底取值：各列的新取值个数 */
export interface NewFallback { mapping: string; entity: string; table: string; columns: { column: string; count: number }[] }

/** 合并任务结果里各映射落入兜底的取值与已通知集合比较，有新取值时告警；没有时什么也不做 */
export async function alertNewFallback(tenantId: string, task: { id: string }, result: Record<string, unknown> | undefined) {
  const records = ((result?.mappings as MergeRecord[] | undefined) ?? [])
    .filter((r): r is MergeRecord & { fallback: FallbackStat[] } => 'fallback' in r && !!r.fallback?.length);
  if (!records.length) return;
  // 只认这个租户的映射：结果来自工作进程，映射 ID 不直接信任
  const owned = new Set((await getDb().select({ id: mappings.id }).from(mappings)
    .where(and(eq(mappings.tenantId, tenantId), inArray(mappings.id, records.map(r => r.mapping))))).map(m => m.id));
  const values = records.filter(r => owned.has(r.mapping)).flatMap(r => r.fallback
    .flatMap(f => f.values.map(v => ({ mappingId: r.mapping, column: f.column, value: v.value, taskId: task.id }))));
  if (!values.length) return;
  const inserted = await getDb().insert(mappingFallbackValues).values(values).onConflictDoNothing()
    .returning({ mapping: mappingFallbackValues.mappingId, column: mappingFallbackValues.column });
  if (!inserted.length) return;

  const fresh: NewFallback[] = records.flatMap(({ mapping, entity, table }) => {
    const counts = new Map<string, number>();
    for (const row of inserted.filter(i => i.mapping === mapping)) counts.set(row.column, (counts.get(row.column) ?? 0) + 1);
    return counts.size ? [{ mapping, entity, table, columns: [...counts].map(([column, count]) => ({ column, count })) }] : [];
  });
  await recordAudit(getDb(), {
    tenantId, system: true, action: 'mapping.fallback_new', targetType: 'task', targetId: task.id,
    detail: { task: task.id, mappings: fresh },
  });
  const text = [
    `合并任务 ${task.id} 里，下面这些映射的值字典没有写到的新取值落入了兜底值：`,
    '',
    ...fresh.map(f => `- ${f.table} → ${entityLabel(f.entity)}（映射 ${f.mapping}）：${f.columns.map(c => `${c.column} 有 ${c.count} 个新取值`).join('，')} ${appLink(`/mappings/${f.mapping}`)}`),
    '',
    '取值与行数请到映射页的合并记录查看。需要单独映射这些取值时，请在值字典里补上后重新发布；以前通知过的取值不再通知。',
  ].join('\n');
  await mailSourceWriters(tenantId, `新的兜底取值：${fresh.length} 个映射`, text);
}
