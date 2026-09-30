// test/pipeline/fixtures.ts —— 流水线接缝的夹具：直接调用领域函数开通租户、入队任务并让调度器把队列跑空
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { enqueueTask, getTask, type TaskKind } from '../../app/.server/tasks';
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
