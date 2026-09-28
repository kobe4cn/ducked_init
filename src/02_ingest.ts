// src/02_ingest.ts —— 多数据源 → 数据湖（bronze）+ 分析库（silver）
//   用法：npm run ingest            全量
//         npm run ingest:incr       增量（基于 updated_at 水位线，仅 SEED_TARGET=pg）
//
//   A. PostgreSQL：postgres 扩展并行扫描 → silver 表 → bronze Parquet（按月分区）
//      增量：WHERE updated_at > 水位线（条件下推到 PG，走索引）→ MERGE INTO silver + 追加 CDC 批次
//   B. 会员 SaaS 接口：按 ID 区间并发分页拉取 → NDJSON 暂存 → DuckDB 批量解析
//   C. 文件：埋点 JSONL.gz / 营销 CSV.gz / 商品 Parquet → bronze 分区 Parquet
import { config, lakePath, outPath } from "./lib/config";
import { connect, exec, q, show, count, timed } from "./lib/duck";
import { startMockApi, idRanges } from "./lib/mock-api";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";

const MODE = process.argv[2] ?? "full";
const usePg = config.seedTarget === "pg";
const S = config.pg.schema;
const con = await connect({ pg: usePg });

await con.run(`
CREATE SCHEMA IF NOT EXISTS meta;
CREATE SCHEMA IF NOT EXISTS silver;
CREATE TABLE IF NOT EXISTS meta.watermark (
  source VARCHAR, tbl VARCHAR, synced_to TIMESTAMP, max_id BIGINT, rows_synced BIGINT, run_at TIMESTAMP,
  PRIMARY KEY (source, tbl));`);

const today = new Date().toISOString().slice(0, 10);

// =====================================================================
// 增量模式
// =====================================================================
if (MODE === "incremental") {
  if (!usePg) throw new Error("增量同步演示需要 SEED_TARGET=pg");
  const wm = Object.fromEntries(
    (
      await q<{ tbl: string; synced_to: string; max_id: string }>(
        con,
        `SELECT tbl, synced_to::VARCHAR AS synced_to, max_id::VARCHAR AS max_id FROM meta.watermark WHERE source = 'pg'`,
      )
    ).map((r) => [r.tbl, r]),
  );

  for (const [tbl, key] of [
    ["customers", "customer_id"],
    ["orders", "order_id"],
  ] as const) {
    const since = wm[tbl].synced_to;
    // 1) 只拉变化的行：WHERE 条件会下推到 PostgreSQL，走 updated_at 索引
    await exec(
      con,
      `CREATE OR REPLACE TEMP TABLE delta AS
                     SELECT * FROM pg.${S}.${tbl} WHERE updated_at > TIMESTAMP '${since}'`,
      `PG ${tbl}：拉取 ${since} 之后的变更`,
    );
    const n = await count(con, "delta");
    if (n === "0") {
      console.log(`  ${tbl} 无变化`);
      continue;
    }
    // 2) CDC 批次追加到 bronze（保留每一批，可回放、可审计）
    await exec(
      con,
      `COPY (SELECT *, DATE '${today}' AS sync_date FROM delta)
                     TO '${outPath(`bronze/pg_${tbl}_cdc`)}' (FORMAT parquet, PARTITION_BY (sync_date), APPEND,
                                                               FILENAME_PATTERN 'batch_{uuid}')`,
    );
    // 3) upsert 进 silver
    await exec(
      con,
      `
      MERGE INTO silver.${tbl} AS s USING delta AS d ON s.${key} = d.${key}
      WHEN MATCHED THEN UPDATE WHEN NOT MATCHED THEN INSERT`,
      `MERGE INTO silver.${tbl}（${n} 行）`,
    );
    await con.run(`UPDATE meta.watermark SET synced_to = (SELECT max(updated_at) FROM delta),
                   rows_synced = ${n.replace(/,/g, "")}, run_at = now() WHERE source = 'pg' AND tbl = '${tbl}'`);
  }
  // 明细：按订单号追加新订单的明细
  const maxId = wm["orders"].max_id;
  await exec(
    con,
    `INSERT INTO silver.order_items SELECT * FROM pg.${S}.order_items WHERE order_id > ${maxId}`,
    "新订单明细追加",
  );
  await con.run(
    `UPDATE meta.watermark SET max_id = (SELECT max(order_id) FROM silver.orders) WHERE tbl = 'orders'`,
  );
  show(
    await q(
      con,
      `SELECT tbl, synced_to::VARCHAR AS synced_to, max_id, rows_synced FROM meta.watermark ORDER BY tbl`,
      undefined,
      "水位线",
    ),
  );
  process.exit(0);
}

