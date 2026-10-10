// app/.server/pipeline/assertions.ts —— 内置断言（ADR-0026）：结果层任务计算前，对任务读到的标准实体检查数据质量。
// error 级的断言失败时任务失败、不登记快照（外部继续读上一版）；warn 级只记录。结果只有断言名、实体、不合格行数与比例，不带行内容。
// 每次运行给检查过的实体各追加一行到湖里的 silver._assertion_runs，行数骤降以它为基准（工作进程不连平台库）。
// 断言失败时，每条断言最多 SAMPLE_LIMIT 行不合格行的样本追加到湖里的隔离区 silver._quarantine；只从标准层取样（敏感字段只有哈希，ADR-0005），行数骤降不取样。
// 读会员或积分流水时另跑两条积分 warn：余额与流水对账、流水余额断档
import type { DuckDBConnection } from '@duckdb/node-api';
import { entityOf } from '../../lib/canonical-model';
import { ASSERTION_RUNS, QUARANTINE } from './lake-schemas';
import { lit } from './merge-engine';
import { PartialFailure } from './partial-failure';

/** error 失败时阻断任务，warn 只记录 */
export type AssertionLevel = 'error' | 'warn';

export interface AssertionResult {
  name: string;
  level: AssertionLevel;
  entity: string;
  /** 不合格的行数 */
  failed: number;
  /** 检查了哪些字段 */
  detail?: string;
  /** order_customer_link：关联得上消费者的订单比例 */
  ratio?: number;
  /** order_customer_link：关联不上消费者的订单数（customer_id 为空也算） */
  orphans?: number;
  /** row_drop：本次运行时的行数 */
  rows?: number;
  /** row_drop：该实体上一次运行时的行数 */
  previous?: number;
}

export const ASSERTION_LABELS: Record<string, string> = {
  primary_key_unique: '主键唯一',
  amount_non_negative: '金额非负',
  order_customer_link: '订单关联消费者',
  row_drop: '行数骤降',
  points_balance: '积分余额对账',
  points_chain: '积分流水断档',
};

/** 订单关联得上消费者的比例低于它时告警 */
const MIN_ORDER_LINK_RATIO = 0.8;
/** 行数少于上一次运行的这个比例时告警 */
const MIN_ROW_RATIO = 0.5;
/** 每条失败的断言最多写进隔离区的行数 */
export const SAMPLE_LIMIT = 100;

/** 各实体的金额字段 */
const AMOUNT_FIELDS: Record<string, string[]> = {
  order: ['amount'],
  order_item: ['amount', 'unit_price'],
  product: ['price'],
};

/** 同一会员的流水按时间排序；同一时刻再按 id 的数值排（id 是字符串，'10' 会排在 '2' 前面） */
const POINTS_ORDER = 'occurred_at, TRY_CAST(points_transaction_id AS BIGINT), points_transaction_id';

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];

/**
 * 判重的键：标准模型的主键。customer 不跨映射查独占（ADR-0024），按数据源判重；主键含指向 customer 的字段时同样按数据源判重。
 * 有 _key_space 列时也并进键。自定义实体在工作进程里不知道主键，不检查
 */
function uniqueKey(entity: string, columns: Set<string>) {
  const model = entityOf(entity);
  if (!model || !model.key.every(k => columns.has(k))) return undefined;
  const bySource = entity === 'customer' || model.key.some(k => model.fields.find(f => f.name === k)?.ref?.entity === 'customer');
  return [...model.key, ...(bySource && columns.has('_source') ? ['_source'] : []), ...(columns.has('_key_space') ? ['_key_space'] : [])];
}

/**
 * 对这些实体里在标准层存在的表跑内置断言：主键唯一（主键为空的行不算重复）、金额非负（error）；订单关联消费者的比例、
 * 行数比该实体上一次运行少一半以上（warn，首次运行没有基准不报）。之后给检查过的实体各追加一行运行记录，记在任务 taskId 名下
 */
