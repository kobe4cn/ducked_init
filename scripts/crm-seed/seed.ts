// scripts/crm-seed/seed.ts —— crmlab 多渠道 CRM 测试造数：先在本机 out/truth.duckdb 里生成真值（truth.sql），再写进 9 个数据源，并建好只读账号。
// 用法：node --env-file=.env --import tsx scripts/crm-seed/seed.ts [--persons 50000] [--end 2026-10-10] [--only 步骤,…]
//   --persons 真实的人数（另加 25 个探针）；--end 数据终点日（UTC，默认今天）：订单、行为都在这一天之前，探针的时间相对它取
//   --only 只跑这几步：truth,mall,loyalty,pos,oms,tmall,douyin,events,activity,wecom,accounts（真值不存在时总会先生成）
//   --set 10m 规模档：写进另一套库、schema 与 S3 前缀（crm_pos_10m、crm_mall_10m…、s3://crm-source/crm/10m/），真值在 out/10m/，与默认的一套并存
//   --round 2 第二轮变更（plan T6）：不重建，在现有真值与数据源上就地执行 round2.sql 的变更（--persons、--end、--only 不起作用）
// 可重复执行：每个数据源先删后建（只动 crm_* 的库、schema、集合与 s3://crm-source/crm/ 前缀），只读账号已存在时沿用（S3 的密钥仍有效时也沿用）。
// 千万级时用批量通道：Postgres 走 DuckDB postgres 扩展（COPY 协议），MySQL 走 LOAD DATA LOCAL INFILE，Mongo 走 mongoimport，S3 由 DuckDB 直接写
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { platformS3 } from '../../app/.server/s3-accounts';
import { putObject, signedFetch, xmlTag, xmlTags } from '../../app/.server/s3-client';

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
if (!/^\d{4}-\d{2}-\d{2}$/.test(END)) throw new Error('--end 形如 2026-10-10');
const ONLY = args.only?.split(',');
const step = (name: string) => !ONLY || ONLY.includes(name);

const HERE = dirname(fileURLToPath(import.meta.url));
/** 数据集：默认（正确性档）或 --set 10m（规模档）。两档的库、schema、集合、S3 前缀与真值各自独立，可以并存；只读账号与 S3 密钥共用 */
const SET = args.set!;
if (!/^[a-z0-9]*$/.test(SET)) throw new Error('--set 只能是小写字母与数字，如 10m');
const SUFFIX = SET ? `_${SET}` : '';
const MALL = `crm_mall${SUFFIX}`, LOY = `crm_loyalty${SUFFIX}`, POS = `crm_pos${SUFFIX}`, OMS = `crm_oms${SUFFIX}`;
const OUT = SET ? join(HERE, 'out', SET) : join(HERE, 'out');
const CREDENTIALS = join(HERE, 'out', 'credentials.txt');
const TRUTH = join(OUT, 'truth.duckdb');
const WECOM = join(OUT, 'wecom.duckdb');
const PG_ADMIN = 'postgresql://crm:crm@localhost:5432/crm';
const MYSQL_ROOT = ['-uroot', '-pcrm', '--default-character-set=utf8mb4'];
const MONGO_URI = 'mongodb://crm:crm-secret@localhost:27017/?authSource=admin';
const S3_PREFIX = `s3://crm-source/crm${SET ? `/${SET}` : ''}`;
const SECRETS = { pg: 'crmlab-reader-secret', my: 'crmlab-reader-secret', mg: 'crmlab-ro-secret' };
/** 行为事件：小规模用 JSON（覆盖 JSON 格式的数据源），百万人以上用 Parquet（JSON 太大、同步太慢） */
const EVENTS_FORMAT = N >= 1_000_000 ? 'parquet' : 'json';

