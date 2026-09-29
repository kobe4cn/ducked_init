// src/lib/export-web.ts —— 给浏览器看板导出数据：wasm/public/data/customers_web.parquet（按城市排序，便于按需读取）
import { mkdirSync } from 'node:fs';
import { connect, exec } from './duck';

mkdirSync('./wasm/public/data', { recursive: true });
const con = await connect({ s3: false });
await exec(con, `
  COPY (
    SELECT u.customer_id, u.city, u.tier, u.gmv::DOUBLE AS gmv, u.orders, r.segment, ls.score AS loyalty
    FROM gold.user_360 u JOIN gold.rfm r USING (customer_id) JOIN gold.loyalty_score ls USING (customer_id)
    ORDER BY city
  ) TO './wasm/public/data/customers_web.parquet' (FORMAT parquet, COMPRESSION zstd)`, '导出 wasm/public/data/customers_web.parquet');
