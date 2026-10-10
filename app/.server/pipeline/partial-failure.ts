// app/.server/pipeline/partial-failure.ts —— 任务部分完成：记为失败，同时保留已完成部分的结果（工作进程据此回报 error 与 result）
export class PartialFailure extends Error {
  constructor(message: string, readonly result: Record<string, unknown>) { super(message); }
}
