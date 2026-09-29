// src/11_extensions.ts —— 按需启用的扩展能力
//   ⑮ vss：HNSW 向量索引（百万级商品相似检索）   ⑯ fts：客服工单全文检索（中文二元分词）
//   ⑰ spatial：客户到门店距离、就近分配、商圈覆盖  ⑱ excel：读写 xlsx
//   ⑲ delta / iceberg：读取其他湖格式               ⑳ JS 自定义函数（Node 驱动）
// 运行：npm run extensions（Delta / Iceberg 示例需要先运行 scripts/make_delta_iceberg.py 生成测试表）
import { existsSync, rmSync, statSync } from 'node:fs';
import { DuckDBScalarFunction, VARCHAR } from '@duckdb/node-api';
import { connect, exec, q, show } from './lib/duck';

const con = await connect({ s3: false });
const only = process.argv[2];
const part = (n: number) => !only || only === String(n);
const ms = async (sql: string) => { const t = performance.now(); await con.run(sql); return performance.now() - t; };

// =====================================================================
// ⑮ vss：HNSW 向量索引。暴力计算在 10 万级够用；百万级、要求毫秒级延迟时建索引
// =====================================================================
if (part(15)) {
  await con.run(`INSTALL vss; LOAD vss;`);
  // 索引持久化到磁盘目前是实验功能：这里放在内存库里，服务启动时从 Parquet / 表重建
  await con.run(`ATTACH IF NOT EXISTS ':memory:' AS vec;`);
  const N = Number(process.env.VSS_ROWS ?? 300_000), DIM = 32;   // 2 核机器上 100 万向量建索引约 400 s
  await exec(con, `
    CREATE OR REPLACE TABLE vec.items AS
    SELECT i AS item_id,
           list_transform(range(${DIM}), lambda d: ((hash(i * ${DIM} + d) % 10000) / 10000.0 - 0.5)::FLOAT)::FLOAT[${DIM}] AS emb
    FROM range(${N}) t(i)`, `15a. 生成 ${N.toLocaleString()} 个 ${DIM} 维商品向量`);

  const probe = `(SELECT emb FROM vec.items WHERE item_id = 12345)`;
  const topk = `SELECT item_id FROM vec.items ORDER BY array_cosine_distance(emb, ${probe}) LIMIT 10`;

  // 暴力计算（建索引前）
  await con.run(topk);
  let t = performance.now();
  for (let i = 0; i < 5; i++) await con.run(topk);
  const bruteMs = (performance.now() - t) / 5;
  const exact = (await q<any>(con, topk)).map(r => r.item_id);

  const buildMs = await ms(`CREATE INDEX items_hnsw ON vec.items USING HNSW (emb) WITH (metric = 'cosine')`);
  // 用常量向量查询，才能走索引（HNSW_INDEX_SCAN）
  const [{ v }] = await q<any>(con, `SELECT emb::VARCHAR AS v FROM vec.items WHERE item_id = 12345`);
  const topkIdx = `SELECT item_id FROM vec.items ORDER BY array_cosine_distance(emb, '${v}'::FLOAT[${DIM}]) LIMIT 10`;
  await con.run(topkIdx);
  t = performance.now();
  for (let i = 0; i < 20; i++) await con.run(topkIdx);
  const idxMs = (performance.now() - t) / 20;
  const approx = (await q<any>(con, topkIdx)).map(r => r.item_id);
  const recall = approx.filter(x => exact.includes(x)).length / 10;
  const plan = (await q<any>(con, `EXPLAIN ${topkIdx}`))[0].explain_value as string;
  console.log(`\n▶ 15b. Top-10 相似检索（${N.toLocaleString()} 个向量）`);
  console.table([{ 暴力计算_ms: +bruteMs.toFixed(1), 建索引_s: +(buildMs / 1000).toFixed(1), 走HNSW索引_ms: +idxMs.toFixed(2),
                   提速: `${(bruteMs / idxMs).toFixed(0)}×`, 'Recall@10': recall, 计划含HNSW: /HNSW_INDEX_SCAN/.test(plan) }]);
  await con.run(`DETACH vec`);
}

