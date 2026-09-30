// 队列调度接缝：领取（claimNextTask）与结束（finishTask）。只看领取顺序与名额，不启动工作进程
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { claimNextTask, enqueueTask, failStaleTasks, finishTask, getTask, heartbeatTasks } from '../../app/.server/tasks';
import { resumeTenant, setTenantQuota, suspendTenant } from '../../app/.server/tenants';
import { resetDb } from '../http/harness';
import { newTenant } from './fixtures';

afterAll(async () => { await closeDb(); });
beforeEach(async () => { await resetDb(); });

const quota = (maxConcurrentTasks: number) => ({ memoryLimitMb: 512, threads: 1, maxConcurrentTasks });

async function enqueue(tenantId: string, n: number) {
  for (let i = 0; i < n; i++) await enqueueTask(tenantId, 'lake.inventory', { i });
}

/** 连续领取（不结束），返回每次领到的租户；null 表示没有可派发的任务 */
async function claimTenants(n: number) {
  const out: (string | null)[] = [];
  for (let i = 0; i < n; i++) out.push((await claimNextTask())?.tenantId ?? null);
  return out;
}

describe('按租户的并发上限', () => {
  it('超出并发上限的任务排队，前一个结束后才派发', async () => {
    const acme = await newTenant('acme');
    await setTenantQuota(null, acme, quota(2));
    await enqueue(acme, 3);

    const first = (await claimNextTask())!;
    const second = (await claimNextTask())!;
    expect(await claimNextTask()).toBeNull();
    expect((await getTask(first.id)).status).toBe('running');

    await finishTask(first.id, { result: {} });
    const third = (await claimNextTask())!;
    expect(third.params).toEqual({ i: 2 });
    expect(second.params).toEqual({ i: 1 });
    expect(await claimNextTask()).toBeNull();
  });

  it('领到的任务带上本租户配额', async () => {
    const acme = await newTenant('acme');
    await setTenantQuota(null, acme, { memoryLimitMb: 4096, threads: 8, maxConcurrentTasks: 1 });
    await enqueue(acme, 1);
    expect((await claimNextTask())!.limits).toEqual({ memoryLimitMb: 4096, threads: 8 });
  });
});

describe('按租户公平调度', () => {
  it('大租户先排了很多任务，小租户的任务仍能在它之间轮到', async () => {
    const big = await newTenant('big');
    const small = await newTenant('small');
    await setTenantQuota(null, big, quota(10));
    await setTenantQuota(null, small, quota(10));
    await enqueue(big, 6);
    await enqueue(small, 2);

    expect(await claimTenants(5)).toEqual([big, small, big, small, big]);
  });

  it('一次只跑一个任务时，排队的租户轮流得到执行', async () => {
    const big = await newTenant('big');
    const small = await newTenant('small');
    const tiny = await newTenant('tiny');
    await enqueue(big, 5);
    await enqueue(small, 2);
    await enqueue(tiny, 1);

    const order: string[] = [];
    for (let task = await claimNextTask(); task; task = await claimNextTask()) {
      order.push(task.tenantId);
      await finishTask(task.id, { result: {} });
    }
    expect(order).toEqual([big, small, tiny, big, small, big, big, big]);
  });
});

describe('停用与中断', () => {
  it('停用租户的任务留在队列里不派发，恢复后继续；停用期间不能提交任务', async () => {
    const acme = await newTenant('acme');
    await enqueue(acme, 1);
    await suspendTenant(null, acme, '欠费');
    expect(await claimNextTask()).toBeNull();
    await expect(enqueueTask(acme, 'lake.inventory')).rejects.toThrow('租户已停用');

    await resumeTenant(null, acme, '已续约');
    expect((await claimNextTask())?.tenantId).toBe(acme);
  });

  it('续期时，租户已停用的运行中任务记为失败并交给调度器终止；其他任务照常续期', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await enqueue(acme, 1);
    await enqueue(globex, 1);
    const a = (await claimNextTask())!;
    const g = (await claimNextTask())!;
    await suspendTenant(null, acme, '欠费');

    expect(await heartbeatTasks([a.id, g.id])).toEqual([a.id]);
    expect(await getTask(a.id)).toMatchObject({ status: 'failed', error: '租户已停用，任务终止' });
    expect((await getTask(g.id)).status).toBe('running');
    // 工作进程被终止后回报的结果不会覆盖失败状态
    await finishTask(a.id, { result: {} });
    expect((await getTask(a.id)).status).toBe('failed');
  });

  it('调度器失联的任务判为失败并释放并发名额；仍在续期的任务不受影响', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');
    await enqueue(acme, 2);
    await enqueue(globex, 1);
    const lost = (await claimNextTask())!;
    const alive = (await claimNextTask())!;
    expect(await claimNextTask()).toBeNull();

    await new Promise(r => setTimeout(r, 50));
    await heartbeatTasks([alive.id]);
    await failStaleTasks(30);
    expect(await getTask(lost.id)).toMatchObject({ status: 'failed', error: '调度器失联，任务中断' });
    expect((await getTask(alive.id)).status).toBe('running');
    expect((await claimNextTask())?.tenantId).toBe(lost.tenantId);
  });
});