const s3 = platformS3();
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
/** UTC 时间转成北京时间（不带时区）：MySQL、DuckDB 文件、CSV 里的时间都这样存 */
const cn = (c: string) => `timezone('Asia/Shanghai', timezone('UTC', ${c}))`;
const caseMap = (col: string, m: Record<string, string>) => `CASE ${col} ${Object.entries(m).map(([k, v]) => `WHEN ${lit(k)} THEN ${lit(v)}`).join(' ')} END`;
const ORDER_STATUS = {
  mall: { created: 'pending', paid: 'paid', shipped: 'shipped', completed: 'completed', cancelled: 'cancelled', refunded: 'refunded' },
  pos: { created: '待支付', paid: '已支付', shipped: '已发货', completed: '已完成', cancelled: '已取消', refunded: '已退款' },
  tmall: { created: 'WAIT_BUYER_PAY', paid: 'WAIT_SELLER_SEND_GOODS', shipped: 'WAIT_BUYER_CONFIRM_GOODS', completed: 'TRADE_FINISHED', cancelled: 'TRADE_CLOSED', refunded: 'REFUND_SUCCESS' },
  douyin: { created: '1', paid: '2', shipped: '3', completed: '5', cancelled: '4', refunded: '21' },
};
/** 源端最后修改时间：支付（或下单）后一小时 */
const touched = 'coalesce(paid_utc, created_utc) + INTERVAL 1 HOUR';

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
    SELECT src, count(*) AS records, (SELECT count(*) FROM ord WHERE ord.src = rec.src) AS orders FROM rec GROUP BY src ORDER BY src`))
    log(`真值 ${r.src}: 消费者记录 ${r.records}，订单 ${r.orders}`);
  const [s] = await rows<Record<string, string>>(con, `
    SELECT (SELECT count(DISTINCT group_rid) FROM expected_identity) AS consumers, (SELECT count(*) FROM item) AS items,
      (SELECT count(*) FROM ledger) AS ledger, (SELECT count(*) FROM coupon) AS coupons, (SELECT count(*) FROM event) AS events`);
  log(`真值：期望的统一消费者 ${s!.consumers}，订单明细 ${s!.items}，积分流水 ${s!.ledger}，券 ${s!.coupons}，行为事件 ${s!.events}`);
  con.closeSync();
}

// ---------- Postgres：自营商城 crm_mall、会员中心 crm_loyalty ----------
function psql(sql: string) {
  execFileSync('psql', [PG_ADMIN, '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'inherit' });
}

function pgReader(schema: string, tables: string[]) {
  psql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crmlab_reader') THEN CREATE ROLE crmlab_reader LOGIN PASSWORD '${SECRETS.pg}'; END IF;
    END $$;
    GRANT CONNECT ON DATABASE crm TO crmlab_reader;
    GRANT USAGE ON SCHEMA ${schema} TO crmlab_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO crmlab_reader;
    ${tables.map(t => `ANALYZE ${schema}.${t};`).join(' ')}`);
}

async function intoPg(fn: (con: DuckDBConnection) => Promise<void>) {
  await withTruth(async con => {
    await con.run(`INSTALL postgres; LOAD postgres; ATTACH ${lit(PG_ADMIN)} AS pgw (TYPE postgres)`);
    await fn(con);
  });
}

async function mall() {
  psql(`
    DROP SCHEMA IF EXISTS ${MALL} CASCADE;
    CREATE SCHEMA ${MALL};
    CREATE TABLE ${MALL}.users (
      user_id BIGINT PRIMARY KEY, nickname TEXT, mobile TEXT, email TEXT, unionid TEXT, gender CHAR(1), birthday DATE, city TEXT,
      registered_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${MALL}.products (sku TEXT PRIMARY KEY, title TEXT, category TEXT, brand TEXT, list_price NUMERIC(12,2), updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${MALL}.orders (
      order_id BIGINT PRIMARY KEY, user_id BIGINT, status TEXT NOT NULL, pay_amount NUMERIC(12,2) NOT NULL, channel TEXT,
      created_at TIMESTAMPTZ NOT NULL, paid_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${MALL}.order_items (
      item_id BIGINT PRIMARY KEY, order_id BIGINT NOT NULL, sku TEXT NOT NULL, qty INT NOT NULL, unit_price NUMERIC(12,2), line_amount NUMERIC(12,2));`);
  await intoPg(async con => {
    await con.run(`INSERT INTO pgw.${MALL}.users
      SELECT r.customer_id::BIGINT, '商城用户' || p.pid, r.phone_raw, r.email_raw, r.unionid_raw,
        CASE p.gender WHEN 'female' THEN 'F' WHEN 'male' THEN 'M' END, p.birthday, r.city,
        timezone('UTC', TIMESTAMP '2021-01-01' + to_days(floor(u(p.pid, 'reg') * 1800)::INT)),
        timezone('UTC', TIMESTAMP '2021-01-02' + to_days(floor(u(p.pid, 'reg') * 1800)::INT))
      FROM t.rec r JOIN t.person p USING (pid) WHERE r.src = 'mall'`);
    await con.run(`INSERT INTO pgw.${MALL}.products
      SELECT product_id, name, category, brand, price, timezone('UTC', TIMESTAMP '2024-01-01') FROM t.product`);
    await con.run(`INSERT INTO pgw.${MALL}.orders
      SELECT order_id::BIGINT, customer_id::BIGINT, ${caseMap('status', ORDER_STATUS.mall)}, amount, channel,
        timezone('UTC', created_utc), timezone('UTC', paid_utc), timezone('UTC', ${touched})
      FROM t.ord WHERE src = 'mall'`);
    await con.run(`INSERT INTO pgw.${MALL}.order_items
      SELECT item_id::BIGINT, order_id::BIGINT, product_id, quantity, unit_price, amount FROM t.item WHERE src = 'mall'`);
  });
  pgReader(MALL, ['users', 'products', 'orders', 'order_items']);
  log(`Postgres ${MALL} 写好了`);
}

