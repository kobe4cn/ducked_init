// test/process-alive.ts —— 判断进程是否还活着：lockTestDb 用它区分「锁文件里的 vitest 还在跑」和「已退出」。
// 僵尸进程（已退出、父进程没回收，#535 的 gate 就是这么白失败的：沙箱里一次 vitest 被外层 timeout 杀掉后
// 成了僵尸，process.kill(pid, 0) 照样成功，锁被当成有人占着）要当作已退出，之后的 vitest 才能接管锁
import { readFileSync } from 'node:fs';

/**
 * `readStatus` 默认读 Linux 的 `/proc/<pid>/status`；注入它只是为了让单测不真造僵尸进程。
 * 顺序：先 `process.kill(pid, 0)`（不存在或 pid 非法都会抛错 → 不活），成功后再看 status。
 */
export function isProcessAlive(
  pid: number,
  readStatus: (pid: number) => string = (p) => readFileSync(`/proc/${p}/status`, 'utf8'),
): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  let status: string;
  try {
    status = readStatus(pid);
  } catch {
    // 读不到（macOS 没有 /proc 等）：只信 process.kill，保持旧行为
    return true;
  }
  // State 行形如 `State:\tS (sleeping)`，僵尸是 `Z (zombie)`
  return !/^State:\s*(\S)/m.exec(status)?.[1]?.startsWith('Z');
}