// =====================================================================
// A. 业务库 → silver + bronze
// =====================================================================
const src = (t: string) =>
  usePg
    ? `pg.${S}.${t}`
    : `read_parquet('${lakePath(`landing/pg_export/${t}${t === "customers" ? ".parquet" : "/*.parquet"}`)}')`;

await exec(
  con,
  `CREATE OR REPLACE TABLE silver.customers AS SELECT * FROM ${src("customers")}`,
  `客户 → silver（${usePg ? "PG 并行扫描" : "landing Parquet"}）`,
);
await exec(
  con,
  `CREATE OR REPLACE TABLE silver.orders AS SELECT * FROM ${src("orders")}`,
  `订单 → silver`,
);
await exec(
  con,
  `CREATE OR REPLACE TABLE silver.order_items AS SELECT * FROM ${src("order_items")}`,
  `订单明细 → silver`,
);

if (usePg) {
  // 历史全量快照写入湖：订单按月分区，便于湖上按时间裁剪
  await exec(
    con,
    `COPY (SELECT *, strftime(order_ts, '%Y-%m') AS order_month FROM silver.orders)
                   TO '${outPath("bronze/pg_orders")}' (FORMAT parquet, PARTITION_BY (order_month), COMPRESSION zstd, OVERWRITE_OR_IGNORE)`,
    "订单快照 → bronze（按月分区）",
  );
  await exec(
    con,
    `COPY silver.customers TO '${outPath("bronze/pg_customers/snapshot.parquet")}' (FORMAT parquet, COMPRESSION zstd)`,
    "客户快照 → bronze",
  );
  await exec(
    con,
    `COPY silver.order_items TO '${outPath("bronze/pg_order_items")}' (FORMAT parquet, COMPRESSION zstd,
                                                     PER_THREAD_OUTPUT, OVERWRITE_OR_IGNORE)`,
    "明细快照 → bronze",
  );
}

await con.run(`
INSERT OR REPLACE INTO meta.watermark
SELECT 'pg', 'customers', max(updated_at), NULL, count(*), now() FROM silver.customers;
INSERT OR REPLACE INTO meta.watermark
SELECT 'pg', 'orders', max(updated_at), max(order_id), count(*), now() FROM silver.orders;`);

// 在源库里制造变更，供 `npm run ingest:incr` 演示：约 1% 订单退款、客户改资料、新订单
if (usePg) {
  await exec(
    con,
    `CALL postgres_execute('pg', '
    UPDATE ${S}.orders SET status = ''refunded'', updated_at = now()
      WHERE order_id % 100 = 0 AND status = ''paid'';
    UPDATE ${S}.customers SET city = ''上海'', updated_at = now() WHERE customer_id % 7000 = 0;
    WITH n AS (
      INSERT INTO ${S}.orders
      SELECT nextval(''${S}.order_seq''), 1 + (g * 37) % (SELECT max(customer_id) FROM ${S}.customers), 1 + g % 60, ''app'',
             now() - (g || '' seconds'')::interval, ''paid'', 199.00, 0, now()
      FROM generate_series(1, 5000) g
      RETURNING order_id)
    INSERT INTO ${S}.order_items SELECT order_id, ''SKU000006'', 1 FROM n;
  ')`,
    "（在 PG 中制造变更：1% 退款、客户改资料、5000 笔新订单）",
  );
}

// =====================================================================
// B. 会员 SaaS 接口（按 ID 区间并发分页）
// =====================================================================
const server = await startMockApi();
const [{ mx }] = await q<{ mx: number }>(
  con,
  `SELECT max(customer_id)::BIGINT AS mx FROM silver.customers`,
);
const base = `http://localhost:${config.apiPort}/api/members`;
const stageDir = "./data/staging/members";
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

