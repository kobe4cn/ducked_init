// app/.server/pipeline/identity-engine.ts —— 身份打通：把本租户各数据源的 customer 记录按确定性规则归并为统一消费者，
// 结果整表写进 silver._identities(_source, customer_id, consumer_id)。在合并到标准层之后、工作进程里运行。
// 一条源记录的身份是 (_source, customer_id)（customer_id 只在一个数据源内唯一，两者有一个为空的行不参与）。规则是按优先级排列的匹配字段，
// 比的是标准层里敏感字段的哈希（哈希前已规范化，空值不参与）：两条记录在某个匹配字段上相等、且在每个更高优先级的字段上不冲突
// （冲突是双方都有值、没有一个相同）时相连；之后取传递闭包：A-B 手机相同、B-C 邮箱相同，则 A、B、C 是同一个消费者。
// 匹配规则由各 customer 映射配置（identityRules），都没配置时用平台默认规则。
// 统一消费者 ID 分配后固定（ADR-0029）：新算出的组对照上一版 _identities 沿用旧 ID，每个旧 ID 留给原成员最多的组，
// 一组继承多个旧 ID 时留分配最早的、其余记 merge 并退役，没分到旧 ID 的组从原 ID 拆出、记 split；
// 全新的组取组内最小的 (_source, customer_id) 再哈希（与敏感字段的哈希无关），撞上分配过的 ID 时加盐重算。
// 分配表 silver._consumer_ids 与变更表 silver._consumer_id_changes 和 _identities 在同一个事务里写入。
// 之后由 silver.event 的登录事件求设备归属，整表写进 silver._device_owner(device_id, consumer_id, login_at)：
// 每台登录过的设备归属到它全局最近一次登录的统一消费者（登录事件的 customer_id 只在它自己的 _source 内解析），
// 同一时刻并列时取较小的 consumer_id；匿名事件（customer_id 为空）经 device_id 对应到统一消费者。
// 最后整表写出 silver._consumer：每个统一消费者一行，customer 的每个非敏感属性取一个存活值并记下来源 <列>__source（ADR-0027），
// 与 silver._consumer_consent：每个统一消费者每个渠道一行，取各源里 updated_at 最新的同意状态，同一时刻撤回优先，记下来源 _source
import type { DuckDBConnection } from '@duckdb/node-api';
import { entityOf } from '../../lib/canonical-model';
import { SILVER_SYSTEM_COLUMNS, tableExists } from './merge-engine';

/** 默认的匹配规则：按优先级是手机号、邮箱、外部 ID 的哈希精确相等 */
export const DEFAULT_RULES: readonly string[] = ['phone', 'email', 'external_id'];

/**
 * 租户的匹配规则：各 customer 映射里配置的匹配字段必须一致（没配置的映射不参与），都没配置时是默认规则。
 * 不一致时抛错，说明是哪些映射；mappingName 给出映射在报错里的叫法
 */
export function identityRules<P extends { entity: string; identity?: { match: string[] } }>(plans: P[], mappingName: (plan: P) => string): readonly string[] {
  const configured = plans.filter(p => p.entity === 'customer' && p.identity);
  const [first] = configured;
  const other = configured.find(p => p.identity!.match.join() !== first.identity!.match.join());
  if (other) {
    const show = (p: P) => `${mappingName(p)}（${p.identity!.match.join(' > ')}）`;
    throw new Error(`消费者映射的身份打通匹配规则不一致：${show(first)}、${show(other)}；请改成一致，或只在一个映射里配置`);
  }
  return first ? first.identity!.match : DEFAULT_RULES;
}

/** 不进 _consumer 的敏感字段：各 customer 映射里标成敏感的列（标准模型的敏感字段 resolveIdentities 总是排除） */
export const consumerSensitive = <P extends { entity: string; columns: { name: string; sensitive?: boolean }[] }>(plans: P[]): string[] =>
  [...new Set(plans.filter(p => p.entity === 'customer').flatMap(p => p.columns.filter(c => c.sensitive).map(c => c.name)))].sort();

