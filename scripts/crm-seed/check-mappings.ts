// scripts/crm-seed/check-mappings.ts —— 用平台的 checkMapping 离线校验 mappings/ 下的映射。源列类型不手写：用只读账号连上 seed.ts 写好的 9 个数据源，
// 按平台列表的方式（openSource / tables）取每张表的 DuckDB 类型；STRUCT 列按下划线展开（Mongo 的嵌套字段）。
// 源视图（mappings 里 view: 的）的列手写在 VIEWS 里，与 views/*.sql 的输出一致。自定义实体按 plan 的登记（ENTITIES）对照。
// 文件名：<数据源>.<表或视图>.<实体>[.<说明>].yaml（同一张表到同一个实体只能有一个映射，第二类事件要先建源视图）。映射之后再校验 definitions/ 下的指标与标签（K2 的 oms 映射不算已发布）
// 用法：node --env-file=.env --import tsx scripts/crm-seed/check-mappings.ts [--describe]（--describe 打印每张源表的列）
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FieldType } from '../../app/lib/canonical-model';
import { DSL_KINDS, type DslKind } from '../../app/.server/pipeline/dsl';
import type { DslCheck, DslContext, MetricSpec } from '../../app/.server/pipeline/dsl/metric-spec';
import { checkMapping, type RegisteredEntity, type SourceColumn } from '../../app/.server/pipeline/mapping-spec';
import type { MergeMappingParam } from '../../app/.server/pipeline/merge-engine';
import { openSource, type SourceSpec } from '../../app/.server/pipeline/source-engine';
import { platformS3 } from '../../app/.server/s3-accounts';

const HERE = dirname(fileURLToPath(import.meta.url));
const s3 = platformS3();
const S3 = { endpoint: s3.endpoint, region: s3.region, urlStyle: s3.urlStyle, useSsl: s3.useSsl, keyId: s3.key, secret: s3.secret };
const PREFIX = 's3://crm-source/crm';
const pg = (schema: string): SourceSpec => ({ kind: 'postgres', host: 'localhost', port: 5432, database: 'crm', schema, user: 'crmlab_reader', password: 'crmlab-reader-secret' });
export const SOURCES: Record<string, SourceSpec> = {
  pos_mysql: { kind: 'mysql', host: 'localhost', port: 3306, database: 'crm_pos', user: 'crmlab_reader', password: 'crmlab-reader-secret' },
  mall_pg: pg('crm_mall'),
  loyalty_pg: pg('crm_loyalty'),
  oms_mongo: { kind: 'mongodb', host: 'localhost', port: 27017, srv: false, tls: false, database: 'crm_oms', authSource: 'admin', user: 'crmlab_ro', password: 'crmlab-ro-secret' },
  tmall_s3: { kind: 's3', path: `${PREFIX}/tmall/`, format: 'parquet', s3: S3 },
  douyin_s3: { kind: 's3', path: `${PREFIX}/douyin/`, format: 'csv', s3: S3 },
  events_s3: { kind: 's3', path: `${PREFIX}/events/`, format: 'json', s3: S3 },
  activity_s3: { kind: 's3', path: `${PREFIX}/activity/`, format: 'csv', s3: S3 },
  wecom_duckdb: { kind: 'duckdb', path: `${PREFIX}/wecom/wecom.duckdb`, s3: S3 },
};

const V = 'VARCHAR', TS = 'TIMESTAMP';
const cols = (o: Record<string, string>): SourceColumn[] => Object.entries(o).map(([name, type]) => ({ name, type }));
const PLATFORM = { _op: V, _batch: 'BIGINT', _commit_ts: 'TIMESTAMP WITH TIME ZONE' };
/** 源视图的输出列（views/<数据源>.<视图>.sql） */
const VIEWS: Record<string, SourceColumn[]> = {
  'douyin_s3.douyin_buyers': cols({ openid: V, mobile: 'BIGINT', mobile_mask: V, city: V, updated_at: TS, ...PLATFORM }),
  'activity_s3.attendances': cols({ 报名编号: V, 活动编号: V, 活动日期: 'DATE', ...PLATFORM }),
  'wecom_duckdb.contact_deletes': cols({ external_userid: V, guide_id: V, del_time: TS, ...PLATFORM }),
};

