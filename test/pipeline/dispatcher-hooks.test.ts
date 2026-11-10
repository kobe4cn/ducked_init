// 调度器结束钩子接缝：任务结束（finishTask）后按 task-hooks.ts 的表执行钩子 → 看执行顺序、触发条件与错误隔离。
// 纯函数部分用手写的任务与结果直接调 runHooks；集成一例真跑调度器验证 hooks 选项与执行时机
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { runHooks, type HookWhen } from '../../app/.server/pipeline/task-hooks';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import type { ClaimedTask } from '../../app/.server/tasks';
import { enqueueTask, getTask, listTasks } from '../../app/.server/tasks';
import { resetDb } from '../http/harness';
import { newTenant } from './fixtures';

afterAll(async () => { await closeDb(); });

/** 手写一个领到的任务：runHooks 只读 id、tenantId、kind、params，其余字段用不到 */
const taskOf = (kind: string, params: Record<string, unknown> = {}) =>
  ({ id: 'task-1', tenantId: 'acme', kind, params }) as unknown as ClaimedTask;

/** 假钩子：运行时把自己的名字记进 calls */
const hook = (name: string, when: HookWhen, calls: string[]) => ({ name, when, run: async () => { calls.push(name); } });

describe('runHooks', () => {
  it('按数组顺序执行满足条件的钩子', async () => {
    const calls: string[] = [];
    await runHooks({ 'lake.inventory': [hook('a', 'succeeded', calls), hook('b', 'result', calls), hook('c', 'succeeded', calls)] },
      taskOf('lake.inventory'), { result: { rows: 1 } });
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('成功（只有 result）：succeeded 与 result 的钩子跑，failed 不跑', async () => {
    const calls: string[] = [];
    await runHooks({ 'lake.inventory': [hook('succeeded', 'succeeded', calls), hook('result', 'result', calls), hook('failed', 'failed', calls)] },
      taskOf('lake.inventory'), { result: { rows: 1 } });
    expect(calls).toEqual(['succeeded', 'result']);
  });

  it('部分失败（error 加 result）：result 与 failed 的钩子跑，succeeded 不跑', async () => {
    const calls: string[] = [];
    await runHooks({ 'lake.inventory': [hook('succeeded', 'succeeded', calls), hook('result', 'result', calls), hook('failed', 'failed', calls)] },
      taskOf('lake.inventory'), { error: '两批里坏了一批', result: { rows: 1 } });
    expect(calls).toEqual(['result', 'failed']);
  });

  it('失败（只有 error，没有 result）：只有 failed 的钩子跑', async () => {
    const calls: string[] = [];
    await runHooks({ 'lake.inventory': [hook('succeeded', 'succeeded', calls), hook('result', 'result', calls), hook('failed', 'failed', calls)] },
      taskOf('lake.inventory'), { error: '参数不合法' });
    expect(calls).toEqual(['failed']);
  });

  it('钩子收到任务、按 kind 定型的参数与结果；failed 的钩子另有 error', async () => {
    const got: { task: string; params: unknown; result?: unknown; error?: string }[] = [];
    await runHooks({
      'source.sync': [
        { name: 'onResult', when: 'result', run: async ctx => { got.push({ task: ctx.task.id, params: ctx.params, result: ctx.result }); } },
        { name: 'onFailed', when: 'failed', run: async ctx => { got.push({ task: ctx.task.id, params: ctx.params, result: ctx.result, error: ctx.error }); } },
      ],
    }, taskOf('source.sync', { sourceId: 'src-1', tables: [] }), { error: '部分失败', result: { tables: [] } });
    expect(got).toEqual([
      { task: 'task-1', params: { sourceId: 'src-1', tables: [] }, result: { tables: [] } },
      { task: 'task-1', params: { sourceId: 'src-1', tables: [] }, result: { tables: [] }, error: '部分失败' },
    ]);
  });

  it('一个钩子抛错记 warn（带任务与钩子名），后面的钩子照跑', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    try {
      await runHooks({
        'lake.inventory': [
          { name: 'boom', when: 'result', run: async () => { throw new Error('钩子炸了'); } },
          hook('after', 'result', calls),
        ],
      }, taskOf('lake.inventory'), { result: {} });
      expect(calls).toEqual(['after']);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toBe('[调度器] 任务 task-1（lake.inventory）的钩子 boom 出错');
      expect(warn.mock.calls[0][1]).toBeInstanceOf(Error);
    } finally {
      warn.mockRestore();
    }
  });

  it('队列里的旧 kind（已不在契约表里）没有钩子，直接返回不报错', async () => {
    const calls: string[] = [];
    await runHooks({ 'lake.inventory': [hook('a', 'result', calls)] }, taskOf('gold.legacy'), { result: {} });
    expect(calls).toEqual([]);
  });

  it('没有登记钩子的 kind 是空数组，不报错', async () => {
    const calls: string[] = [];
    await runHooks({}, taskOf('lake.inventory'), { result: {} });
    expect(calls).toEqual([]);
  });
});

describe('调度器的 hooks 选项', () => {
  beforeEach(async () => { await resetDb(); });

  it('传了就替换整张钩子表；钩子在 finishTask 之后执行，任务已是 succeeded', async () => {
    const acme = await newTenant('acme');
    await enqueueTask(acme, 'lake.inventory', {});
    const seen: { id: string; kind: string; status: string }[] = [];
    await createDispatcher({
      maxWorkers: 1,
      hooks: {
        'lake.inventory': [{
          name: 'record',
          when: 'succeeded',
          run: async ({ task }) => { seen.push({ id: task.id, kind: task.kind, status: (await getTask(task.id)).status }); },
        }],
      },
    }).runUntilIdle();

    const [task] = await listTasks(acme);
    expect(task.status).toBe('succeeded');
    expect(seen).toEqual([{ id: task.id, kind: 'lake.inventory', status: 'succeeded' }]); // 钩子拿到该任务，且跑在 finishTask 之后
  });
});
