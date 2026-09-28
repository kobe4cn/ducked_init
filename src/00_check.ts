// src/00_check.ts —— 环境自检：DuckDB 扩展、PostgreSQL 连接、对象存储读写
import { config, lakePath, isS3Lake } from './lib/config';
import { connect, q } from './lib/duck';

const results: { 项目: string; 状态: string; 说明: string }[] = [];
const ok = (项目: string, 说明: string) => results.push({ 项目, 状态: '✅', 说明 });
const bad = (项目: string, e: unknown) => results.push({ 项目, 状态: '❌', 说明: String(e).split('\n')[0].slice(0, 120) });

const con = await connect({ s3: false });
const [v] = await q<{ v: string }>(con, `SELECT version() AS v`);
ok('DuckDB', `${v.v}，threads=${config.threads}，memory_limit=${config.memoryLimit}`);

if (config.seedTarget === 'pg') {
  try {
    const c = await connect({ pg: true, s3: false });
    const [r] = await q<{ v: string }>(c, `FROM postgres_query('pg', 'SELECT version() AS v')`);
    ok('PostgreSQL', `${config.pg.host}:${config.pg.port}/${config.pg.database} — ${r.v.split(',')[0]}`);
  } catch (e) { bad('PostgreSQL', e); }
}

if (isS3Lake()) {
  try {
    const c = await connect({ s3: true });
    const probe = lakePath('_check/probe.parquet');
    await c.run(`COPY (SELECT 42 AS answer) TO '${probe}' (FORMAT parquet)`);
    const [r] = await q<{ answer: number }>(c, `SELECT answer FROM '${probe}'`);
    ok('对象存储', `${config.s3.endpoint} 写入并读回 ${probe} → ${r.answer}`);
  } catch (e) { bad('对象存储', e); }
} else {
  ok('对象存储', `未使用（LAKE_URI=${config.lake} 为本地目录）`);
}

try {
  const c = await connect({ ducklake: true, s3: false });
  await c.run(`SELECT 1`);
  ok('DuckLake 扩展', '已加载');
} catch (e) { bad('DuckLake 扩展', e); }

console.table(results);
if (results.some(r => r.状态 === '❌')) process.exit(1);
