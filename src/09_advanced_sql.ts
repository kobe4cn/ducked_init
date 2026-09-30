// src/09_advanced_sql.ts —— 进阶 SQL：让 CRM 分析更快、更准、更好维护
//   ① ROLLUP / CUBE / GROUPING SETS 多维小计      ② RANGE 时间窗口（近 30 天滚动）
//   ③ arg_max(x, y, n) 分组 Top-N                ④ MACRO 指标层
//   ⑤ ENUM 低基数列                              ⑥ 客户模糊匹配与去重
//   ⑦ 行为路径分析                               ⑧ 抽样
// 运行：pnpm advanced（需要先跑过 model / crm）
import { statSync, rmSync } from 'node:fs';
import { connect, exec, q, show, timed } from './lib/duck';

const con = await connect({ s3: false });
await con.run(`SET VARIABLE as_of = TIMESTAMP '2026-09-27'`);
const only = process.argv[2];                       // 例：pnpm advanced 3  只跑第 3 节
const part = (n: number) => !only || only === String(n);
const ms = async (sql: string) => { const t = performance.now(); await con.run(sql); return performance.now() - t; };

// =====================================================================
// ① 多维小计：一次扫描出“明细 + 各级小计 + 总计”
// =====================================================================
if (part(1)) {
  // ROLLUP (a, b) = GROUPING SETS ((a, b), (a), ())，适合有层级的维度（城市 → 渠道）
  show(await q(con, `
  SELECT CASE WHEN grouping(u.city) = 1 THEN '【总计】' ELSE u.city END                     AS 城市,
         CASE WHEN grouping(o.channel) = 1 AND grouping(u.city) = 0 THEN '【城市小计】'
              ELSE o.channel END                                                         AS 渠道,
         count(*)                                 AS 订单数,
         round(sum(o.net_amount) / 1e6, 2)        AS GMV_百万
  FROM silver.orders_clean o JOIN gold.user_360 u USING (customer_id)
  WHERE o.status = 'paid' AND u.city IN ('北京', '上海')
  GROUP BY ROLLUP (u.city, o.channel)
  ORDER BY grouping(u.city), u.city, grouping(o.channel), o.channel`, undefined, '1a. ROLLUP：城市 → 渠道，带小计和总计'));

  // GROUPING SETS：看板上 4 个互不相关的切面，一次扫描算完；grouping_id 标出每行属于哪个切面
  const rows = await q<any>(con, `
  SELECT grouping_id(u.city, o.channel, u.tier) AS gid,
         u.city, o.channel, u.tier,
         count(*) AS orders, round(sum(o.net_amount)) AS gmv
  FROM silver.orders_clean o JOIN gold.user_360 u USING (customer_id)
  WHERE o.status = 'paid'
  GROUP BY GROUPING SETS ((u.city), (o.channel), (u.tier), ())
  ORDER BY gid, gmv DESC`, undefined, '1b. GROUPING SETS：按城市 / 渠道 / 等级 / 全局，一条 SQL');
  const label: Record<string, string> = { '3': '按城市', '5': '按渠道', '6': '按等级', '7': '全局' };
  show(rows.map(r => ({ 切面: label[r.gid] ?? r.gid, 维度值: r.city ?? r.channel ?? r.tier ?? '—', 订单: r.orders, GMV: r.gmv })), 20);

  // 对比：同样 4 个切面写成 4 条 SQL
  const t4 = await ms(`
    SELECT u.city, count(*), sum(net_amount) FROM silver.orders_clean o JOIN gold.user_360 u USING (customer_id) WHERE status='paid' GROUP BY 1;
    SELECT channel, count(*), sum(net_amount) FROM silver.orders_clean o JOIN gold.user_360 u USING (customer_id) WHERE status='paid' GROUP BY 1;
    SELECT u.tier, count(*), sum(net_amount) FROM silver.orders_clean o JOIN gold.user_360 u USING (customer_id) WHERE status='paid' GROUP BY 1;
    SELECT count(*), sum(net_amount) FROM silver.orders_clean o JOIN gold.user_360 u USING (customer_id) WHERE status='paid';`);
  const t1 = await ms(`
    SELECT u.city, o.channel, u.tier, count(*), sum(o.net_amount)
    FROM silver.orders_clean o JOIN gold.user_360 u USING (customer_id) WHERE o.status='paid'
    GROUP BY GROUPING SETS ((u.city), (o.channel), (u.tier), ())`);
  console.log(`  4 条独立 SQL：${t4.toFixed(0)} ms；1 条 GROUPING SETS：${t1.toFixed(0)} ms`);

  // CUBE：所有维度组合（2^n 个），适合做交叉分析的“数据立方体”，结果落表供 BI 直接读
  await exec(con, `
  CREATE OR REPLACE TABLE gold.cube_city_channel_tier AS
  SELECT grouping_id(u.city, o.channel, u.tier) AS gid, u.city, o.channel, u.tier,
         count(*) AS orders, count(DISTINCT o.customer_id) AS buyers, sum(o.net_amount) AS gmv
  FROM silver.orders_clean o JOIN gold.user_360 u USING (customer_id)
  WHERE o.status = 'paid' AND o.order_ts >= getvariable('as_of') - INTERVAL 90 DAY
  GROUP BY CUBE (u.city, o.channel, u.tier)`, '1c. CUBE：近 90 天 城市×渠道×等级 全部组合 → gold.cube_city_channel_tier');
  show(await q(con, `SELECT gid, count(*) AS 行数 FROM gold.cube_city_channel_tier GROUP BY ALL ORDER BY gid`), 10);
}

