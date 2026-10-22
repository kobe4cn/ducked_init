// scripts/fmcg-seed/seed.ts —— fmcglab 快消（乳品）多渠道 CRM 测试造数：先在本机 out/truth.duckdb 里生成真值（truth.sql），再写进 13 个数据源，并建好只读账号。
// 用法：node --env-file=.env --import tsx scripts/fmcg-seed/seed.ts [--persons 50000] [--end 2026-10-21] [--only 步骤,…]
//   --persons 真实的人数（另加探针、地推路人与测试账号）；--end 数据终点日（UTC，默认今天）：订单、扫码、行为都在这一天之前，探针的时间相对它取
//   --only 只跑这几步：truth,member,mall,scan,station,erp,oms,tmall,jd,douyin,events,activity,wecom,sellout,accounts（真值不存在时总会先生成）
//   --set 10m 规模档：写进另一套库、schema 与 S3 前缀（fmcg_member_10m…、s3://crm-source/fmcg/10m/），真值在 out/10m/，与默认的一套并存
//   --round 2 第二轮变更（plan T7）：不重建，在现有真值与数据源上就地执行 round2.sql 的变更（--persons、--end、--only 不起作用）
// 可重复执行：每个数据源先删后建（只动 fmcg_* 的库、schema、集合与 s3://crm-source/fmcg/ 前缀），只读账号已存在时沿用（S3 的密钥仍有效时也沿用）。
// 写法沿用 scripts/crm-seed/seed.ts：Postgres 走 DuckDB postgres 扩展，MySQL 走 LOAD DATA LOCAL INFILE，Mongo 走 mongoimport，S3 由 DuckDB 直接写
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { platformS3 } from '../../app/.server/s3-accounts';
import { deleteObject, listObjects, putObject, signedFetch, xmlTag, xmlTags } from '../../app/.server/s3-client';

const { values: args } = parseArgs({
  options: {
    persons: { type: 'string', default: '50000' },
    end: { type: 'string', default: new Date().toISOString().slice(0, 10) },
    only: { type: 'string' },
    round: { type: 'string', default: '1' },
    set: { type: 'string', default: '' },
  },
});
const N = Number(args.persons);
const END = args.end!;
if (!Number.isInteger(N) || N < 1000) throw new Error('--persons 至少 1000');
if (!/^\d{4}-\d{2}-\d{2}$/.test(END)) throw new Error('--end 形如 2026-10-21');
const ONLY = args.only?.split(',');
const step = (name: string) => !ONLY || ONLY.includes(name);

const HERE = dirname(fileURLToPath(import.meta.url));
/** 数据集：默认（正确性档）或 --set 10m（规模档）。两档的库、schema、集合、S3 前缀与真值各自独立；只读账号与 S3 密钥共用 */
const SET = args.set!;
if (!/^[a-z0-9]*$/.test(SET)) throw new Error('--set 只能是小写字母与数字，如 10m');
const SUFFIX = SET ? `_${SET}` : '';
const MEMBER = `fmcg_member${SUFFIX}`, MALL = `fmcg_mall${SUFFIX}`;
const SCAN = `fmcg_scan${SUFFIX}`, STATION = `fmcg_station${SUFFIX}`, ERP = `fmcg_erp${SUFFIX}`, OMS = `fmcg_oms${SUFFIX}`;
const OUT = SET ? join(HERE, 'out', SET) : join(HERE, 'out');
const CREDENTIALS = join(HERE, 'out', 'credentials.txt');
const TRUTH = join(OUT, 'truth.duckdb');
const WECOM = join(OUT, 'wecom.duckdb');
const PG_ADMIN = 'postgresql://crm:crm@localhost:5432/crm';
const MYSQL_ROOT = ['-uroot', '-pcrm', '--default-character-set=utf8mb4'];
const MONGO_URI = 'mongodb://crm:crm-secret@localhost:27017/?authSource=admin';
const S3_PREFIX = `s3://crm-source/fmcg${SET ? `/${SET}` : ''}`;
const SECRETS = { pg: 'fmcglab-reader-secret', my: 'fmcglab-reader-secret', mg: 'fmcglab-ro-secret' };

const s3 = platformS3();
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
/** UTC 时间转成北京时间（不带时区）：MySQL、DuckDB 文件、CSV 里的时间都这样存 */
const cn = (c: string) => `timezone('Asia/Shanghai', timezone('UTC', ${c}))`;
const bj = (c: string, fmt = '%Y-%m-%d %H:%M:%S') => `strftime(${cn(c)}, '${fmt}')`;
const pgUtc = (c: string) => `timezone('UTC', ${c})`;
const caseMap = (col: string, m: Record<string, string>) => `CASE ${col} ${Object.entries(m).map(([k, v]) => `WHEN ${lit(k)} THEN ${lit(v)}`).join(' ')} END`;
const ORDER_STATUS = {
  mall: { created: 'WAIT_PAY', paid: 'PAID', shipped: 'SHIPPED', completed: 'FINISHED', cancelled: 'CLOSED', refunded: 'REFUNDED' },
  station: { created: '未缴费', paid: '已缴费', shipped: '配送中', completed: '已完成', cancelled: '已取消', refunded: '已退订' },
  tmall: { created: 'WAIT_BUYER_PAY', paid: 'WAIT_SELLER_SEND_GOODS', shipped: 'WAIT_BUYER_CONFIRM_GOODS', completed: 'TRADE_FINISHED', cancelled: 'TRADE_CLOSED', refunded: 'REFUND_SUCCESS' },
  jd: { created: '等待付款', paid: '等待出库', shipped: '等待确认收货', completed: '完成', cancelled: '已取消', refunded: '退款成功' },
  douyin: { created: '1', paid: '2', shipped: '3', completed: '5', cancelled: '4', refunded: '21' },
  oms: { created: 'WAIT_PAY', paid: 'WAIT_SEND', shipped: 'SENT', completed: 'FINISHED', cancelled: 'CANCELLED', refunded: 'REFUNDED' },
};
const SUB_STATUS = { active: 'ACTIVE', paused: 'PAUSED', finished: 'FINISHED', cancelled: 'CANCELLED' };

mkdirSync(OUT, { recursive: true });

async function open(path = ':memory:') {
  const con = await (await DuckDBInstance.create(path)).connect();
  await con.run(`SET TimeZone = 'UTC'`);
  return con;
}