const field = (name: string, type: FieldType, sensitive = false) => ({ name, type, sensitive });
/** 自定义实体的登记（plan 2.3）：订单 → 门店 → 区域，消费者（企微添加的导购）→ 导购 → 门店 */
export const ENTITIES = new Map<string, RegisteredEntity>([
  ['custom_region', { name: 'custom_region', fields: [field('region_id', 'string'), field('region_name', 'string')], primaryKey: ['region_id'] }],
  ['custom_store', {
    name: 'custom_store', fields: [field('store_id', 'string'), field('store_name', 'string'), field('region_id', 'string')], primaryKey: ['store_id'],
    relations: [
      { from: { entity: 'order', field: 'store_id' }, ref: { entity: 'custom_store', field: 'store_id' } },
      { from: { entity: 'custom_store', field: 'region_id' }, ref: { entity: 'custom_region', field: 'region_id' } },
    ],
  }],
  ['custom_guide', {
    name: 'custom_guide', fields: [field('guide_id', 'string'), field('guide_name', 'string', true), field('store_id', 'string')], primaryKey: ['guide_id'],
    relations: [
      { from: { entity: 'customer', field: 'x_guide_id' }, ref: { entity: 'custom_guide', field: 'guide_id' } },
      { from: { entity: 'custom_guide', field: 'store_id' }, ref: { entity: 'custom_store', field: 'store_id' } },
    ],
  }],
]);

/** STRUCT(a VARCHAR, b STRUCT(c DOUBLE)) 展开成 x_a、x_b_c */
function flatten(name: string, type: string): SourceColumn[] {
  const m = /^STRUCT\((.*)\)$/.exec(type);
  if (!m) return [{ name, type }];
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < m[1].length; i++) {
    const c = m[1][i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(m[1].slice(start, i).trim()); start = i + 1; }
  }
  parts.push(m[1].slice(start).trim());
  return parts.flatMap(p => {
    const sp = p.match(/^("(?:[^"]|"")+"|\S+)\s+(.*)$/)!;
    return flatten(`${name}_${sp[1].replace(/^"|"$/g, '')}`, sp[2]);
  });
}

/** 每个数据源每张表的列（加上原始层的平台列） */
export async function sourceColumns(names: string[]) {
  const out = new Map<string, SourceColumn[]>();
  for (const name of names) {
    const session = await openSource(SOURCES[name]!, { memoryLimitMb: 1024, threads: 2 });
    try {
      for (const t of await session.tables()) {
        const described = (await session.con.runAndReadAll(`DESCRIBE SELECT * FROM ${t.from}`)).getRowObjectsJson() as { column_name: string; column_type: string }[];
        out.set(`${name}.${t.name}`, [...described.flatMap(c => flatten(c.column_name, c.column_type)), ...cols(PLATFORM)]);
      }
    } finally {
      session.close();
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = readdirSync(join(HERE, 'mappings')).filter(f => f.endsWith('.yaml')).sort();
  const columns = await sourceColumns([...new Set(files.map(f => f.split('.')[0]!))]);
  if (process.argv.includes('--describe')) {
    for (const [table, list] of columns) console.log(`${table}: ${list.filter(c => !c.name.startsWith('_')).map(c => `${c.name} ${c.type}`).join(', ')}`);
  }
  let bad = 0;
  const plans: MergeMappingParam[] = [];
  for (const file of files) {
    const [source, table] = file.split('.');
    const check = checkMapping(readFileSync(join(HERE, 'mappings', file), 'utf8'),
      (name, view) => (view ? VIEWS[`${source}.${name}`] : columns.get(`${source}.${name}`)) ?? `没有这张${view ? '源视图' : '表'}`, ENTITIES);
    const issues = check.ok ? [] : check.issues;
    if (issues.length) bad++;
    console.log(`${issues.length ? '✘' : '✔'} ${file}${issues.map(i => `\n    第 ${i.line} 行 ${i.path}：${i.message}${i.hint ? `\n      ${i.hint.replace(/\n/g, '\n      ')}` : ''}`).join('')}`);
    if (check.ok && !file.includes('.k2.')) plans.push({ ...check.plan, mapping: file, version: 1, sourceId: source! });
    void table;
  }
  // 指标先于标签：标签引用的指标要先在 ctx.metrics 里
  const metrics = new Map<string, DslCheck<MetricSpec>>();
  const ctx: DslContext = { published: ENTITIES, plans, metrics };
  for (const kind of ['metric', 'tag'] as DslKind[]) {
    for (const file of readdirSync(join(HERE, 'definitions', kind)).filter(f => f.endsWith('.yaml')).sort()) {
      const key = file.replace(/\.yaml$/, '');
      const check = DSL_KINDS[kind].check(readFileSync(join(HERE, 'definitions', kind, file), 'utf8'), ctx);
      if (kind === 'metric') metrics.set(key, check as DslCheck<MetricSpec>);
      const issues = check.ok ? [] : check.issues;
      if (check.ok) DSL_KINDS[kind].compile(check.spec, ctx, '2026-09-30', key);
      else bad++;
      console.log(`${issues.length ? '✘' : '✔'} ${kind} ${key}${issues.map(i => `\n    第 ${i.line} 行 ${i.path}：${i.message}`).join('')}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