// =====================================================================
// ② RANGE 时间窗口：按“时间范围”而不是“行数”开窗
// =====================================================================
if (part(2)) {
  await exec(con, `
  CREATE OR REPLACE TABLE gold.order_rolling AS
  SELECT order_id, customer_id, order_ts, net_amount,
         -- 本单发生时，该客户近 30 天（含本单）的消费额与单数
         sum(net_amount) OVER w30 AS spend_30d,
         count(*)        OVER w30 AS orders_30d,
         -- “常态”：再往前 335 天（31–365 天前）的月均消费，不含最近 30 天，避免自己和自己比
         (sum(net_amount) OVER w365 - sum(net_amount) OVER w30) / 11 AS base_month
  FROM silver.orders_clean
  WHERE status = 'paid'
  WINDOW w30  AS (PARTITION BY customer_id ORDER BY order_ts RANGE BETWEEN INTERVAL 30 DAYS PRECEDING AND CURRENT ROW),
         w365 AS (PARTITION BY customer_id ORDER BY order_ts RANGE BETWEEN INTERVAL 365 DAYS PRECEDING AND CURRENT ROW)`,
    '2a. 每笔订单的近 30 天 / 近 365 天滚动消费 → gold.order_rolling');

  // 营销触发器：客户“30 天内第 3 单”的那一刻（每人只触发一次）→ 发 VIP 权益
  show(await q(con, `
  WITH first_hit AS (      -- 每个客户第一次满足“30 天内第 3 单”的那一笔
    SELECT customer_id, order_ts, spend_30d
    FROM gold.order_rolling WHERE orders_30d = 3
    QUALIFY row_number() OVER (PARTITION BY customer_id ORDER BY order_ts) = 1
  )
  SELECT date_trunc('month', order_ts)::DATE AS 月份, count(*) AS 触发人数, round(avg(spend_30d)) AS 触发时近30天消费
  FROM first_hit GROUP BY 1 ORDER BY 月份 DESC LIMIT 6`, undefined, '2b. 触发器：“30 天内第 3 单”的客户（按月）'));

  // 消费激增：近 30 天消费超过此前 11 个月月均的 3 倍
  show(await q(con, `
  SELECT customer_id, order_ts::DATE AS 日期, round(spend_30d) AS 近30天, round(base_month) AS 此前月均,
         round(spend_30d / base_month, 1) AS 倍数
  FROM gold.order_rolling
  WHERE order_ts >= getvariable('as_of') - INTERVAL 30 DAY
    AND base_month >= 100 AND spend_30d > 3 * base_month      -- 此前月均至少 100 元，避免低基数放大
  QUALIFY row_number() OVER (PARTITION BY customer_id ORDER BY spend_30d DESC) = 1
  ORDER BY 倍数 DESC LIMIT 5`, undefined, '2c. 消费激增：近 30 天消费超过此前月均 3 倍'));
}

