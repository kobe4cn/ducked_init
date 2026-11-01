// test/pipeline/identity-helpers.ts —— 身份打通测试的读取与操作 helper（identity-merge / identity-recompute / identity-stable-id 共用）：种子明文 SEEDED，
// 读 silver._identities 与 _device_owner 的 identities、匿名事件的 anonymousEvents、统一消费者同意的 consumerConsent、分组比较的 groupsOf，
// 最近一次合并任务 lastMerge，以及存新草稿并由另一位成员发布的 republish
import type { DuckDBConnection } from '@duckdb/node-api';
import { and, desc, eq } from 'drizzle-orm';
import type { CurrentMember } from '../../app/.server/auth';
import { getDb } from '../../app/.server/db/client';
import { tasks } from '../../app/.server/db/schema';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { publishMapping, saveDraft } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';

export const drain = () => createDispatcher({ maxWorkers: 2 }).runUntilIdle();

/** 种子里的明文：手机号（规范化前后）、邮箱、外部 ID 与姓名 */
export const SEEDED = ['13800000001', '138 0000', '138-0000', '13800000002', '13900000005', '139 0000', 'zhang@crm', 'wang5@example', 'qian7@example',
  'li4@loyalty', 'wx_union_8', '13700000009', '张三', '李四', '王五', '钱七', '孙八'];

export type Identity = { _source: string; customer_id: string; consumer_id: string };
export type DeviceOwner = { device_id: string; consumer_id: string; login_at: string };

/** silver._identities 的全部行（按数据源与 customer_id 排序）与整表的 JSON 文本，以及 silver._device_owner 的全部行（按设备排序） */
export async function identities(tenantId: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  const read = async <T>(sql: string) => (await session.con.runAndReadAll(sql)).getRowObjectsJson() as T[];
  try {
    const rows = await read<Identity>('SELECT * FROM silver._identities ORDER BY _source, customer_id');
    const devices = await read<DeviceOwner>(`SELECT * REPLACE (strftime(login_at AT TIME ZONE 'UTC', '%Y-%m-%d %H:%M') AS login_at)
      FROM silver._device_owner ORDER BY device_id`);
    return { rows, text: JSON.stringify(rows), devices };
  } finally {
    session.close();
  }
}

/** 匿名事件（customer_id 为空）经设备归属到的统一消费者；设备没有归属时为 null */
export async function anonymousEvents(tenantId: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    return (await session.con.runAndReadAll(`SELECT e.event_id, o.consumer_id FROM silver."event" e
      LEFT JOIN silver._device_owner o USING (device_id) WHERE e.customer_id IS NULL ORDER BY e.event_id`)).getRowObjectsJson();
  } finally {
    session.close();
  }
}

/** 某条源记录所属的统一消费者在 silver._consumer_consent 里的各渠道状态与来源（按渠道排序） */
export async function consumerConsent(con: DuckDBConnection, sourceId: string, customerId: string) {
  return (await con.runAndReadAll(`SELECT c.channel, c.status, c._source FROM silver._consumer_consent c JOIN silver._identities i USING (consumer_id)
    WHERE i._source = '${sourceId}' AND i.customer_id = '${customerId}' ORDER BY c.channel`)).getRowObjectsJson();
}

/** 按统一消费者分组，每组是「数据源名:customer_id」的列表；组按第一条排序，便于整体比较 */
export const groupsOf = (rows: Identity[], names: Record<string, string>) => {
  const groups = new Map<string, string[]>();
  for (const r of rows) groups.set(r.consumer_id, [...(groups.get(r.consumer_id) ?? []), `${names[r._source]}:${r.customer_id}`]);
  return [...groups.values()].map(g => g.sort()).sort((a, b) => a[0].localeCompare(b[0]));
};

/** 本租户最近一次合并任务（按创建时间） */
export async function lastMerge(tenantId: string) {
  const [merge] = await getDb().select().from(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.kind, 'silver.merge')))
    .orderBy(desc(tasks.createdAt), desc(tasks.id)).limit(1);
  return merge as typeof merge & { result: { identities?: Record<string, unknown> } };
}

/** 给映射存一版新草稿并由另一位成员发布，跑空调度器（合并与打通完成） */
export async function republish(author: CurrentMember, reviewer: CurrentMember, mappingId: string, yaml: string) {
  await publishMapping(reviewer, mappingId, await saveDraft(author, mappingId, yaml));
  await drain();
}
