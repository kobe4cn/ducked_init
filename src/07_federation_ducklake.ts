// src/07_federation_ducklake.ts —— 联邦查询（DuckDB × PostgreSQL × 湖）与 DuckLake 湖仓表
//   需要 SEED_TARGET=pg。DuckLake 元数据存 PostgreSQL，数据文件存对象存储。
import { config, lakePath } from './lib/config';
import { connect, exec, q, show } from './lib/duck';

const S = config.pg.schema;
const con = await connect({ pg: true, ducklake: true });

// =====================================================================
// 1. 联邦查询：PG 业务表 × 湖上埋点 × 分析库里的会员表，一条 SQL
// =====================================================================
show(await q(con, `
SELECT c.city, l.tier, count(DISTINCT e.user_id) AS 活跃用户
FROM pg.${S}.customers c
JOIN silver.v_events e ON e.user_id = c.customer_id
JOIN silver.loyalty  l ON l.customer_id = c.customer_id
WHERE e.dt >= '2026-09-20' AND e.event = 'pay'
GROUP BY ALL ORDER BY 活跃用户 DESC LIMIT 6`, undefined, '1. 联邦查询：PG × 湖 × 分析库'));

// 过滤条件下推：只有满足条件的行从 PG 传过来（看 EXPLAIN 里的 POSTGRES_SCAN 过滤器）
show(await q(con, `
SELECT status, count(*) AS n, round(sum(pay_amount)) AS gmv
FROM pg.${S}.orders
WHERE order_ts >= TIMESTAMP '2026-09-01'
GROUP BY ALL ORDER BY n DESC`, undefined, '1b. 直接查 PG（WHERE 下推到 PG）'));

// 让 PG 自己完成整条查询（聚合也在 PG 里做，只回传结果）
show(await q(con, `
FROM postgres_query('pg', 'SELECT channel, count(*) AS n FROM ${S}.orders GROUP BY channel ORDER BY n DESC')`,
  undefined, '1c. postgres_query：整条 SQL 在 PG 执行'));

// =====================================================================
// 2. DuckLake：元数据在 PG，数据在 S3；每次写入都是快照，可时间旅行
// =====================================================================
const meta = `dbname=${config.pg.database} host=${config.pg.host} port=${config.pg.port} user=${config.pg.user} password=${config.pg.password}`;
await exec(con, `CALL postgres_execute('pg', 'DROP SCHEMA IF EXISTS ducklake_meta CASCADE; CREATE SCHEMA ducklake_meta;')`);
await exec(con, `
ATTACH 'ducklake:postgres:${meta}' AS lh (DATA_PATH '${lakePath('ducklake/')}', METADATA_SCHEMA 'ducklake_meta')`,
  '2. ATTACH DuckLake（元数据：PostgreSQL，数据：对象存储）');

await exec(con, `
CREATE TABLE lh.orders AS SELECT * FROM silver.orders WHERE order_ts < TIMESTAMP '2026-09-01'`, '2a. 建表并写入 9 月前的订单（新快照）');
await exec(con, `ALTER TABLE lh.orders SET PARTITIONED BY (year(order_ts), month(order_ts))`, '2b. 设置分区（对之后写入的数据生效）');
await exec(con, `INSERT INTO lh.orders SELECT * FROM silver.orders WHERE order_ts >= TIMESTAMP '2026-09-01'`, '2c. 追加 9 月订单（新快照）');
await exec(con, `UPDATE lh.orders SET status = 'refunded' WHERE order_id % 1000 = 7 AND status = 'paid'`, '2d. 批量改状态（新快照）');

show(await q(con, `SELECT snapshot_id, snapshot_time::VARCHAR AS snapshot_time, changes::VARCHAR AS changes FROM lh.snapshots() ORDER BY snapshot_id`,
  undefined, '2e. 快照列表'));

const snaps = await q<{ id: string }>(con, `SELECT snapshot_id::VARCHAR AS id FROM lh.snapshots() ORDER BY snapshot_id`);
const first = snaps.find((_, i) => i >= 1)?.id ?? snaps[0].id;       // 第一次写入数据后的快照
const last = snaps[snaps.length - 1].id;
show(await q(con, `
SELECT 'AT VERSION ${first}' AS 版本, count(*) AS 订单数, count(*) FILTER (WHERE status = 'refunded') AS 退款数 FROM lh.orders AT (VERSION => ${first})
UNION ALL
SELECT '当前', count(*), count(*) FILTER (WHERE status = 'refunded') FROM lh.orders`, undefined, '2f. 时间旅行：对比历史快照与当前'));

show(await q(con, `
SELECT change_type, count(*) AS 行数
FROM lh.table_changes('orders', ${Number(last)}, ${Number(last)})
GROUP BY ALL ORDER BY ALL`, undefined, '2g. 变更流（CDC）：最后一个快照改了什么'));

// 维护：合并小文件、清理过期快照
await exec(con, `CALL ducklake_merge_adjacent_files('lh')`, '2h. 合并相邻小文件');
show(await q(con, `SELECT count(*) AS 数据文件数 FROM glob('${lakePath('ducklake/**/*.parquet')}')`, undefined, '2i. DuckLake 在对象存储上的数据文件'));
await con.run(`DETACH lh`);