/** 只读挂载真值库（别名 t），并建好 truth.sql 里同样的随机宏 u() */
async function withTruth<T>(fn: (con: DuckDBConnection) => Promise<T>) {
  const con = await open();
  await con.run(`ATTACH ${lit(TRUTH)} AS t (READ_ONLY)`);
  await con.run(`CREATE MACRO u(k, salt) AS (hash(CAST(k AS VARCHAR) || ':' || salt) % 1000000)::DOUBLE / 1000000`);
  try { return await fn(con); } finally { con.closeSync(); }
}

async function s3Secret(con: DuckDBConnection) {
  await con.run(`INSTALL httpfs; LOAD httpfs; CREATE SECRET admin_s3 (TYPE s3, KEY_ID ${lit(s3.key)}, SECRET ${lit(s3.secret)},
    REGION ${lit(s3.region)}, ENDPOINT ${lit(s3.endpoint)}, URL_STYLE ${lit(s3.urlStyle)}, USE_SSL ${s3.useSsl})`);
}

/** 把本机文件经标准输入交给容器里的命令 */
function pipeInto(file: string, cmd: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('container', ['exec', '-i', ...cmd], { stdio: ['pipe', 'inherit', 'inherit'] });
    createReadStream(file).pipe(child.stdin);
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd.slice(0, 2).join(' ')} 退出码 ${code}`))));
  });
}

// ---------- 真值 ----------
async function truth() {
  rmSync(TRUTH, { force: true });
  const con = await open(TRUTH);
  await con.run(readFileSync(join(HERE, 'truth.sql'), 'utf8').replaceAll('${N}', String(N)).replaceAll('${END}', END));
  await con.run(readFileSync(join(HERE, 'identity.sql'), 'utf8'));
  await con.run(`CREATE OR REPLACE TABLE meta AS SELECT ${N} AS persons, DATE ${lit(END)} AS data_end, 1 AS round`);
  for (const r of await rows<Record<string, string>>(con, `
    SELECT src, count(*) AS records, (SELECT count(*) FROM ord WHERE ord.src = CASE rec.src WHEN 'member' THEN 'mall' ELSE rec.src END) AS orders
    FROM rec GROUP BY src ORDER BY src`))
    log(`真值 ${r.src}: 消费者记录 ${r.records}，订单 ${r.orders}`);
  const [s] = await rows<Record<string, string>>(con, `
    SELECT (SELECT count(DISTINCT group_rid) FROM expected_identity) AS consumers, (SELECT count(*) FROM item) AS items,
      (SELECT count(*) FROM ledger) AS ledger, (SELECT count(*) FROM scan) AS scans, (SELECT count(*) FROM event) AS events`);
  log(`真值：期望的统一消费者 ${s!.consumers}，订单明细 ${s!.items}，积分流水 ${s!.ledger}，扫码 ${s!.scans}，埋点事件 ${s!.events}`);
  con.closeSync();
}

// ---------- Postgres：会员中心 fmcg_member、小程序商城 fmcg_mall ----------
function psql(sql: string) {
  execFileSync('psql', [PG_ADMIN, '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'inherit' });
}

function pgReader(schema: string, tables: string[]) {
  psql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fmcglab_reader') THEN CREATE ROLE fmcglab_reader LOGIN PASSWORD '${SECRETS.pg}'; END IF;
    END $$;
    GRANT CONNECT ON DATABASE crm TO fmcglab_reader;
    GRANT USAGE ON SCHEMA ${schema} TO fmcglab_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO fmcglab_reader;
    ${tables.map(t => `ANALYZE ${schema}.${t};`).join(' ')}`);
}

async function intoPg(fn: (con: DuckDBConnection) => Promise<void>) {
  await withTruth(async con => {
    await con.run(`INSTALL postgres; LOAD postgres; ATTACH ${lit(PG_ADMIN)} AS pgw (TYPE postgres)`);
    await fn(con);
  });
}

