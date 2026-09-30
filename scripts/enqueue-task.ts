// scripts/enqueue-task.ts —— 用法：pnpm task:enqueue --tenant acme --kind demo.seed --params '{"customers":1000}'
// 为某个租户提交一个任务（由调度器派发执行）。任务类型见 app/.server/pipeline/handlers.ts
import { parseArgs } from 'node:util';
import { closeDb } from '../app/.server/db/client';
import { enqueueTask } from '../app/.server/tasks';
import { tenantIdBySlug } from '../app/.server/tenants';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string' },
    kind: { type: 'string' },
    params: { type: 'string', default: '{}' },
  },
});

if (!values.tenant || !values.kind) {
  console.error('用法：pnpm task:enqueue --tenant <租户标识> --kind <任务类型> [--params <JSON>]');
  process.exit(2);
}

try {
  const task = await enqueueTask(await tenantIdBySlug(values.tenant), values.kind, JSON.parse(values.params!));
  console.log(`已提交任务 ${task.kind}（id=${task.id}）`);
} catch (e) {
  console.error(`提交失败：${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