// 大批量接口数据：每路请求把原始 JSON 行追加到本地 NDJSON 暂存文件，最后由 DuckDB 一次性并行解析。
// 比在 JS 里逐字段 appender.appendXxx() 快一个数量级；Appender 更适合小批量、持续流入的数据（见 06_realtime）。
await timed(
  `会员接口：${config.apiConcurrency} 路并发分页拉取 → NDJSON 暂存`,
  async () => {
    let pages = 0;
    await Promise.all(
      idRanges(Number(mx), config.apiConcurrency).map(async ([lo, hi], w) => {
        const out = createWriteStream(`${stageDir}/part-${w}.ndjson`);
        let after: number | null = lo;
        while (after !== null) {
          const body = (await (
            await fetch(
              `${base}?after=${after}&until=${hi}&size=${config.apiPageSize}`,
            )
          ).json()) as any;
          if (body.data.length)
            out.write(
              body.data.map((r: unknown) => JSON.stringify(r)).join("\n") +
                "\n",
            );
          pages++;
          after = body.next_after;
        }
        await new Promise<void>((r) => out.end(r));
      }),
    );
    console.log(`  ${pages} 页请求`);
  },
);
await exec(
  con,
  `
CREATE OR REPLACE TABLE silver.loyalty AS
SELECT customer_id, tier, points, updated_at
FROM read_json('${stageDir}/*.ndjson',
               columns = {customer_id: 'BIGINT', tier: 'VARCHAR', points: 'INTEGER', updated_at: 'TIMESTAMP'})`,
  "NDJSON 暂存 → silver.loyalty",
);
server.close();
await con.run(
  `COPY silver.loyalty TO '${outPath(`bronze/loyalty/snapshot_${today}.parquet`)}' (FORMAT parquet, COMPRESSION zstd)`,
);

// =====================================================================
// C. 文件型数据源 → bronze
// =====================================================================
// 埋点按天增量处理：每天的 landing 文件 → 当天的 bronze 分区（幂等，可重跑某一天；内存占用与总天数无关）
const days = (
  await q<{ dt: string }>(
    con,
    `
  SELECT DISTINCT regexp_extract(file, 'dt=([0-9-]+)', 1) AS dt
  FROM glob('${lakePath("landing/events/*/*.jsonl.gz")}') ORDER BY dt`,
  )
).map((r) => r.dt);
await timed(
  `埋点 JSONL.gz → bronze/events（${days.length} 天，逐天写分区）`,
  async () => {
    for (const dt of days) {
      await con.run(`
      COPY (
        SELECT event_id, user_id, device_id, event, ts::TIMESTAMP AS ts, props
        FROM read_json('${lakePath(`landing/events/dt=${dt}/*.jsonl.gz`)}',
                       columns = {event_id: 'BIGINT', user_id: 'BIGINT', device_id: 'VARCHAR',
                                  event: 'VARCHAR', ts: 'VARCHAR', props: 'JSON'})
      ) TO '${outPath(`bronze/events/dt=${dt}/events.parquet`)}' (FORMAT parquet, COMPRESSION zstd)`);
    }
  },
);

await exec(
  con,
  `
COPY (SELECT *, strftime(touch_ts, '%Y-%m') AS month FROM read_csv('${lakePath("landing/marketing/*.csv.gz")}'))
TO '${outPath("bronze/touches")}' (FORMAT parquet, PARTITION_BY (month), COMPRESSION zstd, OVERWRITE_OR_IGNORE)`,
  "营销 CSV.gz → bronze/touches（按月分区）",
);

await exec(
  con,
  `CREATE OR REPLACE TABLE silver.products AS
  SELECT * REPLACE (embedding::FLOAT[8] AS embedding) FROM '${lakePath("landing/products/*.parquet")}'`,
  "商品 → silver.products",
);

// 湖上视图：任何进程都能查，分区条件自动下推
await con.run(`
CREATE OR REPLACE VIEW silver.v_events  AS SELECT * FROM read_parquet('${lakePath("bronze/events/*/events.parquet")}',  hive_partitioning = true);
CREATE OR REPLACE VIEW silver.v_touches AS SELECT * FROM read_parquet('${lakePath("bronze/touches/**/*.parquet")}', hive_partitioning = true);`);

show(
  await q(
    con,
    `
SELECT 'silver.customers' AS 表, count(*) AS 行数 FROM silver.customers UNION ALL
SELECT 'silver.orders',      count(*) FROM silver.orders UNION ALL
SELECT 'silver.order_items', count(*) FROM silver.order_items UNION ALL
SELECT 'silver.loyalty',     count(*) FROM silver.loyalty UNION ALL
SELECT 'silver.products',    count(*) FROM silver.products UNION ALL
SELECT '湖 events',          count(*) FROM silver.v_events UNION ALL
SELECT '湖 touches',         count(*) FROM silver.v_touches`,
    undefined,
    "入湖结果",
  ),
);
