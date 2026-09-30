// test/client-build.test.ts —— 客户端打包：HTTP 接缝只做服务端渲染，发现不了页面组件引用 .server 模块的问题，这里跑一次真实构建兜底
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, expect, it } from 'vitest';

const run = promisify(execFile);
let dir: string | undefined;

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('页面组件不引用服务端模块，客户端可以打包', async () => {
  dir = await mkdtemp(join(tmpdir(), 'crm-build-'));
  const result = run('npx', ['react-router', 'build'], { env: { ...process.env, REACT_ROUTER_BUILD_DIR: dir } });
  await expect(result.catch(e => Promise.reject(new Error(String(e.stderr || e.message))))).resolves.toBeTruthy();
}, 120_000);
