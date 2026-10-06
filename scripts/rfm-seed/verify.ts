// scripts/rfm-seed/verify.ts —— 拿真值（out/truth.duckdb）核对一份 RFM 快照：身份打通、每个消费者的 R/F/M 原始值与分值、人群、打通不到的订单数。
// 期望值不经过平台的编译器：按真值里的订单与参数独立计算，只借用平台的 silver._identities 把真实的人对应到统一消费者 ID（五分位并列时按它排序）。
// 用法：
//   node --env-file=.env --import tsx scripts/rfm-seed/verify.ts <租户> [快照 ID 或任务 ID，默认最新一份]     核对快照
//   node --env-file=.env --import tsx scripts/rfm-seed/verify.ts <租户> --params '<参数 JSON>'               不核对，只算期望（先看探针会得到什么）
//   node --env-file=.env --import tsx scripts/rfm-seed/verify.ts --preview '<参数 JSON>'                    不连租户：假定五个源都已接入、打通全对，只算期望
// 数据源须按 README 的名字登记：shop_pg、pos_mysql、mini_mongo、tmall_s3、live_duckdb；没登记或没发布映射的数据源，它的订单不计入期望
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { closeDb } from '../../app/.server/db/client';
import { lakeReady, lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { RFM_DEFAULTS, type RfmBinning, type SegmentRule } from '../../app/.server/pipeline/templates/rfm';
import { tenantIdBySlug } from '../../app/.server/tenants';
import { DuckDBInstance } from '@duckdb/node-api';

const TRUTH = join(dirname(fileURLToPath(import.meta.url)), 'out', 'truth.duckdb');
const SOURCE_CODES: Record<string, string> = { shop_pg: 'pg', pos_mysql: 'my', mini_mongo: 'mg', tmall_s3: 's3', live_duckdb: 'dk' };

const [slug, ...rest] = process.argv.slice(2);
const preview = slug === '--preview';
const paramsArg = preview ? JSON.parse(rest[0]) as Record<string, unknown> : rest[0] === '--params' ? JSON.parse(rest[1]) as Record<string, unknown> : undefined;
const snapshotArg = paramsArg ? undefined : rest[0];
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const tenantId = preview ? '' : await tenantIdBySlug(slug);
if (tenantId === null) throw new Error(`没有租户 ${slug}`);
const platform = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
if (!preview) await platform.connect();

// 预览时假定五个源都已接入，数据源 ID 就用名字
const srcRows = preview ? Object.keys(SOURCE_CODES).map(name => ({ id: name, name })) : (await platform.query<{ id: string; name: string }>(`
  SELECT s.id, s.name FROM platform.sources s
  WHERE s.tenant_id = $1 AND EXISTS (
    SELECT 1 FROM platform.mappings m JOIN platform.mapping_versions v ON v.mapping_id = m.id
    WHERE m.source_id = s.id AND v.status = 'published')`, [tenantId])).rows;
const srcMap = srcRows.filter(s => SOURCE_CODES[s.name]).map(s => ({ code: SOURCE_CODES[s.name], id: s.id, name: s.name }));
if (!srcMap.length) throw new Error('没有按 README 命名、且有已发布映射的数据源');

type Snap = { id: string; task_id: string; table: string; params: Record<string, unknown>; row_count: string; definition_version: number | null; result: Record<string, unknown> | null };
let snap: Snap | undefined;
if (!preview && !paramsArg) {
  const { rows } = await platform.query<Snap>(`
    SELECT s.id, s.task_id, s."table", s.params, s.row_count, s.definition_version, t.result FROM platform.snapshots s JOIN platform.tasks t ON t.id = s.task_id
    WHERE s.tenant_id = $1 AND s.template = 'rfm' AND s.expired_at IS NULL AND ($2::text IS NULL OR s.id::text = $2 OR s.task_id::text = $2)
    ORDER BY s.created_at DESC LIMIT 1`, [tenantId, snapshotArg ?? null]);
  snap = rows[0];
  if (!snap) throw new Error('找不到（未过期的）RFM 快照');
}
if (!preview) await platform.end();

const { definitionVersion: _, ...given } = (snap?.params ?? paramsArg) as Record<string, unknown>;
const p = { ...RFM_DEFAULTS, ...given } as typeof RFM_DEFAULTS & { asOf: string };
if (!p.asOf) throw new Error('参数里没有 asOf');

// ---------- 期望值的 SQL（与平台的编译器分开写） ----------
function scoreSql(b: RfmBinning) {
  if (b.method === 'quintile') {
    return `6 - ntile(5) OVER (ORDER BY recency_days, consumer_id) AS r,
      ntile(5) OVER (ORDER BY frequency, monetary, consumer_id) AS f,
      ntile(5) OVER (ORDER BY monetary, consumer_id) AS m`;
  }
  const steps = (col: string, cmp: string, cuts: number[]) => `1 ${cuts.map(c => `+ CASE WHEN ${col} ${cmp} ${c} THEN 1 ELSE 0 END`).join(' ')}`;
  return `${steps('recency_days', '<=', b.recency)} AS r, ${steps('frequency', '>=', b.frequency)} AS f, ${steps('monetary', '>=', b.monetary)} AS m`;
}
function segmentSql(rules: SegmentRule[]) {
  const when = rules.slice(0, -1).map(rule => {
    const conds: string[] = [];
    for (const k of ['r', 'f', 'm'] as const) {
      if (rule[k]?.min !== undefined) conds.push(`${k} >= ${rule[k]!.min}`);
      if (rule[k]?.max !== undefined) conds.push(`${k} <= ${rule[k]!.max}`);
    }
    return `WHEN ${conds.join(' AND ') || 'true'} THEN ${lit(rule.name)}`;
  });
  return `CASE ${when.join(' ')} ELSE ${lit(rules[rules.length - 1].name)} END`;
}

// 核对都在本机的内存库里做（租户湖的会话禁止访问本地文件，挂不上真值库）。预览时 silver._identities 换成按真值的理想打通（每个真实的人一个 ID）；
// 连租户时只读打开租户湖，把 silver._identities 与快照表复制到内存库
const instance = await DuckDBInstance.create(':memory:');
const con = await instance.connect();
await con.run(`SET TimeZone = 'UTC'; CREATE SCHEMA silver`);
const q = async <T = Record<string, unknown>>(sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
const sqlValue = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : lit(String(v)));

/** 在租户湖里执行 select，结果分批写进内存库的 target（列名、类型由 ddl 给出） */
async function copyFromLake(lakeCon: Awaited<ReturnType<typeof openTenantLake>>['con'], select: string, target: string, ddl: string) {
  await con.run(`CREATE OR REPLACE TABLE ${target} (${ddl})`);
  const rows = (await lakeCon.runAndReadAll(select)).getRows();
  for (let i = 0; i < rows.length; i += 5000) {
    const batch = rows.slice(i, i + 5000).map(r => `(${r.map(v => sqlValue(typeof v === 'bigint' ? Number(v) : v)).join(', ')})`);
    await con.run(`INSERT INTO ${target} VALUES ${batch.join(', ')}`);
  }
}

if (!preview) {
  const lake = await lakeRow(tenantId!);
  if (!lake || !lakeReady(lake)) throw new Error('数据湖没有初始化');
  const lakeSession = await openTenantLake(lakeSpecOf(lake), { memoryLimitMb: 4096, threads: 4 }, undefined, { readOnly: true });
  try {
    await copyFromLake(lakeSession.con, `SELECT _source::VARCHAR, customer_id::VARCHAR, consumer_id::VARCHAR FROM silver._identities`,
      'silver._identities', '_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR');
    if (snap) {
      const table = snap.table.split('.').map(part => `"${part.replace(/"/g, '""')}"`).join('.');
      await copyFromLake(lakeSession.con, `SELECT consumer_id::VARCHAR, recency_days::INTEGER, frequency::INTEGER, monetary::DOUBLE, r::INTEGER, f::INTEGER, m::INTEGER, segment::VARCHAR FROM ${table}`,
        'snapshot', 'consumer_id VARCHAR, recency_days INTEGER, frequency INTEGER, monetary DOUBLE, r INTEGER, f INTEGER, m INTEGER, segment VARCHAR');
    }
  } finally {
    lakeSession.close();
  }
}
const show = (title: string, data: unknown[]) => { console.log(`\n== ${title}`); console.table(data); };

try {
  await con.run(`ATTACH ${lit(TRUTH)} AS t (READ_ONLY)`);
  await con.run(`CREATE OR REPLACE TEMP TABLE srcmap AS SELECT * FROM (VALUES ${srcMap.map(s => `(${lit(s.code)}, ${lit(s.id)}, ${lit(s.name)})`).join(', ')}) v(code, source_id, name)`);
  if (preview) {
    await con.run(`CREATE TABLE silver._identities AS SELECT m.source_id AS _source, r.customer_id, md5(r.pid::VARCHAR) AS consumer_id
      FROM t.rec r JOIN srcmap m ON m.code = r.src`);
  }
  console.log(`${preview ? '预览' : `租户 ${slug}`}，参与核对的数据源：${srcMap.map(s => `${s.name}(${s.code})`).join('、')}`);
  console.log(`参数：${JSON.stringify(p)}`);
  if (snap) console.log(`快照 ${snap.id}（任务 ${snap.task_id}，表 ${snap.table}，定义版本 ${snap.definition_version ?? '空'}）`);

  // ---------- 1. 身份打通 ----------
  await con.run(`CREATE OR REPLACE TEMP TABLE rid AS
    SELECT r.pid, r.src, r.customer_id, i.consumer_id FROM t.rec r JOIN srcmap m ON m.code = r.src
    LEFT JOIN silver._identities i ON i._source = m.source_id AND i.customer_id = r.customer_id`);
  show('身份打通（期望：没有缺失、拆分、误合并）', await q(`SELECT
    count(*) AS 源记录, count(*) FILTER (WHERE consumer_id IS NULL) AS 缺失,
    (SELECT count(*) FROM (SELECT pid FROM rid WHERE consumer_id IS NOT NULL GROUP BY pid HAVING count(DISTINCT consumer_id) > 1)) AS 被拆开的人,
    (SELECT count(*) FROM (SELECT consumer_id FROM rid WHERE consumer_id IS NOT NULL GROUP BY consumer_id HAVING count(DISTINCT pid) > 1)) AS 误合并的消费者,
    count(DISTINCT pid) AS 真实的人, count(DISTINCT consumer_id) AS 统一消费者
    FROM rid`));
  show('探针的打通结果', await q(`SELECT r.pid, string_agg(DISTINCT r.src, '+' ORDER BY r.src) AS 源, count(DISTINCT r.consumer_id) AS 消费者数,
      left(min(r.consumer_id), 12) AS consumer_id前缀, any_value(p.note) AS 说明
    FROM rid r JOIN t.person p USING (pid) WHERE r.pid >= 900000 GROUP BY r.pid ORDER BY r.pid`));

  // ---------- 2. 期望的 RFM ----------
  await con.run(`CREATE OR REPLACE TEMP TABLE pc AS SELECT pid, min(consumer_id) AS consumer_id FROM rid WHERE consumer_id IS NOT NULL GROUP BY pid`);
  await con.run(`CREATE OR REPLACE TEMP TABLE w AS
    SELECT o.pid, o.amount, (coalesce(o.paid_utc, o.created_utc))::DATE AS d FROM t.ord o JOIN srcmap m ON m.code = o.src
    WHERE o.status IN (${p.statuses.map(lit).join(', ')})
      AND (coalesce(o.paid_utc, o.created_utc))::DATE BETWEEN DATE ${lit(p.asOf)} - ${p.lookbackDays - 1} AND DATE ${lit(p.asOf)}`);
  await con.run(`CREATE OR REPLACE TEMP TABLE expected AS
    WITH b AS (
      SELECT pc.consumer_id, (DATE ${lit(p.asOf)} - max(w.d))::INTEGER AS recency_days, count(*)::INTEGER AS frequency, sum(w.amount)::DECIMAL(18, 2) AS monetary
      FROM w JOIN pc USING (pid) GROUP BY pc.consumer_id
    ), s AS (SELECT *, ${scoreSql(p.binning)} FROM b)
    SELECT *, ${segmentSql(p.segments)} AS segment FROM s`);
  const [{ n: unlinked }] = await q<{ n: number }>(`SELECT count(*) AS n FROM w LEFT JOIN pc USING (pid) WHERE pc.consumer_id IS NULL`);

  show('期望的人群分布', await q(`SELECT segment AS 人群, count(*) AS 人数, sum(monetary) AS 金额, round(avg(recency_days), 1) AS 平均R天数, round(avg(frequency), 2) AS 平均F
    FROM expected GROUP BY 1 ORDER BY 2 DESC`));

  // ---------- 3. 与快照比对 ----------
  if (snap) {
    await con.run(`CREATE OR REPLACE TEMP TABLE actual AS SELECT consumer_id, recency_days, frequency, monetary::DECIMAL(18, 2) AS monetary, r, f, m, segment FROM snapshot`);
    const [cmp] = await q(`SELECT
      (SELECT count(*) FROM expected) AS 期望行数, (SELECT count(*) FROM actual) AS 实际行数, ${Number(snap.row_count)} AS 快照登记行数,
      ${Number(unlinked)} AS 期望打通不到, ${JSON.stringify(snap.result?.unlinkedOrders ?? null)} AS 任务结果打通不到,
      count(*) FILTER (WHERE a.consumer_id IS NULL) AS 快照里缺的消费者, count(*) FILTER (WHERE e.consumer_id IS NULL) AS 快照里多的消费者,
      count(*) FILTER (WHERE e.recency_days <> a.recency_days) AS R天数不符, count(*) FILTER (WHERE e.frequency <> a.frequency) AS F单数不符,
      count(*) FILTER (WHERE abs(e.monetary - a.monetary) >= 0.01) AS M金额不符,
      count(*) FILTER (WHERE e.r <> a.r OR e.f <> a.f OR e.m <> a.m) AS 分值不符, count(*) FILTER (WHERE e.segment <> a.segment) AS 人群不符
      FROM expected e FULL JOIN actual a USING (consumer_id)`);
    show('快照比对（期望：行数、打通不到相等，其余全为 0）', [cmp]);
    const diffs = await q(`SELECT coalesce(e.consumer_id, a.consumer_id)[:12] AS consumer, e.recency_days AS eR, a.recency_days AS aR, e.frequency AS eF, a.frequency AS aF,
        e.monetary AS eM, a.monetary AS aM, concat(e.r, e.f, e.m) AS e分, concat(a.r, a.f, a.m) AS a分, e.segment AS e人群, a.segment AS a人群
      FROM expected e FULL JOIN actual a USING (consumer_id)
      WHERE e.consumer_id IS NULL OR a.consumer_id IS NULL OR e.recency_days <> a.recency_days OR e.frequency <> a.frequency
        OR abs(e.monetary - a.monetary) >= 0.01 OR e.r <> a.r OR e.f <> a.f OR e.m <> a.m OR e.segment <> a.segment
      LIMIT 10`);
    if (diffs.length) show('不符的前 10 行', diffs);
    else console.log('\n全部一致 ✔');
  }

  // ---------- 4. 探针 ----------
  show('探针：期望值' + (snap ? '（a 开头的列是快照里的实际值）' : ''), await q(`SELECT pc.pid, e.recency_days AS R天数, e.frequency AS F, e.monetary AS M, concat(e.r, e.f, e.m) AS 分, e.segment AS 人群
      ${snap ? ', a.recency_days AS aR天数, a.frequency AS aF, a.monetary AS aM, concat(a.r, a.f, a.m) AS a分, a.segment AS a人群' : ''}
    FROM pc LEFT JOIN expected e USING (consumer_id) ${snap ? 'LEFT JOIN actual a USING (consumer_id)' : ''}
    WHERE pc.pid >= 900000 ORDER BY pc.pid`));
} finally {
  con.closeSync();
  await closeDb();
}
