// app/.server/pipeline/handlers.ts —— 各类任务在工作进程里做什么。连接只挂载了本租户的数据湖（默认库），表名不带前缀。
// 新增任务类型只改这里；参数在工作进程里校验，不合法时任务记为失败
import type { DuckDBConnection } from '@duckdb/node-api';
import type { EngineLimits, TenantLakeSession } from './lake-engine';
import { profileSource, type SourceSpec } from './source-engine';
import { syncSourceTables, type SyncTableParam } from './sync-engine';

type Params = Record<string, unknown>;
type Result = Record<string, unknown>;

/**
 * 任务的运行环境：配额，任务涉及数据源时（参数带 sourceId）派发时解密好的连接参数，
 * 本租户数据湖的会话（attachSource 的任务里数据源也挂在其中），以及抹掉错误信息中凭据的函数
 */
export interface TaskContext { limits: EngineLimits; source?: SourceSpec; session: TenantLakeSession; redact(message: string): string }

/** attachSource：数据源与数据湖挂在同一个 DuckDB 里（在两者之间搬数据的任务） */
interface Handler { label: string; attachSource?: boolean; run(con: DuckDBConnection, params: Params, ctx: TaskContext): Promise<Result> }

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

function syncTables(params: Params): SyncTableParam[] {
  const tables = params.tables;
  const valid = Array.isArray(tables) && tables.length > 0 && tables.every(t =>
    typeof t?.name === 'string' && typeof t.column === 'string' && (t.kind === 'updated_at' || t.kind === 'increment')
    && (t.key === undefined || typeof t.key === 'string'));
  if (!valid) throw new Error('参数 tables 必须是非空的 { name, column, kind, key? } 列表');
  return tables as SyncTableParam[];
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
  // 采集数据源：表清单、行数、列统计与水位线候选。数据源只读挂载在另一个 DuckDB 里，不碰本租户的数据湖
  'source.profile': {
    label: '采集数据源',
    async run(_con, _params, { source, limits }) {
      if (!source) throw new Error('缺少数据源');
      return profileSource(source, limits);
    },
  },
  // 水位线增量同步：每张表一个变更批次追加到原始层，有主键的表到期时再比对一次主键全集。
  // 有表失败时任务记为失败，结果里保留各表的批次与错误
  'source.sync': {
    label: '同步数据源',
    attachSource: true,
    async run(_con, params, { source, session, redact }) {
      if (!source) throw new Error('缺少数据源');
      if (typeof params.sourceId !== 'string') throw new Error('缺少参数 sourceId');
      const tables = await syncSourceTables(session, source, params.sourceId, syncTables(params), redact);
      const failed = tables.filter(t => 'error' in t);
      if (failed.length) {
        throw new PartialFailure(`${failed.length} 张表同步失败：${failed.map(t => `${t.table}（${'error' in t ? t.error : ''}）`).join('；')}`, { tables });
      }
      return { tables };
    },
  },
} satisfies Record<string, Handler>;

export type TaskKind = keyof typeof HANDLERS;

export const isTaskKind = (kind: string): kind is TaskKind => Object.hasOwn(HANDLERS, kind);