async function member() {
  psql(`
    DROP SCHEMA IF EXISTS ${MEMBER} CASCADE;
    CREATE SCHEMA ${MEMBER};
    CREATE TABLE ${MEMBER}.members (
      member_id TEXT PRIMARY KEY, mobile TEXT NOT NULL, unionid TEXT, nickname TEXT, gender CHAR(1), birthday DATE, city TEXT,
      registered_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${MEMBER}.memberships (
      card_no TEXT PRIMARY KEY, member_id TEXT NOT NULL, tier TEXT, points_balance INT NOT NULL, status TEXT NOT NULL,
      joined_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${MEMBER}.points_ledger (
      txn_id TEXT PRIMARY KEY, card_no TEXT NOT NULL, member_id TEXT NOT NULL, txn_type TEXT NOT NULL, points INT NOT NULL, balance_after INT,
      ref_no TEXT, occurred_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${MEMBER}.redemptions (
      redeem_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, gift_name TEXT NOT NULL, points_cost INT NOT NULL, status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${MEMBER}.coupon_templates (
      template_id TEXT PRIMARY KEY, name TEXT, type TEXT NOT NULL, face_value NUMERIC(12,2), discount_rate NUMERIC(4,3), threshold NUMERIC(12,2),
      campaign_id TEXT, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${MEMBER}.coupons (
      coupon_code TEXT PRIMARY KEY, template_id TEXT NOT NULL, member_id TEXT NOT NULL, campaign_id TEXT, status TEXT NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, discount_amount NUMERIC(12,2), expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${MEMBER}.consents (
      member_id TEXT NOT NULL, channel TEXT NOT NULL, status CHAR(1) NOT NULL, granted_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (member_id, channel));
    CREATE TABLE ${MEMBER}.preferences (
      member_id TEXT NOT NULL, pref_type TEXT NOT NULL, pref_value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (member_id, pref_type, pref_value));`);
  await intoPg(async con => {
    await con.run(`INSERT INTO pgw.${MEMBER}.members
      SELECT r.customer_id, r.phone_raw, r.unionid_raw, '禾川会员' || p.pid, CASE p.gender WHEN 'female' THEN 'F' WHEN 'male' THEN 'M' ELSE 'U' END, p.birthday, r.city,
        ${pgUtc('m.joined_utc')}, ${pgUtc('r.updated_utc')}
      FROM t.rec r JOIN t.person p USING (pid) JOIN t.membership m ON m.customer_id = r.customer_id WHERE r.src = 'member'`);
    await con.run(`INSERT INTO pgw.${MEMBER}.memberships
      SELECT membership_id, customer_id, ${caseMap('level', { normal: '普卡', silver: '银卡', gold: '金卡' })}, points, ${caseMap('status', { active: '正常', frozen: '冻结' })},
        ${pgUtc('joined_utc')}, ${pgUtc(`TIMESTAMP '${END}' - INTERVAL 1 HOUR`)}
      FROM t.membership`);
    await con.run(`INSERT INTO pgw.${MEMBER}.points_ledger
      SELECT ledger_id, membership_id, customer_id, reason, points_change, balance_after, ref, ${pgUtc('occurred_utc')}, ${pgUtc('expires_utc')}, ${pgUtc('occurred_utc')}
      FROM t.ledger`);
    await con.run(`INSERT INTO pgw.${MEMBER}.redemptions
      SELECT redeem_id, customer_id, gift, points_cost, status, ${pgUtc('created_utc')}, ${pgUtc('created_utc + INTERVAL 1 HOUR')} FROM t.redemption`);
    await con.run(`INSERT INTO pgw.${MEMBER}.coupon_templates
      SELECT coupon_template_id, name, ${caseMap('coupon_type', { cash: 'CASH', discount: 'DISCOUNT', gift: 'GIFT', shipping: 'FREESHIP' })},
        face_value, pay_percent / 100, min_spend, campaign_id, ${pgUtc(`TIMESTAMP '2024-01-01'`)}
      FROM t.coupon_template`);
    await con.run(`INSERT INTO pgw.${MEMBER}.coupons
      SELECT coupon_id, coupon_template_id, customer_id, campaign_id, ${caseMap('status', { issued: 'UNUSED', redeemed: 'USED', expired: 'EXPIRED', voided: 'VOID' })},
        ${pgUtc('issued_utc')}, ${pgUtc('redeemed_utc')}, CASE WHEN status = 'redeemed' THEN face END, ${pgUtc('expires_utc')},
        ${pgUtc('coalesce(redeemed_utc, issued_utc) + INTERVAL 1 HOUR')}
      FROM t.coupon`);
    await con.run(`INSERT INTO pgw.${MEMBER}.consents
      SELECT customer_id, upper(channel), CASE status WHEN 'granted' THEN 'Y' ELSE 'N' END, ${pgUtc('granted_utc')}, ${pgUtc('revoked_utc')},
        ${pgUtc('coalesce(revoked_utc, granted_utc)')}
      FROM t.consent WHERE src = 'member'`);
    await con.run(`INSERT INTO pgw.${MEMBER}.preferences SELECT customer_id, preference_type, preference_value, ${pgUtc('updated_utc')} FROM t.preference`);
  });
  pgReader(MEMBER, ['members', 'memberships', 'points_ledger', 'redemptions', 'coupon_templates', 'coupons', 'consents', 'preferences']);
  log(`Postgres ${MEMBER} 写好了`);
}

async function mall() {
  psql(`
    DROP SCHEMA IF EXISTS ${MALL} CASCADE;
    CREATE SCHEMA ${MALL};
    CREATE TABLE ${MALL}.orders (
      order_id BIGINT PRIMARY KEY, member_id TEXT NOT NULL, order_type TEXT NOT NULL, status TEXT NOT NULL, pay_amount NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL, paid_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${MALL}.order_items (
      item_id BIGINT PRIMARY KEY, order_id BIGINT NOT NULL, sku TEXT NOT NULL, qty INT NOT NULL, unit_price NUMERIC(12,2), line_amount NUMERIC(12,2));
    CREATE TABLE ${MALL}.subscriptions (
      sub_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, sku TEXT NOT NULL, plan TEXT NOT NULL, periods INT NOT NULL, delivered INT NOT NULL,
      status TEXT NOT NULL, start_date DATE NOT NULL, updated_at TIMESTAMPTZ NOT NULL);`);
  await intoPg(async con => {
    await con.run(`INSERT INTO pgw.${MALL}.orders
      SELECT o.order_id::BIGINT, o.customer_id, CASE WHEN s.key IS NOT NULL THEN '周期购' ELSE '普通' END, ${caseMap('o.status', ORDER_STATUS.mall)}, o.amount,
        ${pgUtc('o.created_utc')}, ${pgUtc('o.paid_utc')}, ${pgUtc('o.touched_utc')}
      FROM t.ord o LEFT JOIN t.subscription s USING (key) WHERE o.src = 'mall'`);
    await con.run(`INSERT INTO pgw.${MALL}.order_items
      SELECT item_id::BIGINT, order_id::BIGINT, product_id, quantity, unit_price, amount FROM t.item WHERE src = 'mall'`);
    await con.run(`INSERT INTO pgw.${MALL}.subscriptions
      SELECT s.sub_id, r.customer_id, s.product_id, s.plan, s.periods, s.delivered,
        ${caseMap('s.status', SUB_STATUS)}, (${cn('s.start_utc')})::DATE, ${pgUtc('s.start_utc + INTERVAL 1 HOUR')}
      FROM t.subscription s JOIN t.rec r ON r.pid = s.pid AND r.src = 'member'`);
  });
  pgReader(MALL, ['orders', 'order_items', 'subscriptions']);
  log(`Postgres ${MALL} 写好了`);
}

// ---------- MySQL：一物一码 fmcg_scan、奶站 fmcg_station、ERP fmcg_erp ----------
function mysql(sql: string) {
  execFileSync('container', ['exec', '-i', 'mysql', 'mysql', ...MYSQL_ROOT], { input: sql, stdio: ['pipe', 'inherit', 'ignore'] });
}

/** 由真值查询生成 CSV（\N 为空），再 LOAD DATA 进 MySQL 的表 */
async function loadMysql(con: DuckDBConnection, db: string, table: string, query: string) {
  const file = join(OUT, `${db}.${table}.csv`);
  await con.run(`COPY (${query}) TO ${lit(file)} (FORMAT csv, HEADER false, NULLSTR '\\N', QUOTE '"', ESCAPE '"')`);
  await pipeInto(file, ['mysql', 'mysql', '--local-infile=1', ...MYSQL_ROOT, '-e',
    `LOAD DATA LOCAL INFILE '/dev/stdin' INTO TABLE ${db}.${table} CHARACTER SET utf8mb4 FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' LINES TERMINATED BY '\\n'`]);
  rmSync(file);
}

const mysqlDb = (db: string, ddl: string) => mysql(`
  SET GLOBAL local_infile = 1;
  DROP DATABASE IF EXISTS ${db};
  CREATE DATABASE ${db} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
  ${ddl}
  CREATE USER IF NOT EXISTS 'fmcglab_reader'@'%' IDENTIFIED BY '${SECRETS.my}';
  GRANT SELECT ON ${db}.* TO 'fmcglab_reader'@'%';`);