// =====================================================================
// ③ arg_max(x, y, n)：分组 Top-N，不用窗口函数
// =====================================================================
if (part(3)) {
  await exec(con, `
  CREATE OR REPLACE TEMP TABLE cust_sku AS
  SELECT o.customer_id, i.sku, sum(i.qty) AS qty
  FROM silver.order_items i JOIN silver.orders_clean o USING (order_id)
  WHERE o.status = 'paid'
  GROUP BY ALL`, '3a. 准备：客户 × SKU 购买量');

  const tWin = await ms(`
    CREATE OR REPLACE TEMP TABLE top3_win AS
    SELECT customer_id, list(sku ORDER BY qty DESC, sku) AS top3
    FROM (SELECT * FROM cust_sku QUALIFY row_number() OVER (PARTITION BY customer_id ORDER BY qty DESC, sku) <= 3)
    GROUP BY customer_id`);
  const tArg = await ms(`
    CREATE OR REPLACE TEMP TABLE top3_arg AS
    SELECT customer_id, arg_max(sku, qty, 3) AS top3 FROM cust_sku GROUP BY customer_id`);
  const [n] = await q<any>(con, `SELECT count(*) AS n FROM cust_sku`);
  console.log(`\n▶ 3b. 每个客户买得最多的 3 个 SKU（${Number(n.n).toLocaleString()} 行）`);
  console.table([{ '窗口函数 + QUALIFY': `${tWin.toFixed(0)} ms`, 'arg_max(sku, qty, 3)': `${tArg.toFixed(0)} ms`, 提速: `${(tWin / tArg).toFixed(1)}×` }]);

  show(await q(con, `
  SELECT a.customer_id, a.top3 AS arg_max结果,
         max_by(p.category, c.qty) AS 最常买品类,          -- max_by 是 arg_max 的别名
         max(c.qty, 3)             AS 前三购买量            -- max(x, n) 返回最大的 n 个值
  FROM top3_arg a JOIN cust_sku c USING (customer_id) JOIN silver.products p USING (sku)
  WHERE a.customer_id IN (1, 2, 3)
  GROUP BY a.customer_id, a.top3 ORDER BY a.customer_id`, undefined, '3c. 结果样例'));
}

