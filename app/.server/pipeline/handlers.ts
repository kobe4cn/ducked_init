// app/.server/pipeline/handlers.ts —— 各类任务在工作进程里做什么。连接只挂载了本租户的数据湖（默认库），表名不带前缀。
// 新增任务类型只改这里；参数在工作进程里校验，不合法时任务记为失败
import type { DuckDBConnection } from '@duckdb/node-api';
import type { EngineLimits, TenantLakeSession } from './lake-engine';
import { profileSource, type SourceSpec } from './source-engine';
import { syncOptionsFromEnv, syncSourceTables, type SyncTableParam } from './sync-engine';
import { verifySourceLake, type VerifyTableParam } from './verify-engine';
import { mergeToSilver, type MergeMappingParam } from './merge-engine';
import { LAKE_COVERAGE, type NotInLakeReason } from '../../lib/sources';
import { IDENTITIES } from './identity-engine';
import { TEMPLATES } from './templates';
import { compileRfmUnlinked } from './templates/rfm';

type Params = Record<string, unknown>;
type Result = Record<string, unknown>;

/**
 * 任务的运行环境：任务 ID，配额，任务涉及数据源时（参数带 sourceId）派发时解密好的连接参数，合并到标准层时租户的敏感信息盐，
 * 本租户数据湖的会话（attachSource 的任务里数据源也挂在其中），以及抹掉错误信息中凭据的函数
 */
export interface TaskContext { taskId: string; limits: EngineLimits; source?: SourceSpec; piiSalt?: string; session: TenantLakeSession; redact(message: string): string }

/**
 * attachSource：数据源与数据湖挂在同一个 DuckDB 里（在两者之间搬数据或对照的任务）；
 * readOnlyLake：数据湖只读挂载（只出报告、不写湖的任务）
 */
interface Handler { label: string; attachSource?: boolean; readOnlyLake?: boolean; run(con: DuckDBConnection, params: Params, ctx: TaskContext): Promise<Result> }

/** 任务部分完成：记为失败，同时保留已完成部分的结果 */
export class PartialFailure extends Error {
  constructor(message: string, readonly result: Result) { super(message); }
}

const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];