async function loyalty() {
  psql(`
    DROP SCHEMA IF EXISTS ${LOY} CASCADE;
    CREATE SCHEMA ${LOY};
    CREATE TABLE ${LOY}.members (member_id TEXT PRIMARY KEY, mobile TEXT, email TEXT, unionid TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${LOY}.memberships (
      card_no TEXT PRIMARY KEY, member_id TEXT NOT NULL, tier TEXT, points_balance INT NOT NULL, status TEXT NOT NULL,
      joined_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${LOY}.points_ledger (
      txn_id TEXT PRIMARY KEY, card_no TEXT NOT NULL, member_id TEXT NOT NULL, txn_type TEXT NOT NULL, points INT NOT NULL, balance_after INT,
      order_source TEXT, order_no TEXT, occurred_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ);
    CREATE TABLE ${LOY}.coupon_templates (
      template_id TEXT PRIMARY KEY, name TEXT, type TEXT NOT NULL, face_value NUMERIC(12,2), discount_rate NUMERIC(4,3), threshold NUMERIC(12,2),
      campaign_id TEXT, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${LOY}.coupons (
      coupon_code TEXT PRIMARY KEY, template_id TEXT NOT NULL, member_id TEXT NOT NULL, campaign_id TEXT, status TEXT NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, discount_amount NUMERIC(12,2), expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ${LOY}.consents (
      member_id TEXT NOT NULL, channel TEXT NOT NULL, status CHAR(1) NOT NULL, granted_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (member_id, channel));
    CREATE TABLE ${LOY}.preferences (
      member_id TEXT NOT NULL, pref_type TEXT NOT NULL, pref_value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (member_id, pref_type, pref_value));`);
  await intoPg(async con => {
    await con.run(`INSERT INTO pgw.${LOY}.members
      SELECT customer_id, phone_raw, email_raw, unionid_raw, timezone('UTC', m.joined_utc), timezone('UTC', m.joined_utc + INTERVAL 1 DAY)
      FROM t.rec r JOIN t.membership m USING (customer_id) WHERE r.src = 'loyalty'`);
    await con.run(`INSERT INTO pgw.${LOY}.memberships
      SELECT membership_id, customer_id, level, points, ${caseMap('status', { active: '正常', frozen: '冻结', cancelled: '注销' })},
        timezone('UTC', joined_utc), NULL, timezone('UTC', TIMESTAMP '${END}' - INTERVAL 1 HOUR)
      FROM t.membership`);
    await con.run(`INSERT INTO pgw.${LOY}.points_ledger
      SELECT ledger_id, membership_id, customer_id, upper(change_type), points_change, balance_after, order_src, order_id,
        timezone('UTC', occurred_utc), timezone('UTC', expires_utc)
      FROM t.ledger`);
    await con.run(`INSERT INTO pgw.${LOY}.coupon_templates
      SELECT coupon_template_id, name, ${caseMap('coupon_type', { cash: 'CASH', discount: 'DISCOUNT', gift: 'GIFT', shipping: 'FREESHIP' })},
        face_value, pay_percent / 100, min_spend, campaign_id, timezone('UTC', TIMESTAMP '2024-01-01')
      FROM t.coupon_template`);
    await con.run(`INSERT INTO pgw.${LOY}.coupons
      SELECT coupon_id, coupon_template_id, customer_id, campaign_id, ${caseMap('status', { issued: 'UNUSED', redeemed: 'USED', expired: 'EXPIRED', voided: 'VOID' })},
        timezone('UTC', issued_utc), timezone('UTC', redeemed_utc), CASE WHEN status = 'redeemed' THEN face END, timezone('UTC', expires_utc),
        timezone('UTC', coalesce(redeemed_utc, issued_utc) + INTERVAL 1 HOUR)
      FROM t.coupon`);
    await con.run(`INSERT INTO pgw.${LOY}.consents
      SELECT customer_id, upper(channel), CASE status WHEN 'granted' THEN 'Y' ELSE 'N' END, timezone('UTC', granted_utc), timezone('UTC', revoked_utc),
        timezone('UTC', coalesce(revoked_utc, granted_utc))
      FROM t.consent WHERE src = 'loyalty'`);
    await con.run(`INSERT INTO pgw.${LOY}.preferences
      SELECT customer_id, preference_type, preference_value, timezone('UTC', updated_utc) FROM t.preference`);
  });
  pgReader(LOY, ['members', 'memberships', 'points_ledger', 'coupon_templates', 'coupons', 'consents', 'preferences']);
  log(`Postgres ${LOY} 写好了`);
}

