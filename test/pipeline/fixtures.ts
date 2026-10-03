// test/pipeline/fixtures.ts —— 流水线接缝的夹具：直接调用领域函数开通租户、入队任务并让调度器把队列跑空、把数据源的表全部选入同步范围、
// 发布映射并合并、读取标准层
import { and, eq } from 'drizzle-orm';
import type { CurrentMember } from '../../app/.server/auth';
import { getDb } from '../../app/.server/db/client';
import { members, spaces, tenants, type Role } from '../../app/.server/db/schema';
import { lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createMapping, publishMapping } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { enqueueTask, getTask, type TaskKind } from '../../app/.server/tasks';
import { getSource, setSyncScope } from '../../app/.server/sources';
import { createTenant } from '../../app/.server/tenants';

/** 开通一个租户，返回租户 ID */
export async function newTenant(slug: string) {
  const { tenant } = await createTenant({ slug, name: slug, adminEmail: `admin@${slug}.com` });
  return tenant.id;
}

/** 入队一个任务并让调度器把队列跑空，返回该任务的最终状态 */
export async function runTask(tenantId: string, kind: TaskKind, params: Record<string, unknown> = {}) {
  const { id } = await enqueueTask(tenantId, kind, params);
  await createDispatcher({ maxWorkers: 4 }).runUntilIdle();
  return getTask(id);
}

/** 以某个成员的身份调用领域函数（与登录后服务端拿到的当前成员相同）；成员不存在时以给定角色加入租户 */
export async function memberOf(tenantId: string, email: string, role: Role = 'data_engineer'): Promise<CurrentMember> {
  const db = getDb();
  await db.insert(members).values({ tenantId, email, role }).onConflictDoNothing();
  const [row] = await db
    .select({
      memberId: members.id,
      email: members.email,
      role: members.role,
      tenant: { id: tenants.id, slug: tenants.slug, name: tenants.name },
      space: { id: spaces.id, name: spaces.name },
    })
    .from(members)
    .innerJoin(tenants, eq(tenants.id, members.tenantId))
    .innerJoin(spaces, and(eq(spaces.tenantId, tenants.id), eq(spaces.isDefault, true)))
    .where(and(eq(members.tenantId, tenantId), eq(members.email, email)));
  return row;
}

/** 把数据源列出的、账号可读的表全部选入同步范围（选入后入队采集，调用方再让调度器跑空） */
export async function selectAllTables(member: CurrentMember, sourceId: string) {
  const { listing } = await getSource(member, sourceId);
  await setSyncScope(member, sourceId, { add: listing.filter(t => t.readable && !t.gone).map(t => t.name) });
}

/** 起草并由另一位成员发布，让调度器跑完合并 */
export async function publish(author: CurrentMember, reviewer: CurrentMember, sourceId: string, yaml: string) {
  const mapping = await createMapping(author, sourceId, yaml);
  await publishMapping(reviewer, mapping.id, 1);
  await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
  return mapping.id;
}

/** 读取本租户标准层某个实体的表（时间按 UTC 文本、金额按文本显示） */
export async function silver(tenantId: string, entity: string, orderBy: string) {
  const session = await openTenantLake(lakeSpecOf((await lakeRow(tenantId))!), { memoryLimitMb: 256, threads: 1 });
  try {
    const columns = (await session.con.runAndReadAll(`DESCRIBE silver."${entity}"`)).getRowObjectsJson() as { column_name: string; column_type: string }[];
    // 带时区的时间在会话里按 UTC 转成文本（不交给客户端按本机时区换算）
    const times = columns.filter(c => c.column_type === 'TIMESTAMP WITH TIME ZONE' && c.column_name !== '_merged_at').map(c => `"${c.column_name}"::VARCHAR AS "${c.column_name}"`);
    const reader = await session.con.runAndReadAll(`SELECT * EXCLUDE (_merged_at) REPLACE (_version::INT AS _version${times.map(t => `, ${t}`).join('')})
      FROM silver."${entity}" ORDER BY ${orderBy}`);
    return reader.getRowObjectsJson() as Record<string, unknown>[];
  } finally {
    session.close();
  }
}
