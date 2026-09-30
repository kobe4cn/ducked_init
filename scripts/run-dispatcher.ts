// scripts/run-dispatcher.ts —— 用法：pnpm dispatcher
// 常驻的调度器：从平台 PG 的任务队列领取任务，每个任务启动一个只挂载本租户数据湖的工作进程。
// 本机同时运行的工作进程数由 PLATFORM_MAX_WORKERS 控制（默认 4）；可以在多台机器上各跑一个
import { closeDb } from '../app/.server/db/client';
import { createDispatcher } from '../app/.server/pipeline/dispatcher';

const maxWorkers = Number(process.env.PLATFORM_MAX_WORKERS ?? 4);
const dispatcher = createDispatcher({ maxWorkers });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log('调度器停止中：不再领取新任务，等待运行中的任务结束…');
    dispatcher.stop();
  });
}

console.log(`调度器已启动：本机最多同时运行 ${maxWorkers} 个工作进程`);
await dispatcher.run();
await closeDb();
