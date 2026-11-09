// vitest.config.ts —— 测试配置
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import { PER_WORKER_KEYS } from './test/setup-env';

// 本地的 .env.test（不提交，模板见 .env.test.example）：对象存储、MongoDB、MySQL 测试的连接；命令行里设置的同名变量优先
const envTest = join(import.meta.dirname, '.env.test');
if (existsSync(envTest)) process.loadEnvFile(envTest);

// 测试用平台 PG（独立的库，测试会清表）。写进 process.env 使 globalSetup 与被测服务都能读到
process.env.PLATFORM_DATABASE_URL =
  process.env.TEST_PLATFORM_DATABASE_URL ?? 'postgres://crm:crm@localhost:5432/crm_platform_test';
// 租户数据湖的根目录：测试用本地临时目录（测试会清空）
process.env.PLATFORM_LAKE_URI = join(tmpdir(), 'crm_platform_test_lake');
// 数据源夹具所在的源库（测试会重建其中的 shop schema 与两个测试账号）
process.env.TEST_SOURCE_DATABASE_URL ??= 'postgres://crm:crm@localhost:5432/crm_source_test';
// 测试不真正发信：即使 shell 里有 MAIL_HOST，默认实现也是输出到控制台（HTTP 测试另用收件箱替换）
process.env.MAILER = 'console';
// 测试不调用真实的模型服务：本地 .env.test 或 shell 里的平台默认配置不带进测试，要测时用 vi.stubEnv
delete process.env.LLM_BASE_URL;
delete process.env.LLM_MODEL;
delete process.env.LLM_API_KEY;
// 平台档位（ADR-0055）同理，两档各三个变量一起清
for (const tier of ['FAST', 'REASONING']) {
  for (const suffix of ['MODEL', 'BASE_URL', 'API_KEY']) delete process.env[`LLM_${tier}_${suffix}`];
}
// 凭据信封加密的主密钥：测试用固定值
process.env.PLATFORM_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
// DuckDB 文件类数据源所在的本地目录（每个租户一个子目录）
process.env.PLATFORM_SOURCE_FILES_DIR = join(tmpdir(), 'crm_platform_test_sources');
// 没有水位线字段、行数达到这个值的大表全量比对时默认每天同步；测试调低，夹具里的 events 表即为大表
process.env.SOURCE_LARGE_TABLE_ROWS = '1000';
// 设置 TEST_S3_LAKE_URI（如 s3://crm-lake/platform-test）后，隔离测试在对象存储上再跑一遍。
// 平台账号取 S3_*，未设置时用本地 SeaweedFS 的开发账号（db_script/docker-compose.yml）；租户账号由测试开通租户时经 IAM API 创建
if (process.env.TEST_S3_LAKE_URI) {
  process.env.S3_ACCESS_KEY ??= 'crm';
  process.env.S3_SECRET_KEY ??= 'crm-secret';
}
// 以上是基准值；每个 worker 在 test/setup-env.ts 里加后缀 _w<i> 用自己的一份（config 在主进程求值，拿不到 VITEST_POOL_ID）
for (const key of PER_WORKER_KEYS) {
  const value = process.env[key];
  if (value) process.env[`CRM_TEST_BASE_${key}`] = value;
}

// 测试超时的统一放宽倍数 CRM_TEST_TIMEOUT_SCALE（本地与 CI 不设，按 1）：沙箱门槛的完整测试里
// 4 个 worker 共用一台 PG 与 CPU、还有并行沙箱同时跑，负载下比本地约慢一倍（#439 实测），用例体里的
// publishedIdentitySources 平均就要 26.8 s（docs/test-plans/test-duration-report.md），整体逼近、超过 90 s，
// 已出过 3 张「负载下变慢、单跑能过」的偶发失败票（#357 / #440 / #459）。Sandcastle 沙箱设 2（180 s / 120 s），
// 之后的超时票先查是否真卡住，不再逐文件放宽。非数字或 ≤0 时按 1。
const parsedTimeoutScale = Number(process.env.CRM_TEST_TIMEOUT_SCALE ?? 1);
const timeoutScale = Number.isFinite(parsedTimeoutScale) && parsedTimeoutScale > 0 ? parsedTimeoutScale : 1;

// 测试不走 vite.config.ts（reactRouter 插件由 HTTP 接缝自己起的 vite 服务加载）
export default defineConfig({
  // 渲染组件的纯函数测试按 tsconfig 解析 ~/ 路径
  resolve: { tsconfigPaths: true },
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/setup-env.ts'],
    // 文件级并行：每个 worker 用自己的库与目录（test/setup-env.ts）。每个 worker 最多两个连接池
    // （测试侧与 vite 侧各 10 个）再加 DuckLake 的连接；默认 8 个 worker 要求 PG 的 max_connections ≥ 300
    // （db_script/docker-compose.yml），PG 还是默认的 100 时用 CRM_TEST_WORKERS=4
    maxWorkers: Number(process.env.CRM_TEST_WORKERS ?? 8),
    // CI 的 runner 性能差别大：慢的机器整体慢约 1.7 倍，快机器上 20–25 s 的流水线测试在慢机器上会超过 30 s。
    // timeoutScale：沙箱门槛经 CRM_TEST_TIMEOUT_SCALE 统一放宽（见上面的注释）
    testTimeout: 90_000 * timeoutScale,
    hookTimeout: 60_000 * timeoutScale,
  },
});
