// src/10_engineering.ts —— 上线必备的工程能力
//   ⑨ 多进程只读并发 + 蓝绿切换        ⑩ 查询超时、取消与进度
//   ⑪ 加密与脱敏（个人信息）          ⑫ 数据质量：坏行隔离、字段演进、断言检查
//   ⑬ SCD2：客户属性历史与“下单时”口径  ⑭ 性能诊断：Profiling JSON、Parquet 行组与 Bloom 过滤器
// 运行：npm run engineering（需要先跑过 model / crm）
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { config } from './lib/config';
import { connect, exec, q, show } from './lib/duck';

const run = promisify(execFile);
const con = await connect({ s3: false });
await con.run(`SET VARIABLE as_of = TIMESTAMP '2026-09-27'`);
const only = process.argv[2];
const part = (n: number) => !only || only === String(n);
mkdirSync('./data/serving', { recursive: true });
mkdirSync('./data/secure', { recursive: true });
mkdirSync('./data/dq', { recursive: true });

// =====================================================================
// ⑨ 多进程只读并发：写进程出“服务库”，多个 API 进程只读挂载，蓝绿切换
// =====================================================================
if (part(9)) {
  // 1) 写进程：把接口要用的 gold 表导出成一个独立的“服务库”文件（带版本号）
  const version = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const file = `./data/serving/crm_serving_${version}.duckdb`;
  await exec(con, `
    ATTACH '${file}' AS serving;
    CREATE TABLE serving.user_360      AS SELECT * FROM gold.user_360 ORDER BY customer_id;
    CREATE TABLE serving.rfm           AS SELECT * FROM gold.rfm ORDER BY customer_id;
    CREATE TABLE serving.loyalty_score AS SELECT * FROM gold.loyalty_score ORDER BY customer_id;
    CHECKPOINT serving;
    DETACH serving;`, `9a. 生成服务库 ${file}`);
  console.log(`  文件大小 ${(statSync(file).size / 1e6).toFixed(0)} MB`);

  // 2) 蓝绿切换：current 软链接原子地指向新版本；读进程下次打开时拿到新数据
  const current = './data/serving/current.duckdb';
  const tmpLink = `${current}.${version}`;
  symlinkSync(`crm_serving_${version}.duckdb`, tmpLink);
  renameSync(tmpLink, current);                        // rename 是原子操作，读进程不会看到“半个文件”
  console.log(`✔ 9b. current.duckdb → crm_serving_${version}.duckdb（原子切换）`);

  // 3) 4 个独立的 Node 进程同时以只读方式打开同一个文件，各做 2000 次点查
  const [{ mx }] = await q<any>(con, `SELECT max(customer_id)::BIGINT AS mx FROM gold.user_360`);
  const worker = (n: number) => run(process.execPath, ['--import', 'tsx', 'src/lib/reader-worker.ts', current, String(n), String(mx)]);
  const t0 = performance.now();
  const outs = await Promise.all([1, 2, 3, 4].map(() => worker(2000)));
  const wall = performance.now() - t0;
  const stats = outs.map(o => JSON.parse(o.stdout));
  console.log(`\n▶ 9c. 4 个进程同时只读查询同一个库（每个 2000 次客户画像点查）`);
  console.table(stats.map(s => ({ 进程: s.pid, 打开耗时_ms: s.open_ms, p50_ms: s.p50, p95_ms: s.p95, 单进程QPS: s.qps })));
  console.log(`  合计 8000 次查询，总耗时 ${(wall / 1000).toFixed(1)} s，整体约 ${Math.round(8000 / (wall / 1000))} QPS`);

  // 4) 只读进程运行期间，另一个进程尝试以读写方式打开：会被文件锁拒绝
  const reader = spawn(process.execPath, ['--import', 'tsx', 'src/lib/reader-worker.ts', current, '20000', String(mx)]);
  await new Promise(r => setTimeout(r, 1500));
  try {
    await DuckDBInstance.create(current);                  // 默认读写
    console.log('  （意外）读写打开成功');
  } catch (e) {
    console.log(`✔ 9d. 有只读进程时，读写打开被拒绝：${String(e).split('\n')[0].slice(0, 110)}…`);
  }
  reader.kill();

  // 5) 清理旧版本：只保留最近 2 个
  const { readdirSync } = await import('node:fs');
  const olds = readdirSync('./data/serving').filter(f => /^crm_serving_\d+\.duckdb$/.test(f)).sort().slice(0, -2);
  olds.forEach(f => rmSync(`./data/serving/${f}`, { force: true }));
}

