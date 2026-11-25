// .sandcastle/gate-queue.ts —— 门槛队列：同一时间只跑一个门槛，票的门槛优先于 main 的兜底完整测试。
// 兜底（low）只在没有票的门槛在等时才开跑；它在排队期间来了票，票先跑。已经开跑的兜底不打断。
// 2026-11-26 起：之前兜底和票排同一个先进先出的队，兜底一跑 45 分钟，期间进队的票平白多等这么久。

export type GateQueue = {
  /** 排上队后执行 job；low 为兜底测试，有票（非 low）在等时让票先跑。 */
  run<T>(job: () => Promise<T>, opts?: { low?: boolean }): Promise<T>;
};

export function createGateQueue(): GateQueue {
  const waiters: { low: boolean; start: () => void }[] = [];
  let busy = false;
  const pump = () => {
    if (busy || waiters.length === 0) return;
    const high = waiters.findIndex((w) => !w.low);
    const [next] = waiters.splice(high >= 0 ? high : 0, 1);
    busy = true;
    next.start();
  };
  return {
    async run(job, opts = {}) {
      await new Promise<void>((start) => {
        waiters.push({ low: opts.low === true, start });
        pump();
      });
      try {
        return await job();
      } finally {
        busy = false;
        pump();
      }
    },
  };
}