// ---------- MySQL：门店收银 crm_pos ----------
function mysql(sql: string) {
  execFileSync('container', ['exec', '-i', 'mysql', 'mysql', ...MYSQL_ROOT], { input: sql, stdio: ['pipe', 'inherit', 'ignore'] });
}

/** 由真值查询生成 CSV（\N 为空），再 LOAD DATA 进 MySQL 的表 */
async function loadMysql(con: DuckDBConnection, table: string, query: string) {
  const file = join(OUT, `pos.${table}.csv`);
  await con.run(`COPY (${query}) TO ${lit(file)} (FORMAT csv, HEADER false, NULLSTR '\\N', QUOTE '"', ESCAPE '"')`);
  await pipeInto(file, ['mysql', 'mysql', '--local-infile=1', ...MYSQL_ROOT, '-e',
    `LOAD DATA LOCAL INFILE '/dev/stdin' INTO TABLE ${POS}.${table} CHARACTER SET utf8mb4 FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"' LINES TERMINATED BY '\\n'`]);
  rmSync(file);
}

async function pos() {
  mysql(`
    SET GLOBAL local_infile = 1;
    DROP DATABASE IF EXISTS ${POS};
    CREATE DATABASE ${POS} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
    CREATE TABLE ${POS}.regions (region_id VARCHAR(8) PRIMARY KEY, region_name VARCHAR(32) NOT NULL);
    CREATE TABLE ${POS}.stores (store_code VARCHAR(8) PRIMARY KEY, store_name VARCHAR(64) NOT NULL, region_id VARCHAR(8) NOT NULL);
    CREATE TABLE ${POS}.guides (guide_id VARCHAR(8) PRIMARY KEY, guide_name VARCHAR(32) NOT NULL, store_code VARCHAR(8) NOT NULL);
    CREATE TABLE ${POS}.members (
      member_id INT PRIMARY KEY, member_name VARCHAR(64), phone VARCHAR(32), email VARCHAR(128), city VARCHAR(16),
      sms_opt_in TINYINT NOT NULL, opt_updated_at DATETIME, registered_at DATETIME NOT NULL, updated_at DATETIME NOT NULL);
    CREATE TABLE ${POS}.sales (
      sale_id INT PRIMARY KEY, member_id INT NULL, status VARCHAR(8) NOT NULL, amount DECIMAL(12,2) NOT NULL,
      sold_at DATETIME NOT NULL, paid_at DATETIME NULL, store_code VARCHAR(8) NOT NULL, is_void TINYINT NOT NULL DEFAULT 0, updated_at DATETIME NOT NULL,
      KEY (updated_at));
    CREATE TABLE ${POS}.sale_items (
      line_id INT PRIMARY KEY, sale_id INT NOT NULL, sku VARCHAR(16) NOT NULL, qty INT NOT NULL, price DECIMAL(12,2), line_amount DECIMAL(12,2));
    CREATE USER IF NOT EXISTS 'crmlab_reader'@'%' IDENTIFIED BY '${SECRETS.my}';
    GRANT SELECT ON ${POS}.* TO 'crmlab_reader'@'%';`);
  await withTruth(async con => {
    await loadMysql(con, 'regions', `SELECT region_id, name FROM t.region`);
    await loadMysql(con, 'stores', `SELECT store_id, name, region_id FROM t.store`);
    await loadMysql(con, 'guides', `SELECT guide_id, name, store_id FROM t.guide`);
    await loadMysql(con, 'members', `
      SELECT r.customer_id::INT, p.name, r.phone_raw, r.email_raw, r.city,
        CASE WHEN c.status = 'granted' THEN 1 ELSE 0 END, strftime(${cn('coalesce(c.revoked_utc, c.granted_utc)')}, '%Y-%m-%d %H:%M:%S'),
        strftime(${cn(`TIMESTAMP '2020-06-01' + to_days(floor(u(p.pid, 'preg') * 1900)::INT)`)}, '%Y-%m-%d %H:%M:%S'),
        strftime(${cn(`greatest(TIMESTAMP '2020-06-02' + to_days(floor(u(p.pid, 'preg') * 1900)::INT), coalesce(c.revoked_utc, c.granted_utc))`)}, '%Y-%m-%d %H:%M:%S')
      FROM t.rec r JOIN t.person p USING (pid) LEFT JOIN t.consent c ON c.src = 'pos' AND c.customer_id = r.customer_id WHERE r.src = 'pos'`);
    await loadMysql(con, 'sales', `
      SELECT order_id::INT, customer_id::INT, ${caseMap('status', ORDER_STATUS.pos)}, amount,
        strftime(${cn('created_utc')}, '%Y-%m-%d %H:%M:%S'), strftime(${cn('paid_utc')}, '%Y-%m-%d %H:%M:%S'), store_id, 0,
        strftime(${cn(touched)}, '%Y-%m-%d %H:%M:%S')
      FROM t.ord WHERE src = 'pos'`);
    await loadMysql(con, 'sale_items', `SELECT item_id::INT, order_id::INT, product_id, quantity, unit_price, amount FROM t.item WHERE src = 'pos'`);
  });
  log(`MySQL ${POS} 写好了`);
}

