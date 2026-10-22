// scripts/fmcg-seed/verify.ts —— 拿真值（out/truth.duckdb）核对一个 fmcglab 租户：身份打通、设备归属、统一消费者的属性与同意、标准层各实体的行数与金额、
// 合并组的存活结果（订单取最新、商品逐字段补齐）、积分断言、每个指标与标签的最新快照，最后给出工作台分析题的参考答案（扫码率、窜货）。
// 期望值不经过平台的编译器：按真值里的订单、扫码、积分等独立计算，窗口用每张快照自己的 asOf。指标里的人按真值的「期望消费者」（expected_identity
// 的组）对应到平台的统一消费者 ID，打通错了指标也会对不上。指标与标签只核对 definitions/ 里有的键，且平台上这一版的定义要与 definitions/ 一致（注释不算）。
// 自己的 DuckDB 只读挂载租户的数据湖（与 openTenantLake 同样的 ATTACH），同时挂上真值库，全部比对在 SQL 里做。
// 用法：node --env-file=.env --import tsx scripts/fmcg-seed/verify.ts <租户> [--only identity,consumer,silver,metrics,analysis] [--set 10m]
// 数据源须按 README 的名字登记（member_pg、mall_pg、scan_mysql、station_mysql、erp_mysql、oms_mongo、tmall_s3、jd_s3、douyin_s3、events_s3、activity_s3、sellout_s3、wecom_duckdb）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { DuckDBInstance } from '@duckdb/node-api';
import pg from 'pg';
import { parse } from 'yaml';
import { closeDb } from '../../app/.server/db/client';
import { lakeReady, lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { tenantIdBySlug } from '../../app/.server/tenants';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 登记名 → 真值里的来源代号 */
const SOURCE_CODES: Record<string, string> = {
  member_pg: 'member', mall_pg: 'mall', scan_mysql: 'scan', station_mysql: 'station', erp_mysql: 'erp', oms_mongo: 'oms',
  tmall_s3: 'tmall', jd_s3: 'jd', douyin_s3: 'douyin', events_s3: 'events', activity_s3: 'activity', sellout_s3: 'sellout', wecom_duckdb: 'wecom',
};
const PERSON_SOURCES = ['member', 'scan', 'station', 'tmall', 'jd', 'douyin', 'wecom', 'activity'];

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { only: { type: 'string' }, set: { type: 'string', default: '' } } });
const slug = positionals[0];
if (!slug) throw new Error('用法：verify.ts <租户> [--only identity,consumer,silver,metrics,analysis]');
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
type Snap = { template: string; table: string; as_of: string; version: number; yaml: string };
// 每个指标与标签最新的一张未过期快照，连同它那一版的定义原文
const snaps = (await platform.query<Snap>(`
  SELECT DISTINCT ON (s.template) s.template, s."table", s.params->>'asOf' AS as_of, s.definition_version AS version, v.yaml
  FROM platform.snapshots s
  JOIN platform.dsl_definitions d ON d.tenant_id = s.tenant_id AND s.template = d.kind || ':' || d.key
  JOIN platform.dsl_versions v ON v.definition_id = d.id AND v.version = s.definition_version
  WHERE s.tenant_id = $1 AND s.expired_at IS NULL ORDER BY s.template, s.created_at DESC`, [tenantId])).rows;
// 标签引用的指标：平台上最新的已发布版本（标签编译时内联的就是它）
const publishedMetrics = new Map((await platform.query<{ key: string; yaml: string }>(`
  SELECT DISTINCT ON (d.key) d.key, v.yaml FROM platform.dsl_definitions d JOIN platform.dsl_versions v ON v.definition_id = d.id
  WHERE d.tenant_id = $1 AND d.kind = 'metric' AND v.status = 'published' ORDER BY d.key, v.version DESC`, [tenantId])).rows.map(r => [r.key, r.yaml]));