export async function runAssertions(con: DuckDBConnection, entities: readonly string[], taskId: string): Promise<AssertionResult[]> {
  const columns = new Map<string, Set<string>>();
  for (const c of await rows<{ entity: string; name: string }>(con, `
    SELECT table_name AS entity, column_name AS name FROM information_schema.columns
    WHERE table_catalog = 'lake' AND table_schema = 'silver' AND table_name IN (${[...entities, 'customer', 'membership', 'points_transaction'].map(lit).join(', ')})`)) {
    columns.set(c.entity, (columns.get(c.entity) ?? new Set()).add(c.name));
  }
  const results: AssertionResult[] = [];
  /** 断言 → 取出它不合格行的 SELECT（未加 LIMIT） */
  const samples = new Map<AssertionResult, string>();
  const rowCounts = new Map<string, number>();
  for (const entity of entities) {
    const present = columns.get(entity);
    if (!present) continue;
    const table = `silver.${ident(entity)}`;
    const [{ n: total }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM ${table}`);
    const rowCount = Number(total);
    rowCounts.set(entity, rowCount);
    const key = uniqueKey(entity, present);
    if (key) {
      const modelKey = entityOf(entity)!.key;
      const [{ n }] = await rows<{ n: string }>(con, `
        SELECT coalesce(sum(n), 0) AS n FROM (
          SELECT count(*) AS n FROM ${table} WHERE ${modelKey.map(k => `${ident(k)} IS NOT NULL`).join(' AND ')}
          GROUP BY ${key.map(ident).join(', ')} HAVING count(*) > 1)`);
      const result: AssertionResult = { name: 'primary_key_unique', level: 'error', entity, failed: Number(n), detail: key.join(', ') };
      results.push(result);
      samples.set(result, `
        SELECT t.* FROM ${table} t SEMI JOIN (
          SELECT ${key.map(ident).join(', ')} FROM ${table} WHERE ${modelKey.map(k => `${ident(k)} IS NOT NULL`).join(' AND ')}
          GROUP BY ${key.map(ident).join(', ')} HAVING count(*) > 1) d
        ON ${key.map(k => `t.${ident(k)} IS NOT DISTINCT FROM d.${ident(k)}`).join(' AND ')}`);
    }
    const amounts = (AMOUNT_FIELDS[entity] ?? []).filter(f => present.has(f));
    if (amounts.length) {
      const negative = `SELECT * FROM ${table} WHERE ${amounts.map(f => `${ident(f)} < 0`).join(' OR ')}`;
      const [{ n }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM (${negative})`);
      const result: AssertionResult = { name: 'amount_non_negative', level: 'error', entity, failed: Number(n), detail: amounts.join(', ') };
      results.push(result);
      samples.set(result, negative);
    }
    const customer = columns.get('customer');
    if (entity === 'order' && present.has('customer_id') && customer?.has('customer_id')) {
      const bySource = present.has('_source') && customer.has('_source');
      const result = await orderCustomerLink(con, bySource);
      results.push(result);
      samples.set(result, `
        SELECT f.* FROM silver."order" f ANTI JOIN (SELECT DISTINCT customer_id AS k${bySource ? ', _source' : ''} FROM silver.customer) t
          ON f.customer_id = t.k${bySource ? ' AND f._source = t._source' : ''}`);
    }
    const [lastRun] = await rows<{ rows: string }>(con, `SELECT rows FROM ${ASSERTION_RUNS} WHERE entity = ${lit(entity)} ORDER BY "at" DESC LIMIT 1`);
    if (lastRun) {
      const previous = Number(lastRun.rows);
      results.push({ name: 'row_drop', level: 'warn', entity, failed: rowCount < previous * MIN_ROW_RATIO ? previous - rowCount : 0, rows: rowCount, previous });
    }
  }
  const membership = columns.get('membership');
  const pointsTx = columns.get('points_transaction');
  if ((entities.includes('membership') || entities.includes('points_transaction'))
    && membership && ['membership_id', 'points'].every(c => membership.has(c))
    && pointsTx && ['membership_id', 'points_change', 'balance_after', 'occurred_at'].every(c => pointsTx.has(c))) {
    for (const [result, sample] of await pointsAssertions(con)) {
      results.push(result);
      samples.set(result, sample);
    }
  }
  await recordRuns(con, taskId, rowCounts, results);
  await writeQuarantine(con, taskId, samples);
  return results;
}

/**
 * 把每条失败断言的不合格行（最多 SAMPLE_LIMIT 行）追加进隔离区（表在初始化数据湖时建好）。
 * 每行记断言、级别、实体、标准模型主键（多列用逗号连接）、整行 JSON、任务与时间
 */
async function writeQuarantine(con: DuckDBConnection, taskId: string, samples: ReadonlyMap<AssertionResult, string>) {
  for (const [r, sample] of samples) {
    if (!r.failed) continue;
    const key = entityOf(r.entity)!.key.map(k => `s.${ident(k)}::VARCHAR`).join(`, ',', `);
    await con.run(`
      INSERT INTO ${QUARANTINE}
      SELECT ${lit(r.name)}, ${lit(r.level)}, ${lit(r.entity)}, concat(${key}), to_json(s), ${lit(taskId)}, now()
      FROM (${sample} ORDER BY ALL LIMIT ${SAMPLE_LIMIT}) s`);
  }
}