// =====================================================================
// ⑩ 查询超时、取消与进度
// =====================================================================
if (part(10)) {
  /** 给任意查询加超时：到点调用 interrupt()，查询以 INTERRUPT 错误结束，连接可继续使用 */
  async function withTimeout<T>(c: DuckDBConnection, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    const timer = setTimeout(() => c.interrupt(), timeoutMs);
    try { return await fn(); }
    catch (e) {
      if (/interrupt/i.test(String(e))) throw new Error(`查询超过 ${timeoutMs} ms 被取消`);
      throw e;
    } finally { clearTimeout(timer); }
  }

  const heavy = `SELECT count(*) FROM silver.order_items a JOIN silver.order_items b USING (sku)`;   // 故意写的“爆炸 JOIN”
  const t0 = performance.now();
  try {
    await withTimeout(con, 1000, () => con.runAndReadAll(heavy));
  } catch (e) {
    console.log(`\n✔ 10a. ${(e as Error).message}，实际用时 ${(performance.now() - t0).toFixed(0)} ms`);
  }
  const [ok] = await q<any>(con, `SELECT count(*) AS n FROM gold.user_360`);
  console.log(`  同一连接随后照常可用：user_360 共 ${ok.n} 行`);

  // 进度：长查询运行时轮询 connection.progress（先打开进度统计）
  await con.run(`SET enable_progress_bar = true; SET enable_progress_bar_print = false;`);
  const samples: string[] = [];
  const poll = setInterval(() => {
    const p = con.progress;
    if (p.percentage >= 0) samples.push(`${p.percentage.toFixed(0)}%`);
  }, 250);
  const t1 = performance.now();
  await con.run(`
    CREATE OR REPLACE TEMP TABLE _progress_demo AS
    SELECT customer_id, sum(net_amount) OVER (PARTITION BY customer_id ORDER BY order_ts
             RANGE BETWEEN INTERVAL 90 DAYS PRECEDING AND CURRENT ROW) AS s
    FROM silver.orders_clean`);
  clearInterval(poll);
  console.log(`✔ 10b. 长查询 ${(performance.now() - t1).toFixed(0)} ms，进度采样：${[...new Set(samples)].join(' → ') || '（太快，未采到）'}`);

  // 并发保护：一个实例里同时运行的重查询数加上限（简单信号量），多租户接口必备
  class Semaphore {
    private q: (() => void)[] = []; private n = 0;
    constructor(private max: number) {}
    async use<T>(fn: () => Promise<T>) {
      if (this.n >= this.max) await new Promise<void>(r => this.q.push(r));
      this.n++;
      try { return await fn(); } finally { this.n--; this.q.shift()?.(); }
    }
  }
  const gate = new Semaphore(2);
  const pool = await Promise.all([1, 2, 3, 4, 5, 6].map(() => connect({ s3: false })));
  const t2 = performance.now();
  const done: string[] = [];
  await Promise.all(pool.map((c, i) => gate.use(async () => {
    await withTimeout(c, 30_000, () => c.runAndReadAll(
      `SELECT city, count(*) FROM silver.orders_clean JOIN gold.user_360 USING (customer_id) GROUP BY ALL`));
    done.push(`#${i + 1}@${((performance.now() - t2) / 1000).toFixed(1)}s`);
  })));
  console.log(`✔ 10c. 6 个请求、最多 2 个并发执行，完成顺序：${done.join(' ')}`);
}

