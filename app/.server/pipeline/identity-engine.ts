// app/.server/pipeline/identity-engine.ts —— 身份打通：把本租户各数据源的 customer 记录按确定性规则归并为统一消费者，
// 结果整表写进 silver._identities(_source, customer_id, consumer_id)。在合并到标准层之后、工作进程里运行。
// 一条源记录的身份是 (_source, customer_id)（customer_id 只在一个数据源内唯一，两者有一个为空的行不参与）。规则是标准层里敏感字段的哈希精确相等
// （哈希前已规范化，空值不参与），合并语义是传递闭包：A-B 手机相同、B-C 邮箱相同，则 A、B、C 是同一个消费者。
// 统一消费者 ID 取组内最小的 (_source, customer_id) 再哈希，与敏感字段的哈希无关，同样的输入总得到同样的结果。
// 之后由 silver.event 的登录事件求设备归属，整表写进 silver._device_owner(device_id, consumer_id, login_at)：
// 每台登录过的设备归属到它全局最近一次登录的统一消费者（登录事件的 customer_id 只在它自己的 _source 内解析），
// 同一时刻并列时取较小的 consumer_id；匿名事件（customer_id 为空）经 device_id 对应到统一消费者
import type { DuckDBConnection } from '@duckdb/node-api';

/** 默认的匹配规则：按顺序是手机号、邮箱、外部 ID 的哈希精确相等。顺序只是优先级的记录，合并语义是纯传递闭包 */
export const DEFAULT_RULES = ['phone', 'email', 'external_id'] as const;

/** 登录事件的事件类型，先写死，还不能配置 */
export const LOGIN_EVENT = 'login';

/** 一次打通的摘要：统一消费者（组）数、参与打通的源记录数与已归属的设备数 */
export interface IdentitySummary { groups: number; records: number; devices: number }

export const IDENTITIES = 'silver._identities';
export const DEVICE_OWNER = 'silver._device_owner';
const CUSTOMER = 'silver."customer"';
const EVENT = 'silver."event"';
const NODES = 'stage.identity_nodes';
const VALUES = 'stage.identity_values';
const LABELS = 'stage.identity_labels';
const NEXT = 'stage.identity_next';

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];

/**
 * 由 silver.customer 整表重算身份打通，再由 silver.event（不存在时没有设备归属）求设备归属，
 * 在一个事务里覆盖写入 silver._identities 与 silver._device_owner。silver.customer 必须存在；
 * 表里还没有的规则字段（早先发布的映射建的表没有新加的字段）跳过。中间结果在会话的本机库 stage 里算好，
 * 事务里只写数据湖（DuckDB 一个事务只能写一个库）
 */