// =====================================================================
// ⑯ fts：客服工单全文检索。DuckDB 自带分词按空格切，中文需要先分词：这里用“二元切分”（bigram）
// =====================================================================
if (part(16)) {
  await con.run(`INSTALL fts; LOAD fts;`);
  await exec(con, `
    CREATE OR REPLACE MACRO zh_bigram(t) AS
      array_to_string(list_transform(range(greatest(length(t) - 1, 1)), lambda i: substr(t, i + 1, 2)), ' ');

    CREATE OR REPLACE TABLE main.tickets AS
    WITH tpl AS (SELECT unnest([
      '退款一直没有到账，已经等了一周',   '快递太慢了，下单五天还没发货',     '收到的商品有破损，要求换货',
      '会员积分没有到账，请帮忙查询',     '优惠券无法使用，结算时提示失效',   '想修改收货地址，订单还没发货',
      '商品尺码不合适，申请退货退款',     '客服回复太慢，问题一直没解决',     '发票抬头开错了，需要重新开具',
      '黑金会员的专属权益在哪里查看']) AS tmpl)
    SELECT i AS ticket_id, 1 + hash(i) % 1000000 AS customer_id,
           TIMESTAMP '2026-06-01' + to_seconds((hash(i * 7) % 10000000)::BIGINT) AS created_at,
           tmpl || CASE WHEN i % 3 = 0 THEN '，订单号 ' || (hash(i) % 99999999)::VARCHAR ELSE '' END AS content
    FROM range(200000) t(i), (SELECT list(tmpl) AS l FROM tpl) x, LATERAL (SELECT l[1 + (hash(i * 3) % 10)::INT] AS tmpl)`,
    '16a. 生成 20 万条客服工单');
  await exec(con, `ALTER TABLE main.tickets ADD COLUMN IF NOT EXISTS tokens VARCHAR; UPDATE main.tickets SET tokens = zh_bigram(content);`,
    '16b. 中文二元切分 → tokens 列');
  await exec(con, `PRAGMA create_fts_index('main.tickets', 'ticket_id', 'tokens', stemmer = 'none', stopwords = 'none', ignore = '', lower = 0, strip_accents = 0, overwrite = 1)`,
    '16c. 建全文索引');

  // 命中的工单按内容去重展示：相关度（BM25）、命中条数
  const search = async (kw: string) => q<any>(con, `
    WITH hits AS (
      SELECT ticket_id, regexp_replace(content, '，订单号 [0-9]+', '') AS content, score
      FROM (SELECT *, fts_main_tickets.match_bm25(ticket_id, zh_bigram($kw)) AS score FROM main.tickets)
      WHERE score IS NOT NULL
    )
    SELECT content AS 工单内容, round(max(score), 2) AS 相关度, count(*) AS 命中条数
    FROM hits GROUP BY content ORDER BY 相关度 DESC LIMIT 4`, { kw }, `16d. 搜索「${kw}」（BM25 相关度排序）`);
  show(await search('退款没到账'));
  show(await search('发货慢'));

  // 对比：LIKE 只能精确包含，不能排序也不能容忍词序变化
  show(await q(con, `SELECT count(*) AS LIKE_命中 FROM main.tickets WHERE content LIKE '%退款没到账%'`), 1);
  show(await q(con, `
    SELECT CASE WHEN content LIKE '%退款%' THEN '退款' WHEN content LIKE '%发货%' OR content LIKE '%快递%' THEN '物流'
                WHEN content LIKE '%积分%' OR content LIKE '%会员%' THEN '会员' ELSE '其他' END AS 主题,
           count(*) AS 工单数, count(DISTINCT t.customer_id) AS 客户数,
           round(avg(u.gmv)) AS 客户平均GMV
    FROM main.tickets t JOIN gold.user_360 u USING (customer_id)
    GROUP BY ALL ORDER BY 工单数 DESC`, undefined, '16e. 工单 × 客户画像：哪些问题影响高价值客户'));
}