/** 登录事件的事件类型，先写死，还不能配置 */
export const LOGIN_EVENT = 'login';

/** 一次打通的摘要：统一消费者（组）数、参与打通的源记录数、已归属的设备数，以及本次记下的 ID 合并与拆开数 */
export interface IdentitySummary { groups: number; records: number; devices: number; merged: number; split: number }

export const IDENTITIES = 'silver._identities';
export const DEVICE_OWNER = 'silver._device_owner';
export const CONSUMER = 'silver._consumer';
export const CONSUMER_CONSENT = 'silver._consumer_consent';
export const CONSUMER_IDS = 'silver._consumer_ids';
export const CONSUMER_ID_CHANGES = 'silver._consumer_id_changes';
const CUSTOMER = 'silver."customer"';
const EVENT = 'silver."event"';
const CONSENT = 'silver."consent"';
const NODES = 'stage.identity_nodes';
const VALUES = 'stage.identity_values';
const WIDE = 'stage.identity_wide';
const EDGES = 'stage.identity_edges';
const LABELS = 'stage.identity_labels';
const NEXT = 'stage.identity_next';
const OLD_IDS = 'stage.identity_old_ids';
const OVERLAP = 'stage.identity_overlap';
const OWNER = 'stage.identity_owner';
const ASSIGNED = 'stage.identity_assigned';
const CHANGES = 'stage.identity_changes';
const NEXT_IDS = 'stage.identity_next_ids';

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];

/** resolveIdentities 的选项 */
export interface IdentityOptions {
  /** 属性存活的数据源优先级：映射 ID → 名次，越小越优先，没配的排最后；为空时只按 updated_at 取最新 */
  priority?: Record<string, number>;
  /** 另外不进 _consumer 的敏感字段（映射里标成敏感的 x_ 字段，见 consumerSensitive）；标准模型的敏感字段总是不进 */
  sensitive?: readonly string[];
}

/**
 * 由 silver.customer 整表重算身份打通，再由 silver.event（不存在时没有设备归属）求设备归属与统一消费者的属性，
 * 再由 silver.consent（不存在时是空表）求统一消费者的同意，
 * 在一个事务里覆盖写入 silver._identities、silver._device_owner、silver._consumer 与 silver._consumer_consent。silver.customer 必须存在；
 * 表里还没有的规则字段（早先发布的映射建的表没有新加的字段）跳过。中间结果在会话的本机库 stage 里算好，
 * 事务里只写数据湖（DuckDB 一个事务只能写一个库）
 */