async function scan() {
  mysqlDb(SCAN, `
    CREATE TABLE ${SCAN}.scan_users (
      openid VARCHAR(32) PRIMARY KEY, unionid VARCHAR(32), phone VARCHAR(20), nickname VARCHAR(64), city VARCHAR(16),
      first_scan_at DATETIME, updated_at DATETIME NOT NULL, KEY (updated_at));
    CREATE TABLE ${SCAN}.sku_points (sku VARCHAR(8) PRIMARY KEY, product_name VARCHAR(64), brand VARCHAR(16), points_per_scan INT NOT NULL, updated_at DATETIME NOT NULL);
    CREATE TABLE ${SCAN}.codes (
      code VARCHAR(20) PRIMARY KEY, sku VARCHAR(8) NOT NULL, batch_no VARCHAR(8) NOT NULL, produced_at DATETIME NOT NULL, sales_region VARCHAR(4) NOT NULL,
      created_at DATETIME NOT NULL, KEY (created_at));
    CREATE TABLE ${SCAN}.scans (
      scan_id BIGINT PRIMARY KEY, code VARCHAR(20) NOT NULL, openid VARCHAR(32) NOT NULL, sku VARCHAR(8), batch_no VARCHAR(8), scan_time DATETIME NOT NULL,
      scan_region VARCHAR(4), result VARCHAR(8) NOT NULL, reward_type VARCHAR(4) NOT NULL, reward_value DECIMAL(8,2) NOT NULL, created_at DATETIME NOT NULL,
      KEY (created_at));`);
  await withTruth(async con => {
    await loadMysql(con, SCAN, 'scan_users', `
      SELECT r.customer_id, r.unionid_raw, r.phone_raw, '微信用户' || right(r.customer_id, 4), r.city,
        (SELECT ${bj('min(s.scan_utc)')} FROM t.scan s WHERE s.openid = r.customer_id), ${bj('r.updated_utc')}
      FROM t.rec r WHERE r.src = 'scan'`);
    await loadMysql(con, SCAN, 'sku_points', `SELECT product_id, name, brand, scan_points, ${bj(`TIMESTAMP '2025-06-01'`)} FROM t.product`);
    await loadMysql(con, SCAN, 'codes', `SELECT code, product_id, batch_no, ${bj('produced_utc')}, sales_region, ${bj('produced_utc + INTERVAL 1 DAY')} FROM t.code`);
    await loadMysql(con, SCAN, 'scans', `
      SELECT s.scan_id, s.code, s.openid, CASE WHEN s.result <> '无效码' THEN s.product_id END, c.batch_no, ${bj('s.scan_utc')}, s.scan_region,
        s.result, s.reward_type, s.reward_value, ${bj('s.scan_utc + INTERVAL 2 SECOND')}
      FROM t.scan s LEFT JOIN t.code c USING (code)`);
  });
  log(`MySQL ${SCAN} 写好了`);
}

async function station() {
  mysqlDb(STATION, `
    CREATE TABLE ${STATION}.stations (station_id VARCHAR(8) PRIMARY KEY, station_name VARCHAR(32) NOT NULL, city VARCHAR(16), region_id VARCHAR(4) NOT NULL);
    CREATE TABLE ${STATION}.members (
      member_id INT PRIMARY KEY, name VARCHAR(32), phone VARCHAR(20), address_city VARCHAR(16), station_id VARCHAR(8),
      sms_notify TINYINT NOT NULL, notify_updated_at DATETIME, updated_at DATETIME NOT NULL, KEY (updated_at));
    CREATE TABLE ${STATION}.bills (
      bill_id INT PRIMARY KEY, member_id INT NOT NULL, station_id VARCHAR(8) NOT NULL, bill_month CHAR(7) NOT NULL, amount DECIMAL(12,2) NOT NULL,
      status VARCHAR(8) NOT NULL, created_at DATETIME NOT NULL, paid_at DATETIME, updated_at DATETIME NOT NULL, KEY (updated_at));`);
  await withTruth(async con => {
    await loadMysql(con, STATION, 'stations', `SELECT station_id, name, city, region_id FROM t.station`);
    await loadMysql(con, STATION, 'members', `
      SELECT r.customer_id::INT, p.name, r.phone_raw, r.city, (SELECT min(store_id) FROM t.ord o WHERE o.src = 'station' AND o.customer_id = r.customer_id AND NOT o.test_store),
        CASE WHEN c.status = 'granted' THEN 1 ELSE 0 END, ${bj('coalesce(c.revoked_utc, c.granted_utc)')}, ${bj('r.updated_utc')}
      FROM t.rec r JOIN t.person p USING (pid) LEFT JOIN t.consent c ON c.src = 'station' AND c.customer_id = r.customer_id WHERE r.src = 'station'`);
    await loadMysql(con, STATION, 'bills', `
      SELECT order_id::INT, customer_id::INT, store_id, ${bj('created_utc', '%Y-%m')}, amount, ${caseMap('status', ORDER_STATUS.station)},
        ${bj('created_utc')}, ${bj('paid_utc')}, ${bj('touched_utc')}
      FROM t.ord WHERE src = 'station'`);
  });
  log(`MySQL ${STATION} 写好了`);
}

async function erp() {
  mysqlDb(ERP, `
    CREATE TABLE ${ERP}.products (
      sku_code VARCHAR(8) PRIMARY KEY, name VARCHAR(64) NOT NULL, category VARCHAR(16) NOT NULL, brand VARCHAR(16), spec VARCHAR(16),
      list_price DECIMAL(12,2), barcode VARCHAR(13), updated_at DATETIME NOT NULL, KEY (updated_at));
    CREATE TABLE ${ERP}.regions (region_id VARCHAR(4) PRIMARY KEY, region_name VARCHAR(16) NOT NULL);`);
  await withTruth(async con => {
    await loadMysql(con, ERP, 'products', `
      SELECT product_id, name, category, CASE WHEN NOT erp_brand_missing THEN brand END, regexp_extract(name, ' (\\S+)（', 1), price,
        '69' || lpad((i * 7919)::VARCHAR, 11, '0'), ${bj(`TIMESTAMP '2025-01-01'`)}
      FROM t.product WHERE in_erp`);
    await loadMysql(con, ERP, 'regions', `SELECT region_id, name FROM t.region`);
  });
  log(`MySQL ${ERP} 写好了`);
}