/** 本租户数据湖里的全部表与行数 */
export async function inventory(con: DuckDBConnection) {
  const tables = await rows<{ schema: string; name: string }>(con, `
    SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
    WHERE table_catalog = 'lake' ORDER BY ALL`);
  return Promise.all(tables.map(async t => {
    const [{ n }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM "${t.schema}"."${t.name}"`);
    return { name: t.schema === 'main' ? t.name : `${t.schema}.${t.name}`, rows: Number(n) };
  }));
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string');

/** 同步参数里的表：水位线字段与种类要么都有、要么都没有（全量比对）。业务主键在旧任务里是单个字段 */
function syncTables(params: Params): SyncTableParam[] {
  const tables = params.tables;
  const valid = Array.isArray(tables) && tables.length > 0 && tables.every(t =>
    typeof t?.name === 'string'
    && (t.column === undefined ? t.kind === undefined : typeof t.column === 'string' && (t.kind === 'updated_at' || t.kind === 'increment'))
    && (t.key === undefined || typeof t.key === 'string' || isStrings(t.key))
    && (t.softDelete === undefined || typeof t.softDelete === 'string'));
  if (!valid) throw new Error('参数 tables 必须是非空的 { name, column?, kind?, key?, softDelete? } 列表');
  return (tables as (SyncTableParam | (Omit<SyncTableParam, 'key'> & { key: string }))[])
    .map(t => (typeof t.key === 'string' ? { ...t, key: [t.key] } : t as SyncTableParam));
}

/** 平台判断的未进湖原因：账号读不了、源端已删除由工作进程实时判断，不在参数里 */
const NOT_IN_LAKE_REASONS = Object.keys(LAKE_COVERAGE).filter(c => !['in_lake', 'unreadable', 'gone'].includes(c)) as NotInLakeReason[];

/** 核对参数里的表：最近一次列出表得到的清单（可以为空），每张带是否在同步范围内、平台判断的未进湖原因与同步设置 */
function verifyTables(params: Params): VerifyTableParam[] {
  const tables = params.tables;
  const valid = Array.isArray(tables) && tables.every(t =>
    typeof t?.name === 'string' && typeof t.inScope === 'boolean' && NOT_IN_LAKE_REASONS.includes(t.reason)
    && (t.key === undefined || isStrings(t.key))
    && (t.softDelete === undefined || typeof t.softDelete === 'string')
    && (t.column === undefined ? t.kind === undefined : typeof t.column === 'string' && (t.kind === 'updated_at' || t.kind === 'increment')));
  if (!valid) throw new Error('参数 tables 必须是 { name, inScope, reason, key?, softDelete?, column?, kind? } 列表');
  return tables as VerifyTableParam[];
}

/** 合并参数里的映射：已发布的版本及其合并计划（发布时已校验过，这里只核对形状） */
function mergeMappings(params: Params): MergeMappingParam[] {
  const mappings = params.mappings;
  const valid = Array.isArray(mappings) && mappings.length > 0 && mappings.every(m =>
    typeof m?.mapping === 'string' && Number.isInteger(m.version) && typeof m.sourceId === 'string'
    && typeof m.entity === 'string' && typeof m.table === 'string'
    && Array.isArray(m.columns) && m.columns.length > 0 && Array.isArray(m.entityColumns) && isStrings(m.key)
    && (m.latest === null || typeof m.latest === 'string'));
  if (!valid) throw new Error('参数 mappings 必须是非空的已发布映射列表');
  return mappings as MergeMappingParam[];
}

/** 合并参数里身份打通的匹配规则（入队时由全部 customer 映射汇总）；早先入队的合并没有这一项，用默认规则 */
function identityMatch(params: Params) {
  const rules = params.identity;
  if (rules === undefined) return undefined;
  if (!isStrings(rules)) throw new Error('参数 identity 必须是非空的字段名列表');
  return rules;
}

function positiveInt(params: Params, key: string, max: number) {
  const v = params[key];
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > max) throw new Error(`参数 ${key} 必须是 1 到 ${max} 之间的整数`);
  return v as number;
}

export const HANDLERS = {
  'lake.inventory': {
    label: '盘点数据湖',
    run: async con => ({ tables: await inventory(con) }),
  },
  // 造数夹具：与 src/01_seed.ts 相同，用 hash() 确定性生成消费者与订单，同样的参数每次得到同样的数据
  'demo.seed': {
    label: '生成演示数据',
    async run(con, params) {
      const customers = positiveInt(params, 'customers', 1_000_000);
      const u01 = (x: string, salt: number) => `((hash(${x}::BIGINT * 1000003 + ${salt}) % 10000000)::DOUBLE / 1e7)`;
      await con.run(`
        DROP TABLE IF EXISTS orders;
        DROP TABLE IF EXISTS customers;
        CREATE TABLE customers AS
        SELECT i AS customer_id,
               '消费者' || i AS name,
               ['北京','上海','广州','深圳','杭州','成都','武汉','西安'][1 + floor(${u01('i', 7)} * 8)::INT] AS city,
               TIMESTAMP '2024-01-01' + to_seconds((${u01('i', 4)} * 83000000)::BIGINT) AS created_at
        FROM range(1, ${customers} + 1) t(i);
        CREATE TABLE orders AS
        SELECT row_number() OVER (ORDER BY c.customer_id, k) AS order_id,
               c.customer_id,
               c.created_at + to_days((${u01('c.customer_id * 17 + k', 11)} * 600)::INT) AS order_ts,
               round(20 + ${u01('c.customer_id * 17 + k', 12)} * 980, 2) AS pay_amount
        FROM customers c, range(floor(${u01('c.customer_id', 10)} * 6)::BIGINT) r(k);`);
      return { tables: await inventory(con) };
    },
  },
  // 采集数据源：同步范围内的表（参数 tables）的行数、列统计与水位线候选，范围外的表不碰。
  // 数据源只读挂载在另一个 DuckDB 里，不碰本租户的数据湖
  'source.profile': {
    label: '采集数据源',
    async run(_con, params, { source, limits }) {
      if (!source) throw new Error('缺少数据源');
      if (!isStrings(params.tables)) throw new Error('参数 tables 必须是非空的表名列表');
      return profileSource(source, limits, { tables: params.tables });
    },
  },
  // 同步：每张表一个变更批次追加到原始层。有水位线的表增量读取，到了比对周期再比对一次主键全集（没有主键时整行全量比对）；
  // 没有水位线的表全量比对。参数 reconcile 为真时（成员在核对发现差异后触发）不等比对周期，增量之后都比对一次。
  // 有表失败时任务记为失败，结果里保留各表的批次与错误；源端已经没有的表跳过，不算失败
  'source.sync': {
    label: '同步数据源',
    attachSource: true,
    async run(_con, params, { source, session, limits, redact }) {
      if (!source) throw new Error('缺少数据源');
      if (typeof params.sourceId !== 'string') throw new Error('缺少参数 sourceId');
      const options = params.reconcile === true ? { ...syncOptionsFromEnv(), reconcileHours: 0 } : syncOptionsFromEnv();
      const tables = await syncSourceTables(session, source, params.sourceId, syncTables(params), limits, redact, options);
      const failed = tables.filter(t => 'error' in t && !t.gone);
      if (failed.length) {
        throw new PartialFailure(`${failed.length} 张表同步失败：${failed.map(t => `${t.table}（${'error' in t ? t.error : ''}）`).join('；')}`, { tables });
      }
      return { tables };
    },
  },
  // 核对湖中数据：源端的全部表标出是否进湖与源端行数，已进湖的表再核对位置、文件、结构与数据量。
  // 数据湖只读挂载，只出报告不写湖；differences 是已进湖、四项有不一致的表数
  'source.verify': {
    label: '核对湖中数据',
    attachSource: true,
    readOnlyLake: true,
    async run(_con, params, { source, session, limits, redact }) {
      if (!source) throw new Error('缺少数据源');
      if (typeof params.sourceId !== 'string') throw new Error('缺少参数 sourceId');
      const tables = await verifySourceLake(session, source, params.sourceId, verifyTables(params), limits, redact);
      return { tables, differences: tables.filter(t => t.ok === false).length };
    },
  },
  // 合并到标准层：按已发布的映射把原始层里新的变更批次合并进标准层，每个映射各自一个事务，之后按参数里的匹配规则重算身份打通。
  // 有映射或打通失败时任务记为失败，结果里保留各映射的合并结果、打通摘要（组数、记录数与已归属设备数，不带哈希）与错误；
  // 源表还没同步进原始层的映射跳过，不算失败
  'silver.merge': {
    label: '合并到标准层',
    async run(_con, params, { session, piiSalt, redact }) {
      if (!piiSalt) throw new Error('缺少敏感信息盐');
      const result = await mergeToSilver(session, mergeMappings(params), piiSalt, redact, identityMatch(params));
      const failed = result.mappings.filter(m => 'error' in m);
      const problems = [
        ...(failed.length ? [`${failed.length} 个映射合并失败：${failed.map(m => `${m.entity} ← ${m.table}（${'error' in m ? m.error : ''}）`).join('；')}`] : []),
        ...(result.identities && 'error' in result.identities ? [`身份打通失败：${result.identities.error}`] : []),
      ];
      if (problems.length) throw new PartialFailure(problems.join('；'), result);
      return result;
    },
  },
  // RFM 分层：按参数（asOf 必填，其余取模板默认值）把打通后的统一消费者的订单编译成 R/F/M 分与人群，
  // 写进结果层的一张快照表 gold."rfm__<任务 ID>"，只有 consumer_id 与分值，没有明文。打通不到消费者的订单不计入，结果里报告条数。
  // 第一期参数直接放在任务参数里，还不经过已发布的定义；参数编辑与双人发布之后接上
  'gold.rfm': {
    label: TEMPLATES.rfm.label,
    async run(con, params, { taskId }) {
      const rfm = TEMPLATES.rfm.parse(params);
      const present = await rows<{ name: string }>(con, `
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_catalog = 'lake' AND table_schema = 'silver' AND table_name IN ('order', '_identities')`);
      const has = (name: string) => present.some(t => t.name === name);
      if (!has('order')) throw new Error('标准层还没有订单（silver.order）：先发布 order 映射并合并');
      if (!has('_identities')) throw new Error(`标准层还没有身份打通结果（${IDENTITIES}）：先发布 customer 映射并合并`);
      const name = `rfm__${taskId}`;
      await con.run(`CREATE SCHEMA IF NOT EXISTS gold; CREATE TABLE gold."${name}" AS ${TEMPLATES.rfm.compile(rfm)}`);
      const [{ n }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM gold."${name}"`);
      const [{ n: unlinked }] = await rows<{ n: string }>(con, compileRfmUnlinked(rfm));
      return { table: `gold.${name}`, rows: Number(n), unlinkedOrders: Number(unlinked), params: rfm };
    },
  },
} satisfies Record<string, Handler>;

export type TaskKind = keyof typeof HANDLERS;

export const isTaskKind = (kind: string): kind is TaskKind => Object.hasOwn(HANDLERS, kind);