// =====================================================================
// ④ MACRO：把指标口径定义成宏，存进库里，所有脚本 / 服务 / BI 共用
// =====================================================================
if (part(4)) {
  await exec(con, `
  CREATE SCHEMA IF NOT EXISTS metrics;

  -- 标量宏：RFM 人群规则（口径只在这里改）
  CREATE OR REPLACE MACRO metrics.rfm_segment(r, f, m) AS
    CASE WHEN r >= 4 AND f >= 4 AND m >= 4 THEN '重要价值'
         WHEN r >= 4 AND f <= 2 AND m >= 4 THEN '重要发展'
         WHEN r <= 2 AND f >= 4 AND m >= 4 THEN '重要保持'
         WHEN r <= 2 AND f <= 2 AND m >= 4 THEN '重要挽留'
         WHEN r >= 4 AND f >= 4             THEN '一般价值'
         WHEN r >= 4                        THEN '新客/潜力'
         WHEN r <= 2 AND f >= 3             THEN '一般保持'
         ELSE '一般挽留' END;

  -- 带默认参数的标量宏：客单价分档
  CREATE OR REPLACE MACRO metrics.aov_band(aov, low := 150, high := 500) AS
    CASE WHEN aov < low THEN '低客单' WHEN aov < high THEN '中客单' ELSE '高客单' END;

  -- 表宏：“活跃客户”的统一定义
  CREATE OR REPLACE MACRO metrics.active_customers(days) AS TABLE
    SELECT customer_id FROM gold.user_360 WHERE recency_days <= days;

  -- 表宏：任意时间段的核心 KPI
  CREATE OR REPLACE MACRO metrics.kpi_between(d_from, d_to) AS TABLE
    SELECT count(*)                         AS orders,
           count(DISTINCT customer_id)      AS buyers,
           round(sum(net_amount))           AS gmv,
           round(sum(net_amount) / count(*), 2) AS aov
    FROM silver.orders_clean
    WHERE status = 'paid' AND order_ts >= d_from AND order_ts < d_to;

  -- 表宏 + COLUMNS()：维度作为参数传入，按任意维度拆 GMV
  CREATE OR REPLACE MACRO metrics.gmv_by(dim) AS TABLE
    SELECT COLUMNS(dim) AS dim_value, count(*) AS customers, round(sum(gmv)) AS gmv
    FROM gold.user_360 WHERE orders > 0
    GROUP BY ALL ORDER BY gmv DESC;`, '4a. 定义指标宏（存在库里，重启后仍在）');

  show(await q(con, `
  SELECT metrics.rfm_segment(r, f, m) AS 人群, metrics.aov_band(gmv / orders) AS 客单档, count(*) AS 客户数
  FROM gold.rfm WHERE segment IN ('重要价值', '重要保持')
  GROUP BY ALL ORDER BY 人群, 客单档`, undefined, '4b. 标量宏：RFM 规则 + 客单价分档'));

  // TS 里用命名参数调用表宏：口径统一，调用方只关心参数
  const kpi = async (from: string, to: string) =>
    (await q<any>(con, `FROM metrics.kpi_between($f::TIMESTAMP, $t::TIMESTAMP)`, { f: from, t: to }))[0];
  const [cur, prev] = [await kpi('2026-09-01', '2026-09-27'), await kpi('2026-08-01', '2026-08-27')];
  console.log('\n▶ 4c. 表宏 + 命名参数：本月 vs 上月同期');
  console.table([{ 期间: '2026-09-01 ~ 09-26', ...cur }, { 期间: '2026-08-01 ~ 08-26', ...prev }]);

  show(await q(con, `SELECT count(*) AS 近30天活跃客户 FROM metrics.active_customers(30)`), 1);
  show(await q(con, `FROM metrics.gmv_by('register_channel')`, undefined, '4d. 维度当参数：metrics.gmv_by(\'register_channel\')'));

  // 指标目录：库里有哪些宏、参数是什么
  show(await q(con, `
  SELECT function_name AS 宏, function_type AS 类型, parameters::VARCHAR AS 参数
  FROM duckdb_functions() WHERE schema_name = 'metrics' AND NOT internal ORDER BY 1`, undefined, '4e. 指标目录（duckdb_functions）'));
}