// =====================================================================
// ⑪ 加密与脱敏：个人信息（姓名、手机号）
// =====================================================================
if (part(11)) {
  const KEY = process.env.PII_KEY ?? 'demo-only-change-me-32-bytes-key!';   // 生产：从 KMS / 环境变量读取，不写进代码
  const encFile = './data/secure/pii.duckdb';
  rmSync(encFile, { force: true });
  if (!(await q<any>(con, `SELECT 1 FROM duckdb_tables() WHERE schema_name = 'silver' AND table_name = 'contacts_a'`)).length)
    throw new Error('请先运行 npm run advanced -- 6 生成 contacts_a');

  // 1) 加密数据库文件：整库 AES 加密，没有密钥无法打开
  await exec(con, `
    ATTACH '${encFile}' AS pii (ENCRYPTION_KEY '${KEY}');
    CREATE TABLE pii.contacts AS SELECT * FROM silver.contacts_a;
    DETACH pii;`, '11a. 个人信息写入加密库 data/secure/pii.duckdb');
  for (const [label, sql] of [
    ['不带密钥打开', `ATTACH '${encFile}' AS x1`],
    ['用错误密钥打开', `ATTACH '${encFile}' AS x2 (ENCRYPTION_KEY 'wrong-key')`],
  ]) {
    try { await con.run(sql); console.log(`  ${label}：（意外）成功`); }
    catch (e) { console.log(`  ${label}：拒绝 → ${String(e).split('\n')[0].slice(0, 90)}`); }
  }
  await con.run(`ATTACH '${encFile}' AS pii (ENCRYPTION_KEY '${KEY}', READ_ONLY)`);
  show(await q(con, `SELECT count(*) AS 行数 FROM pii.contacts`, undefined, '11b. 正确密钥读取'), 1);

  // 2) 加密 Parquet：落湖的文件也加密（密钥注册在会话里）
  await exec(con, `
    PRAGMA add_parquet_key('crm_k1', '${KEY.slice(0, 32)}');
    COPY pii.contacts TO './data/secure/contacts_enc.parquet' (FORMAT parquet, ENCRYPTION_CONFIG {footer_key: 'crm_k1'});`,
    '11c. 写加密 Parquet');
  try { await con.run(`SELECT count(*) FROM read_parquet('./data/secure/contacts_enc.parquet')`); }
  catch (e) { console.log(`  不带密钥读取：拒绝 → ${String(e).split('\n')[0].slice(0, 90)}`); }
  show(await q(con, `SELECT count(*) AS 行数 FROM read_parquet('./data/secure/contacts_enc.parquet', encryption_config = {footer_key: 'crm_k1'})`,
    undefined, '11d. 带密钥读取加密 Parquet'), 1);

  // 3) 脱敏视图 + 假名化：分析人员只看脱敏数据；跨系统关联用加盐哈希，不用明文手机号
  await exec(con, `
    CREATE OR REPLACE MACRO mask_phone(p) AS substr(p, 1, 3) || '****' || substr(p, 8);
    CREATE OR REPLACE MACRO mask_name(n)  AS substr(n, 1, 1) || repeat('*', length(n) - 1);
    CREATE OR REPLACE MACRO pseudo_id(p, salt) AS substr(sha256(salt || p), 1, 16);
    CREATE OR REPLACE TEMP VIEW v_contacts_masked AS
      SELECT a_id, mask_name(name) AS name, mask_phone(phone) AS phone,
             pseudo_id(phone, '${KEY.slice(-8)}') AS phone_key, city, birth_year
      FROM pii.contacts;`, '11e. 脱敏宏与视图');
  show(await q(con, `FROM v_contacts_masked LIMIT 3`, undefined, '11f. 分析人员看到的数据'));
  await con.run(`DETACH pii`);
}

