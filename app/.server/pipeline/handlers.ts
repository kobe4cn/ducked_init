// app/.server/pipeline/handlers.ts —— 各类任务在工作进程里做什么。连接只挂载了本租户的数据湖（默认库），表名不带前缀。
// 新增任务类型只改这里；参数在工作进程里校验，不合法时任务记为失败
import type { DuckDBConnection } from '@duckdb/node-api';

type Params = Record<string, unknown>;
type Result = Record<string, unknown>;

interface Handler { label: string; run(con: DuckDBConnection, params: Params): Promise<Result> }

const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];

/** 本租户数据湖里的全部表与行数 */
async function inventory(con: DuckDBConnection) {
  const tables = await rows<{ schema: string; name: string }>(con, `
    SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
    WHERE table_catalog = 'lake' ORDER BY ALL`);
  return Promise.all(tables.map(async t => {
    const [{ n }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM "${t.schema}"."${t.name}"`);
    return { name: t.schema === 'main' ? t.name : `${t.schema}.${t.name}`, rows: Number(n) };
  }));
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
} satisfies Record<string, Handler>;

export type TaskKind = keyof typeof HANDLERS;

export const isTaskKind = (kind: string): kind is TaskKind => Object.hasOwn(HANDLERS, kind);