export async function resolveIdentities(con: DuckDBConnection, rules: readonly string[] = DEFAULT_RULES): Promise<IdentitySummary> {
  const columns = new Set((await rows<{ column_name: string }>(con, `DESCRIBE ${CUSTOMER}`)).map(c => c.column_name));
  const used = rules.filter(r => columns.has(r));
  const events = (await rows(con, `
    SELECT 1 FROM information_schema.tables WHERE table_catalog = 'lake' AND table_schema = 'silver' AND table_name = 'event'`)).length > 0;
  try {
    // 每条源记录一个编号，按 (_source, customer_id) 排序，组里最小的编号就是组里最小的源记录
    await con.run(`CREATE OR REPLACE TABLE ${NODES} AS
      SELECT _source, customer_id, row_number() OVER (ORDER BY _source, customer_id) AS node
      FROM (SELECT DISTINCT _source, customer_id FROM ${CUSTOMER} WHERE _source IS NOT NULL AND customer_id IS NOT NULL)`);
    await con.run(`CREATE OR REPLACE TABLE ${VALUES} AS SELECT DISTINCT * FROM (${used.length
      ? used.map(r => `SELECT n.node, ${lit(r)} AS rule, c.${ident(r)} AS value FROM ${CUSTOMER} c
          JOIN ${NODES} n ON n._source = c._source AND n.customer_id = c.customer_id WHERE c.${ident(r)} IS NOT NULL`).join(' UNION ALL ')
      : `SELECT NULL::BIGINT AS node, NULL::VARCHAR AS rule, NULL::VARCHAR AS value LIMIT 0`})`);
    // 标签传播到不动点：每条记录取与它共享某个取值的记录里最小的标签，再取自己标签那条记录的标签（跳跃，收敛更快）
    await con.run(`CREATE OR REPLACE TABLE ${LABELS} AS SELECT node, node AS label FROM ${NODES}`);
    for (;;) {
      await con.run(`CREATE OR REPLACE TABLE ${NEXT} AS
        WITH shared AS (SELECT v.rule, v.value, min(l.label) AS label FROM ${VALUES} v JOIN ${LABELS} l USING (node) GROUP BY ALL),
        near AS (SELECT v.node, min(s.label) AS label FROM ${VALUES} v JOIN shared s USING (rule, value) GROUP BY ALL)
        SELECT l.node, least(l.label, coalesce(n.label, l.label), j.label) AS label
        FROM ${LABELS} l LEFT JOIN near n USING (node) JOIN ${LABELS} j ON j.node = l.label`);
      const [{ changed }] = await rows<{ changed: string }>(con, `
        SELECT count(*) AS changed FROM ${NEXT} x JOIN ${LABELS} l USING (node) WHERE x.label <> l.label`);
      await con.run(`CREATE OR REPLACE TABLE ${LABELS} AS SELECT * FROM ${NEXT}`);
      if (!Number(changed)) break;
    }

    await con.run('BEGIN');
    try {
      await con.run(`CREATE TABLE IF NOT EXISTS ${IDENTITIES} (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR)`);
      await con.run(`DELETE FROM ${IDENTITIES}`);
      await con.run(`INSERT INTO ${IDENTITIES}
        SELECT n._source, n.customer_id, sha256(m._source || chr(31) || m.customer_id) AS consumer_id
        FROM ${NODES} n JOIN ${LABELS} l USING (node) JOIN ${NODES} m ON m.node = l.label
        ORDER BY n._source, n.customer_id`);
      await con.run(`CREATE TABLE IF NOT EXISTS ${DEVICE_OWNER} (device_id VARCHAR, consumer_id VARCHAR, login_at TIMESTAMPTZ)`);
      await con.run(`DELETE FROM ${DEVICE_OWNER}`);
      if (events) {
        await con.run(`INSERT INTO ${DEVICE_OWNER}
          SELECT e.device_id, i.consumer_id, e.occurred_at AS login_at
          FROM ${EVENT} e JOIN ${IDENTITIES} i ON i._source = e._source AND i.customer_id = e.customer_id
          WHERE e.event_type = ${lit(LOGIN_EVENT)} AND e.device_id IS NOT NULL AND e.occurred_at IS NOT NULL
          QUALIFY row_number() OVER (PARTITION BY e.device_id ORDER BY e.occurred_at DESC, i.consumer_id) = 1
          ORDER BY e.device_id`);
      }
      await con.run('COMMIT');
    } catch (e) {
      await con.run('ROLLBACK').catch(() => undefined);
      throw e;
    }
    const [summary] = await rows<{ groups: string; records: string; devices: string }>(con, `
      SELECT count(DISTINCT consumer_id) AS groups, count(*) AS records, (SELECT count(*) FROM ${DEVICE_OWNER}) AS devices FROM ${IDENTITIES}`);
    return { groups: Number(summary.groups), records: Number(summary.records), devices: Number(summary.devices) };
  } finally {
    await con.run([NODES, VALUES, LABELS, NEXT].map(t => `DROP TABLE IF EXISTS ${t};`).join(' '));
  }
}