// =====================================================================
// ⑫ 数据质量：坏行隔离、字段演进、断言检查
// =====================================================================
if (part(12)) {
  // 1) 一个带脏数据的 CSV（运营上传的会员名单）
  writeFileSync('./data/dq/members_upload.csv', [
    'customer_id,tier,points,updated_at',
    '1001,金卡,1200,2026-09-01 10:00:00',
    '1002,银卡,abc,2026-09-01 10:05:00',          // points 不是数字
    '1003,普通,300,2026-13-45 99:00:00',          // 日期非法
    '1004,黑金,50000,2026-09-02 08:00:00,多余列',  // 列数不对
    '1005,银卡,800,2026-09-02 09:30:00',
  ].join('\n'));
  await exec(con, `
    CREATE OR REPLACE TEMP TABLE upload AS
    SELECT * FROM read_csv('./data/dq/members_upload.csv',
      columns = {customer_id: 'BIGINT', tier: 'VARCHAR', points: 'INTEGER', updated_at: 'TIMESTAMP'},
      header = true, store_rejects = true)`, '12a. 读取 CSV，坏行不中断导入（store_rejects）');
  show(await q(con, `SELECT * FROM upload`, undefined, '  正常入库的行'));
  show(await q(con, `
    SELECT line AS 行号, column_name AS 列, error_type AS 错误类型, csv_line AS 原始内容
    FROM reject_errors ORDER BY line`, undefined, '12b. 被隔离的坏行（reject_errors）'));

  // 2) 字段演进：同一数据源，第二批多了一列、少了一列
  await con.run(`
    COPY (SELECT 1 AS customer_id, '金卡' AS tier, 100 AS points) TO './data/dq/batch_v1.parquet';
    COPY (SELECT 2 AS customer_id, '银卡' AS tier, true AS phone_verified) TO './data/dq/batch_v2.parquet';`);
  show(await q(con, `
    SELECT * FROM read_parquet('./data/dq/batch_*.parquet', union_by_name = true, filename = true)`,
    undefined, '12c. union_by_name：按列名合并，缺的列补 NULL'));

  // 3) 断言检查：每次入湖后跑一遍，结果落表；严重问题直接让任务失败
  await con.run(`CREATE TABLE IF NOT EXISTS meta.dq_results (
    run_at TIMESTAMP, check_name VARCHAR, severity VARCHAR, bad_rows BIGINT, passed BOOLEAN)`);
  const checks: { name: string; severity: 'error' | 'warn'; sql: string }[] = [
    { name: '订单号唯一', severity: 'error',
      sql: `SELECT count(*) - count(DISTINCT order_id) FROM silver.orders` },
    { name: '订单必须有客户', severity: 'error',
      sql: `SELECT count(*) FROM silver.orders o ANTI JOIN silver.customers c USING (customer_id)` },
    { name: '实付金额非负', severity: 'error',
      sql: `SELECT count(*) FROM silver.orders_clean WHERE net_amount < 0` },
    { name: '事件时间不在未来', severity: 'warn',
      sql: `SELECT count(*) FROM silver.events WHERE ts > now() + INTERVAL 1 HOUR` },
    { name: '明细 SKU 在商品主数据中', severity: 'warn',
      sql: `SELECT count(*) FROM (SELECT DISTINCT sku FROM silver.order_items) i ANTI JOIN silver.products USING (sku)` },
    { name: '日订单量较前 7 日均值下降不超过 50%', severity: 'warn',
      sql: `WITH d AS (SELECT order_ts::DATE AS d, count(*) AS n FROM silver.orders_clean
                       WHERE order_ts >= getvariable('as_of') - INTERVAL 60 DAY GROUP BY 1),
            w AS (SELECT d, n, avg(n) OVER (ORDER BY d ROWS BETWEEN 7 PRECEDING AND 1 PRECEDING) AS avg7 FROM d)
            SELECT count(*) FROM w WHERE n < 0.5 * avg7 AND d < getvariable('as_of')::DATE - 1` },
  ];
  const results = [];
  for (const c of checks) {
    const [r] = await q<any>(con, `SELECT (${c.sql})::BIGINT AS bad`);
    const bad = Number(r.bad);
    await con.run(`INSERT INTO meta.dq_results VALUES (now(), $n, $s, $b, $p)`, { n: c.name, s: c.severity, b: bad, p: bad === 0 });
    results.push({ 检查项: c.name, 级别: c.severity, 问题行数: bad, 结果: bad === 0 ? '✅ 通过' : c.severity === 'error' ? '❌ 失败' : '⚠️ 警告' });
  }
  console.log('\n▶ 12d. 断言检查（结果写入 meta.dq_results）');
  console.table(results);
  if (results.some(r => r.结果.startsWith('❌'))) console.log('  存在 error 级问题：生产中这里应 process.exit(1)，阻止下游任务');

  // 4) 约束：在 silver 层用主键 / NOT NULL / CHECK 把关
  await con.run(`CREATE OR REPLACE TEMP TABLE t_loyalty_strict (
    customer_id BIGINT PRIMARY KEY, tier VARCHAR NOT NULL CHECK (tier IN ('普通','银卡','金卡','黑金')),
    points INTEGER CHECK (points >= 0))`);
  for (const v of [`(1, '金卡', 10)`, `(1, '银卡', 20)`, `(2, '钻石', 5)`, `(3, '普通', -1)`]) {
    try { await con.run(`INSERT INTO t_loyalty_strict VALUES ${v}`); console.log(`  插入 ${v}：成功`); }
    catch (e) { console.log(`  插入 ${v}：拒绝 → ${String(e).split('\n')[0].slice(0, 80)}`); }
  }
}