// ---------- MongoDB：订单中台 crm_oms（天猫订单的第二份拷贝，K2） ----------
async function oms() {
  const file = join(OUT, 'oms.orders.ndjson');
  await withTruth(async con => {
    // 扩展 JSON：时间写 {"$date": …}，金额写 {"$numberDouble": …}（否则整数金额会存成 int32，同一字段混两种类型）。
    // 约 2% 的订单另有一个更早的旧版本文档（同一 tid、待付款），P01 的天猫订单旧版本金额 999（K6：去重后应是 150）
    const date = (c: string) => `CASE WHEN ${c} IS NOT NULL THEN struct_pack("$date" := strftime(${c}, '%Y-%m-%dT%H:%M:%S.000Z')) END`;
    const doc = (status: string, amount: string, paid: string, updated: string) => `
      SELECT order_id AS tid, 'TMALL' AS source, struct_pack(id := customer_id) AS buyer, ${status} AS status,
        struct_pack(total := struct_pack("$numberDouble" := (${amount})::VARCHAR), paid_at := ${date(paid)}) AS payment,
        struct_pack(company := CASE WHEN status IN ('shipped', 'completed') THEN ['顺丰', '中通', '京东'][1 + (hash(order_id) % 3)::INT] END,
          status := CASE WHEN status IN ('shipped', 'completed') THEN 'SIGNED' ELSE 'NONE' END) AS logistics,
        ${date('created_utc')} AS created_at, ${date(updated)} AS updated_at
      FROM t.ord WHERE src = 'tmall'`;
    await con.run(`COPY (
      ${doc(caseMap('status', ORDER_STATUS.tmall), 'amount::DOUBLE', 'paid_utc', touched)}
      UNION ALL
      ${doc(`'WAIT_BUYER_PAY'`, `CASE WHEN key = 'p01-tm' THEN 999 ELSE amount::DOUBLE END`, 'NULL::TIMESTAMP', 'created_utc')}
        AND status <> 'created' AND (key = 'p01-tm' OR u(order_id, 'dup') < 0.02)
    ) TO ${lit(file)} (FORMAT json)`);
  });
  execFileSync('container', ['exec', 'mongodb', 'mongosh', '--quiet', MONGO_URI, '--eval', `db.getSiblingDB('${OMS}').dropDatabase()`], { stdio: 'inherit' });
  await pipeInto(file, ['mongodb', 'mongoimport', '--quiet', '--uri', MONGO_URI, '--db', OMS, '--collection', 'orders', '--numInsertionWorkers', '4']);
  rmSync(file);
  execFileSync('container', ['exec', 'mongodb', 'mongosh', '--quiet', MONGO_URI, '--eval', `
    const a = db.getSiblingDB('admin');
    if (!a.getUser('crmlab_ro')) a.createUser({ user: 'crmlab_ro', pwd: '${SECRETS.mg}', roles: [{ role: 'read', db: '${OMS}' }] });
    else a.grantRolesToUser('crmlab_ro', [{ role: 'read', db: '${OMS}' }]);
    print('${OMS}.orders 文档数 ' + db.getSiblingDB('${OMS}').orders.countDocuments());`], { stdio: 'inherit' });
  log(`MongoDB ${OMS} 写好了`);
}

// ---------- S3：天猫 Parquet、抖店 CSV、埋点、活动报名 CSV ----------
async function tmall() {
  await withTruth(async con => {
    await s3Secret(con);
    await con.run(`COPY (
      SELECT r.customer_id AS buyer_id, 'tb_nick_' || r.pid AS buyer_nick, r.unionid_raw AS unionid, r.phone_raw AS receiver_mobile,
        epoch_ms(TIMESTAMP '2022-06-01' + to_days((r.pid % 1000)::INT)) AS created_ms
      FROM t.rec r WHERE r.src = 'tmall' ORDER BY buyer_id
    ) TO '${S3_PREFIX}/tmall/buyers/buyers.parquet' (FORMAT parquet)`);
    await con.run(`COPY (
      SELECT order_id::BIGINT AS tid, customer_id AS buyer_id, ${caseMap('status', ORDER_STATUS.tmall)} AS trade_status,
        amount::DOUBLE AS payment, epoch_ms(created_utc) AS created_ms, epoch_ms(paid_utc) AS pay_ms, epoch_ms(${touched}) AS modified_ms
      FROM t.ord WHERE src = 'tmall' ORDER BY tid
    ) TO '${S3_PREFIX}/tmall/trades/trades.parquet' (FORMAT parquet)`);
  });
  log(`S3 Parquet ${S3_PREFIX}/tmall/ 写好了`);
}