// =====================================================================
// ⑰ spatial：客户到门店的距离、就近分配、3 公里覆盖率
// =====================================================================
if (part(17)) {
  await con.run(`INSTALL spatial; LOAD spatial;`);
  await exec(con, `
    CREATE OR REPLACE TABLE main.city_center AS SELECT * FROM (VALUES
      ('北京', 39.9042, 116.4074), ('上海', 31.2304, 121.4737), ('广州', 23.1291, 113.2644), ('深圳', 22.5431, 114.0579),
      ('杭州', 30.2741, 120.1551), ('成都', 30.5728, 104.0668), ('武汉', 30.5928, 114.3055), ('西安', 34.3416, 108.9398)
    ) t(city, lat, lon);
    -- 60 家门店：在市中心 ±0.15 度（约 15 公里）范围内
    CREATE OR REPLACE TABLE main.stores_geo AS
    SELECT s AS store_id, c.city,
           c.lat + ((hash(s) % 3000) / 10000.0 - 0.15) AS lat, c.lon + ((hash(s * 7) % 3000) / 10000.0 - 0.15) AS lon
    FROM range(1, 61) t(s) JOIN (SELECT *, row_number() OVER () - 1 AS k FROM main.city_center) c ON c.k = s % 8;
    -- 客户住址（抽 20 万人）：在市中心 ±0.25 度范围内
    CREATE OR REPLACE TABLE main.customers_geo AS
    SELECT u.customer_id, u.city, u.gmv,
           c.lat + ((hash(u.customer_id) % 5000) / 10000.0 - 0.25) AS lat,
           c.lon + ((hash(u.customer_id * 3) % 5000) / 10000.0 - 0.25) AS lon
    FROM gold.user_360 u JOIN main.city_center c USING (city) WHERE u.customer_id % 5 = 0;`,
    '17a. 生成门店与客户坐标（WGS84）');

  // 每个客户找同城最近的门店：ST_Distance_Sphere 返回米，参数为 (纬度, 经度) 顺序的点
  await exec(con, `
    CREATE OR REPLACE TABLE gold.customer_nearest_store AS
    SELECT c.customer_id, c.city, c.gmv,
           arg_min(s.store_id, d) AS store_id, round(min(d) / 1000, 2) AS km
    FROM main.customers_geo c
    JOIN main.stores_geo s USING (city),
    LATERAL (SELECT ST_Distance_Sphere(ST_Point(c.lat, c.lon), ST_Point(s.lat, s.lon)) AS d)
    GROUP BY c.customer_id, c.city, c.gmv`, '17b. 就近门店分配（20 万客户 × 同城门店）');
  show(await q(con, `
    SELECT city AS 城市, count(*) AS 客户数,
           round(100.0 * avg((km <= 3)::INT), 1) AS 三公里覆盖率_pct,
           round(median(km), 2) AS 到最近门店_中位公里,
           round(sum(gmv) FILTER (WHERE km > 5) / 1e6, 1) AS 五公里外客户GMV_百万
    FROM gold.customer_nearest_store GROUP BY ALL ORDER BY 三公里覆盖率_pct`, undefined, '17c. 门店覆盖分析：哪里该开新店'));
  show(await q(con, `
    SELECT store_id AS 门店, count(*) AS 分配客户, round(sum(gmv) / 1e6, 2) AS 客户GMV_百万,
           ST_AsText(ST_Point(any_value(s.lon), any_value(s.lat))) AS 位置_WKT
    FROM gold.customer_nearest_store JOIN main.stores_geo s USING (store_id, city)
    GROUP BY store_id ORDER BY 客户GMV_百万 DESC LIMIT 5`, undefined, '17d. 客户价值最高的门店'));
}

// =====================================================================
// ⑱ excel：给业务方导出 xlsx，读取运营上传的 xlsx
// =====================================================================
if (part(18)) {
  await con.run(`INSTALL excel; LOAD excel;`);
  const file = './reports/rfm_summary.xlsx';
  rmSync(file, { force: true });
  await exec(con, `
    COPY (
      SELECT segment AS 人群, count(*) AS 客户数, round(avg(recency_days)) AS 平均沉默天数,
             round(avg(orders), 1) AS 平均订单, round(avg(gmv)) AS 平均消费
      FROM gold.rfm GROUP BY ALL ORDER BY 客户数 DESC
    ) TO '${file}' (FORMAT xlsx, HEADER true, SHEET 'RFM人群')`, `18a. 导出 ${file}`);
  console.log(`  文件大小 ${(statSync(file).size / 1024).toFixed(1)} KB`);
  show(await q(con, `SELECT * FROM read_xlsx('${file}', sheet = 'RFM人群')`, undefined, '18b. 读回 xlsx'));
}

