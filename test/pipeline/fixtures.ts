// test/pipeline/fixtures.ts —— 流水线接缝的夹具：直接调用领域函数开通租户、入队任务并让调度器把队列跑空、把数据源的表全部选入同步范围
import { and, eq } from 'drizzle-orm';
import type { CurrentMember } from '../../app/.server/auth';
import { getDb } from '../../app/.server/db/client';
import { members, spaces, tenants, type Role } from '../../app/.server/db/schema';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
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