/** 给检查过的实体各追加一行运行记录：行数与这个实体的断言结果 */
async function recordRuns(con: DuckDBConnection, taskId: string, rowCounts: ReadonlyMap<string, number>, results: readonly AssertionResult[]) {
  for (const [entity, rowCount] of rowCounts) {
    const json = JSON.stringify(results.filter(r => r.entity === entity));
    await con.run(`INSERT INTO ${ASSERTION_RUNS} VALUES (${lit(taskId)}, ${lit(entity)}, ${rowCount}, ${lit(json)}::JSON, now())`);
  }
}

/** 订单里 customer_id 非空且在 silver.customer 里找得到（按数据源找，同 relationStats）的比例；customer_id 为空的订单也算关联不上（orphans）。低于阈值时把关联不上的订单数记为不合格 */
async function orderCustomerLink(con: DuckDBConnection, bySource: boolean): Promise<AssertionResult> {
  const [{ total, linked }] = await rows<{ total: string; linked: string }>(con, `
    SELECT count(*) AS total, count(t.k) AS linked FROM silver."order" f
    LEFT JOIN (SELECT DISTINCT customer_id AS k${bySource ? ', _source' : ''} FROM silver.customer) t
      ON f.customer_id = t.k${bySource ? ' AND f._source = t._source' : ''}`);
  const orphans = Number(total) - Number(linked);
  const ratio = Number(total) ? Number(linked) / Number(total) : 1;
  return { name: 'order_customer_link', level: 'warn', entity: 'order', failed: ratio < MIN_ORDER_LINK_RATIO ? orphans : 0, ratio: Math.round(ratio * 10000) / 10000, orphans };
}

/**
 * 积分的两条 warn 断言（membership 与 points_transaction 都在标准层时）。
 * points_balance：membership.points 与流水 points_change 之和（没有流水时为 0）、或按时间最后一笔的 balance_after（为空不比）不相等的会员数；
 * diff 是余额减流水求和，求和对得上时是余额减最后一笔余额，detail 带会员数与 |diff| 合计。
 * points_chain：同一会员按时间排序后 balance_after 不等于上一笔 balance_after + points_change 的流水数（每会员第一笔、余额为空的不查）
 */
async function pointsAssertions(con: DuckDBConnection): Promise<[AssertionResult, string][]> {
  const balance = `
    SELECT m.membership_id, m.points, coalesce(t.sum_change, 0) AS sum_change, t.last_balance,
      CASE WHEN m.points <> coalesce(t.sum_change, 0) THEN m.points - coalesce(t.sum_change, 0) ELSE m.points - t.last_balance END AS diff
    FROM silver.membership m LEFT JOIN (
      SELECT membership_id, sum(points_change)::BIGINT AS sum_change, arg_max_null(balance_after, (${POINTS_ORDER})) AS last_balance
      FROM silver.points_transaction WHERE membership_id IS NOT NULL GROUP BY membership_id) t USING (membership_id)
    WHERE m.points <> coalesce(t.sum_change, 0) OR m.points <> t.last_balance`;
  const chain = `
    SELECT * FROM (
      SELECT *, lag(balance_after) OVER (PARTITION BY membership_id ORDER BY ${POINTS_ORDER}) AS previous_balance
      FROM silver.points_transaction WHERE membership_id IS NOT NULL)
    WHERE balance_after <> previous_balance + points_change`;
  const [{ n, total }] = await rows<{ n: string; total: string }>(con, `SELECT count(*) AS n, coalesce(sum(abs(diff)), 0)::BIGINT AS total FROM (${balance})`);
  const [{ n: broken }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM (${chain})`);
  return [
    [{ name: 'points_balance', level: 'warn', entity: 'membership', failed: Number(n), detail: `${n} 个会员不一致，差额合计 ${total}` }, balance],
    [{ name: 'points_chain', level: 'warn', entity: 'points_transaction', failed: Number(broken), detail: 'balance_after' }, chain],
  ];
}

/** 失败的 error 级断言 */
export const failedErrors = (results: readonly AssertionResult[]) => results.filter(r => r.level === 'error' && r.failed > 0);

/** 一条断言失败的摘要：断言名、实体与不合格行数 */
export const describeAssertion = (r: AssertionResult) => `${ASSERTION_LABELS[r.name] ?? r.name}（silver.${r.entity}，${r.failed} 行不合格）`;

/** 有 error 级断言失败时让任务失败（不写结果、不登记快照），结果里带全部断言 */
export function assertOrThrow(results: AssertionResult[]) {
  const failed = failedErrors(results);
  if (failed.length) throw new PartialFailure(`断言失败：${failed.map(describeAssertion).join('；')}`, { assertions: results });
}