// ---------- MongoDB：订单中台 fmcg_oms ----------
async function oms() {
  const file = join(OUT, 'oms.orders.ndjson');
  await withTruth(async con => {
    // 扩展 JSON：时间写 {"$date": …}，金额写 {"$numberDouble": …}（否则整数金额会存成 int32）。约 2% 的订单另有一个更早的旧版本文档（同一 so_id、待付款），
    // 映射按 so_id 去重、取 modified 最新的一版（K6）。嵌套字段平台按下划线展开：buyer.id → buyer_id、pay.total → pay_total
    const date = (c: string) => `CASE WHEN ${c} IS NOT NULL THEN struct_pack("$date" := strftime(${c}, '%Y-%m-%dT%H:%M:%S.000Z')) END`;
    const money = (c: string) => `struct_pack("$numberDouble" := (${c})::DOUBLE::VARCHAR)`;
    const PLATFORM = `CASE src WHEN 'tmall' THEN 'TMALL' WHEN 'jd' THEN 'JD' ELSE 'DOUYIN' END`;
    const doc = (status: string, paid: string, updated: string) => `
      SELECT order_id AS so_id, ${PLATFORM} AS platform, '禾川' || ${PLATFORM} || '旗舰店' AS shop, struct_pack(id := customer_id) AS buyer, ${status} AS status,
        struct_pack(total := ${money('amount')}, paid_at := ${date(paid)}) AS pay,
        struct_pack(company := logistics) AS logistics, ${date('created_utc')} AS created, ${date(updated)} AS modified
      FROM t.ord WHERE variant IS NOT NULL`;
    await con.run(`COPY (
      ${doc(caseMap('oms_status', ORDER_STATUS.oms), 'paid_utc', 'oms_updated_utc')}
      UNION ALL
      ${doc(`'WAIT_PAY'`, 'NULL::TIMESTAMP', 'created_utc')} AND oms_status <> 'created' AND (key = 'p01-tm' OR u(order_id, 'dup') < 0.02)
      UNION ALL
      SELECT so_id, 'B2B', '禾川企业团购', struct_pack(id := company), 'FINISHED', struct_pack(total := ${money('amount')}, paid_at := ${date('created_utc')}),
        struct_pack(company := '德邦'), ${date('created_utc')}, ${date('created_utc + INTERVAL 2 DAY')}
      FROM t.oms_b2b
    ) TO ${lit(file)} (FORMAT json)`);
  });
  execFileSync('container', ['exec', 'mongodb', 'mongosh', '--quiet', MONGO_URI, '--eval', `db.getSiblingDB('${OMS}').dropDatabase()`], { stdio: 'inherit' });
  await pipeInto(file, ['mongodb', 'mongoimport', '--quiet', '--uri', MONGO_URI, '--db', OMS, '--collection', 'orders', '--numInsertionWorkers', '4']);
  rmSync(file);
  execFileSync('container', ['exec', 'mongodb', 'mongosh', '--quiet', MONGO_URI, '--eval', `
    const a = db.getSiblingDB('admin');
    if (!a.getUser('fmcglab_ro')) a.createUser({ user: 'fmcglab_ro', pwd: '${SECRETS.mg}', roles: [{ role: 'read', db: '${OMS}' }] });
    else a.grantRolesToUser('fmcglab_ro', [{ role: 'read', db: '${OMS}' }]);
    print('${OMS}.orders 文档数 ' + db.getSiblingDB('${OMS}').orders.countDocuments());`], { stdio: 'inherit' });
  log(`MongoDB ${OMS} 写好了`);
}

// ---------- S3：天猫 Parquet，京东、抖店、活动、商超销量 CSV，埋点 JSON ----------
async function tmall() {
  await withTruth(async con => {
    await s3Secret(con);
    // 天猫只给 OUID（品牌内唯一的买家 ID）；入会（品牌会员通）的买家才有明文手机号，其余只有脱敏号
    await con.run(`COPY (
      SELECT r.customer_id AS ouid, 'tb_' || substr(md5(r.customer_id), 1, 8) AS buyer_nick, r.phone_raw AS member_mobile, r.phone_mask AS mobile_mask,
        CASE WHEN r.has_phone THEN 'VIP1' END AS member_level, epoch_ms(TIMESTAMP '2023-06-01' + to_days((r.pid % 900)::INT)) AS first_buy_ms
      FROM t.rec r WHERE r.src = 'tmall' ORDER BY ouid
    ) TO '${S3_PREFIX}/tmall/buyers/buyers.parquet' (FORMAT parquet)`);
    await con.run(`COPY (
      SELECT order_id::BIGINT AS tid, customer_id AS ouid, ${caseMap('plat_status', ORDER_STATUS.tmall)} AS trade_status, amount::DOUBLE AS payment,
        epoch_ms(created_utc) AS created_ms, epoch_ms(paid_utc) AS pay_ms, epoch_ms(plat_updated_utc) AS modified_ms
      FROM t.ord WHERE src = 'tmall' AND plat_status IS NOT NULL ORDER BY tid
    ) TO '${S3_PREFIX}/tmall/trades/trades.parquet' (FORMAT parquet)`);
    // 子订单：商家编码（outer_iid）没填时是空字符串（K4）
    await con.run(`COPY (
      SELECT i.item_id::BIGINT AS oid, i.order_id::BIGINT AS tid, coalesce(i.product_id, '') AS outer_iid, coalesce(p.name, '赠品') AS title, i.quantity AS num, i.amount::DOUBLE AS payment
      FROM t.item i LEFT JOIN t.product p USING (product_id) WHERE i.src = 'tmall' ORDER BY oid
    ) TO '${S3_PREFIX}/tmall/trade_items/trade_items.parquet' (FORMAT parquet)`);
  });
  log(`S3 Parquet ${S3_PREFIX}/tmall/ 写好了`);
}