// =====================================================================
// ⑬ SCD2：保存客户属性（城市、等级）的历史版本，按“下单那一刻”的属性统计
// =====================================================================
if (part(13)) {
  // 初始版本：2026-01-01 时的城市与等级
  await exec(con, `
    CREATE OR REPLACE TABLE silver.customer_dim (
      customer_id BIGINT, city VARCHAR, tier VARCHAR,
      valid_from TIMESTAMP, valid_to TIMESTAMP, is_current BOOLEAN);
    INSERT INTO silver.customer_dim
    SELECT c.customer_id, c.city,
           CASE WHEN l.tier = '黑金' AND hash(c.customer_id) % 3 = 0 THEN '金卡' ELSE l.tier END,   -- 年初时部分黑金还是金卡
           TIMESTAMP '2026-01-01', NULL, true
    FROM silver.customers c JOIN silver.loyalty l USING (customer_id);`, '13a. 初始化维表（2026-01-01 版本）');

  /** 应用一批变更：变了的旧版本关闭，写入新版本；没变的不动。在一个事务里完成 */
  async function applyScd2(changesSql: string, at: string) {
    await con.run(`BEGIN`);
    try {
      await con.run(`CREATE OR REPLACE TEMP TABLE _chg AS ${changesSql}`);
      await con.run(`
        UPDATE silver.customer_dim d SET valid_to = TIMESTAMP '${at}', is_current = false
        FROM _chg c
        WHERE d.customer_id = c.customer_id AND d.is_current
          AND (d.city IS DISTINCT FROM c.city OR d.tier IS DISTINCT FROM c.tier)`);
      await con.run(`
        INSERT INTO silver.customer_dim
        SELECT c.customer_id, c.city, c.tier, TIMESTAMP '${at}', NULL, true
        FROM _chg c ANTI JOIN silver.customer_dim d ON d.customer_id = c.customer_id AND d.is_current`);
      await con.run(`COMMIT`);
    } catch (e) { await con.run(`ROLLBACK`); throw e; }
  }
  // 两批变更：4 月 1 日一部分金卡升黑金；7 月 1 日 1% 客户搬到上海
  await applyScd2(`
    SELECT d.customer_id, d.city, l.tier FROM silver.customer_dim d JOIN silver.loyalty l USING (customer_id)
    WHERE d.is_current AND d.tier <> l.tier`, '2026-04-01');
  await applyScd2(`
    SELECT customer_id, CASE WHEN customer_id % 100 = 7 THEN '上海' ELSE city END AS city, tier
    FROM silver.customer_dim WHERE is_current`, '2026-07-01');
  show(await q(con, `
    SELECT count(*) AS 版本总数, count(*) FILTER (WHERE is_current) AS 当前版本, count(DISTINCT customer_id) AS 客户数
    FROM silver.customer_dim`, undefined, '13b. 两批变更后'), 1);
  show(await q(con, `
    SELECT customer_id, city, tier, valid_from::DATE AS 生效, valid_to::DATE AS 失效, is_current
    FROM silver.customer_dim
    WHERE customer_id = (SELECT customer_id FROM silver.customer_dim GROUP BY 1 HAVING count(*) = 3 ORDER BY 1 LIMIT 1)
    ORDER BY valid_from`, undefined, '13c. 一个客户的完整历史'));

  // 按“下单时”的等级统计：ASOF JOIN 找订单时间点生效的那个版本
  show(await q(con, `
    WITH o AS (SELECT * FROM silver.orders_clean WHERE status = 'paid' AND order_ts >= TIMESTAMP '2026-01-01')
    SELECT coalesce(pit.tier, '—') AS 等级,
           round(sum(o.net_amount) FILTER (WHERE pit.tier IS NOT NULL) / 1e6, 2) AS 按下单时等级_GMV百万,
           (SELECT round(sum(o2.net_amount) / 1e6, 2) FROM o o2 JOIN silver.customer_dim cur
              ON cur.customer_id = o2.customer_id AND cur.is_current WHERE cur.tier = pit.tier) AS 按当前等级_GMV百万
    FROM o ASOF LEFT JOIN silver.customer_dim pit
      ON o.customer_id = pit.customer_id AND o.order_ts >= pit.valid_from
    GROUP BY pit.tier ORDER BY 按下单时等级_GMV百万 DESC`, undefined, '13d. 同样的订单：按“下单时等级” vs 按“当前等级”'));
}

