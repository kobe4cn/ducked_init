// vitest.config.ts —— 测试配置
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// 测试用平台 PG（独立的库，测试会清表）。写进 process.env 使 globalSetup 与被测服务都能读到
process.env.PLATFORM_DATABASE_URL =
  process.env.TEST_PLATFORM_DATABASE_URL ?? 'postgres://crm:crm@localhost:5432/crm_platform_test';
// 租户数据湖的根目录：测试用本地临时目录（测试会清空）
process.env.PLATFORM_LAKE_URI = join(tmpdir(), 'crm_platform_test_lake');
// 数据源夹具所在的源库（测试会重建其中的 shop schema 与两个测试账号）
process.env.TEST_SOURCE_DATABASE_URL ??= 'postgres://crm:crm@localhost:5432/crm_source_test';
// 凭据信封加密的主密钥：测试用固定值
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
// DuckDB 文件类数据源所在的本地目录（每个租户一个子目录）
process.env.PLATFORM_SOURCE_FILES_DIR = join(tmpdir(), 'crm_platform_test_sources');
// 没有水位线字段、行数达到这个值的表本期不支持；测试调低，夹具里的 events 表即为大表
process.env.SOURCE_LARGE_TABLE_ROWS = '1000';
// 设置 TEST_S3_LAKE_URI（如 s3://crm-lake/platform-test）后，隔离测试在对象存储上再跑一遍。
// 平台账号取 S3_*，未设置时用本地 SeaweedFS 的开发账号（db_script/docker-compose.yml）；租户账号由测试开通租户时经 IAM API 创建
if (process.env.TEST_S3_LAKE_URI) {
  process.env.S3_ACCESS_KEY ??= 'crm';
  process.env.S3_SECRET_KEY ??= 'crm-secret';
}

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
