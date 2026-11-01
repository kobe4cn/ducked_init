// test/setup-env.ts —— 按 vitest worker 分库：每个 worker（VITEST_POOL_ID，1…maxWorkers）用自己的平台库、源库、湖目录、
// 源文件目录与对象存储前缀，名字是基准值加后缀 _w<i>。基准值由 vitest.config.ts 存在 CRM_TEST_BASE_* 里。
// 作为 setupFiles 每个测试文件跑一次（同一进程会跑多次），所以总是从基准值推，不在当前值上追加。
// 不在 vitest 里（scripts 引用夹具）时没有 VITEST_POOL_ID，不加后缀

/** 本 worker 的后缀：_w<i>；不在 vitest worker 里时为空 */
export const WORKER_SUFFIX = process.env.VITEST_POOL_ID ? `_w${process.env.VITEST_POOL_ID}` : '';

/** 连接串里的库名 */
export const dbNameOf = (url: string) => new URL(url).pathname.slice(1);

/** 连接串里的库名（路径）加后缀，其余不变 */
export function withDbSuffix(url: string, suffix = WORKER_SUFFIX) {
  const u = new URL(url);
  u.pathname = `${u.pathname}${suffix}`;
  return u.toString();
}

/** 基准值 → 本 worker 的值；值是连接串时给库名加后缀，否则（目录、s3:// 前缀）直接加在末尾 */
const PER_WORKER: Record<string, (base: string) => string> = {
  PLATFORM_DATABASE_URL: withDbSuffix,
  TEST_SOURCE_DATABASE_URL: withDbSuffix,
  TEST_MYSQL_URL: withDbSuffix,
  TEST_MONGO_URL: withDbSuffix,
  PLATFORM_LAKE_URI: base => base + WORKER_SUFFIX,
  PLATFORM_SOURCE_FILES_DIR: base => base + WORKER_SUFFIX,
  TEST_S3_LAKE_URI: base => base + WORKER_SUFFIX,
};

/** 按 worker 区分的环境变量：vitest.config.ts 把它们的基准值存到 CRM_TEST_BASE_<键> */
export const PER_WORKER_KEYS = Object.keys(PER_WORKER);

// vitest 主进程（vitest.config.ts、global-setup 导入本文件）与 scripts 里没有 VITEST_POOL_ID，环境变量保持不变
if (WORKER_SUFFIX) {
  for (const [key, derive] of Object.entries(PER_WORKER)) {
    const base = process.env[`CRM_TEST_BASE_${key}`];
    if (base) process.env[key] = derive(base);
  }
}