// =====================================================================
// ⑤ ENUM：低基数字符串列（城市、渠道、状态、等级）
// =====================================================================
if (part(5)) {
  await exec(con, `
  CREATE TYPE IF NOT EXISTS city_t    AS ENUM (SELECT DISTINCT city FROM silver.customers WHERE city IS NOT NULL ORDER BY 1);
  CREATE TYPE IF NOT EXISTS channel_t AS ENUM ('app', 'mini_program', 'web', 'store');
  CREATE TYPE IF NOT EXISTS status_t  AS ENUM ('paid', 'refunded', 'cancelled');
  CREATE TYPE IF NOT EXISTS tier_t    AS ENUM ('普通', '银卡', '金卡', '黑金');   -- 顺序即排序顺序`, '5a. 定义 ENUM 类型');

  // 同一份订单宽表，分别用 VARCHAR / ENUM 存成两个独立的库文件，对比体积与查询速度
  const build = (typ: 'varchar' | 'enum') => {
    const c = (col: string, t: string) => (typ === 'enum' ? `${col}::${t}` : col);
    return `
      SELECT o.order_id, o.customer_id, o.order_ts, o.net_amount,
             ${c('u.city', 'city_t')} AS city, ${c('o.channel', 'channel_t')} AS channel,
             ${c('o.status', 'status_t')} AS status, ${c('u.tier', 'tier_t')} AS tier
      FROM silver.orders_clean o JOIN gold.user_360 u USING (customer_id)`;
  };
  const res: Record<string, string>[] = [];
  for (const typ of ['varchar', 'enum'] as const) {
    const file = `./data/_enum_test_${typ}.duckdb`;
    rmSync(file, { force: true });
    await con.run(`ATTACH '${file}' AS t_${typ}`);
    const tBuild = await ms(`CREATE TABLE t_${typ}.orders AS ${build(typ)}`);
    await con.run(`CHECKPOINT t_${typ}`);
    const tAgg = await ms(`SELECT city, channel, status, tier, count(*), sum(net_amount) FROM t_${typ}.orders GROUP BY ALL`);
    const tSort = await ms(`CREATE OR REPLACE TEMP TABLE _s AS SELECT * FROM t_${typ}.orders ORDER BY city, tier, channel, order_ts`);
    const tJoin = await ms(`SELECT count(*) FROM t_${typ}.orders a JOIN t_${typ}.orders b ON a.order_id = b.order_id AND a.city = b.city AND a.channel = b.channel`);
    await con.run(`DETACH t_${typ}`);
    res.push({ 类型: typ.toUpperCase(), 建表: `${tBuild.toFixed(0)} ms`, 文件大小: `${(statSync(file).size / 1e6).toFixed(0)} MB`,
               四维分组: `${tAgg.toFixed(0)} ms`, 全表排序: `${tSort.toFixed(0)} ms`, 自关联: `${tJoin.toFixed(0)} ms` });
    rmSync(file, { force: true });
  }
  console.log('\n▶ 5b. VARCHAR vs ENUM（同一份订单数据）');
  console.table(res);

  // ENUM 的排序按定义顺序：等级天然按 普通 < 银卡 < 金卡 < 黑金 排
  show(await q(con, `
  SELECT tier::tier_t AS 等级, count(*) AS 客户数 FROM gold.user_360 WHERE tier IS NOT NULL
  GROUP BY ALL ORDER BY 等级`, undefined, '5c. ENUM 按定义顺序排序'));
  show(await q(con, `SELECT enum_range(NULL::tier_t) AS 全部取值, enum_code('金卡'::tier_t) AS 金卡编码`), 1);
}

