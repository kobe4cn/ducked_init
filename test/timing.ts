// test/timing.ts —— 测量夹具的固定开销：设置 TEST_TIMING=<jsonl 路径> 时，每次调用追加一行 { name, ms, at, file, test }（at 是开始时刻的 epoch 毫秒）；
// 没设置时直接执行，行为不变。用追加写：每个测试文件在不同的 worker 进程里跑。汇总见 scripts/test-duration-report.ts
import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';

// 只在开启计时时加载 vitest：scripts/*-seed 也引用流水线夹具，在 vitest 之外运行
const vitest = process.env.TEST_TIMING ? await import('vitest') : null;

/** 当前文件（相对仓库根目录）与用例名；在 beforeAll 里 test 为 null */
function where() {
  const { testPath, currentTestName } = vitest!.expect.getState();
  return { file: testPath ? relative(process.cwd(), testPath) : null, test: currentTestName ?? null };
}

/** 写一行计时记录（只在开启计时时调用）；extra 是附带的字段（如任务的 status） */
export function record(name: string, ms: number, extra: Record<string, unknown> = {}) {
  const at = Math.round(Date.now() - ms);
  appendFileSync(process.env.TEST_TIMING!, `${JSON.stringify({ name, ms: Math.round(ms), at, ...where(), ...extra })}\n`);
}

export const timingEnabled = () => !!process.env.TEST_TIMING;

/** 计时执行 fn，记一行 name 的耗时（失败也记） */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!timingEnabled()) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    record(name, performance.now() - start);
  }
}
