// app/.server/pipeline/serving-engine.ts —— 生成服务库（ADR-0033）：把参数里各已发布定义的快照表合成一个 DuckDB 文件，
// 上传到本租户存储前缀下的 _serving/v<版本>.duckdb。工作进程不读平台库，读哪些快照由调用方放进参数。
// 服务库只有 consumer_id、标签、指标与 RFM 分值，以及统一消费者 ID 的退役对照，不放标准层或原始层的表；快照表本来就没有明文（ADR-0005）
import { SERVING_DIR, type TenantLakeSession } from './lake-engine';
import { CONSUMER_ID_CHANGES } from './identity-engine';
import { ident, lit, rows, tableExists } from './merge-engine';

/** 一个要放进服务库的快照：快照 ID、模板（rfm、metric:<键>、tag:<键>）与结果层表名；其余字段（定义版本等）由调用方记在指针上 */
export interface ServingSnapshot { id: string; template: string; table: string }

export interface ServingParams { version: number; target: string; snapshots: ServingSnapshot[] }

/** 服务库里各表的行数 */
export interface ServingRows { tags: number; metrics: number; rfm: number; consumer_aliases: number }

/** 结果层快照表名 gold.<种类>__<任务 ID> */
export const SNAPSHOT_TABLE = /^gold\.([a-z][a-z0-9]*)__[0-9a-f-]{36}$/;

/** 服务库在存储前缀下的位置 */
export const servingPath = (dataPath: string, version: number) => `${dataPath}${SERVING_DIR}v${version}.duckdb`;

/** 指标的维度列拼成 JSON 对象（没有维度时为 {}）：服务库的 metrics.dims 与指定快照点查时同一种拼法 */
export const dimsJson = (columns: string[]) =>
  columns.length ? `json_object(${columns.map(n => `${lit(n)}, ${ident(n)}`).join(', ')})` : `'{}'::JSON`;

const quoted = (table: string) => `gold.${ident(table.slice('gold.'.length))}`;

/** 各快照按模板分到 RFM、指标、标签；表名、模板与表名前缀不一致或重复时抛错 */
function classify(snapshots: ServingSnapshot[]) {
  const seen = new Set<string>();
  const out = { rfm: [] as ServingSnapshot[], metric: [] as (ServingSnapshot & { key: string })[], tag: [] as ServingSnapshot[] };
  for (const s of snapshots) {
    const prefix = SNAPSHOT_TABLE.exec(s.table)?.[1];
    const [kind, key] = s.template === 'rfm' ? ['rfm', ''] : [s.template.split(':', 1)[0], s.template.slice(s.template.indexOf(':') + 1)];
    if (!prefix || prefix !== kind || (kind !== 'rfm' && !key)) throw new Error(`快照 ${s.id} 的表名 ${s.table} 与模板 ${s.template} 不合规`);
    if (seen.has(s.template)) throw new Error(`模板 ${s.template} 有不止一个快照`);
    seen.add(s.template);
    if (kind === 'rfm') out.rfm.push(s);
    else if (kind === 'metric') out.metric.push({ ...s, key });
    else if (kind === 'tag') out.tag.push(s);
    else throw new Error(`快照 ${s.id} 的模板 ${s.template} 不合规`);
  }
  return out;
}

/** 各部分 UNION ALL 起来；没有部分时用 empty（只带列与类型、没有行） */
const union = (parts: string[], empty: string) => (parts.length ? parts.join('\nUNION ALL\n') : `${empty} LIMIT 0`);

/**
 * 在会话的本机库 serving 里建好服务库的表（都按 consumer_id 排序写入），上传到 target；返回各表行数。
 * 快照表不在时抛错、不上传
 */