async function douyin() {
  // 抖店导出：中文表头、每单一行、买家信息内嵌在订单里；金额以分计；时间是北京时间字符串；未授权的买家手机号为空，只有脱敏手机号
  await withTruth(async con => {
    await s3Secret(con);
    await con.run(`COPY (
      SELECT o.order_id AS "订单编号", o.customer_id AS "买家openid", r.phone_raw AS "买家手机号", r.phone_mask AS "买家手机号（脱敏）",
        r.city AS "收货城市", ${caseMap('o.status', ORDER_STATUS.douyin)} AS "订单状态", (o.amount * 100)::BIGINT AS "实付金额（分）",
        strftime(${cn('o.created_utc')}, '%Y-%m-%d %H:%M:%S') AS "下单时间", strftime(${cn('o.paid_utc')}, '%Y-%m-%d %H:%M:%S') AS "支付时间",
        strftime(${cn('coalesce(o.paid_utc, o.created_utc) + INTERVAL 1 HOUR')}, '%Y-%m-%d %H:%M:%S') AS "更新时间"
      FROM t.ord o JOIN (SELECT r.*, p.city FROM t.rec r JOIN t.person p USING (pid) WHERE r.src = 'douyin') r ON r.customer_id = o.customer_id
      WHERE o.src = 'douyin' ORDER BY o.order_id
    ) TO '${S3_PREFIX}/douyin/dy_orders/dy_orders.csv' (FORMAT csv, HEADER true)`);
  });
  log(`S3 CSV ${S3_PREFIX}/douyin/ 写好了`);
}

async function events() {
  await withTruth(async con => {
    await s3Secret(con);
    const select = `SELECT event_id, customer_id AS user_id, device_id, event_type AS event_name, epoch_ms(occurred_utc) AS ts_ms, page FROM t.event`;
    if (EVENTS_FORMAT === 'json') {
      await con.run(`COPY (${select} ORDER BY event_id) TO '${S3_PREFIX}/events/events/events.json' (FORMAT json)`);
    } else {
      // 按月分文件，便于观察大表同步
      for (const { m } of await rows<{ m: string }>(con, `SELECT DISTINCT strftime(occurred_utc, '%Y-%m') AS m FROM t.event ORDER BY 1`))
        await con.run(`COPY (${select} WHERE strftime(occurred_utc, '%Y-%m') = ${lit(m)} ORDER BY event_id) TO '${S3_PREFIX}/events/events/events-${m}.parquet' (FORMAT parquet)`);
    }
    // 埋点平台的用户档案（与事件同一格式，同一数据源只认一种格式）：登录过的商城用户，带手机与邮箱。平台只在本数据源内解析事件的 customer_id（#150），
    // 埋点源要有自己的消费者记录，靠身份打通并到商城那个人
    await con.run(`COPY (
      SELECT r.customer_id AS user_id, r.phone_raw AS mobile, r.email_raw AS email, epoch_ms(min(e.occurred_utc)) AS first_login_ms
      FROM t.event e JOIN t.rec r ON r.src = 'mall' AND r.customer_id = e.customer_id
      WHERE e.event_type = 'login' GROUP BY ALL ORDER BY user_id
    ) TO '${S3_PREFIX}/events/users/users.${EVENTS_FORMAT}' (FORMAT ${EVENTS_FORMAT})`);
  });
  log(`S3 ${EVENTS_FORMAT === 'json' ? 'JSON' : 'Parquet'} ${S3_PREFIX}/events/ 写好了`);
}

