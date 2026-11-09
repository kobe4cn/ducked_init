// test/enqueue-task-script.test.ts —— pnpm task:enqueue 命令行（#548）：不认识的 kind 在查库之前退出 2；参数不合法时入队里 parse 报错、退出 1
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '../app/.server/db/client';
import { createTenant, resetDb, runCli } from './http/harness';

afterAll(async () => { await closeDb(); });

describe('scripts/enqueue-task.ts', () => {
  it('不认识的任务类型：报错退出 2（不查库，不用建租户）', async () => {
    const r = await runCli('scripts/enqueue-task.ts', ['--tenant', 'acme', '--kind', 'no.such.kind']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('未知的任务类型：no.such.kind');
  });

  it('参数不合法：入队时 parse 报错，退出 1，文案与工作进程一致', async () => {
    await resetDb();
    await createTenant('acme', '示例商贸', 'admin@acme.com');
    const r = await runCli('scripts/enqueue-task.ts', ['--tenant', 'acme', '--kind', 'demo.seed', '--params', '{"customers":-1}']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('参数 customers 必须是 1 到 1000000 之间的整数');
  });
});
