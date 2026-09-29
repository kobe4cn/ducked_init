import { defineConfig } from 'vitest/config';

// 测试用平台 PG（独立的库，测试会清表）。写进 process.env 使 globalSetup 与被测服务都能读到
process.env.PLATFORM_DATABASE_URL =
  process.env.TEST_PLATFORM_DATABASE_URL ?? 'postgres://crm:crm@localhost:5432/crm_platform_test';

// 测试不走 vite.config.ts（reactRouter 插件由 HTTP 接缝自己起的 vite 服务加载）
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // 所有测试共用一个测试库，串行执行避免互相清表
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