async function jd() {
  // 京东导出：中文表头；用户 PIN；入会手机带 86- 前缀；明细只有京东 SKU，要用 SKU 对照表换成商家编码（源视图 jd_lines）
  await withTruth(async con => {
    await s3Secret(con);
    await con.run(`COPY (
      SELECT o.order_id AS "订单号", o.customer_id AS "用户PIN", r.phone_raw AS "入会手机", r.phone_mask AS "手机号（脱敏）", ${caseMap('o.plat_status', ORDER_STATUS.jd)} AS "订单状态",
        o.amount AS "应付金额", ${bj('o.created_utc')} AS "下单时间", ${bj('o.paid_utc')} AS "付款时间", ${bj('o.plat_updated_utc')} AS "更新时间"
      FROM t.ord o JOIN t.rec r ON r.src = 'jd' AND r.customer_id = o.customer_id WHERE o.src = 'jd' ORDER BY o.order_id
    ) TO '${S3_PREFIX}/jd/jd_orders/jd_orders.csv' (FORMAT csv, HEADER true)`);
    await con.run(`COPY (
      SELECT i.order_id AS "订单号", 'JD' || (100000 + substr(i.product_id, 3)::INT) AS "京东SKU", p.name AS "商品名称", i.quantity AS "数量", i.amount AS "金额"
      FROM t.item i JOIN t.product p USING (product_id) WHERE i.src = 'jd' ORDER BY 1, 2
    ) TO '${S3_PREFIX}/jd/jd_items/jd_items.csv' (FORMAT csv, HEADER true)`);
    await con.run(`COPY (
      SELECT 'JD' || (100000 + i) AS "京东SKU", product_id AS "商家编码" FROM t.product WHERE in_erp ORDER BY 1
    ) TO '${S3_PREFIX}/jd/sku_map/sku_map.csv' (FORMAT csv, HEADER true)`);
  });
  log(`S3 CSV ${S3_PREFIX}/jd/ 写好了`);
}

async function douyin() {
  // 抖店导出：中文表头、每单一行（直播带货一单一个商品）、买家信息内嵌；金额以分计；状态码数字；时间是北京时间字符串
  await withTruth(async con => {
    await s3Secret(con);
    await con.run(`COPY (
      SELECT o.order_id AS "订单编号", i.item_id AS "子订单编号", o.customer_id AS "买家openid", r.phone_raw AS "买家手机号", r.phone_mask AS "买家手机号（脱敏）",
        r.city AS "收货城市", ['禾川官方直播间', '达人·小鹿妈妈', '达人·牛奶哥', '达人·宝妈日记'][1 + (hash(o.order_id) % 4)::INT] AS "带货账号",
        i.product_id AS "商家编码", p.name AS "商品名称", i.quantity AS "数量", ${caseMap('o.plat_status', ORDER_STATUS.douyin)} AS "订单状态",
        (o.amount * 100)::BIGINT AS "实付金额（分）", ${bj('o.created_utc')} AS "下单时间", ${bj('o.paid_utc')} AS "支付时间", ${bj('o.plat_updated_utc')} AS "更新时间"
      FROM t.ord o JOIN t.rec r ON r.src = 'douyin' AND r.customer_id = o.customer_id JOIN t.item i ON i.src = 'douyin' AND i.order_id = o.order_id
      JOIN t.product p ON p.product_id = i.product_id
      WHERE o.src = 'douyin' ORDER BY o.order_id
    ) TO '${S3_PREFIX}/douyin/dy_orders/dy_orders.csv' (FORMAT csv, HEADER true)`);
  });
  log(`S3 CSV ${S3_PREFIX}/douyin/ 写好了`);
}

async function events() {
  for (const { path } of await listObjects(s3, `${S3_PREFIX}/events/`)) await deleteObject(s3, `${S3_PREFIX}/events/${path}`);
  await withTruth(async con => {
    await s3Secret(con);
    const select = `SELECT event_id, customer_id AS user_id, device_id, event_type AS event_name, epoch_ms(occurred_utc) AS ts_ms, page FROM t.event`;
    if (N < 1_000_000) await con.run(`COPY (${select} ORDER BY event_id) TO '${S3_PREFIX}/events/events/events.json' (FORMAT json)`);
    else {
      for (const { m } of await rows<{ m: string }>(con, `SELECT DISTINCT strftime(occurred_utc, '%Y-%m') AS m FROM t.event ORDER BY 1`))
        await con.run(`COPY (${select} WHERE strftime(occurred_utc, '%Y-%m') = ${lit(m)} ORDER BY event_id) TO '${S3_PREFIX}/events/events/events-${m}.parquet' (FORMAT parquet)`);
    }
  });
  log(`S3 ${N < 1_000_000 ? 'JSON' : 'Parquet'} ${S3_PREFIX}/events/ 写好了`);
}

async function activity() {
  // 地推试饮报名表：手填，没有可靠的 ID；手机号格式杂、偶有错号，导购替路人填了自己的手机号（P05）；时间形如 2026/9/1 14:05（北京时间）
  await withTruth(async con => {
    await s3Secret(con);
    await con.run(`COPY (
      SELECT s.signup_id AS "报名编号", p.name AS "姓名", r.phone_raw AS "手机", a.name AS "活动", s.activity_id AS "活动编号", p.city AS "城市",
        ${bj('s.signup_utc', '%Y/%-m/%-d %H:%M')} AS "报名时间", CASE WHEN s.received THEN '是' ELSE '否' END AS "是否领取"
      FROM t.signup s JOIN t.person p USING (pid) JOIN t.activity a USING (activity_id) JOIN t.rec r ON r.src = 'activity' AND r.customer_id = s.signup_id
      ORDER BY s.signup_id
    ) TO '${S3_PREFIX}/activity/signups/signups.csv' (FORMAT csv, HEADER true)`);
  });
  log(`S3 CSV ${S3_PREFIX}/activity/ 写好了`);
}

async function sellout() {
  // 经销商每周回传的商超门店销量：没有消费者，只能做门店、商品维度的分析（工作台），不能做指标
  await withTruth(async con => {
    await s3Secret(con);
    await con.run(`COPY (SELECT store_code AS "门店编码", name AS "门店名称", chain AS "系统", city AS "城市", region_id AS "大区" FROM t.ka_store ORDER BY 1)
      TO '${S3_PREFIX}/sellout/ka_stores/ka_stores.csv' (FORMAT csv, HEADER true)`);
    await con.run(`COPY (SELECT week AS "周", week_start AS "周一", store_code AS "门店编码", product_id AS "商家编码", qty AS "销量", amount AS "销售额"
      FROM t.sellout ORDER BY 2, 3, 4) TO '${S3_PREFIX}/sellout/sellout/sellout.csv' (FORMAT csv, HEADER true)`);
  });
  log(`S3 CSV ${S3_PREFIX}/sellout/ 写好了`);
}