// =====================================================================
// ⑥ 客户模糊匹配：两个系统的会员表合并去重（姓名写法不同、手机号格式不同）
// =====================================================================
if (part(6)) {
  await exec(con, `
  -- A 系统（线上 CRM）：20 万会员，有姓名、手机、城市、出生年
  CREATE OR REPLACE TABLE silver.contacts_a AS
  WITH p AS (
    SELECT customer_id, city, birth_year,
           ['王','李','张','刘','陈','杨','黄','赵','吴','周','徐','孙','马','朱','胡','郭','何','林','高','罗'][1 + (hash(customer_id * 3) % 20)::INT] AS sn,
           ['伟','芳','娜','敏','静','丽','强','磊','洋','艳','勇','军','杰','娟','涛','明','超','秀','霞','平',
            '刚','桂','英','华','文','玲','建','辉','红','斌','鹏','宇','浩','凯','晨','欣','怡','婷','雪','琳'] AS g,
           (hash(customer_id * 7) % 1000000007)::BIGINT AS h
    FROM silver.customers WHERE customer_id <= 200000
  )
  SELECT customer_id AS a_id,
         sn || g[(1 + h % 40)::INT] || CASE WHEN h % 3 = 0 THEN '' ELSE g[(1 + (h // 40) % 40)::INT] END AS name,
         '1' || (30 + h % 60)::VARCHAR || lpad(((h // 97) % 100000000)::VARCHAR, 8, '0')  AS phone,
         city, birth_year
  FROM p;

  -- B 系统（门店 POS）：6 万会员，其中 4.2 万是 A 里的同一个人（录入不规范），1.8 万是新人
  CREATE OR REPLACE TABLE silver.contacts_b AS
  WITH same AS (
    SELECT a_id AS true_a_id, name, phone, city, birth_year, (hash(a_id * 11) % 100)::INT AS r
    FROM silver.contacts_a WHERE hash(a_id * 13) % 100 < 21          -- 约 4.2 万
  )
  SELECT row_number() OVER () AS b_id, true_a_id,
         CASE WHEN r < 15 THEN replace(replace(replace(replace(name, '张', '張'), '陈', '陳'), '刘', '劉'), '黄', '黃')  -- 繁体
              WHEN r < 25 THEN substr(name, 1, 1) || ' ' || substr(name, 2)                                            -- 多了空格
              WHEN r < 32 THEN substr(name, 1, length(name) - 1) || '某'                                               -- 错一个字
              ELSE name END AS name,
         CASE WHEN r BETWEEN 40 AND 59 THEN '+86 ' || substr(phone, 1, 3) || '-' || substr(phone, 4, 4) || '-' || substr(phone, 8)
              WHEN r BETWEEN 60 AND 69 THEN '86' || phone
              WHEN r BETWEEN 70 AND 84 THEN NULL                                                                        -- 没留手机
              WHEN r BETWEEN 85 AND 89 THEN '1' || (30 + r)::VARCHAR || '00000000'                                       -- 换了号
              ELSE phone END AS phone,
         city, birth_year
  FROM same
  UNION ALL
  SELECT 100000000 + i, NULL, '新' || ['王','李','张'][(1 + i % 3)::INT] || '客' || i::VARCHAR,
         '19' || lpad((hash(i) % 1000000000)::VARCHAR, 9, '0'),
         ['北京','上海','广州','深圳'][(1 + i % 4)::INT], (1980 + i % 20)::INT
  FROM range(18000) t(i);`, '6a. 构造两个系统的会员表（B 表带真实答案 true_a_id，用于评估）');

  // 标准化：手机号只留数字、去掉 86 前缀；姓名去空格、繁转简（示例只处理常见姓）
  await exec(con, `
  CREATE OR REPLACE MACRO norm_phone(p) AS nullif(regexp_replace(regexp_replace(p, '[^0-9]', '', 'g'), '^86', ''), '');
  CREATE OR REPLACE MACRO norm_name(n)  AS replace(replace(replace(replace(replace(n, ' ', ''), '張', '张'), '陳', '陈'), '劉', '刘'), '黃', '黄');`,
    '6b. 标准化宏');

  const evalMatch = async (label: string, sql: string) => {
    const [r] = await q<any>(con, `
      WITH m AS (${sql})
      SELECT count(*)                                                    AS 匹配对数,
             count(*) FILTER (WHERE b.true_a_id = m.a_id)                AS 正确,
             (SELECT count(*) FROM silver.contacts_b WHERE true_a_id IS NOT NULL) AS 应匹配
      FROM m JOIN silver.contacts_b b USING (b_id)`, undefined, label);
    return { 方法: label.replace(/^6\w\. /, ''), 匹配对数: r.匹配对数, 召回率: `${(100 * r.正确 / r.应匹配).toFixed(1)}%`,
             准确率: `${(100 * r.正确 / Math.max(1, r.匹配对数)).toFixed(1)}%` };
  };
  const results = [];
  results.push(await evalMatch('6c. 原始手机号精确匹配', `
    SELECT b.b_id, a.a_id FROM silver.contacts_b b JOIN silver.contacts_a a ON a.phone = b.phone`));
  results.push(await evalMatch('6d. 标准化手机号匹配', `
    SELECT b.b_id, a.a_id FROM silver.contacts_b b JOIN silver.contacts_a a ON norm_phone(a.phone) = norm_phone(b.phone)`));
  // 分块（blocking）：只在“同城市 + 同出生年”的候选里比姓名，避免 6 万 × 20 万 的全量笛卡尔积
  results.push(await evalMatch('6e. 手机号 + 姓名相似度兜底（分块）', `
    WITH by_phone AS (
      SELECT b.b_id, a.a_id FROM silver.contacts_b b JOIN silver.contacts_a a ON norm_phone(a.phone) = norm_phone(b.phone)
    ),
    rest AS (SELECT * FROM silver.contacts_b WHERE b_id NOT IN (SELECT b_id FROM by_phone)),
    by_name AS (
      SELECT r.b_id, a.a_id,
             jaro_winkler_similarity(norm_name(a.name), norm_name(r.name)) AS sim
      FROM rest r JOIN silver.contacts_a a ON a.city = r.city AND a.birth_year = r.birth_year
      WHERE jaro_winkler_similarity(norm_name(a.name), norm_name(r.name)) >= 0.90
      QUALIFY row_number() OVER (PARTITION BY r.b_id ORDER BY sim DESC) = 1
          AND count(*) OVER (PARTITION BY r.b_id, sim) = 1        -- 同分的多个候选：放弃，交给人工
    )
    SELECT b_id, a_id FROM by_phone UNION ALL SELECT b_id, a_id FROM by_name`));
  console.log('\n▶ 6f. 匹配效果对比');
  console.table(results);

  show(await q(con, `
  SELECT '王小明' AS a, '王晓明' AS b, round(jaro_winkler_similarity('王小明', '王晓明'), 3) AS jaro_winkler,
         levenshtein('王小明', '王晓明') AS 编辑距离, round(jaccard('王小明', '王晓明'), 3) AS jaccard
  UNION ALL SELECT '张伟', '張偉', round(jaro_winkler_similarity('张伟', '張偉'), 3), levenshtein('张伟', '張偉'), round(jaccard('张伟', '張偉'), 3)
  UNION ALL SELECT '张伟', norm_name('張伟'), round(jaro_winkler_similarity('张伟', norm_name('張伟')), 3), levenshtein('张伟', norm_name('張伟')), round(jaccard('张伟', norm_name('張伟')), 3)`,
    undefined, '6g. 相似度函数对中文姓名的表现'));
}

