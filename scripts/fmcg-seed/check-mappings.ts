// scripts/fmcg-seed/check-mappings.ts —— 用平台的 checkMapping 离线校验 mappings/ 下的映射，再校验并编译 definitions/ 下的指标与标签。
// 源列类型不手写：用只读账号连上 seed.ts 写好的 13 个数据源取真实类型（scripts/crm-seed/check-mappings.ts 的 sourceColumns，Mongo 的嵌套字段按下划线展开）。
// 源视图（mappings 里 view: 的）的列手写在 VIEWS 里，与 views/*.sql 的输出一致。自定义实体按 plan 2.3 的登记（ENTITIES）对照。
// 文件名：<数据源>.<表或视图>.<实体>[.<说明>].yaml（同一张表到同一个实体只能有一个映射，第二类事件要先建源视图）
// 用法：node --env-file=.env --import tsx scripts/fmcg-seed/check-mappings.ts [--describe]（--describe 打印每张源表的列）
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FieldType } from '../../app/lib/canonical-model';
import { DSL_KINDS, type DslKind } from '../../app/.server/pipeline/dsl';
import type { DslCheck, DslContext, MetricSpec } from '../../app/.server/pipeline/dsl/metric-spec';
import { checkMapping, type RegisteredEntity, type SourceColumn } from '../../app/.server/pipeline/mapping-spec';
import type { MergeMappingParam } from '../../app/.server/pipeline/merge-engine';
import type { SourceSpec } from '../../app/.server/pipeline/source-engine';
import { platformS3 } from '../../app/.server/s3-accounts';
import { sourceColumns } from '../crm-seed/check-mappings';

const HERE = dirname(fileURLToPath(import.meta.url));
const s3 = platformS3();
const S3 = { endpoint: s3.endpoint, region: s3.region, urlStyle: s3.urlStyle, useSsl: s3.useSsl, keyId: s3.key, secret: s3.secret };
const PREFIX = 's3://crm-source/fmcg';
const USER = 'fmcglab_reader', PASSWORD = 'fmcglab-reader-secret';
const pg = (schema: string): SourceSpec => ({ kind: 'postgres', host: 'localhost', port: 5432, database: 'crm', schema, user: USER, password: PASSWORD });
const my = (database: string): SourceSpec => ({ kind: 'mysql', host: 'localhost', port: 3306, database, user: USER, password: PASSWORD });
const file = (dir: string, format: 'csv' | 'json' | 'parquet'): SourceSpec => ({ kind: 's3', path: `${PREFIX}/${dir}/`, format, s3: S3 });
export const SOURCES: Record<string, SourceSpec> = {
  member_pg: pg('fmcg_member'),
  mall_pg: pg('fmcg_mall'),
  scan_mysql: my('fmcg_scan'),
  station_mysql: my('fmcg_station'),
  erp_mysql: my('fmcg_erp'),
  oms_mongo: { kind: 'mongodb', host: 'localhost', port: 27017, srv: false, tls: false, database: 'fmcg_oms', authSource: 'admin', user: 'fmcglab_ro', password: 'fmcglab-ro-secret' },
  tmall_s3: file('tmall', 'parquet'),
  jd_s3: file('jd', 'csv'),
  douyin_s3: file('douyin', 'csv'),
  events_s3: file('events', 'json'),
  activity_s3: file('activity', 'csv'),
  sellout_s3: file('sellout', 'csv'),
  wecom_duckdb: { kind: 'duckdb', path: `${PREFIX}/wecom/wecom.duckdb`, s3: S3 },
};

const V = 'VARCHAR', TS = 'TIMESTAMP', BIG = 'BIGINT', DBL = 'DOUBLE';
const cols = (o: Record<string, string>): SourceColumn[] => Object.entries(o).map(([name, type]) => ({ name, type }));
const PLATFORM = { _op: V, _batch: BIG, _commit_ts: 'TIMESTAMP WITH TIME ZONE' };
/** 订单中台按平台拆开的三个源视图输出同样的列 */
const OMS_VIEW = cols({ doc_id: V, so_id: V, buyer_id: V, status: V, pay_total: DBL, pay_paid_at: TS, logistics_company: V, created: TS, modified: TS, ...PLATFORM });
/** 源视图的输出列（views/<数据源>.<视图>.sql） */
export const VIEWS: Record<string, SourceColumn[]> = {
  'oms_mongo.oms_tmall': OMS_VIEW,
  'oms_mongo.oms_jd': OMS_VIEW,
  'oms_mongo.oms_douyin': OMS_VIEW,
  'jd_s3.jd_buyers': cols({ pin: V, mobile: V, updated_at: TS, ...PLATFORM }),
  'jd_s3.jd_lines': cols({ 订单号: BIG, 京东SKU: V, 商家编码: V, 数量: BIG, 金额: DBL, ...PLATFORM }),
  'douyin_s3.dy_buyers': cols({ openid: V, mobile: BIG, city: V, updated_at: TS, ...PLATFORM }),
  'activity_s3.signups_clean': cols({ 报名编号: V, 姓名: V, 手机: V, 城市: V, 报名时间: TS, ...PLATFORM }),
  'wecom_duckdb.group_quits': cols({ group_id: V, external_userid: V, quit_time: TS, ...PLATFORM }),
};