// =====================================================================
// ⑭ 性能诊断：Profiling JSON、Parquet 行组统计、排序写入、Bloom 过滤器
// =====================================================================
if (part(14)) {
  // 1) 把执行计划输出成 JSON，程序化找出最慢的算子
  const prof = './reports/profile.json';
  mkdirSync('./reports', { recursive: true });
  await con.run(`SET enable_profiling = 'json'; SET profiling_output = '${prof}';`);
  await con.run(`
    SELECT u.city, r.segment, count(*), sum(o.net_amount)
    FROM silver.orders_clean o JOIN gold.user_360 u USING (customer_id) JOIN gold.rfm r USING (customer_id)
    WHERE o.status = 'paid' GROUP BY ALL`);
  await con.run(`SET enable_profiling = 'no_output'`);
  type Node = { operator_name: string; operator_timing: number; operator_cardinality: number; operator_rows_scanned?: number; children: Node[] };
  const root = JSON.parse(readFileSync(prof, 'utf8'));
  const flat: Node[] = [];
  const walk = (n: Node) => { if (n.operator_name) flat.push(n); n.children?.forEach(walk); };
  root.children.forEach(walk);
  console.log(`\n▶ 14a. Profiling JSON：总耗时 ${(root.latency * 1000).toFixed(0)} ms，峰值缓冲内存 ${(root.system_peak_buffer_memory / 1e6).toFixed(0)} MB`);
  console.table(flat.sort((a, b) => b.operator_timing - a.operator_timing).slice(0, 5).map(n => ({
    算子: n.operator_name.trim(), 耗时_ms: +(n.operator_timing * 1000).toFixed(1), 输出行数: n.operator_cardinality,
    扫描行数: n.operator_rows_scanned ?? 0 })));

  // 2) 同一份订单写两份 Parquet：乱序 vs 按 customer_id 排序；对比点查要读的行组数
  for (const f of ['unsorted', 'sorted']) rmSync(`./data/dq/orders_${f}.parquet`, { force: true });
  await exec(con, `
    COPY (SELECT * FROM silver.orders_clean ORDER BY hash(order_id)) TO './data/dq/orders_unsorted.parquet' (FORMAT parquet, ROW_GROUP_SIZE 122880);
    COPY (SELECT * FROM silver.orders_clean ORDER BY customer_id)    TO './data/dq/orders_sorted.parquet'   (FORMAT parquet, ROW_GROUP_SIZE 122880);`,
    '14b. 写两份 Parquet（乱序 / 按客户排序）');
  const rows = [];
  for (const f of ['unsorted', 'sorted']) {
    const file = `./data/dq/orders_${f}.parquet`;
    const [m] = await q<any>(con, `
      SELECT count(DISTINCT row_group_id) AS 行组数,
             count(DISTINCT row_group_id) FILTER (WHERE path_in_schema = 'customer_id'
               AND 424242 BETWEEN TRY_CAST(stats_min AS BIGINT) AND TRY_CAST(stats_max AS BIGINT)) AS 需读行组
      FROM parquet_metadata('${file}')`);
    const t = performance.now();
    for (let i = 0; i < 20; i++) await con.run(`SELECT count(*), sum(net_amount) FROM '${file}' WHERE customer_id = ${400000 + i * 1111}`);
    rows.push({ 文件: f, 大小_MB: +(statSync(file).size / 1e6).toFixed(0), 行组数: m.行组数, 查一个客户需读行组: m.需读行组,
                单次点查_ms: +((performance.now() - t) / 20).toFixed(1) });
  }
  console.log('\n▶ 14c. 乱序 vs 按客户排序（parquet_metadata 统计 + 实测）');
  console.table(rows);

  // 3) Bloom 过滤器：DuckDB 写 Parquet 时会为字典编码的列写 Bloom 过滤器，等值查询可跳过行组
  show(await q(con, `
    SELECT row_group_id AS 行组, bloom_filter_excludes AS 可跳过
    FROM parquet_bloom_probe('./data/dq/orders_sorted.parquet', 'channel', 'wechat_shop')
    LIMIT 3`, undefined, '14d. Bloom 过滤器探测：channel = \'wechat_shop\'（不存在的值）'));

  // 4) 内存去向：按用途查看当前内存占用
  show(await q(con, `
    SELECT tag AS 用途, round(memory_usage_bytes / 1e6) AS 内存_MB, round(temporary_storage_bytes / 1e6) AS 溢写_MB
    FROM duckdb_memory() WHERE memory_usage_bytes > 0 OR temporary_storage_bytes > 0 ORDER BY memory_usage_bytes DESC`,
    undefined, '14e. duckdb_memory()：内存用在哪'));
}