// =====================================================================
// ⑦ 行为路径：把每个会话变成一条路径字符串，找常见路径和流失模式
// =====================================================================
if (part(7)) {
  await exec(con, `
  CREATE OR REPLACE TABLE gold.session_paths AS
  SELECT session_id, any_value(user_id) AS user_id, min(ts) AS start_ts,
         any_value(entry_from) FILTER (WHERE entry_from IS NOT NULL) AS entry,
         -- 连续重复的步骤合并成 “步骤×n”，路径更好读
         regexp_replace(string_agg(event, '>' ORDER BY ts, event_id), '(view_item)(>view_item)+', 'view_item×n', 'g') AS path,
         list(event ORDER BY ts, event_id) AS steps
  FROM silver.events WHERE user_id IS NOT NULL
  GROUP BY session_id`, '7a. 会话 → 路径（string_agg + 正则折叠）→ gold.session_paths');

  show(await q(con, `
  SELECT path AS 路径, count(*) AS 会话数,
         round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS 占比_pct,
         round(avg(len(list_filter(steps, lambda x: x = 'view_item'))), 1) AS 平均浏览商品数
  FROM gold.session_paths GROUP BY path ORDER BY 会话数 DESC LIMIT 8`, undefined, '7b. Top 路径'));

  // 模式匹配：加购后离开（没有 checkout），按入口看
  show(await q(con, `
  SELECT entry AS 入口,
         count(*) FILTER (WHERE regexp_matches(path, 'add_cart$'))              AS 加购后直接离开,
         count(*) FILTER (WHERE regexp_matches(path, 'checkout$'))              AS 结算后离开,
         count(*) FILTER (WHERE regexp_matches(path, '^login>.*pay$'))          AS 登录后完成支付,
         -- 浏览多少步后加购：list_position 找到步骤位置
         round(avg(list_position(steps, 'add_cart') - 1) FILTER (WHERE list_contains(steps, 'add_cart')), 2) AS 加购前平均步数
  FROM gold.session_paths WHERE entry IS NOT NULL
  GROUP BY ALL ORDER BY 入口`, undefined, '7c. 正则找流失模式 + list_position'));

  // 转移矩阵（桑基图数据）：当前步骤 → 下一步骤，末尾补 “离开”
  show(await q(con, `
  WITH t AS (
    SELECT event AS 当前, coalesce(lead(event) OVER (PARTITION BY session_id ORDER BY ts, event_id), '(离开)') AS 下一步
    FROM silver.events WHERE user_id IS NOT NULL
  )
  PIVOT t ON 下一步 IN ('view_item', 'search', 'add_cart', 'checkout', 'pay', '(离开)') USING count(*)
  GROUP BY 当前 ORDER BY 当前`, undefined, '7d. 步骤转移矩阵（行 = 当前，列 = 下一步）'));
}

