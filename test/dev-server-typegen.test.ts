// test/dev-server-typegen.test.ts —— #615：测试起的 dev 服务器并发生成路由类型时同删同写 .react-router/types 报 ENOTEMPTY。
// 插件没有官方开关，用补丁加 REACT_ROUTER_SKIP_TYPEGEN（vitest.config.ts 里设），测试服务器不做类型生成。
// 本地 pnpm dev 不设这个变量，行为不变。同一进程内并发起 4 个服务器即可复现，不要反复单跑碰运气。
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { it, expect } from 'vitest';
import { WORKER_SUFFIX } from './setup-env';

const MARKER = join('.react-router', 'types', '#615-marker');

it('测试起的 dev 服务器不删、不重写 .react-router/types（#615）', async () => {
  await mkdir(join('.react-router', 'types'), { recursive: true });
  await writeFile(MARKER, '#615');
  try {
    await Promise.all(Array.from({ length: 4 }, async () => {
      // 选项与 test/http/harness.ts 的 start() 相同（cacheDir 换成本文件专用的）；
      // close() 会等插件的类型生成跑完，所以每个服务器都关掉后结果是确定的
      const vite: ViteDevServer = await createServer({
        configFile: 'vite.config.ts',
        // 用单独的缓存目录、不做浏览器端依赖预构建（原因见 test/http/harness.ts 的 start()）
        cacheDir: `node_modules/.vite-test-typegen${WORKER_SUFFIX}`,
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { middlewareMode: true, hmr: false, watch: null },
        appType: 'custom',
        logLevel: 'error',
      });
      await vite.close();
    }));
    // 修复前并发删写会把标记文件删掉（并常报 ENOTEMPTY 的未处理拒绝）；修复后（REACT_ROUTER_SKIP_TYPEGEN）保留
    expect(existsSync(MARKER)).toBe(true);
  } finally {
    await rm(MARKER, { force: true });
  }
});