// =====================================================================
// ⑲ delta / iceberg：直接读取其他团队的湖表（只读）
// =====================================================================
if (part(19)) {
  if (existsSync('./data/lakeformats/delta_orders')) {
    await con.run(`INSTALL delta; LOAD delta;`);
    show(await q(con, `
      SELECT channel, count(*) AS 订单, round(sum(net_amount)) AS GMV
      FROM delta_scan('./data/lakeformats/delta_orders') GROUP BY ALL ORDER BY 订单 DESC`,
      undefined, '19a. delta_scan：读 Delta Lake 表'));
  } else console.log('（跳过 Delta：先运行 python3 scripts/make_delta_iceberg.py）');

  if (existsSync('./data/lakeformats/iceberg_meta.txt')) {
    await con.run(`INSTALL iceberg; LOAD iceberg;`);
    const { readFileSync } = await import('node:fs');
    const meta = readFileSync('./data/lakeformats/iceberg_meta.txt', 'utf8').trim();
    show(await q(con, `
      SELECT tier, count(*) AS 客户数, sum(points) AS 总积分
      FROM iceberg_scan('${meta}') GROUP BY ALL ORDER BY 客户数 DESC`, undefined, '19b. iceberg_scan：读 Iceberg 表'));
    show(await q(con, `SELECT sequence_number, snapshot_id, timestamp_ms FROM iceberg_snapshots('${meta}')`,
      undefined, '19c. Iceberg 快照'));
  } else console.log('（跳过 Iceberg：先运行 python3 scripts/make_delta_iceberg.py）');
}

// =====================================================================
// ⑳ JS 自定义函数：SQL 不好写、需要 JS 生态的逻辑（这里：手机号 → 运营商）
// =====================================================================
if (part(20)) {
  const MOBILE = new Set(['134','135','136','137','138','139','147','150','151','152','157','158','159','172','178','182','183','184','187','188','195','197','198']);
  const UNICOM = new Set(['130','131','132','145','155','156','166','171','175','176','185','186','196']);
  const carrier = (p: string) => { const k = p.slice(0, 3); return MOBILE.has(k) ? '移动' : UNICOM.has(k) ? '联通' : '电信/其他'; };

  con.registerScalarFunction(DuckDBScalarFunction.create({
    name: 'phone_carrier',
    returnType: VARCHAR,
    parameterTypes: [VARCHAR],
    mainFunction: (_info, input, output) => {
      const v = input.getColumnVector(0);
      for (let i = 0; i < input.rowCount; i++) {
        const p = v.getItem(i) as string | null;
        output.setItem(i, p == null ? null : carrier(p));
      }
      output.flush();
    },
  }));
  if (!(await q<any>(con, `SELECT 1 FROM duckdb_tables() WHERE schema_name = 'silver' AND table_name = 'contacts_a'`)).length)
    throw new Error('请先运行 npm run advanced -- 6 生成 contacts_a');

  let t = performance.now();
  const byJs = await q<any>(con, `SELECT phone_carrier(phone) AS 运营商, count(*) AS 人数 FROM silver.contacts_a GROUP BY ALL ORDER BY 1`);
  const jsMs = performance.now() - t;
  // 同样的逻辑写成 SQL 宏：在 DuckDB 内部并行执行
  await con.run(`CREATE OR REPLACE MACRO phone_carrier_sql(p) AS CASE
      WHEN substr(p, 1, 3) IN (${[...MOBILE].map(x => `'${x}'`).join(',')}) THEN '移动'
      WHEN substr(p, 1, 3) IN (${[...UNICOM].map(x => `'${x}'`).join(',')}) THEN '联通' ELSE '电信/其他' END`);
  t = performance.now();
  await q(con, `SELECT phone_carrier_sql(phone) AS 运营商, count(*) FROM silver.contacts_a GROUP BY ALL`);
  const sqlMs = performance.now() - t;
  console.log('\n▶ 20a. JS 自定义函数：手机号 → 运营商（20 万行）');
  console.table(byJs);
  console.table([{ JS函数_ms: +jsMs.toFixed(0), 同逻辑SQL宏_ms: +sqlMs.toFixed(0) }]);
}