// =====================================================================
// ⑧ 抽样：调试口径时先用样本，确认后再跑全量
// =====================================================================
if (part(8)) {
  const metric = (from: string) => `
    SELECT round(avg(net_amount), 2) AS 客单价,
           round(100.0 * avg((status = 'refunded')::INT), 2) AS 退款率_pct,
           count(DISTINCT customer_id) AS 客户数
    FROM ${from}`;
  const rows: Record<string, unknown>[] = [];
  for (const [label, from] of [
    ['全量', 'silver.orders_clean'],
    ['1% system（按数据块抽，最快）', 'silver.orders_clean USING SAMPLE 1% (system)'],
    ['1% bernoulli（按行抽）', 'silver.orders_clean USING SAMPLE 1% (bernoulli)'],
    ['10 万行 reservoir（固定行数）', 'silver.orders_clean USING SAMPLE 100000 ROWS'],
    ['1% 客户（按客户哈希抽，保留每人完整订单）', '(SELECT * FROM silver.orders_clean WHERE hash(customer_id) % 100 = 0)'],
  ] as const) {
    const t = performance.now();
    const [r] = await q<any>(con, metric(from));
    rows.push({ 方式: label, 耗时: `${(performance.now() - t).toFixed(0)} ms`, ...r });
  }
  console.log('\n▶ 8a. 抽样方式对比（订单表）');
  console.table(rows);

  // 按客户抽样的价值：人均指标（人均订单、复购率）只有按客户抽才无偏
  show(await q(con, `
  SELECT '全量' AS 方式, round(avg(n), 3) AS 人均订单, round(100.0 * avg((n >= 2)::INT), 2) AS 复购率_pct
  FROM (SELECT customer_id, count(*) n FROM silver.orders_clean WHERE status = 'paid' GROUP BY 1)
  UNION ALL
  SELECT '1% bernoulli 按行', round(avg(n), 3), round(100.0 * avg((n >= 2)::INT), 2)
  FROM (SELECT customer_id, count(*) n FROM (FROM silver.orders_clean USING SAMPLE 1% (bernoulli)) WHERE status = 'paid' GROUP BY 1)
  UNION ALL
  SELECT '1% 按客户哈希', round(avg(n), 3), round(100.0 * avg((n >= 2)::INT), 2)
  FROM (SELECT customer_id, count(*) n FROM silver.orders_clean WHERE status = 'paid' AND hash(customer_id) % 100 = 0 GROUP BY 1)`,
    undefined, '8b. 人均指标：按行抽样有偏，按客户抽样无偏'));

  // 可复现：REPEATABLE (种子) 让每次抽到同一批
  show(await q(con, `
  SELECT (SELECT sum(order_id) FROM silver.orders_clean USING SAMPLE 1000 ROWS (reservoir, 42)) AS 第一次,
         (SELECT sum(order_id) FROM silver.orders_clean USING SAMPLE 1000 ROWS (reservoir, 42)) AS 第二次`,
    undefined, '8c. 固定种子，样本可复现'));
}
