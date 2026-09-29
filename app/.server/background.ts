// app/.server/background.ts —— 进程内后台任务：请求先返回，耗时或会暴露差异的工作放到后面做
// 进程退出时未完成的任务会丢失（例如一封登录邮件，成员重新申请即可）；需要可靠投递时改走平台 PG 上的任务队列
const pending = new Set<Promise<void>>();

export function runInBackground(label: string, task: () => Promise<unknown>) {
  const p: Promise<void> = task()
    .then(() => undefined, e => console.error(`[后台任务失败] ${label}`, e))
    .finally(() => pending.delete(p));
  pending.add(p);
}

/** 等待当前所有后台任务结束（测试与停机时使用） */
export async function drain() {
  while (pending.size) await Promise.all(pending);
}
