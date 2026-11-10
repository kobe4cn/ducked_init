// test/process-alive.ts 的纯函数用例（不连库）：lockTestDb 判断锁文件里的 vitest 是否还活着，
// 僵尸进程（#535 gate 白失败的根因：/proc/<pid>/status 的 State 为 Z、父进程没回收）要当作已退出，
// 读 status 的部分注入，不真造僵尸进程
import { describe, expect, it } from 'vitest';
import { isProcessAlive } from './process-alive';

describe('isProcessAlive', () => {
  it('进程不存在 → 不活', () => {
    // 2**22 + 12345 超过 Linux 默认 pid_max，必然不存在；process.kill(pid, 0) 抛 ESRCH
    expect(isProcessAlive(2 ** 22 + 12345)).toBe(false);
  });

  it('State 为 Z（僵尸）→ 不活', () => {
    expect(isProcessAlive(process.pid, () => 'Name:\tnode\nState:\tZ (zombie)\n')).toBe(false);
  });

  it('State 为 S（正常运行）→ 活', () => {
    expect(isProcessAlive(process.pid, () => 'State:\tS (sleeping)\n')).toBe(true);
  });

  it('读不到 /proc/<pid>/status（如 macOS 没有 /proc）→ 只看 process.kill，保持旧行为：活', () => {
    expect(
      isProcessAlive(process.pid, () => {
        throw new Error('ENOENT');
      }),
    ).toBe(true);
  });

  it('不注入 readStatus 时对本进程取默认实现：本进程不是僵尸 → 活（Linux 与 macOS 都是）', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