export async function resolveIdentities(
  con: DuckDBConnection, rules: readonly string[] = DEFAULT_RULES, opts: IdentityOptions = {},
): Promise<IdentitySummary> {
  const described = (await rows<{ column_name: string }>(con, `DESCRIBE ${CUSTOMER}`)).map(c => c.column_name);
  const columns = new Set(described);
  const sensitive = new Set([...entityOf('customer')!.fields.filter(f => f.pii).map(f => f.name), ...opts.sensitive ?? []]);
  // 属性列：除系统列、customer_id 与敏感字段以外的列
  const notAttributes = new Set([...Object.keys(SILVER_SYSTEM_COLUMNS), 'customer_id', ...sensitive]);
  const attributes = described.filter(c => !notAttributes.has(c));
  const used = rules.filter(r => columns.has(r));
  const hasEvent = await tableExists(con, 'silver', 'event');
  const hasConsent = await tableExists(con, 'silver', 'consent');
  const hasIdentities = await tableExists(con, 'silver', IDENTITIES.split('.')[1]);
  const hasIds = await tableExists(con, 'silver', CONSUMER_IDS.split('.')[1]);
  const nowSql = `${lit(new Date().toISOString())}::TIMESTAMPTZ`;
  try {
    // 每条源记录一个编号，按 (_source, customer_id) 排序，组里最小的编号就是组里最小的源记录
    await con.run(`CREATE OR REPLACE TABLE ${NODES} AS
      SELECT _source, customer_id, row_number() OVER (ORDER BY _source, customer_id) AS node
      FROM (SELECT DISTINCT _source, customer_id FROM ${CUSTOMER} WHERE _source IS NOT NULL AND customer_id IS NOT NULL)`);
    await con.run(`CREATE OR REPLACE TABLE ${VALUES} AS SELECT DISTINCT * FROM (${used.length
      ? used.map(r => `SELECT n.node, ${lit(r)} AS rule, c.${ident(r)} AS value FROM ${CUSTOMER} c
          JOIN ${NODES} n ON n._source = c._source AND n.customer_id = c.customer_id WHERE c.${ident(r)} IS NOT NULL`).join(' UNION ALL ')
      : `SELECT NULL::BIGINT AS node, NULL::VARCHAR AS rule, NULL::VARCHAR AS value LIMIT 0`})`);
    // 每条记录在各匹配字段上的取值（排好序的列表，没有值时为空）：c0 是最高优先级的字段
    const col = (j: number) => `c${j}`;
    await con.run(`CREATE OR REPLACE TABLE ${WIDE} AS SELECT node${used.map((r, j) => `,
      CASE WHEN count(*) FILTER (WHERE rule = ${lit(r)}) > 0 THEN list_sort(list(DISTINCT value) FILTER (WHERE rule = ${lit(r)})) END AS ${col(j)}`).join('')}
      FROM ${VALUES} GROUP BY node`);
    // 第 i 个字段上的边：同一个取值、更高优先级字段的取值也完全相同的记录是一类，彼此都不冲突，连到类里最小的记录；
    // 同一个取值的不同类之间，在更高优先级字段上不冲突时，两类的代表相连。这样边数随记录数线性增长，只有类与类之间成对比较
    await con.run(`CREATE OR REPLACE TABLE ${EDGES} (a BIGINT, b BIGINT)`);
    for (const [i, r] of used.entries()) {
      const higher = used.slice(0, i).map((_, j) => col(j));
      const sig = ['v.value', ...higher.map(c => `w.${c}`)].join(', ');
      const fits = higher.map(c => `NOT (x.${c} IS NOT NULL AND y.${c} IS NOT NULL AND NOT list_has_any(x.${c}, y.${c}))`);
      await con.run(`INSERT INTO ${EDGES}
        WITH m AS (SELECT v.node, v.value${higher.map(c => `, w.${c}`).join('')}, min(v.node) OVER (PARTITION BY ${sig}) AS rep
          FROM ${VALUES} v JOIN ${WIDE} w USING (node) WHERE v.rule = ${lit(r)}),
        reps AS (SELECT DISTINCT rep, value${higher.map(c => `, ${c}`).join('')} FROM m)
        SELECT node, rep FROM m WHERE node <> rep${higher.length ? `
        UNION ALL SELECT x.rep, y.rep FROM reps x JOIN reps y ON x.value = y.value AND x.rep < y.rep WHERE ${fits.join(' AND ')}` : ''}`);
    }
    await con.run(`INSERT INTO ${EDGES} SELECT b, a FROM ${EDGES}`);
    // 标签传播到不动点：每条记录取相连记录里最小的标签，再取自己标签那条记录的标签（跳跃，收敛更快）
    await con.run(`CREATE OR REPLACE TABLE ${LABELS} AS SELECT node, node AS label FROM ${NODES}`);
    for (;;) {
      await con.run(`CREATE OR REPLACE TABLE ${NEXT} AS
        WITH near AS (SELECT e.a AS node, min(l.label) AS label FROM ${EDGES} e JOIN ${LABELS} l ON l.node = e.b GROUP BY ALL)
        SELECT l.node, least(l.label, coalesce(n.label, l.label), j.label) AS label
        FROM ${LABELS} l LEFT JOIN near n USING (node) JOIN ${LABELS} j ON j.node = l.label`);
      const [{ changed }] = await rows<{ changed: string }>(con, `
        SELECT count(*) AS changed FROM ${NEXT} x JOIN ${LABELS} l USING (node) WHERE x.label <> l.label`);
      await con.run(`CREATE OR REPLACE TABLE ${LABELS} AS SELECT * FROM ${NEXT}`);
      if (!Number(changed)) break;
    }
    await assignIds(con, hasIdentities, hasIds, nowSql);

    await con.run('BEGIN');
    try {
      await con.run(`CREATE TABLE IF NOT EXISTS ${IDENTITIES} (_source VARCHAR, customer_id VARCHAR, consumer_id VARCHAR)`);
      await con.run(`DELETE FROM ${IDENTITIES}`);
      await con.run(`INSERT INTO ${IDENTITIES}
        SELECT n._source, n.customer_id, a.consumer_id
        FROM ${NODES} n JOIN ${LABELS} l USING (node) JOIN ${ASSIGNED} a USING (label)
        ORDER BY n._source, n.customer_id`);
      await con.run(`CREATE TABLE IF NOT EXISTS ${CONSUMER_IDS} (consumer_id VARCHAR, assigned_at TIMESTAMPTZ, retired_at TIMESTAMPTZ)`);
      await con.run(`DELETE FROM ${CONSUMER_IDS}`);
      await con.run(`INSERT INTO ${CONSUMER_IDS} SELECT * FROM ${NEXT_IDS} ORDER BY consumer_id`);
      await con.run(`CREATE TABLE IF NOT EXISTS ${CONSUMER_ID_CHANGES} (old_id VARCHAR, new_id VARCHAR, reason VARCHAR, changed_at TIMESTAMPTZ)`);
      await con.run(`INSERT INTO ${CONSUMER_ID_CHANGES} SELECT old_id, new_id, reason, ${nowSql} FROM ${CHANGES} ORDER BY reason, old_id, new_id`);
      await con.run(`CREATE TABLE IF NOT EXISTS ${DEVICE_OWNER} (device_id VARCHAR, consumer_id VARCHAR, login_at TIMESTAMPTZ)`);
      await con.run(`DELETE FROM ${DEVICE_OWNER}`);
      if (hasEvent) {
        await con.run(`INSERT INTO ${DEVICE_OWNER}
          SELECT e.device_id, i.consumer_id, e.occurred_at AS login_at
          FROM ${EVENT} e JOIN ${IDENTITIES} i ON i._source = e._source AND i.customer_id = e.customer_id
          WHERE e.event_type = ${lit(LOGIN_EVENT)} AND e.device_id IS NOT NULL AND e.occurred_at IS NOT NULL
          QUALIFY row_number() OVER (PARTITION BY e.device_id ORDER BY e.occurred_at DESC, i.consumer_id) = 1
          ORDER BY e.device_id`);
      }
      // 每个属性取排序最前的非空值（名次、updated_at 新的在前，再按 (_source, customer_id) 定序），来源取同一行的 _source
      const ranks = Object.entries(opts.priority ?? {});
      const order = [
        ...(ranks.length ? [`CASE c._mapping ${ranks.map(([m, r]) => `WHEN ${lit(m)} THEN ${Number(r)}`).join(' ')} END ASC NULLS LAST`] : []),
        ...(columns.has('updated_at') ? ['c.updated_at DESC NULLS LAST'] : []),
        'c._source', 'c.customer_id',
      ].join(', ');
      await con.run(`CREATE OR REPLACE TABLE ${CONSUMER} AS
        SELECT i.consumer_id${attributes.map(a => `,
          first(c.${ident(a)} ORDER BY ${order}) FILTER (WHERE c.${ident(a)} IS NOT NULL) AS ${ident(a)},
          first(c._source ORDER BY ${order}) FILTER (WHERE c.${ident(a)} IS NOT NULL) AS ${ident(`${a}__source`)}`).join('')}
        FROM ${CUSTOMER} c JOIN ${IDENTITIES} i ON i._source = c._source AND i.customer_id = c.customer_id
        GROUP BY i.consumer_id ORDER BY i.consumer_id`);
      // 同意只按时间，不看数据源名次：updated_at 新的在前，同一时刻撤回在前，再按 (_source, customer_id) 定序
      await con.run(`CREATE OR REPLACE TABLE ${CONSUMER_CONSENT} (consumer_id VARCHAR, channel VARCHAR, status VARCHAR, updated_at TIMESTAMPTZ, _source VARCHAR)`);
      if (hasConsent) {
        await con.run(`INSERT INTO ${CONSUMER_CONSENT}
          SELECT i.consumer_id, c.channel, c.status, c.updated_at, c._source
          FROM ${CONSENT} c JOIN ${IDENTITIES} i ON i._source = c._source AND i.customer_id = c.customer_id
          WHERE c.channel IS NOT NULL
          QUALIFY row_number() OVER (PARTITION BY i.consumer_id, c.channel
            ORDER BY c.updated_at DESC NULLS LAST, (c.status = 'revoked') DESC NULLS LAST, c._source, c.customer_id) = 1
          ORDER BY i.consumer_id, c.channel`);
      }
      await con.run('COMMIT');
    } catch (e) {
      await con.run('ROLLBACK').catch(() => undefined);
      throw e;
    }
    const [summary] = await rows<{ groups: string; records: string; devices: string; merged: string; split: string }>(con, `
      SELECT count(DISTINCT consumer_id) AS groups, count(*) AS records, (SELECT count(*) FROM ${DEVICE_OWNER}) AS devices,
        (SELECT count(*) FROM ${CHANGES} WHERE reason = 'merge') AS merged, (SELECT count(*) FROM ${CHANGES} WHERE reason = 'split') AS split
      FROM ${IDENTITIES}`);
    return {
      groups: Number(summary.groups), records: Number(summary.records), devices: Number(summary.devices),
      merged: Number(summary.merged), split: Number(summary.split),
    };
  } finally {
    await con.run([NODES, VALUES, WIDE, EDGES, LABELS, NEXT, OLD_IDS, OVERLAP, OWNER, ASSIGNED, CHANGES, NEXT_IDS]
      .map(t => `DROP TABLE IF EXISTS ${t};`).join(' '));
  }
}