const field = (name: string, type: FieldType, sensitive = false) => ({ name, type, sensitive });
const rel = (from: string, ref: string) => {
  const [fe, ff] = from.split('.') as [string, string];
  const [re, rf] = ref.split('.') as [string, string];
  return { from: { entity: fe, field: ff }, ref: { entity: re, field: rf } };
};
/** 自定义实体的登记（plan 2.3）：维度（大区、奶站、码、商超门店）与事实（周期购、商超周销量），label 与 kind 给 setup.ts 登记用 */
export const ENTITIES = new Map<string, RegisteredEntity & { label: string; kind: 'dimension' | 'fact' }>([
  ['custom_region', { name: 'custom_region', label: '大区', kind: 'dimension', fields: [field('region_id', 'string'), field('region_name', 'string')], primaryKey: ['region_id'] }],
  ['custom_station', {
    name: 'custom_station', label: '奶站', kind: 'dimension', primaryKey: ['station_id'],
    fields: [field('station_id', 'string'), field('station_name', 'string'), field('city', 'string'), field('region_id', 'string')],
    relations: [rel('order.store_id', 'custom_station.station_id'), rel('custom_station.region_id', 'custom_region.region_id')],
  }],
  ['custom_code', {
    name: 'custom_code', label: '一物一码', kind: 'dimension', primaryKey: ['code'],
    fields: [field('code', 'string'), field('sku', 'string'), field('batch_no', 'string'), field('sales_region', 'string'), field('produced_at', 'timestamp')],
    relations: [rel('event.x_code', 'custom_code.code'), rel('custom_code.sales_region', 'custom_region.region_id')],
  }],
  ['custom_subscription', {
    name: 'custom_subscription', label: '周期购', kind: 'fact', primaryKey: ['sub_id'],
    fields: [field('sub_id', 'string'), field('customer_id', 'string'), field('product_id', 'string'), field('plan', 'string'), field('periods', 'integer'),
      field('delivered', 'integer'), field('status', 'string'), field('start_date', 'date'), field('updated_at', 'timestamp')],
    relations: [rel('custom_subscription.customer_id', 'customer.customer_id'), rel('custom_subscription.product_id', 'product.product_id')],
  }],
  ['custom_ka_store', {
    name: 'custom_ka_store', label: '商超门店', kind: 'dimension', primaryKey: ['store_code'],
    fields: [field('store_code', 'string'), field('store_name', 'string'), field('chain', 'string'), field('city', 'string'), field('region_id', 'string')],
    relations: [rel('custom_ka_store.region_id', 'custom_region.region_id')],
  }],
  ['custom_sellout', {
    name: 'custom_sellout', label: '商超周销量', kind: 'fact', primaryKey: ['week', 'store_code', 'product_id'],
    fields: [field('week', 'string'), field('week_start', 'date'), field('store_code', 'string'), field('product_id', 'string'), field('qty', 'integer'), field('amount', 'decimal')],
    relations: [rel('custom_sellout.store_code', 'custom_ka_store.store_code'), rel('custom_sellout.product_id', 'product.product_id')],
  }],
]);

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = readdirSync(join(HERE, 'mappings')).filter(f => f.endsWith('.yaml')).sort();
  const names = process.argv.includes('--describe') ? Object.keys(SOURCES) : [...new Set(files.map(f => f.split('.')[0]!))];
  const columns = await sourceColumns(names, SOURCES);
  if (process.argv.includes('--describe')) {
    for (const [table, list] of columns) console.log(`${table}: ${list.filter(c => !c.name.startsWith('_')).map(c => `${c.name} ${c.type}`).join(', ')}`);
  }
  let bad = 0;
  const plans: MergeMappingParam[] = [];
  for (const f of files) {
    const [source] = f.split('.');
    const check = checkMapping(readFileSync(join(HERE, 'mappings', f), 'utf8'),
      (name, view) => (view ? VIEWS[`${source}.${name}`] : columns.get(`${source}.${name}`)) ?? `没有这张${view ? '源视图' : '表'}`, ENTITIES);
    const issues = check.ok ? [] : check.issues;
    if (issues.length) bad++;
    console.log(`${issues.length ? '✘' : '✔'} ${f}${issues.map(i => `\n    第 ${i.line} 行 ${i.path}：${i.message}${i.hint ? `\n      ${i.hint.replace(/\n/g, '\n      ')}` : ''}`).join('')}`);
    if (check.ok) plans.push({ ...check.plan, mapping: f, version: 1, sourceId: source! });
  }
  // 指标先于标签：标签引用的指标要先在 ctx.metrics 里
  const metrics = new Map<string, DslCheck<MetricSpec>>();
  const ctx: DslContext = { published: ENTITIES, plans, metrics };
  for (const kind of ['metric', 'tag'] as DslKind[]) {
    for (const f of readdirSync(join(HERE, 'definitions', kind)).filter(x => x.endsWith('.yaml')).sort()) {
      const key = f.replace(/\.yaml$/, '');
      const check = DSL_KINDS[kind].check(readFileSync(join(HERE, 'definitions', kind, f), 'utf8'), ctx);
      if (kind === 'metric') metrics.set(key, check as DslCheck<MetricSpec>);
      const issues = check.ok ? [] : check.issues;
      if (check.ok) DSL_KINDS[kind].compile(check.spec, ctx, '2026-09-30', key);
      else bad++;
      console.log(`${issues.length ? '✘' : '✔'} ${kind} ${key}${issues.map(i => `\n    第 ${i.line} 行 ${i.path}：${i.message}`).join('')}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
