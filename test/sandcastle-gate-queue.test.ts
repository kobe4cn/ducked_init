// .sandcastle/gate-queue.ts：门槛同一时间只跑一个，票的门槛优先于 main 的兜底完整测试
import { describe, expect, it } from 'vitest';
import { createGateQueue } from '../.sandcastle/gate-queue';

/** 一个手动结束的任务：开跑时记进 log，调 finish() 才结束。 */
function job(log: string[], name: string) {
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  return {
    run: async () => {
      log.push(`start ${name}`);
      await done;
      log.push(`end ${name}`);
      return name;
    },
    finish: () => finish(),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createGateQueue', () => {
  it('同一时间只跑一个，票按进队顺序', async () => {
    const q = createGateQueue();
    const log: string[] = [];
    const a = job(log, 'a');
    const b = job(log, 'b');
    const pa = q.run(a.run);
    const pb = q.run(b.run);
    await tick();
    expect(log).toEqual(['start a']);
    a.finish();
    await expect(pa).resolves.toBe('a');
    await tick();
    expect(log).toEqual(['start a', 'end a', 'start b']);
    b.finish();
    await expect(pb).resolves.toBe('b');
  });

  it('兜底排在票前面进队时，票先跑；没有票在等时兜底才开跑', async () => {
    const q = createGateQueue();
    const log: string[] = [];
    const t1 = job(log, 't1');
    const main = job(log, 'main');
    const t2 = job(log, 't2');
    q.run(t1.run);
    const pm = q.run(main.run, { low: true });
    q.run(t2.run);
    await tick();
    t1.finish();
    await tick();
    expect(log.at(-1)).toBe('start t2');
    t2.finish();
    await tick();
    expect(log.at(-1)).toBe('start main');
    main.finish();
    await expect(pm).resolves.toBe('main');
  });

  it('队空时兜底直接开跑，开跑后来的票等它跑完；任务失败不卡住队列', async () => {
    const q = createGateQueue();
    const log: string[] = [];
    const main = job(log, 'main');
    q.run(main.run, { low: true });
    const pf = q.run(async () => {
      log.push('start bad');
      throw new Error('gate crashed');
    });
    const t = job(log, 't');
    const pt = q.run(t.run);
    await tick();
    expect(log).toEqual(['start main']);
    main.finish();
    await expect(pf).rejects.toThrow('gate crashed');
    await tick();
    expect(log.at(-1)).toBe('start t');
    t.finish();
    await expect(pt).resolves.toBe('t');
  });
});