async function activity() {
  // 线下活动报名表：手填的表格导出，没有可靠的 ID，手机号格式杂、偶有错号；时间形如 2026/9/1 14:05（北京时间）
  await withTruth(async con => {
    await s3Secret(con);
    await con.run(`COPY (
      SELECT s.signup_id AS "报名编号", p.name AS "姓名", r.phone_raw AS "手机", a.name AS "活动", s.activity_id AS "活动编号",
        strftime(${cn('s.signup_utc')}, '%Y/%-m/%-d %H:%M') AS "报名时间", CASE WHEN s.attended THEN '是' ELSE '否' END AS "是否到场",
        strftime(${cn('a.held_at')}, '%Y/%-m/%-d') AS "活动日期"
      FROM t.signup s JOIN t.person p USING (pid) JOIN t.activity a USING (activity_id) JOIN t.rec r ON r.src = 'activity' AND r.customer_id = s.signup_id
      ORDER BY s.signup_id
    ) TO '${S3_PREFIX}/activity/signups/signups.csv' (FORMAT csv, HEADER true)`);
  });
  log(`S3 CSV ${S3_PREFIX}/activity/ 写好了`);
}

// ---------- S3 上的 DuckDB 文件：企业微信 ----------
async function wecom() {
  rmSync(WECOM, { force: true });
  rmSync(`${WECOM}.wal`, { force: true });
  await withTruth(async con => {
    await con.run(`ATTACH ${lit(WECOM)} AS w`);
    await con.run(`CREATE TABLE w.contacts AS
      SELECT c.external_userid, r.unionid_raw AS unionid, r.phone_raw AS mobile, c.guide_id, ${cn('c.added_utc')} AS add_time, ${cn('c.deleted_utc')} AS del_time,
        ${cn('coalesce(c.deleted_utc, c.added_utc)')} AS update_time
      FROM t.wecom_contact c JOIN t.rec r ON r.src = 'wecom' AND r.customer_id = c.external_userid`);
    await con.run(`CREATE TABLE w.chats AS SELECT chat_id, external_userid, guide_id, ${cn('chat_utc')} AS chat_time, msg_count FROM t.wecom_chat`);
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

// ---------- S3 只读账号：只能读 crm-source/crm/ ----------
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
  const UserName = 'src-crmlab-ro';
  await iam('CreateUser', { UserName });
  // 上次签发的密钥还有效就沿用：已登记的 S3 数据源用的就是它，重新签发会让它们连不上
  const file = CREDENTIALS;
  const keys = xmlTags(await iam('ListAccessKeys', { UserName }), 'AccessKeyId');
  const saved = existsSync(file) ? /Access Key (\S+)  Secret (\S+)/.exec(readFileSync(file, 'utf8')) : null;
  const reuse = saved && keys.includes(saved[1]!);
  for (const AccessKeyId of keys) if (!reuse || AccessKeyId !== saved![1]) await iam('DeleteAccessKey', { UserName, AccessKeyId });
  await iam('PutUserPolicy', {
    UserName, PolicyName: 'crm-source-read',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::crm-source/crm/*'] },
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: ['arn:aws:s3:::crm-source'], Condition: { StringLike: { 's3:prefix': ['crm/*'] } } },
      ],
    }),
  });
  let key = saved?.[1] ?? '', secret = saved?.[2] ?? '';
  if (!reuse) {
    const xml = await iam('CreateAccessKey', { UserName });
    key = xmlTag(xml, 'AccessKeyId') ?? '';
    secret = xmlTag(xml, 'SecretAccessKey') ?? '';
  }
  writeFileSync(file, [
    `# crmlab 测试数据源的只读账号（seed.ts 生成，不要提交）。两档共用账号；规模档（--set 10m）的库、schema 加后缀 _10m，S3 前缀多一级 10m/`,
    `Postgres  主机 localhost  端口 5432  库 crm  schema crm_mall / crm_loyalty  用户 crmlab_reader  密码 ${SECRETS.pg}`,
    `MySQL     主机 localhost  端口 3306  库 crm_pos  用户 crmlab_reader  密码 ${SECRETS.my}`,
    `MongoDB   主机 localhost  端口 27017  库 crm_oms  认证库 admin  用户 crmlab_ro  密码 ${SECRETS.mg}`,
    `S3        端点 ${s3.endpoint}  区域 ${s3.region}  路径风格 ${s3.urlStyle}  SSL ${s3.useSsl}  Access Key ${key}  Secret ${secret}`,
    `          前缀 s3://crm-source/crm/tmall/ …/douyin/ …/events/ …/activity/   DuckDB 文件 s3://crm-source/crm/wecom/wecom.duckdb（规模档 s3://crm-source/crm/10m/…）`,
    '',
  ].join('\n'));
  log(`只读账号写在 ${file}`);
}

// ---------- 第二轮变更（plan T6）：真值打补丁，再把同样的变更就地写进数据源 ----------
async function round2() {
  if (!existsSync(TRUTH)) throw new Error('还没有第一轮的真值：先不带 --round 跑一遍');
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const NOW = `TIMESTAMP ${lit(now)}`;
  {
    const con = await open(TRUTH);
    const [m] = await rows<{ round: number }>(con, `SELECT round FROM meta`);
    if (Number(m!.round) !== 1) { con.closeSync(); throw new Error(`真值已经是第 ${m!.round} 轮：第二轮只能在第一轮之后跑一次（重来请不带 --round 重新造数）`); }
    await con.run(readFileSync(join(HERE, 'round2.sql'), 'utf8'));
    await con.run(readFileSync(join(HERE, 'identity.sql'), 'utf8'));
    con.closeSync();
  }
  const pgUtc = (c: string) => `timezone('UTC', ${c})`;
  const one = async (con: DuckDBConnection, sql: string) => (await rows<Record<string, string>>(con, sql))[0]!;
  await withTruth(async con => {
    // 商城：新订单与明细，P08 补手机，P01 网页单退款，商品改品类（修改时间都是现在，按水位线增量同步）
    await con.run(`INSTALL postgres; LOAD postgres; ATTACH ${lit(PG_ADMIN)} AS pgw (TYPE postgres)`);
    await con.run(`INSERT INTO pgw.${MALL}.orders
      SELECT order_id::BIGINT, customer_id::BIGINT, 'paid', amount, channel, ${pgUtc('created_utc')}, ${pgUtc('created_utc + INTERVAL 10 MINUTE')}, ${pgUtc(NOW)}
      FROM t.r2_orders WHERE src = 'mall'`);
    await con.run(`INSERT INTO pgw.${MALL}.order_items SELECT item_id::BIGINT, order_id::BIGINT, product_id, quantity, unit_price, amount FROM t.r2_items WHERE src = 'mall'`);
    const p08 = await one(con, `SELECT customer_id, phone FROM t.r2_phone`);
    const refund = await one(con, `SELECT order_id FROM t.r2_refund`);
    const product = await one(con, `SELECT product_id, category FROM t.r2_product`);
    await con.run(`DETACH pgw`);
    psql(`
      UPDATE ${MALL}.users SET mobile = ${lit(p08.phone!)}, updated_at = now() WHERE user_id = ${Number(p08.customer_id)};
      UPDATE ${MALL}.orders SET status = 'refunded', updated_at = now() WHERE order_id = ${Number(refund.order_id)};
      UPDATE ${MALL}.products SET category = ${lit(product.category!)}, updated_at = now() WHERE sku = ${lit(product.product_id!)};`);
    log('商城：新订单、P08 补手机、P01 退款、商品改品类');
    // POS：新订单与明细，3 笔作废（is_void = 1，修改时间是现在的北京时间）
    await loadMysql(con, 'sales', `
      SELECT order_id::INT, customer_id::INT, '已支付', amount, strftime(${cn('created_utc')}, '%Y-%m-%d %H:%M:%S'),
        strftime(${cn('created_utc + INTERVAL 10 MINUTE')}, '%Y-%m-%d %H:%M:%S'), store_id, 0, strftime(${cn(NOW)}, '%Y-%m-%d %H:%M:%S')
      FROM t.r2_orders WHERE src = 'pos'`);
    await loadMysql(con, 'sale_items', `SELECT item_id::INT, order_id::INT, product_id, quantity, unit_price, amount FROM t.r2_items WHERE src = 'pos'`);
    const voided = (await rows<{ order_id: string }>(con, `SELECT order_id FROM t.r2_voided`)).map(r => Number(r.order_id));
    const [{ bj }] = await rows<{ bj: string }>(con, `SELECT strftime(${cn(NOW)}, '%Y-%m-%d %H:%M:%S') AS bj`);
    mysql(`UPDATE ${POS}.sales SET is_void = 1, updated_at = '${bj}' WHERE sale_id IN (${voided.join(', ')});`);
    log(`POS：新订单、作废 ${voided.join('、')}`);
  });
  // 天猫文件少 5 笔、活动表多一条 P11 的报名：重新导出文件（全量比对）
  await tmall();
  await activity();
  log('第二轮变更写好了：同步后用 verify.ts 核对（期望已按第二轮更新）');
}

const started = Date.now();
if (args.round === '2') {
  await round2();
  log(`完成，用时 ${((Date.now() - started) / 60000).toFixed(1)} 分钟`);
  process.exit(0);
}
if (step('truth') || !existsSync(TRUTH)) await truth();
if (step('mall')) await mall();
if (step('loyalty')) await loyalty();
if (step('pos')) await pos();
if (step('oms')) await oms();
if (step('tmall')) await tmall();
if (step('douyin')) await douyin();
if (step('events')) await events();
if (step('activity')) await activity();
if (step('wecom')) await wecom();
if (step('accounts')) await accounts();
log(`完成，用时 ${((Date.now() - started) / 60000).toFixed(1)} 分钟`);