/**
 * 在 stage 里给新算出的每个组（LABELS 的 label，即组里最小的 node）选定统一消费者 ID：对照上一版 _identities，
 * 每个旧 ID 只留给原成员最多的组（平局取 label 小的，即含最小源记录的组）；一组继承多个旧 ID 时留 assigned_at 最早的
 * （平局取较小的 ID），其余记 merge 并退役；没分到旧 ID 的组取新 ID，从它含有的每个旧 ID 拆出、记 split。
 * 结果是 ASSIGNED(label, consumer_id)、CHANGES(old_id, new_id, reason) 与写回分配表的全部行 NEXT_IDS。
 * 分配表不存在时用上一版 _identities 播种（原 ID 全部保留，不记变更）。必须在写 _identities 的事务之前调用
 */
/** 新组的 ID：组内最小源记录（m）的哈希，salt 大于 0 时在哈希输入后加盐 */
const freshId = (salt: string) => `sha256(m._source || chr(31) || m.customer_id${salt === '0' ? '' : ` || chr(31) || (${salt})`})`;

async function assignIds(con: DuckDBConnection, hasIdentities: boolean, hasIds: boolean, nowSql: string) {
  await con.run(`CREATE OR REPLACE TABLE ${OLD_IDS} AS ${hasIds
    ? `SELECT consumer_id, assigned_at, retired_at FROM ${CONSUMER_IDS}`
    : hasIdentities
      ? `SELECT DISTINCT consumer_id, ${nowSql} AS assigned_at, NULL::TIMESTAMPTZ AS retired_at FROM ${IDENTITIES}`
      : `SELECT NULL::VARCHAR AS consumer_id, NULL::TIMESTAMPTZ AS assigned_at, NULL::TIMESTAMPTZ AS retired_at LIMIT 0`}`);
  // 每个新组与每个旧 ID 重叠的源记录数
  await con.run(`CREATE OR REPLACE TABLE ${OVERLAP} AS ${hasIdentities
    ? `SELECT l.label, i.consumer_id AS old_id, count(*) AS n
      FROM ${NODES} n JOIN ${LABELS} l USING (node) JOIN ${IDENTITIES} i ON i._source = n._source AND i.customer_id = n.customer_id
      GROUP BY ALL`
    : `SELECT NULL::BIGINT AS label, NULL::VARCHAR AS old_id, NULL::BIGINT AS n LIMIT 0`}`);
  // 每个旧 ID 归属的新组；组内按 assigned_at、ID 排名，第一名存活
  await con.run(`CREATE OR REPLACE TABLE ${OWNER} AS
    SELECT label, old_id, row_number() OVER (PARTITION BY label ORDER BY o.assigned_at NULLS LAST, old_id) AS rank
    FROM (SELECT * FROM ${OVERLAP} QUALIFY row_number() OVER (PARTITION BY old_id ORDER BY n DESC, label) = 1) w
    LEFT JOIN ${OLD_IDS} o ON o.consumer_id = w.old_id`);
  // 没分到旧 ID 的组先取组内最小源记录的哈希，撞上分配过的 ID 就在哈希输入后加盐重算
  await con.run(`CREATE OR REPLACE TABLE ${ASSIGNED} AS
    SELECT label, old_id AS consumer_id, false AS fresh, 0 AS salt FROM ${OWNER} WHERE rank = 1
    UNION ALL
    SELECT l.label, ${freshId('0')}, true, 0
    FROM (SELECT DISTINCT label FROM ${LABELS}) l JOIN ${NODES} m ON m.node = l.label
    WHERE l.label NOT IN (SELECT label FROM ${OWNER})`);
  for (;;) {
    const clash = `fresh AND consumer_id IN (SELECT consumer_id FROM ${OLD_IDS})`;
    const [{ clashes }] = await rows<{ clashes: string }>(con, `SELECT count(*) AS clashes FROM ${ASSIGNED} WHERE ${clash}`);
    if (!Number(clashes)) break;
    await con.run(`UPDATE ${ASSIGNED} a SET salt = a.salt + 1,
      consumer_id = ${freshId('a.salt + 1')} FROM ${NODES} m WHERE m.node = a.label AND ${clash}`);
  }
  await con.run(`CREATE OR REPLACE TABLE ${CHANGES} AS
    SELECT w.old_id, a.consumer_id AS new_id, 'merge' AS reason FROM ${OWNER} w JOIN ${ASSIGNED} a USING (label) WHERE w.rank > 1
    UNION ALL
    SELECT v.old_id, a.consumer_id, 'split' FROM ${OVERLAP} v JOIN ${ASSIGNED} a USING (label) WHERE a.fresh`);
  await con.run(`CREATE OR REPLACE TABLE ${NEXT_IDS} AS
    SELECT consumer_id, assigned_at,
      CASE WHEN consumer_id IN (SELECT old_id FROM ${CHANGES} WHERE reason = 'merge') THEN ${nowSql} ELSE retired_at END AS retired_at
    FROM ${OLD_IDS}
    UNION ALL
    SELECT consumer_id, ${nowSql}, NULL FROM ${ASSIGNED} WHERE fresh`);
}