// ---------- S3 上的 DuckDB 文件：企业微信社群 ----------
async function wecom() {
  rmSync(WECOM, { force: true });
  rmSync(`${WECOM}.wal`, { force: true });
  await withTruth(async con => {
    await con.run(`ATTACH ${lit(WECOM)} AS w`);
    await con.run(`CREATE TABLE w.contacts AS
      SELECT c.external_userid, r.unionid_raw AS unionid, r.phone_raw AS mobile, c.owner_id, ${cn('c.added_utc')} AS add_time, ${cn('c.deleted_utc')} AS del_time,
        ${cn('coalesce(c.deleted_utc, c.added_utc)')} AS update_time
      FROM t.wecom_contact c JOIN t.rec r ON r.src = 'wecom' AND r.customer_id = c.external_userid`);
    await con.run(`CREATE TABLE w.groups AS SELECT group_id, name AS group_name, region_id FROM t.wecom_group`);
    await con.run(`CREATE TABLE w.group_members AS
      SELECT group_id, external_userid, ${cn('joined_utc')} AS join_time, ${cn('quit_utc')} AS quit_time, ${cn('coalesce(quit_utc, joined_utc)')} AS update_time
      FROM t.wecom_member`);
    await con.run(`CREATE TABLE w.mass_sends AS
      SELECT send_id, external_userid, campaign_id, ${cn('sent_utc')} AS send_time,
        ${caseMap('status', { failed: '失败', delivered: '送达', opened: '已读', clicked: '点击' })} AS result
      FROM t.wecom_send`);
    await con.run(`DETACH w`);
  });
  const size = statSync(WECOM).size;
  await putObject(s3, `${S3_PREFIX}/wecom/wecom.duckdb`, Readable.toWeb(createReadStream(WECOM)) as ReadableStream<Uint8Array>, size);
  log(`DuckDB 文件 ${S3_PREFIX}/wecom/wecom.duckdb 写好了（${(size / 1048576).toFixed(1)} MiB）`);
}

// ---------- S3 只读账号：只能读 crm-source/fmcg/ ----------
async function iam(action: string, params: Record<string, string>) {
  const res = await signedFetch(s3, 'iam', {
    method: 'POST', path: '/',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams({ Action: action, Version: '2010-05-08', ...params }).toString(),
  });
  const xml = await res.text();
  if (!res.ok && !(action === 'CreateUser' && xmlTag(xml, 'Code') === 'EntityAlreadyExists')) throw new Error(`IAM ${action}：${xml}`);
  return xml;
}

