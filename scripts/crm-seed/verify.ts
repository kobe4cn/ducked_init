// scripts/crm-seed/verify.ts —— 拿真值（out/truth.duckdb）核对一个 crmlab 租户：身份打通、设备归属、标准层各实体的行数与金额、每个指标与标签的最新快照。
// 期望值不经过平台的编译器：按真值里的订单、积分、行为等独立计算，窗口用每张快照自己的 asOf。指标里的人按真值的「期望消费者」（expected_identity
// 的组）对应到平台的统一消费者 ID，打通错了指标也会对不上。
// 指标与标签只核对 definitions/ 里有的键，且平台上这一版的定义要与 definitions/ 里的一致（注释不算），否则跳过并说明；标签的规则取平台上这一版的。
// 已知缺口照平台现在的口径算期望，另外单独列出差距：匿名事件不计入设备主人（#154）。
// 千万级时不往 JS 里搬数据：自己的 DuckDB 只读挂载租户的数据湖（与 openTenantLake 同样的 ATTACH），同时挂上真值库，全部比对在 SQL 里做。
// 用法：node --env-file=.env --import tsx scripts/crm-seed/verify.ts <租户> [--only identity,silver,metrics] [--set 10m]
// 数据源须按 README 的名字登记：pos_mysql、mall_pg、loyalty_pg、oms_mongo、tmall_s3、douyin_s3、events_s3、activity_s3、wecom_duckdb
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { DuckDBInstance } from '@duckdb/node-api';
import pg from 'pg';
import { parse } from 'yaml';
import { closeDb } from '../../app/.server/db/client';
import { lakeReady, lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { tenantIdBySlug } from '../../app/.server/tenants';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 登记名 → 真值里的来源代码；oms_mongo 只在 K2 里临时映射，不算进期望 */
const SOURCE_CODES: Record<string, string> = {
  pos_mysql: 'pos', mall_pg: 'mall', loyalty_pg: 'loyalty', tmall_s3: 'tmall', douyin_s3: 'douyin',
  events_s3: 'events', activity_s3: 'activity', wecom_duckdb: 'wecom', oms_mongo: 'oms',
};
const PERSON_SOURCES = ['pos', 'mall', 'loyalty', 'tmall', 'douyin', 'activity', 'wecom'];

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { only: { type: 'string' }, set: { type: 'string', default: '' } } });
const slug = positionals[0];
if (!slug) throw new Error('用法：verify.ts <租户> [--only identity,silver,metrics]');
/** 数据集（seed.ts --set）：规模档的真值在 out/<set>/ */
const TRUTH = join(HERE, 'out', args.set!, 'truth.duckdb');
const step = (name: string) => !args.only || args.only.split(',').includes(name);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

const tenantId = await tenantIdBySlug(slug).catch(() => null);
if (!tenantId) throw new Error(`没有租户 ${slug}`);
const lake = await lakeRow(tenantId);
if (!lake || !lakeReady(lake)) throw new Error('数据湖没有初始化');
const spec = lakeSpecOf(lake);

const platform = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
await platform.connect();
const sources = (await platform.query<{ id: string; name: string }>(`SELECT id, name FROM platform.sources WHERE tenant_id = $1`, [tenantId])).rows
  .filter(s => SOURCE_CODES[s.name]);
type Snap = { template: string; table: string; as_of: string; version: number; yaml: string; created_at: Date };
// 每个指标与标签最新的一张未过期快照，连同它那一版的定义原文
const snaps = (await platform.query<Snap>(`
  SELECT DISTINCT ON (s.template) s.template, s."table", s.params->>'asOf' AS as_of, s.definition_version AS version, v.yaml, s.created_at
  FROM platform.snapshots s
  JOIN platform.dsl_definitions d ON d.tenant_id = s.tenant_id AND s.template = d.kind || ':' || d.key
  JOIN platform.dsl_versions v ON v.definition_id = d.id AND v.version = s.definition_version
  WHERE s.tenant_id = $1 AND s.expired_at IS NULL ORDER BY s.template, s.created_at DESC`, [tenantId])).rows;