export async function buildServingStore(session: TenantLakeSession, { version, target, snapshots }: ServingParams): Promise<ServingRows> {
  if (!session.serving) throw new Error('会话没有挂载服务库');
  const { con } = session;
  const { rfm, metric, tag } = classify(snapshots);

  const present = new Set((await rows<{ name: string }>(con, `
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_catalog = 'lake' AND table_schema = 'gold'`)).map(t => `gold.${t.name}`));
  const missing = snapshots.filter(s => !present.has(s.table));
  if (missing.length) throw new Error(`结果层没有快照表 ${missing.map(s => s.table).join('、')}`);

  const columns = await rows<{ name: string; column: string }>(con, `
    SELECT table_name AS name, column_name AS "column" FROM information_schema.columns
    WHERE table_catalog = 'lake' AND table_schema = 'gold' ORDER BY ordinal_position`);
  // 指标的维度列名各不相同：按快照表的实际列拼 dims，排除 consumer_id 与 value
  const dims = (table: string) =>
    dimsJson(columns.filter(c => `gold.${c.name}` === table && c.column !== 'consumer_id' && c.column !== 'value').map(c => c.column));

  await con.run(`CREATE TABLE serving.tags AS SELECT * FROM (${union(
    tag.map(s => `SELECT consumer_id::VARCHAR AS consumer_id, tag_key::VARCHAR AS tag, tag_value::VARCHAR AS tag_value FROM ${quoted(s.table)}`),
    'SELECT NULL::VARCHAR AS consumer_id, NULL::VARCHAR AS tag, NULL::VARCHAR AS tag_value',
  )}) ORDER BY consumer_id, tag`);
  await con.run(`CREATE TABLE serving.metrics AS SELECT * FROM (${union(
    metric.map(s => `SELECT consumer_id::VARCHAR AS consumer_id, ${lit(s.key)} AS metric, ${dims(s.table)} AS dims, value::DOUBLE AS value FROM ${quoted(s.table)}`),
    'SELECT NULL::VARCHAR AS consumer_id, NULL::VARCHAR AS metric, NULL::JSON AS dims, NULL::DOUBLE AS value',
  )}) ORDER BY consumer_id, metric, dims::VARCHAR`);
  const rfmColumns = 'consumer_id::VARCHAR AS consumer_id, segment::VARCHAR AS segment, r::INTEGER AS r, f::INTEGER AS f, m::INTEGER AS m, '
    + 'recency_days::INTEGER AS recency_days, frequency::BIGINT AS frequency, monetary::DECIMAL(38, 2) AS monetary';
  await con.run(`CREATE TABLE serving.rfm AS SELECT * FROM (${union(
    rfm.map(s => `SELECT ${rfmColumns} FROM ${quoted(s.table)}`),
    `SELECT ${rfmColumns} FROM (SELECT NULL AS consumer_id, NULL AS segment, NULL AS r, NULL AS f, NULL AS m, NULL AS recency_days, NULL AS frequency, NULL AS monetary)`,
  )}) ORDER BY consumer_id`);
  // 退役的 ID 只来自 merge（split 的原 ID 留给另一组，不退役，ADR-0029）；退役 ID 合进的 ID 后来也可能退役，沿着链走到现在的 ID
  const [schema, table] = CONSUMER_ID_CHANGES.split('.') as [string, string];
  await con.run(`CREATE TABLE serving.consumer_aliases AS ${await tableExists(con, schema, table)
    ? `WITH RECURSIVE merged AS (SELECT DISTINCT old_id, new_id FROM ${CONSUMER_ID_CHANGES} WHERE reason = 'merge'),
      walk(retired_id, consumer_id, depth) AS (
        SELECT old_id, new_id, 1 FROM merged
        UNION ALL
        SELECT w.retired_id, m.new_id, w.depth + 1 FROM walk w JOIN merged m ON m.old_id = w.consumer_id WHERE w.depth < 1000)
      SELECT retired_id, consumer_id FROM walk WHERE consumer_id NOT IN (SELECT old_id FROM merged) ORDER BY consumer_id, retired_id`
    : 'SELECT NULL::VARCHAR AS retired_id, NULL::VARCHAR AS consumer_id LIMIT 0'}`);
  await con.run(`CREATE TABLE serving.meta AS SELECT ${version}::INTEGER AS version, now() AS built_at`);

  const [counts] = await rows<Record<keyof ServingRows, string>>(con, `SELECT
    (SELECT count(*) FROM serving.tags) AS tags, (SELECT count(*) FROM serving.metrics) AS metrics,
    (SELECT count(*) FROM serving.rfm) AS rfm, (SELECT count(*) FROM serving.consumer_aliases) AS consumer_aliases`);
  await session.serving.upload(target);
  return Object.fromEntries(Object.entries(counts!).map(([k, n]) => [k, Number(n)])) as unknown as ServingRows;
}