async function accounts() {
  const UserName = 'src-fmcglab-ro';
  await iam('CreateUser', { UserName });
  // 上次签发的密钥还有效就沿用：已登记的 S3 数据源用的就是它，重新签发会让它们连不上
  const keys = xmlTags(await iam('ListAccessKeys', { UserName }), 'AccessKeyId');
  const saved = existsSync(CREDENTIALS) ? /Access Key (\S+)  Secret (\S+)/.exec(readFileSync(CREDENTIALS, 'utf8')) : null;
  const reuse = saved && keys.includes(saved[1]!);
  for (const AccessKeyId of keys) if (!reuse || AccessKeyId !== saved![1]) await iam('DeleteAccessKey', { UserName, AccessKeyId });
  await iam('PutUserPolicy', {
    UserName, PolicyName: 'fmcg-source-read',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::crm-source/fmcg/*'] },
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: ['arn:aws:s3:::crm-source'], Condition: { StringLike: { 's3:prefix': ['fmcg/*'] } } },
      ],
    }),
  });
  let key = saved?.[1] ?? '', secret = saved?.[2] ?? '';
  if (!reuse) {
    const xml = await iam('CreateAccessKey', { UserName });
    key = xmlTag(xml, 'AccessKeyId') ?? '';
    secret = xmlTag(xml, 'SecretAccessKey') ?? '';
  }
  writeFileSync(CREDENTIALS, [
    `# fmcglab 测试数据源的只读账号（seed.ts 生成，不要提交）。两档共用账号；规模档（--set 10m）的库、schema 加后缀 _10m，S3 前缀多一级 10m/`,
    `Postgres  主机 localhost  端口 5432  库 crm  schema fmcg_member / fmcg_mall  用户 fmcglab_reader  密码 ${SECRETS.pg}`,
    `MySQL     主机 localhost  端口 3306  库 fmcg_scan / fmcg_station / fmcg_erp  用户 fmcglab_reader  密码 ${SECRETS.my}`,
    `MongoDB   主机 localhost  端口 27017  库 fmcg_oms  认证库 admin  用户 fmcglab_ro  密码 ${SECRETS.mg}`,
    `S3        端点 ${s3.endpoint}  区域 ${s3.region}  路径风格 ${s3.urlStyle}  SSL ${s3.useSsl}  Access Key ${key}  Secret ${secret}`,
    `          前缀 s3://crm-source/fmcg/tmall/ …/jd/ …/douyin/ …/events/ …/activity/ …/sellout/   DuckDB 文件 s3://crm-source/fmcg/wecom/wecom.duckdb`,
    '',
  ].join('\n'));
  log(`只读账号写在 ${CREDENTIALS}`);
}

// ---------- 第二轮变更（plan T7）：真值打补丁，再把同样的变更就地写进数据源 ----------
async function round2() {
  if (!existsSync(TRUTH)) throw new Error('还没有第一轮的真值：先不带 --round 跑一遍');
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const NOW = `TIMESTAMP ${lit(now)}`;
  {
    const con = await open(TRUTH);
    const [m] = await rows<{ round: number }>(con, `SELECT round FROM meta`);
    if (Number(m!.round) !== 1) { con.closeSync(); throw new Error(`真值已经是第 ${m!.round} 轮：第二轮只能在第一轮之后跑一次（重来请不带 --round 重新造数）`); }
    await con.run(readFileSync(join(HERE, 'round2.sql'), 'utf8').replaceAll('${NOW}', NOW));
    await con.run(readFileSync(join(HERE, 'identity.sql'), 'utf8'));
    con.closeSync();
  }
  const one = async (con: DuckDBConnection, sql: string) => (await rows<Record<string, string>>(con, sql))[0]!;
  await withTruth(async con => {
    // 商城：新订单与明细；会员中心：订单与扫码积分、余额、P01 改城市、退订微信；周期购暂停（修改时间都是现在，按水位线增量同步）
    await con.run(`INSTALL postgres; LOAD postgres; ATTACH ${lit(PG_ADMIN)} AS pgw (TYPE postgres)`);
    await con.run(`INSERT INTO pgw.${MALL}.orders
      SELECT order_id::BIGINT, customer_id, '普通', 'PAID', amount, ${pgUtc('created_utc')}, ${pgUtc('created_utc + INTERVAL 10 MINUTE')}, ${pgUtc(NOW)} FROM t.r2_orders`);
    await con.run(`INSERT INTO pgw.${MALL}.order_items SELECT item_id::BIGINT, order_id::BIGINT, product_id, 1, amount, amount FROM t.r2_items`);
    await con.run(`INSERT INTO pgw.${MEMBER}.points_ledger
      SELECT l.ledger_id, l.membership_id, l.customer_id, l.reason, l.points_change, l.balance_after, l.ref, ${pgUtc('l.occurred_utc')}, ${pgUtc('l.expires_utc')}, ${pgUtc(NOW)}
      FROM t.ledger l WHERE l.ledger_id IN (SELECT ledger_id FROM t.r2_ledger)`);
    const cards = await rows<{ membership_id: string; points: number }>(con, `SELECT membership_id, points FROM t.membership WHERE membership_id IN (SELECT membership_id FROM t.r2_ledger) AND pid <> 99000018`);
    const city = await one(con, `SELECT customer_id, city FROM t.r2_city`);
    const consent = await one(con, `SELECT customer_id, channel FROM t.r2_consent`);
    const sub = await one(con, `SELECT sub_id FROM t.subscription WHERE key IN (SELECT key FROM t.r2_sub)`);
    await con.run(`DETACH pgw`);
    psql(`
      UPDATE ${MEMBER}.memberships m SET points_balance = v.points, updated_at = now() FROM (VALUES ${cards.map(c => `(${lit(c.membership_id)}, ${Number(c.points)})`).join(', ')}) v(card, points)
        WHERE m.card_no = v.card;
      UPDATE ${MEMBER}.members SET city = ${lit(city.city!)}, updated_at = now() WHERE member_id = ${lit(city.customer_id!)};
      UPDATE ${MEMBER}.consents SET status = 'N', revoked_at = now(), updated_at = now() WHERE member_id = ${lit(consent.customer_id!)} AND channel = ${lit(consent.channel!.toUpperCase())};
      UPDATE ${MALL}.subscriptions SET status = 'PAUSED', updated_at = now() WHERE sub_id = ${lit(sub.sub_id!)};`);
    log(`商城：${(await one(con, 'SELECT count(*) AS n FROM t.r2_orders')).n} 笔新订单；会员中心：${cards.length} 张卡加了积分、P01 改城市、退订微信；周期购暂停 1 张`);
    // 扫码平台：P03 绑手机、新扫码；ERP：补品牌、新品建档（修改时间是现在的北京时间）
    const [{ bjNow }] = await rows<{ bjNow: string }>(con, `SELECT ${bj(NOW)} AS bjNow`);
    const bind = await one(con, `SELECT customer_id, phone FROM t.r2_bind`);
    mysql(`UPDATE ${SCAN}.scan_users SET phone = ${lit(bind.phone!)}, updated_at = '${bjNow}' WHERE openid = ${lit(bind.customer_id!)};`);
    await loadMysql(con, SCAN, 'codes', `SELECT code, product_id, 'B' || strftime(scan_utc - INTERVAL 20 DAY, '%Y%m'), ${bj('scan_utc - INTERVAL 20 DAY')}, scan_region, '${bjNow}' FROM t.r2_scans`);
    await loadMysql(con, SCAN, 'scans', `
      SELECT s.scan_id, s.code, s.openid, s.product_id, 'B' || strftime(s.scan_utc - INTERVAL 20 DAY, '%Y%m'), ${bj('s.scan_utc')}, s.scan_region, s.result,
        s.reward_type, s.reward_value, '${bjNow}'
      FROM t.scan s WHERE s.sk IN (SELECT sk FROM t.r2_scans)`);
    const brand = await one(con, `SELECT product_id, brand FROM t.r2_product`);
    mysql(`UPDATE ${ERP}.products SET brand = ${lit(brand.brand!)}, updated_at = '${bjNow}' WHERE sku_code = ${lit(brand.product_id!)};`);
    await loadMysql(con, ERP, 'products', `
      SELECT product_id, name, category, brand, regexp_extract(name, ' (\\S+)（', 1), price, '69' || lpad((i * 7919)::VARCHAR, 11, '0'), '${bjNow}'
      FROM t.product WHERE product_id = 'HC0061'`);
    log(`扫码平台：P03 绑手机、${(await one(con, 'SELECT count(*) AS n FROM t.r2_scans')).n} 次新扫码；ERP：${brand.product_id} 补品牌、HC0061 建档`);
    // 订单中台：5 笔天猫订单退款（modified 是现在）
    const refunds = (await rows<{ order_id: string }>(con, `SELECT order_id FROM t.r2_oms_refund`)).map(r => r.order_id);
    execFileSync('container', ['exec', 'mongodb', 'mongosh', '--quiet', MONGO_URI, '--eval', `
      const r = db.getSiblingDB('${OMS}').orders.updateMany({ so_id: { $in: ${JSON.stringify(refunds)} }, status: { $ne: 'WAIT_PAY' } },
        { $set: { status: 'REFUNDED', modified: new Date('${now.replace(' ', 'T')}Z') } });
      print('订单中台退款 ' + r.modifiedCount + ' 笔');`], { stdio: 'inherit' });
  });
  // 天猫导出少 3 笔：重新导出文件（全量比对）
  await tmall();
  log('第二轮变更写好了：同步后用 verify.ts 核对（期望已按第二轮更新）');
}

const started = Date.now();
if (args.round === '2') {
  await round2();
  log(`完成，用时 ${((Date.now() - started) / 60000).toFixed(1)} 分钟`);
  process.exit(0);
}
if (step('truth') || !existsSync(TRUTH)) await truth();
if (step('member')) await member();
if (step('mall')) await mall();
if (step('scan')) await scan();
if (step('station')) await station();
if (step('erp')) await erp();
if (step('oms')) await oms();
if (step('tmall')) await tmall();
if (step('jd')) await jd();
if (step('douyin')) await douyin();
if (step('events')) await events();
if (step('activity')) await activity();
if (step('wecom')) await wecom();
if (step('sellout')) await sellout();
if (step('accounts')) await accounts();
log(`完成，用时 ${((Date.now() - started) / 60000).toFixed(1)} 分钟`);