// 结果层任务读到的积分断言（ADR-0026 断言 4）：最近一次带 membership / points_transaction 的计算
type Assertion = { name: string; level: string; failed: number; detail?: string };
const [lastAssertions] = (await platform.query<{ assertions: Assertion[] }>(`
  SELECT result->'assertions' AS assertions FROM platform.tasks WHERE tenant_id = $1 AND kind = 'gold.dsl' AND status = 'succeeded'
    AND result->'assertions' @> '[{"name": "points_balance"}]' ORDER BY finished_at DESC LIMIT 1`, [tenantId])).rows;
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
  const [meta] = await q<{ persons: number; data_end: string; round: number }>(`SELECT persons, data_end::VARCHAR AS data_end, round FROM t.meta`);
  const has = async (table: string) => (await q(`SELECT 1 FROM duckdb_tables() WHERE database_name = 'lake' AND schema_name = 'silver' AND table_name = ${lit(table)}`)).length > 0;

  await con.run(`CREATE TEMP TABLE srcmap AS SELECT * FROM (VALUES ${sources.length ? sources.map(s => `(${lit(SOURCE_CODES[s.name]!)}, ${lit(s.id)}, ${lit(s.name)})`).join(', ') : `('', '', '')`}) v(code, source_id, name)`);
  const codes = new Set(sources.map(s => SOURCE_CODES[s.name]!));
  console.log(`租户 ${slug}：真值 ${meta!.persons} 人 + 探针，数据终点 ${meta!.data_end}，第 ${meta!.round} 轮；已登记的数据源 ${sources.map(s => s.name).join('、') || '（无）'}`);
  const missing = PERSON_SOURCES.filter(c => !codes.has(c));
  if (missing.length) console.log(`⚠️ 没有登记 ${missing.join('、')}：期望的打通按全部数据源算，这些源上的人会显示为「被拆开」`);

  // ---------- 1. 身份打通 ----------
  await con.run(`CREATE TEMP TABLE rid AS SELECT src, customer_id, pid, group_rid FROM t.expected_identity`);
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
      (SELECT count(*) FROM act a WHERE NOT EXISTS (SELECT 1 FROM rid r WHERE r.src = a.src AND r.customer_id = a.customer_id)) AS 多出,
      count(DISTINCT group_rid) AS 期望消费者, count(DISTINCT consumer_id) AS 统一消费者
      FROM j`));
    show('各数据源的消费者记录', await q(`SELECT src AS 来源, count(*) AS 期望, count(consumer_id) AS 已打通 FROM j GROUP BY 1 ORDER BY 1`));
    show('探针的打通结果', await q(`SELECT j.pid, any_value(p.note) AS 说明, string_agg(DISTINCT j.src, '+' ORDER BY j.src) AS 来源,
        count(DISTINCT j.group_rid) AS 期望消费者, count(DISTINCT j.consumer_id) AS 实际消费者, left(min(j.consumer_id), 12) AS consumer_id前缀
      FROM j JOIN t.person p USING (pid) WHERE p.archetype = 'probe' GROUP BY j.pid ORDER BY j.pid`));
    // 误合并按「一个统一消费者里有几个真实的人」排：占位号、导购代填没去掉时，这里是一个人连着几十条记录
    const bad = await q(`SELECT consumer_id[:12] AS consumer, count(DISTINCT pid) AS 真实的人数, count(*) AS 记录数,
        string_agg(DISTINCT src, '+' ORDER BY src) AS 来源, string_agg(DISTINCT pid::VARCHAR, ',' ORDER BY pid::VARCHAR)[:80] AS 真实的人
      FROM j WHERE consumer_id IN (SELECT consumer_id FROM j WHERE consumer_id IS NOT NULL GROUP BY 1 HAVING count(DISTINCT group_rid) > 1)
      GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
    if (bad.length) show('误合并最多的 5 个统一消费者（P04 占位号、P05 导购代填没去掉时出现在这里）', bad);

    // 点查接口用的 ID（README T9）：几个探针现在的统一消费者 ID；「先合后拆」后退役 ID 的别名指向的人（#252）
    show('点查用的统一消费者 ID（T9.3）', await q(`SELECT j.pid, any_value(p.note) AS 说明, min(j.consumer_id) AS consumer_id
      FROM j JOIN t.person p USING (pid) WHERE j.pid IN (99000001, 99000014, 99000022) GROUP BY j.pid ORDER BY j.pid`));
    if (await has('_consumer_id_changes')) {
      show('先合后拆后仍指向被拆开的组的退役 ID（T9.4，#252：点查它返回的是「现在的主人」，不是原来的人）', await q(`
        WITH m AS (SELECT old_id, new_id FROM lake.silver._consumer_id_changes WHERE reason = 'merge'),
        s AS (SELECT DISTINCT old_id FROM lake.silver._consumer_id_changes WHERE reason = 'split')
        SELECT m.old_id AS 退役ID, m.new_id AS 别名指向, (SELECT string_agg(DISTINCT j.pid::VARCHAR, ',') FROM j WHERE j.consumer_id = m.new_id) AS 现在的主人pid,
          (SELECT count(*) FROM m m2 WHERE m2.new_id = m.new_id) AS 指向它的退役ID数
        FROM m WHERE m.new_id IN (SELECT old_id FROM s) ORDER BY m.old_id LIMIT 3`));
    }

    // 设备归属：每台登录过的设备归到全局最近一次登录的人（登录事件的 user_id 是会员号）
    if (await has('_device_owner')) {
      show('设备归属（期望：不符为 0）', await q(`
        WITH last AS (SELECT device_id, arg_max(customer_id, occurred_utc) AS customer_id FROM t.event WHERE event_type = 'login' GROUP BY 1),
        e AS (SELECT l.device_id, g.consumer_id FROM last l JOIN rid r ON r.src = 'member' AND r.customer_id = l.customer_id JOIN gcons g USING (group_rid))
        SELECT count(*) AS 期望设备, count(d.device_id) AS 平台有, count(*) FILTER (WHERE d.consumer_id IS DISTINCT FROM e.consumer_id) AS 不符,
          (SELECT count(*) FROM lake.silver._device_owner) AS 平台设备数
        FROM e LEFT JOIN lake.silver._device_owner d USING (device_id)`));
    }
  }

  // ---------- 2. 统一消费者的属性与同意（ADR-0027） ----------
  if (step('consumer') && await has('_consumer')) {
    // 城市：会员中心优先（survivorship 1），其余按 updated_at 取最新的非空值；只有会员中心、扫码平台、奶站、抖音映射了城市
    await con.run(`CREATE TEMP TABLE ecity AS
      SELECT g.consumer_id, arg_min(r.city, (CASE WHEN r.src = 'member' THEN 0 ELSE 1 END, -epoch(r.updated_utc))) AS city
      FROM t.rec r JOIN rid USING (src, customer_id) JOIN gcons g USING (group_rid)
      WHERE r.city IS NOT NULL AND r.src IN ('member', 'scan', 'station', 'douyin') AND r.src IN (SELECT code FROM srcmap) GROUP BY 1`);
    show('统一消费者的城市（期望：不符为 0；K8 = 上海，第二轮 P01 = 北京）', await q(`
      SELECT count(*) AS 期望有城市, count(c.city) AS 平台有城市, count(*) FILTER (WHERE c.city IS DISTINCT FROM e.city) AS 不符,
        (SELECT c2.city FROM lake.silver._consumer c2 JOIN gcons g ON g.consumer_id = c2.consumer_id JOIN rid ON rid.group_rid = g.group_rid WHERE rid.pid = 99000014 LIMIT 1) AS K8,
        (SELECT c2.city FROM lake.silver._consumer c2 JOIN gcons g ON g.consumer_id = c2.consumer_id JOIN rid ON rid.group_rid = g.group_rid WHERE rid.pid = 99000001 LIMIT 1) AS P01
      FROM ecity e LEFT JOIN lake.silver._consumer c USING (consumer_id)`));
    if (await has('_consumer_consent')) {
      // 同意：每人每渠道取各源 updated_at 最新的一条，同一时刻撤回优先
      await con.run(`CREATE TEMP TABLE econsent AS
        SELECT g.consumer_id, c.channel, arg_min(c.status, (-epoch(coalesce(c.revoked_utc, c.granted_utc)), CASE c.status WHEN 'revoked' THEN 0 ELSE 1 END)) AS status
        FROM t.consent c JOIN rid ON rid.src = c.src AND rid.customer_id = c.customer_id JOIN gcons g USING (group_rid) WHERE c.src IN (SELECT code FROM srcmap) GROUP BY 1, 2`);
      show('统一消费者的同意（期望：不符为 0；K5 短信 = revoked）', await q(`
        SELECT count(*) AS 期望, count(c.status) AS 平台有, count(*) FILTER (WHERE c.status IS DISTINCT FROM e.status) AS 不符,
          (SELECT c2.status FROM lake.silver._consumer_consent c2 JOIN gcons g ON g.consumer_id = c2.consumer_id JOIN rid ON rid.group_rid = g.group_rid
            WHERE rid.pid = 99000015 AND c2.channel = 'sms' LIMIT 1) AS K5短信
        FROM econsent e LEFT JOIN lake.silver._consumer_consent c USING (consumer_id, channel)`));
    }
  }

  // ---------- 3. 标准层 ----------
  if (step('silver')) {
    const silver: { entity: string; expected: string; amount?: string }[] = [
      { entity: 'customer', expected: `SELECT src, count(*) AS n FROM rid GROUP BY 1` },
      // 订单：电商订单在合并组里，一个订单号一行，_source 是胜出的一边（中台较新时是 oms）
      { entity: 'order', expected: `SELECT winner AS src, count(*) AS n, sum(amount) AS amount FROM t.ord WHERE NOT test_store GROUP BY 1`, amount: 'amount' },
      { entity: 'order_item', expected: `SELECT src, count(*) AS n, sum(amount) AS amount FROM t.item GROUP BY 1`, amount: 'amount' },
      // 商品：逐字段补齐时 _source 是有这个键的最高优先级组员（ERP 在前）
      { entity: 'product', expected: `SELECT CASE WHEN in_erp THEN 'erp' ELSE 'scan' END AS src, count(*) AS n FROM t.product GROUP BY 1` },
      { entity: 'membership', expected: `SELECT 'member' AS src, count(*) AS n, sum(points) AS amount FROM t.membership`, amount: 'points' },
      { entity: 'points_transaction', expected: `SELECT 'member' AS src, count(*) AS n, sum(points_change) AS amount FROM t.ledger`, amount: 'points_change' },
      { entity: 'coupon', expected: `SELECT 'member' AS src, count(*) AS n FROM t.coupon` },
      { entity: 'coupon_template', expected: `SELECT 'member' AS src, count(*) AS n FROM t.coupon_template` },
      { entity: 'consent', expected: `SELECT src, count(*) AS n FROM t.consent GROUP BY 1` },
      { entity: 'preference', expected: `SELECT 'member' AS src, count(*) AS n FROM t.preference` },
      { entity: 'event', expected: `
        SELECT 'events' AS src, count(*) AS n FROM t.event
        UNION ALL SELECT 'scan', count(*) FROM t.scan WHERE NOT test
        UNION ALL SELECT 'member', count(*) FROM t.redemption WHERE status <> '已取消'
        UNION ALL SELECT 'wecom', (SELECT count(*) FROM t.wecom_member) + (SELECT count(quit_utc) FROM t.wecom_member)
        UNION ALL SELECT 'activity', count(*) FROM t.signup` },
      { entity: 'touch', expected: `SELECT 'wecom' AS src, count(*) AS n FROM t.wecom_send` },
      { entity: 'custom_region', expected: `SELECT 'erp' AS src, count(*) AS n FROM t.region` },
      { entity: 'custom_station', expected: `SELECT 'station' AS src, count(*) AS n FROM t.station` },
      { entity: 'custom_code', expected: `SELECT 'scan' AS src, count(*) AS n FROM t.code` },
      { entity: 'custom_subscription', expected: `SELECT 'mall' AS src, count(*) AS n FROM t.subscription` },
      { entity: 'custom_ka_store', expected: `SELECT 'sellout' AS src, count(*) AS n FROM t.ka_store` },
      { entity: 'custom_sellout', expected: `SELECT 'sellout' AS src, count(*) AS n, sum(qty) AS amount FROM t.sellout`, amount: 'qty' },
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
    show('标准层各实体（期望：已映射的都是 ✔）', out);

    // 合并组的存活结果：订单状态取较新的一边、物流只在中台胜出时有；商品品牌由扫码平台补齐、新品没有品类
    if (await has('order')) {
      show('订单合并组（取最新 updated_at；期望：不符为 0）', await q(`
        WITH e AS (SELECT order_id, status, CASE WHEN winner = 'oms' THEN logistics END AS logistics, winner, variant, plat_status FROM t.ord WHERE src IN ('tmall', 'jd', 'douyin')),
        a AS (SELECT o.order_id, o.status, o.x_logistics_company AS logistics, m.code AS winner FROM lake.silver."order" o JOIN srcmap m ON m.source_id = o._source
              WHERE o._key_space IS NULL)
        SELECT count(*) AS 电商订单, count(a.order_id) AS 平台有, count(*) FILTER (WHERE e.status IS DISTINCT FROM a.status) AS 状态不符,
          count(*) FILTER (WHERE e.winner IS DISTINCT FROM a.winner) AS 胜出方不符, count(*) FILTER (WHERE e.logistics IS DISTINCT FROM a.logistics) AS 物流不符,
          count(*) FILTER (WHERE e.winner = 'oms') AS 期望中台胜出, count(*) FILTER (WHERE e.status = 'refunded' AND e.plat_status = 'completed') AS 平台已完成而中台退款,
          count(*) FILTER (WHERE e.variant = 'plat_newer') AS 平台确认收货更晚, count(*) FILTER (WHERE e.variant IS NOT NULL AND e.plat_status IS NULL) AS 平台导出里已删
        FROM e LEFT JOIN a USING (order_id)`));
      show('订单合并组探针', await q(`SELECT o.key, p.note AS 说明, o.plat_status AS 平台状态, o.oms_status AS 中台状态, o.status AS 期望, a.status AS 实际, m.code AS 胜出方
        FROM t.ord o JOIN t.person p USING (pid) LEFT JOIN lake.silver."order" a ON a.order_id = o.order_id AND a._key_space IS NULL LEFT JOIN srcmap m ON m.source_id = a._source
        WHERE o.key IN ('k2a-tm', 'k2b-jd', 'p01-tm', 'p01-jd', 'p01-dy') ORDER BY o.key`));
    }
    if (await has('product')) {
      show('商品合并组（逐字段补齐，ERP 优先；期望：不符为 0）', await q(`
        WITH e AS (SELECT product_id, CASE WHEN in_erp THEN category END AS category, brand, CASE WHEN in_erp THEN price END AS price FROM t.product)
        SELECT count(*) AS 商品, count(a.product_id) AS 平台有, count(*) FILTER (WHERE e.brand IS DISTINCT FROM a.brand) AS 品牌不符,
          count(*) FILTER (WHERE e.category IS DISTINCT FROM a.category) AS 品类不符, count(*) FILTER (WHERE e.price IS DISTINCT FROM a.price) AS 标价不符,
          count(*) FILTER (WHERE a.category IS NULL) AS 没有品类
        FROM e LEFT JOIN lake.silver.product a USING (product_id)`));
    }
  }

  // ---------- 4. 积分断言（L3：会员卡余额 999、流水 200，期望只这一个会员不一致、差额 799，流水没有断档） ----------
  if (step('silver') && lastAssertions) {
    show('积分断言（期望：points_balance 1 个会员、差额 799；points_chain 0）',
      lastAssertions.assertions.filter(a => a.name.startsWith('points_')).map(a => ({ 断言: a.name, 级别: a.level, 不通过: a.failed, 说明: a.detail })));
  }

  // ---------- 5. 指标与标签 ----------
  if (step('metrics')) {
    const win = (col: string, days: number, asOf: string) => `${col}::DATE > DATE ${lit(asOf)} - ${days} AND ${col}::DATE <= DATE ${lit(asOf)}`;
    const PAID = `status IN ('paid', 'shipped', 'completed')`;
    // 每类事实对应到期望消费者，再经 gcons 到平台的统一消费者
    const facts = (table: string, src: string, key = 'customer_id', where = 'true') =>
      `(SELECT f.*, g.consumer_id FROM ${table} f JOIN rid r ON r.src = ${src} AND r.customer_id = f.${key} JOIN gcons g USING (group_rid) WHERE ${where})`;
    // 商城订单的下单人是会员中心的会员号（customer_source: member_pg）
    const orders = facts('t.ord', `CASE f.src WHEN 'mall' THEN 'member' ELSE f.src END`, 'customer_id', 'NOT f.test_store');
    const scans = facts('t.scan', `'scan'`, 'openid', `f.result = '成功' AND NOT f.test`);
    // 埋点的 user_id 是会员号；匿名事件计入设备主人：设备全局最近一次登录的人（ADR-0025）
    const events = facts(`(SELECT e.*, coalesce(e.customer_id, o.customer_id) AS owner_id FROM t.event e LEFT JOIN
      (SELECT device_id, arg_max(customer_id, occurred_utc) AS customer_id FROM t.event WHERE event_type = 'login' GROUP BY 1) o
      ON e.customer_id IS NULL AND o.device_id = e.device_id)`, `'member'`, 'owner_id');
    const ledger = facts('t.ledger', `'member'`);
    /** 统一消费者的城市（与第 2 节同一口径）：只在 revenue_by_city 用到，按需建 */
    const ecityReady = async () => {
      await con.run(`CREATE TEMP TABLE IF NOT EXISTS ecity AS
        SELECT g.consumer_id, arg_min(r.city, (CASE WHEN r.src = 'member' THEN 0 ELSE 1 END, -epoch(r.updated_utc))) AS city
        FROM t.rec r JOIN rid USING (src, customer_id) JOIN gcons g USING (group_rid)
        WHERE r.city IS NOT NULL AND r.src IN ('member', 'scan', 'station', 'douyin') AND r.src IN (SELECT code FROM srcmap) GROUP BY 1`);
      return 'ecity';
    };
    /** 每个指标的期望：列为 consumer_id、维度…、value；dims 是维度列名 */
    const EXPECTED: Record<string, { dims: string[]; sql: (asOf: string) => string | Promise<string> }> = {
      revenue_365d: { dims: [], sql: a => `SELECT consumer_id, sum(amount) AS value FROM ${orders} o WHERE ${PAID} AND ${win('created_utc', 365, a)} GROUP BY 1` },
      order_count_365d: { dims: [], sql: a => `SELECT consumer_id, count(*) AS value FROM ${orders} o WHERE ${PAID} AND ${win('created_utc', 365, a)} GROUP BY 1` },
      channel_count: { dims: [], sql: a => `SELECT consumer_id, count(DISTINCT channel) AS value FROM ${orders} o WHERE ${PAID} AND ${win('created_utc', 365, a)} GROUP BY 1` },
      avg_order_value_365d: { dims: [], sql: a => `SELECT consumer_id, avg(amount) AS value FROM ${orders} o WHERE ${PAID} AND ${win('created_utc', 365, a)} GROUP BY 1` },
      revenue_by_region: {
        dims: ['region'],
        sql: a => `SELECT consumer_id, coalesce(rg.name, '未关联') AS region, sum(amount) AS value
          FROM ${orders} o LEFT JOIN t.station s ON s.station_id = o.store_id LEFT JOIN t.region rg ON rg.region_id = s.region_id
          WHERE ${PAID} AND ${win('o.created_utc', 365, a)} GROUP BY ALL`,
      },
      revenue_by_city: {
        dims: ['city'],
        sql: async a => `SELECT o.consumer_id, coalesce(c.city, '未关联') AS city, sum(amount) AS value
          FROM ${orders} o LEFT JOIN ${await ecityReady()} c USING (consumer_id) WHERE ${PAID} AND ${win('o.created_utc', 365, a)} GROUP BY ALL`,
      },
      days_since_last_order: { dims: [], sql: a => `SELECT consumer_id, DATE ${lit(a)} - max(created_utc::DATE) AS value FROM ${orders} o WHERE ${PAID} GROUP BY 1` },
      scan_count_30d: { dims: [], sql: a => `SELECT consumer_id, count(*) AS value FROM ${scans} s WHERE ${win('scan_utc', 30, a)} GROUP BY 1` },
      scan_by_sales_region_90d: {
        dims: ['sales_region'],
        sql: a => `SELECT s.consumer_id, coalesce(rg.name, '未关联') AS sales_region, count(*) AS value
          FROM ${scans} s LEFT JOIN t.code c USING (code) LEFT JOIN t.region rg ON rg.region_id = c.sales_region WHERE ${win('s.scan_utc', 90, a)} GROUP BY ALL`,
      },
      days_since_last_scan: { dims: [], sql: a => `SELECT consumer_id, DATE ${lit(a)} - max(scan_utc::DATE) AS value FROM ${scans} s GROUP BY 1` },
      points_balance: { dims: [], sql: () => `SELECT consumer_id, sum(points_change) AS value FROM ${ledger} GROUP BY 1` },
      points_from_scan_90d: {
        dims: [], sql: a => `SELECT consumer_id, sum(points_change) AS value FROM ${ledger} WHERE reason = 'EARN_SCAN' AND ${win('occurred_utc', 90, a)} GROUP BY 1`,
      },
      active_subscriptions: {
        dims: [], sql: () => `SELECT consumer_id, count(*) AS value FROM ${facts(`(SELECT s.*, r.customer_id FROM t.subscription s JOIN t.rec r ON r.pid = s.pid AND r.src = 'member')`, `'member'`)}
          WHERE status = 'active' GROUP BY 1`,
      },
      coupon_redeem_rate: {
        dims: [], sql: () => `SELECT consumer_id, count(*) FILTER (WHERE status = 'redeemed')::DOUBLE / count(*) AS value FROM ${facts('t.coupon', `'member'`)} GROUP BY 1`,
      },
      views_7d: { dims: [], sql: a => `SELECT consumer_id, count(*) AS value FROM ${events} e WHERE event_type = 'view_product' AND ${win('occurred_utc', 7, a)} GROUP BY 1` },
      trial_received: { dims: [], sql: () => `SELECT consumer_id, count(*) AS value FROM ${facts('t.signup', `'activity'`, 'signup_id')} WHERE received GROUP BY 1` },
      group_joins: { dims: [], sql: () => `SELECT consumer_id, count(*) AS value FROM ${facts('t.wecom_member', `'wecom'`, 'external_userid')} GROUP BY 1` },
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
      await con.run(`CREATE OR REPLACE TEMP TABLE ${name}_e AS SELECT * FROM (${await EXPECTED[key]!.sql(asOf)})`);
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
      } else {
        type Item = { metric: string } & Record<string, number | string>;
        type Rule = { value: string | number; when: Record<string, number> | { all?: Item[]; any?: Item[] } };
        const tag = parse(s.yaml) as { metric?: string; rules: Rule[]; missing?: Record<string, number | null>; default: string | number };
        // 单指标写法即 all 里一项；引用的指标去重后按出现顺序编号 tm0、tm1……
        const conditionsOf = (r: Rule): { join: string; items: Item[] } => {
          if (tag.metric !== undefined) return { join: 'AND', items: [{ ...(r.when as Record<string, number>), metric: tag.metric }] };
          const w = r.when as { all?: Item[]; any?: Item[] };
          return w.any ? { join: 'OR', items: w.any } : { join: 'AND', items: w.all ?? [] };
        };
        const keys = [...new Set(tag.rules.flatMap(r => conditionsOf(r).items.map(item => item.metric)))];
        const unknown = keys.find(k => !EXPECTED[k]);
        if (unknown) { console.log(`\n== ${label}：引用的指标 ${unknown} 不在 definitions/ 里，跳过`); continue; }
        const changed = keys.find(k => !publishedMetrics.get(k) || !same('metric', k, publishedMetrics.get(k)!));
        if (changed) { console.log(`\n== ${label}：引用的指标 ${changed} 最新发布版与 definitions/ 不同，跳过`); continue; }
        // 不在指标结果里（或取值为空）的人：missing 写了按写的，没写时计数与求和记 0，其余记空（与 tag-spec 的口径各写一份，独立核对）
        const valueOf = (k: string) => {
          const i = keys.indexOf(k);
          const agg = (local('metric', k)!.measure as { agg: string }).agg;
          const miss = tag.missing && k in tag.missing ? tag.missing[k] : ['count', 'count_distinct', 'sum'].includes(agg) ? 0 : null;
          return miss === null || miss === undefined ? `tm${i}.value::DOUBLE` : `coalesce(tm${i}.value::DOUBLE, ${miss})`;
        };
        const OPS: Record<string, string> = { gte: '>=', gt: '>', lte: '<=', lt: '<', eq: '=' };
        const sqlv = (v: string | number) => lit(String(v));
        const cases = tag.rules.map(r => {
          const { join, items } = conditionsOf(r);
          const terms = items.map(item => `(${Object.entries(item).filter(([op]) => op !== 'metric').map(([op, n]) => `${valueOf(item.metric)} ${OPS[op]} ${n}`).join(' AND ')})`);
          return `WHEN ${terms.join(` ${join} `)} THEN ${sqlv(r.value)}`;
        }).join(' ');
        for (const [i, k] of keys.entries()) await expectedMetric(k, s.as_of, `tm${i}`);
        // 人群是全部统一消费者
        await con.run(`CREATE OR REPLACE TEMP TABLE tg_e AS SELECT u.consumer_id, CASE ${cases} ELSE ${sqlv(tag.default)} END AS value
          FROM (SELECT DISTINCT consumer_id FROM lake.silver._identities) u ${keys.map((_, i) => `LEFT JOIN tm${i}_e tm${i} ON tm${i}.consumer_id = u.consumer_id`).join(' ')}`);
        await con.run(`CREATE OR REPLACE TEMP TABLE tg_a AS SELECT consumer_id, tag_value::VARCHAR AS value FROM lake.${s.table.split('.').map(ident).join('.')}`);
        await compare(label, 'tg', [], 'e.value IS DISTINCT FROM a.value');
        show(`${key} 各取值人数（期望 / 实际）`, await q(`SELECT coalesce(e.value, a.value) AS 取值, e.n AS 期望, a.n AS 实际 FROM
          (SELECT value, count(*) AS n FROM tg_e GROUP BY 1) e FULL JOIN (SELECT value, count(*) AS n FROM tg_a GROUP BY 1) a USING (value) ORDER BY 1`));
        show(`${key} 探针`, await probeRows('tg', []));
      }
    }
    if (!snaps.length) console.log('\n还没有指标或标签的快照');
  }

  // ---------- 6. 工作台分析题的参考答案（README T6） ----------
  if (step('analysis')) {
    const [{ start, stop }] = await q<{ start: string; stop: string }>(`SELECT min(week_start)::VARCHAR AS start, (max(week_start) + 7)::VARCHAR AS stop FROM t.sellout`);
    show(`扫码率参考值：${start} 起 26 周，各大区成功扫码数（按码的销售大区） / 商超销量（按门店大区）`, await q(`
      WITH s AS (SELECT c.sales_region AS region_id, count(*) AS scans FROM t.scan x JOIN t.code c USING (code)
                 WHERE x.result = '成功' AND NOT x.test AND x.scan_utc >= DATE ${lit(start)} AND x.scan_utc < DATE ${lit(stop)} GROUP BY 1),
      k AS (SELECT st.region_id, sum(o.qty) AS qty FROM t.sellout o JOIN t.ka_store st USING (store_code) GROUP BY 1)
      SELECT rg.name AS 大区, s.scans AS 扫码数, k.qty AS 商超销量, round(s.scans / k.qty, 4) AS 扫码率
      FROM t.region rg LEFT JOIN s USING (region_id) LEFT JOIN k USING (region_id) ORDER BY rg.region_id`));
    // 指标做不了（订单明细不能做基础实体，过滤不能走到商品），只能在工作台里算：近 365 天（截至数据终点日）买过各品类的统一消费者数
    show(`品类渗透参考值：${meta!.data_end} 往前 365 天，已付订单的明细按商品品类，买过的统一消费者数（商品没关联上的记「未关联」）`, await q(`
      SELECT coalesce(CASE WHEN p.in_erp THEN p.category END, '未关联') AS 品类, count(DISTINCT g.consumer_id) AS 购买人数, sum(i.amount) AS 金额
      FROM t.item i JOIN t.ord o ON o.src = i.src AND o.order_id = i.order_id
      JOIN rid ON rid.src = CASE o.src WHEN 'mall' THEN 'member' ELSE o.src END AND rid.customer_id = o.customer_id JOIN gcons g USING (group_rid)
      LEFT JOIN t.product p USING (product_id)
      WHERE o.status IN ('paid', 'shipped', 'completed') AND o.created_utc::DATE > DATE ${lit(meta!.data_end)} - 365 AND o.created_utc::DATE <= DATE ${lit(meta!.data_end)}
      GROUP BY 1 ORDER BY 2 DESC`));
    show('窜货参考值：成功扫码里码的销售大区 ≠ 扫码大区的次数，按销售大区', await q(`
      SELECT rg.name AS 销售大区, count(*) AS 成功扫码, count(*) FILTER (WHERE c.sales_region <> x.scan_region) AS 窜货,
        round(count(*) FILTER (WHERE c.sales_region <> x.scan_region) / count(*), 4) AS 占比
      FROM t.scan x JOIN t.code c USING (code) JOIN t.region rg ON rg.region_id = c.sales_region WHERE x.result = '成功' AND NOT x.test GROUP BY rg.region_id, 1 ORDER BY rg.region_id`));
  }
} finally {
  con.closeSync();
  instance.closeSync();
  await closeDb();
}