// 标签引用的指标：平台上最新的已发布版本（标签编译时内联的就是它）
const publishedMetrics = new Map((await platform.query<{ key: string; yaml: string }>(`
  SELECT DISTINCT ON (d.key) d.key, v.yaml FROM platform.dsl_definitions d JOIN platform.dsl_versions v ON v.definition_id = d.id
  WHERE d.tenant_id = $1 AND d.kind = 'metric' AND v.status = 'published' ORDER BY d.key, v.version DESC`, [tenantId])).rows.map(r => [r.key, r.yaml]));
await platform.end();

const instance = await DuckDBInstance.create(':memory:', { memory_limit: '32GiB', threads: '8' });
const con = await instance.connect();
const q = async <T = Record<string, unknown>>(sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
const show = (title: string, data: unknown[]) => { console.log(`\n== ${title}`); if (data.length) console.table(data); else console.log('（无）'); };

try {
  await con.run(`SET TimeZone = 'UTC'; INSTALL ducklake; LOAD ducklake; INSTALL postgres; LOAD postgres; INSTALL httpfs; LOAD httpfs`);
  if (spec.s3) {
    const s = spec.s3;
    await con.run(`CREATE SECRET lake_s3 (TYPE s3, KEY_ID ${lit(s.key)}, SECRET ${lit(s.secret)}, REGION ${lit(s.region)},
      ENDPOINT ${lit(s.endpoint)}, URL_STYLE ${lit(s.urlStyle)}, USE_SSL ${s.useSsl}, SCOPE ${lit(spec.dataPath)})`);
  }
  await con.run(`ATTACH ${lit(`ducklake:postgres:${spec.catalogUrl}`)} AS lake (DATA_PATH ${lit(spec.dataPath)}, METADATA_SCHEMA ${lit(spec.catalogSchema)}, READ_ONLY)`);
  await con.run(`ATTACH ${lit(TRUTH)} AS t (READ_ONLY)`);
  const [meta] = await q<{ persons: number; data_end: string }>(`SELECT persons, data_end::VARCHAR AS data_end FROM t.meta`);
  const has = async (table: string) => (await q(`SELECT 1 FROM duckdb_tables() WHERE database_name = 'lake' AND schema_name = 'silver' AND table_name = ${lit(table)}`)).length > 0;

  await con.run(`CREATE TEMP TABLE srcmap AS SELECT * FROM (VALUES ${sources.length ? sources.map(s => `(${lit(SOURCE_CODES[s.name]!)}, ${lit(s.id)}, ${lit(s.name)})`).join(', ') : `('', '', '')`}) v(code, source_id, name)`);
  const codes = new Set(sources.map(s => SOURCE_CODES[s.name]!));
  console.log(`租户 ${slug}：真值 ${meta!.persons} 人 + 探针，数据终点 ${meta!.data_end}；已登记的数据源 ${sources.map(s => s.name).join('、') || '（无）'}`);
  const missing = PERSON_SOURCES.filter(c => !codes.has(c));
  if (missing.length) console.log(`⚠️ 没有登记 ${missing.join('、')}：期望的打通按全部数据源算，这些源上的人会显示为「被拆开」`);
  if (codes.has('oms')) console.log('⚠️ 登记了 oms_mongo：若它的订单映射还在发布状态，天猫订单会算两遍（K2）');

  // ---------- 1. 身份打通 ----------
  // 期望：真值的 expected_identity；埋点的用户档案（events_s3.users）与同一人的商城记录同组
  await con.run(`CREATE TEMP TABLE rid AS
    SELECT src, customer_id, pid, group_rid FROM t.expected_identity
    UNION ALL
    SELECT 'events', e.customer_id, e.pid, e.group_rid FROM t.expected_identity e
    WHERE e.src = 'mall' AND e.customer_id IN (SELECT customer_id FROM t.event WHERE event_type = 'login')`);
  const identities = await has('_identities');
  await con.run(`CREATE TEMP TABLE act AS ${identities
    ? `SELECT m.code AS src, i.customer_id, i.consumer_id FROM lake.silver._identities i JOIN srcmap m ON m.source_id = i._source`
    : `SELECT NULL::VARCHAR AS src, NULL::VARCHAR AS customer_id, NULL::VARCHAR AS consumer_id WHERE false`}`);
  await con.run(`CREATE TEMP TABLE j AS SELECT r.*, a.consumer_id FROM rid r LEFT JOIN act a USING (src, customer_id) WHERE r.src IN (SELECT code FROM srcmap)`);
  // 每个期望消费者（组）对应的统一消费者：取组里最小的那个（组被拆开时，其余的算到「被拆开」里）
  await con.run(`CREATE TEMP TABLE gcons AS SELECT group_rid, min(consumer_id) AS consumer_id FROM j WHERE consumer_id IS NOT NULL GROUP BY group_rid`);
  if (step('identity')) {
    if (!identities) console.log('\n标准层还没有 silver._identities（没有发布过 customer 映射）');
    show('身份打通（期望：缺失、被拆开、误合并、多出都为 0，统一消费者 = 期望消费者）', await q(`SELECT
      count(*) AS 源记录, count(*) FILTER (WHERE consumer_id IS NULL) AS 缺失,
      (SELECT count(*) FROM (SELECT group_rid FROM j WHERE consumer_id IS NOT NULL GROUP BY 1 HAVING count(DISTINCT consumer_id) > 1)) AS 被拆开,
      (SELECT count(*) FROM (SELECT consumer_id FROM j WHERE consumer_id IS NOT NULL GROUP BY 1 HAVING count(DISTINCT group_rid) > 1)) AS 误合并,
      (SELECT count(*) FROM act a WHERE a.src <> 'oms' AND NOT EXISTS (SELECT 1 FROM rid r WHERE r.src = a.src AND r.customer_id = a.customer_id)) AS 多出,
      count(DISTINCT group_rid) AS 期望消费者, count(DISTINCT consumer_id) AS 统一消费者
      FROM j`));
    show('各数据源的消费者记录', await q(`SELECT src AS 来源, count(*) AS 期望, count(consumer_id) AS 已打通 FROM j GROUP BY 1 ORDER BY 1`));
    show('探针的打通结果', await q(`SELECT j.pid, any_value(p.note) AS 说明, string_agg(DISTINCT j.src, '+' ORDER BY j.src) AS 来源,
        count(DISTINCT j.group_rid) AS 期望消费者, count(DISTINCT j.consumer_id) AS 实际消费者, left(min(j.consumer_id), 12) AS consumer_id前缀
      FROM j JOIN t.person p USING (pid) WHERE p.archetype = 'probe' GROUP BY j.pid ORDER BY j.pid`));
    const bad = await q(`SELECT consumer_id[:12] AS consumer, string_agg(DISTINCT pid::VARCHAR, ',') AS 真实的人, string_agg(src || ':' || customer_id, ' ' ORDER BY src) AS 记录
      FROM j WHERE consumer_id IN (SELECT consumer_id FROM j WHERE consumer_id IS NOT NULL GROUP BY 1 HAVING count(DISTINCT group_rid) > 1) GROUP BY 1 LIMIT 5`);
    if (bad.length) show('误合并的前 5 个', bad);

    // 设备归属：每台登录过的设备归到全局最近一次登录的人
    if (await has('_device_owner')) {
      show('设备归属（期望：不符为 0）', await q(`
        WITH last AS (SELECT device_id, arg_max(customer_id, occurred_utc) AS customer_id FROM t.event WHERE event_type = 'login' GROUP BY 1),
        e AS (SELECT l.device_id, g.consumer_id FROM last l JOIN rid r ON r.src = 'events' AND r.customer_id = l.customer_id JOIN gcons g USING (group_rid))
        SELECT count(*) AS 期望设备, count(d.device_id) AS 平台有, count(*) FILTER (WHERE d.consumer_id IS DISTINCT FROM e.consumer_id) AS 不符,
          (SELECT count(*) FROM lake.silver._device_owner) AS 平台设备数
        FROM e LEFT JOIN lake.silver._device_owner d USING (device_id)`));
    }
  }

  // ---------- 2. 标准层 ----------
  if (step('silver')) {
    const silver: { entity: string; expected: string; amount?: string }[] = [
      { entity: 'customer', expected: `SELECT src, count(*) AS n FROM rid GROUP BY 1` },
      { entity: 'order', expected: `SELECT src, count(*) AS n, sum(amount) AS amount FROM t.ord WHERE NOT coalesce(test_store, false) GROUP BY 1`, amount: 'amount' },
      { entity: 'order_item', expected: `SELECT src, count(*) AS n, sum(amount) AS amount FROM t.item GROUP BY 1`, amount: 'amount' },
      { entity: 'product', expected: `SELECT 'mall' AS src, count(*) AS n FROM t.product` },
      { entity: 'membership', expected: `SELECT 'loyalty' AS src, count(*) AS n, sum(points) AS amount FROM t.membership`, amount: 'points' },
      { entity: 'points_transaction', expected: `SELECT 'loyalty' AS src, count(*) AS n, sum(points_change) AS amount FROM t.ledger`, amount: 'points_change' },
      { entity: 'coupon', expected: `SELECT 'loyalty' AS src, count(*) AS n FROM t.coupon` },
      { entity: 'coupon_template', expected: `SELECT 'loyalty' AS src, count(*) AS n FROM t.coupon_template` },
      { entity: 'consent', expected: `SELECT src, count(*) AS n FROM t.consent GROUP BY 1` },
      { entity: 'preference', expected: `SELECT 'loyalty' AS src, count(*) AS n FROM t.preference` },
      { entity: 'event', expected: `
        SELECT 'events' AS src, count(*) AS n FROM t.event
        UNION ALL SELECT 'wecom', (SELECT count(*) FROM t.wecom_contact) + (SELECT count(deleted_utc) FROM t.wecom_contact) + (SELECT count(*) FROM t.wecom_chat)
        UNION ALL SELECT 'activity', (SELECT count(*) FROM t.signup) + (SELECT count(*) FILTER (WHERE attended) FROM t.signup)` },
      { entity: 'touch', expected: `SELECT 'wecom' AS src, count(*) AS n FROM t.wecom_send` },
      { entity: 'custom_store', expected: `SELECT 'pos' AS src, count(*) AS n FROM t.store` },
      { entity: 'custom_region', expected: `SELECT 'pos' AS src, count(*) AS n FROM t.region` },
      { entity: 'custom_guide', expected: `SELECT 'pos' AS src, count(*) AS n FROM t.guide` },
    ];
    const out: Record<string, unknown>[] = [];
    for (const s of silver) {
      const present = await has(s.entity);
      const actual = present
        ? `SELECT m.code AS src, count(*) AS n${s.amount ? `, sum(${ident(s.amount)}) AS amount` : ''} FROM lake.silver.${ident(s.entity)} x JOIN srcmap m ON m.source_id = x._source GROUP BY 1`
        : `SELECT NULL::VARCHAR AS src, 0 AS n${s.amount ? ', NULL::DOUBLE AS amount' : ''} WHERE false`;
      out.push(...await q(`
        WITH e AS (${s.expected}), a AS (${actual})
        SELECT ${lit(s.entity)} AS 实体, coalesce(e.src, a.src) AS 来源, e.n AS 期望行数, a.n AS 实际行数,
          ${s.amount ? 'round(e.amount::DOUBLE, 2) AS 期望合计, round(a.amount::DOUBLE, 2) AS 实际合计,' : 'NULL AS 期望合计, NULL AS 实际合计,'}
          CASE WHEN a.src IS NULL THEN '未映射' WHEN e.n IS DISTINCT FROM a.n ${s.amount ? 'OR abs(e.amount::DOUBLE - a.amount::DOUBLE) >= 0.01' : ''} THEN '✘' ELSE '✔' END AS 结果
        FROM e FULL JOIN a USING (src) WHERE coalesce(e.src, a.src) IN (SELECT code FROM srcmap) ORDER BY 2`));
    }
    show('标准层各实体（期望：已映射的都是 ✔；oms 只在 K2 时出现）', out);
  }

  // ---------- 3. 指标与标签 ----------
  if (step('metrics')) {
    const win = (col: string, days: number, asOf: string) => `${col}::DATE > DATE ${lit(asOf)} - ${days} AND ${col}::DATE <= DATE ${lit(asOf)}`;
    const PAID = `status IN ('paid', 'shipped', 'completed')`;
    // 每类事实对应到期望消费者，再经 gcons 到平台的统一消费者
    const facts = (table: string, src: string, key = 'customer_id', where = 'true') =>
      `(SELECT f.*, g.consumer_id FROM ${table} f JOIN rid r ON r.src = ${src} AND r.customer_id = f.${key} JOIN gcons g USING (group_rid) WHERE ${where})`;
    const orders = facts('t.ord', 'f.src', 'customer_id', 'NOT coalesce(f.test_store, false)');
    const events = facts('t.event', `'events'`);
    /** 每个指标的期望：列为 consumer_id、维度…、value；dims 是维度列名 */
    const EXPECTED: Record<string, { dims: string[]; sql: (asOf: string) => string }> = {
      revenue_365d: { dims: [], sql: a => `SELECT consumer_id, sum(amount) AS value FROM ${orders} o WHERE ${PAID} AND ${win('created_utc', 365, a)} GROUP BY 1` },
      order_count_365d: { dims: [], sql: a => `SELECT consumer_id, count(*) AS value FROM ${orders} o WHERE ${PAID} AND ${win('created_utc', 365, a)} GROUP BY 1` },
      channel_count: { dims: [], sql: a => `SELECT consumer_id, count(DISTINCT channel) AS value FROM ${orders} o WHERE ${PAID} AND ${win('created_utc', 365, a)} GROUP BY 1` },
      revenue_by_region: {
        dims: ['region'],
        sql: a => `SELECT consumer_id, coalesce(rg.name, '未关联') AS region, sum(amount) AS value
          FROM ${orders} o LEFT JOIN t.store s USING (store_id) LEFT JOIN t.region rg ON rg.region_id = s.region_id
          WHERE ${PAID} AND ${win('o.created_utc', 365, a)} GROUP BY ALL`,
      },
      revenue_by_city: {
        // 城市取下单那条消费者记录上的（天猫买家没有城市）
        dims: ['city'],
        sql: a => `SELECT consumer_id, coalesce(CASE WHEN o.src <> 'tmall' THEN nullif(c.city, '') END, '未关联') AS city, sum(amount) AS value
          FROM ${orders} o LEFT JOIN t.rec c ON c.src = o.src AND c.customer_id = o.customer_id
          WHERE ${PAID} AND ${win('o.created_utc', 365, a)} GROUP BY ALL`,
      },
      points_balance: { dims: [], sql: () => `SELECT consumer_id, sum(points_change) AS value FROM ${facts('t.ledger', `'loyalty'`)} GROUP BY 1` },
      points_earned_90d: {
        dims: [],
        sql: a => `SELECT consumer_id, sum(points_change) AS value FROM ${facts('t.ledger', `'loyalty'`)} WHERE change_type = 'earn' AND ${win('occurred_utc', 90, a)} GROUP BY 1`,
      },
      views_7d: { dims: [], sql: a => `SELECT consumer_id, count(*) AS value FROM ${events} e WHERE event_type = 'view' AND ${win('occurred_utc', 7, a)} GROUP BY 1` },
      coupons_redeemed: { dims: [], sql: () => `SELECT consumer_id, count(*) AS value FROM ${facts('t.coupon', `'loyalty'`)} WHERE status = 'redeemed' GROUP BY 1` },
      wecom_chats_30d: {
        dims: ['guide'],
        sql: a => `SELECT consumer_id, guide_id AS guide, count(*) AS value FROM ${facts('t.wecom_chat', `'wecom'`, 'external_userid')} WHERE ${win('chat_utc', 30, a)} GROUP BY ALL`,
      },
      activity_attended: { dims: [], sql: () => `SELECT consumer_id, count(*) AS value FROM ${facts('t.signup', `'activity'`, 'signup_id')} WHERE attended GROUP BY 1` },
    };
    const local = (kind: string, key: string) => {
      try { return parse(readFileSync(join(HERE, 'definitions', kind, `${key}.yaml`), 'utf8')) as Record<string, unknown>; } catch { return undefined; }
    };
    const same = (kind: string, key: string, yaml: string) => isDeepStrictEqual(parse(yaml), local(kind, key));
    const probeRows = (table: string, dims: string[]) => q(`
      SELECT p.pid, p.note AS 说明, ${dims.map(d => `coalesce(e.${ident(d)}, a.${ident(d)}) AS ${ident(d)}, `).join('')}e.value AS 期望, a.value AS 实际
      FROM t.person p JOIN (SELECT DISTINCT pid, group_rid FROM j) pj USING (pid) JOIN gcons g USING (group_rid)
      LEFT JOIN ${table}_e e USING (consumer_id) LEFT JOIN ${table}_a a ON a.consumer_id = g.consumer_id ${dims.map(d => `AND a.${ident(d)} = e.${ident(d)}`).join(' ')}
      WHERE p.archetype = 'probe' AND (e.value IS NOT NULL OR a.value IS NOT NULL) ORDER BY p.pid`);

    /** 期望表 <name>_e 与快照表 <name>_a 逐行比对 */
    async function compare(title: string, name: string, dims: string[], valueCmp: string) {
      const on = ['consumer_id', ...dims];
      const [r] = await q<Record<string, number>>(`SELECT
        (SELECT count(*) FROM ${name}_e) AS 期望行数, (SELECT count(*) FROM ${name}_a) AS 实际行数,
        count(*) FILTER (WHERE a.consumer_id IS NULL) AS 快照里缺, count(*) FILTER (WHERE e.consumer_id IS NULL) AS 快照里多,
        count(*) FILTER (WHERE e.consumer_id IS NOT NULL AND a.consumer_id IS NOT NULL AND ${valueCmp}) AS 取值不符
        FROM ${name}_e e FULL JOIN ${name}_a a USING (${on.join(', ')})`);
      const ok = Number(r!.快照里缺) === 0 && Number(r!.快照里多) === 0 && Number(r!.取值不符) === 0;
      show(`${title} ${ok ? '✔' : '✘'}`, [r]);
      if (!ok) {
        show('不符的前 5 行', await q(`SELECT consumer_id[:12] AS consumer, ${dims.map(d => `${ident(d)}, `).join('')}e.value AS 期望, a.value AS 实际
          FROM ${name}_e e FULL JOIN ${name}_a a USING (${on.join(', ')})
          WHERE e.consumer_id IS NULL OR a.consumer_id IS NULL OR ${valueCmp} LIMIT 5`));
      }
    }

    const expectedMetric = async (key: string, asOf: string, name: string) => {
      await con.run(`CREATE OR REPLACE TEMP TABLE ${name}_e AS SELECT * FROM (${EXPECTED[key]!.sql(asOf)})`);
    };
    for (const s of snaps) {
      const [kind, key] = s.template.split(':') as [string, string];
      const label = `${kind === 'metric' ? '指标' : '标签'} ${key} 第 ${s.version} 版（asOf ${s.as_of}，快照 ${s.table}）`;
      const [schema, table] = s.table.split('.') as [string, string];
      if (!(await q(`SELECT 1 FROM duckdb_tables() WHERE database_name = 'lake' AND schema_name = ${lit(schema)} AND table_name = ${lit(table)}`)).length) {
        console.log(`\n== ${label}：快照表不在数据湖里（数据湖被重置过？），跳过`);
        continue;
      }
      if (kind === 'metric') {
        if (!EXPECTED[key]) { console.log(`\n== ${label}：definitions/ 里没有，跳过`); continue; }
        if (!same('metric', key, s.yaml)) { console.log(`\n== ${label}：与 definitions/metric/${key}.yaml 不同，跳过`); continue; }
        const { dims } = EXPECTED[key];
        await expectedMetric(key, s.as_of, 'm');
        await con.run(`CREATE OR REPLACE TEMP TABLE m_a AS SELECT * FROM lake.${s.table.split('.').map(ident).join('.')}`);
        await compare(label, 'm', dims, 'abs(e.value::DOUBLE - a.value::DOUBLE) >= 0.005');
        show(`${key} 探针`, await probeRows('m', dims));
        if (key === 'views_7d') {
          // #154：匿名浏览没有计入设备主人。这里按领域口径（设备最近一次登录的人）算出差距
          show('views_7d 按设备归属的差距（#154：平台现在不计入匿名浏览）', await q(`
            WITH owner AS (SELECT device_id, arg_max(customer_id, occurred_utc) AS customer_id FROM t.event WHERE event_type = 'login' GROUP BY 1)
            SELECT count(*) AS 匿名浏览, count(o.device_id) AS 能归属到人的, count(*) FILTER (WHERE o.customer_id IS NULL) AS 从未登录的设备
            FROM t.event e LEFT JOIN owner o USING (device_id)
            WHERE e.customer_id IS NULL AND e.event_type = 'view' AND ${win('e.occurred_utc', 7, s.as_of)}`));
        }
      } else {
        const tag = parse(s.yaml) as { metric: string; rules: { value: string | number; when: Record<string, number> }[]; default: string | number };
        if (!EXPECTED[tag.metric]) { console.log(`\n== ${label}：引用的指标 ${tag.metric} 不在 definitions/ 里，跳过`); continue; }
        const metricYaml = publishedMetrics.get(tag.metric);
        if (!metricYaml || !same('metric', tag.metric, metricYaml)) { console.log(`\n== ${label}：引用的指标 ${tag.metric} 最新发布版与 definitions/ 不同，跳过`); continue; }
        const OPS: Record<string, string> = { gte: '>=', gt: '>', lte: '<=', lt: '<', eq: '=' };
        const sqlv = (v: string | number) => lit(String(v));
        const cases = tag.rules.map(r => `WHEN ${Object.entries(r.when).map(([op, n]) => `value::DOUBLE ${OPS[op]} ${n}`).join(' AND ') || 'true'} THEN ${sqlv(r.value)}`).join(' ');
        await expectedMetric(tag.metric, s.as_of, 'tm');
        await con.run(`CREATE OR REPLACE TEMP TABLE tg_e AS SELECT consumer_id, CASE ${cases} ELSE ${sqlv(tag.default)} END AS value FROM tm_e`);
        await con.run(`CREATE OR REPLACE TEMP TABLE tg_a AS SELECT consumer_id, tag_value::VARCHAR AS value FROM lake.${s.table.split('.').map(ident).join('.')}`);
        await compare(label, 'tg', [], 'e.value IS DISTINCT FROM a.value');
        show(`${key} 各取值人数（期望 / 实际）`, await q(`SELECT coalesce(e.value, a.value) AS 取值, e.n AS 期望, a.n AS 实际 FROM
          (SELECT value, count(*) AS n FROM tg_e GROUP BY 1) e FULL JOIN (SELECT value, count(*) AS n FROM tg_a GROUP BY 1) a USING (value) ORDER BY 1`));
        show(`${key} 探针`, await probeRows('tg', []));
      }
    }
    if (!snaps.length) console.log('\n还没有指标或标签的快照');
  }
} finally {
  con.closeSync();
  instance.closeSync();
  await closeDb();
}
