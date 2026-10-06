// scripts/rfm-seed/seed.ts —— RFM 整体测试造数：先在本机 truth.duckdb 里生成真值，再写进 5 种数据源，并建好各自的只读账号。
// 用法：node --env-file=.env --import tsx scripts/rfm-seed/seed.ts [人数，默认 200000] [只跑的步骤，逗号分隔：truth,pg,my,mg,s3,dk,accounts]
// 可重复执行：每个数据源先删后建（只动 rfm_* 的库、schema、集合与 s3://crm-source/rfm/ 前缀），只读账号已存在时沿用（S3 的密钥会重新签发）
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { Double, MongoClient } from 'mongodb';
import { platformS3 } from '../../app/.server/s3-accounts';
import { putObject, signedFetch, xmlTag, xmlTags } from '../../app/.server/s3-client';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
const TRUTH = join(OUT, 'truth.duckdb');
const LIVE = join(OUT, 'live.duckdb');
const N = Number(process.argv[2] ?? 200000);
const ONLY = process.argv[3]?.split(',');
const step = (name: string) => !ONLY || ONLY.includes(name);

const PG_ADMIN = 'postgresql://crm:crm@localhost:5432/crm';
const MYSQL_ROOT = 'host=127.0.0.1 port=3306 user=root password=crm';
const MONGO_ROOT = 'mongodb://crm:crm-secret@localhost:27017/?authSource=admin';
const S3_PREFIX = 's3://crm-source/rfm';
const SECRETS = { pg: 'rfm-reader-secret', my: 'rfm-reader-secret', mg: 'rfm-ro-secret' };

const s3 = platformS3();
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];
// 北京时间（不带时区）：MySQL 与 DuckDB 文件里的时间都这样存
const local = (c: string) => `timezone('Asia/Shanghai', timezone('UTC', ${c}))`;
const statusMap = (m: Record<string, string>) => `CASE status ${Object.entries(m).map(([k, v]) => `WHEN ${lit(k)} THEN ${lit(v)}`).join(' ')} END`;

mkdirSync(OUT, { recursive: true });

async function open(path = ':memory:') {
  const con = await (await DuckDBInstance.create(path)).connect();
  await con.run(`SET TimeZone = 'UTC'`);
  return con;
}

// ---------- 真值 ----------
async function truth() {
  rmSync(TRUTH, { force: true });
  const con = await open(TRUTH);
  await con.run(readFileSync(join(HERE, 'truth.sql'), 'utf8').replaceAll('${N}', String(N)));
  await con.run(readFileSync(join(HERE, 'specials.sql'), 'utf8'));
  for (const r of await rows<Record<string, string>>(con, `
    SELECT src, count(*) AS orders, count(*) FILTER (WHERE pid IS NULL) AS unlinked, (SELECT count(*) FROM rec WHERE rec.src = ord.src) AS customers
    FROM ord GROUP BY src ORDER BY src`)) log(`真值 ${r.src}: 消费者 ${r.customers}，订单 ${r.orders}（打通不到 ${r.unlinked}）`);
  con.closeSync();
}

async function withTruth<T>(fn: (con: DuckDBConnection) => Promise<T>) {
  const con = await open();
  await con.run(`ATTACH ${lit(TRUTH)} AS t (READ_ONLY)`);
  try { return await fn(con); } finally { con.closeSync(); }
}

// ---------- Postgres：电商主站 rfm_shop ----------
async function pg() {
  await withTruth(async con => {
    await con.run(`INSTALL postgres; LOAD postgres; ATTACH ${lit(PG_ADMIN)} AS pgw (TYPE postgres)`);
    await con.run(`CALL postgres_execute('pgw', ${lit(`
      DROP SCHEMA IF EXISTS rfm_shop CASCADE;
      CREATE SCHEMA rfm_shop;
      CREATE TABLE rfm_shop.customers (
        customer_id BIGINT PRIMARY KEY, nick_name TEXT, mobile TEXT, email TEXT, unionid TEXT,
        gender CHAR(1), city TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
      CREATE TABLE rfm_shop.orders (
        order_id BIGINT PRIMARY KEY, customer_id BIGINT, status TEXT NOT NULL, pay_amount NUMERIC(12,2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL, paid_at TIMESTAMPTZ, channel TEXT, updated_at TIMESTAMPTZ NOT NULL);`)})`);
    await con.run(`INSERT INTO pgw.rfm_shop.customers
      SELECT customer_id::BIGINT, '主站用户' || pid, phone_raw, email_raw, unionid_raw,
        CASE WHEN u2 < 0.45 THEN 'F' WHEN u2 < 0.9 THEN 'M' END,
        ['上海', '北京', '杭州', '广州', '成都', '深圳'][1 + (pid % 6)::INT],
        timezone('UTC', TIMESTAMP '2023-01-01' + to_days((u1 * 1000)::INT)), timezone('UTC', TIMESTAMP '2023-01-02' + to_days((u1 * 1000)::INT))
      FROM (SELECT *, (hash(pid || 'g') % 1000) / 1000.0 AS u2, (hash(pid || 'c') % 1000) / 1000.0 AS u1 FROM t.rec WHERE src = 'pg')`);
    await con.run(`INSERT INTO pgw.rfm_shop.orders
      SELECT order_id::BIGINT, customer_id::BIGINT,
        ${statusMap({ created: 'pending', paid: 'paid', shipped: 'shipped', completed: 'completed', cancelled: 'cancelled', refunded: 'refunded' })},
        amount, timezone('UTC', created_utc), timezone('UTC', paid_utc), ['app', 'web', 'h5'][1 + (hash(key) % 3)::INT],
        timezone('UTC', coalesce(paid_utc, created_utc) + INTERVAL 1 HOUR)
      FROM t.ord WHERE src = 'pg'`);
  });
  execFileSync('psql', [PG_ADMIN, '-q', '-v', 'ON_ERROR_STOP=1', '-c', `
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rfm_reader') THEN CREATE ROLE rfm_reader LOGIN PASSWORD '${SECRETS.pg}'; END IF;
    END $$;
    GRANT CONNECT ON DATABASE crm TO rfm_reader;
    GRANT USAGE ON SCHEMA rfm_shop TO rfm_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA rfm_shop TO rfm_reader;
    ANALYZE rfm_shop.customers; ANALYZE rfm_shop.orders;`], { stdio: 'inherit' });
  log('Postgres rfm_shop 写好了');
}

// ---------- MySQL：门店 POS rfm_pos ----------
function mysql(sql: string) {
  execFileSync('container', ['exec', '-i', 'mysql', 'mysql', '-uroot', '-pcrm', '--default-character-set=utf8mb4'], { input: sql, stdio: ['pipe', 'inherit', 'ignore'] });
}

async function my() {
  mysql(`
    DROP DATABASE IF EXISTS rfm_pos;
    CREATE DATABASE rfm_pos DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
    CREATE TABLE rfm_pos.members (
      member_id INT PRIMARY KEY, member_name VARCHAR(64), phone VARCHAR(32), email VARCHAR(128), register_store VARCHAR(16),
      registered_at DATETIME NOT NULL, updated_at DATETIME NOT NULL);
    CREATE TABLE rfm_pos.sales (
      sale_id INT PRIMARY KEY, member_id INT NULL, status VARCHAR(8) NOT NULL, amount DECIMAL(12,2) NOT NULL,
      sold_at DATETIME NOT NULL, paid_at DATETIME NULL, store_code VARCHAR(16), updated_at DATETIME NOT NULL);
    CREATE USER IF NOT EXISTS 'rfm_reader'@'%' IDENTIFIED BY '${SECRETS.my}';
    GRANT SELECT ON rfm_pos.* TO 'rfm_reader'@'%';`);
  await withTruth(async con => {
    await con.run(`INSTALL mysql; LOAD mysql; ATTACH ${lit(`${MYSQL_ROOT} database=rfm_pos`)} AS myw (TYPE mysql)`);
    await con.run(`INSERT INTO myw.members
      SELECT customer_id::INT, '门店会员' || pid, phone_raw, email_raw, 'S' || lpad((pid % 40)::VARCHAR, 3, '0'),
        ${local(`TIMESTAMP '2023-01-01' + to_days((pid % 900)::INT)`)}, ${local(`TIMESTAMP '2023-01-02' + to_days((pid % 900)::INT)`)}
      FROM t.rec WHERE src = 'my'`);
    await con.run(`INSERT INTO myw.sales
      SELECT order_id::INT, customer_id::INT,
        ${statusMap({ created: '待支付', paid: '已支付', shipped: '已发货', completed: '已完成', cancelled: '已取消', refunded: '已退款' })},
        amount, ${local('created_utc')}, ${local('paid_utc')}, 'S' || lpad((hash(key) % 40)::VARCHAR, 3, '0'),
        ${local('coalesce(paid_utc, created_utc) + INTERVAL 1 HOUR')}
      FROM t.ord WHERE src = 'my'`);
  });
  log('MySQL rfm_pos 写好了');
}

// ---------- MongoDB：小程序 rfm_mini ----------
async function mg() {
  const data = await withTruth(async con => ({
    users: await rows<{ customer_id: string; pid: string; phone_raw: string | null; email_raw: string | null; created_ms: number }>(con, `
      SELECT customer_id, pid::VARCHAR AS pid, phone_raw, email_raw, epoch_ms(TIMESTAMP '2023-03-01' + to_days((pid % 800)::INT))::DOUBLE AS created_ms
      FROM t.rec WHERE src = 'mg' ORDER BY customer_id`),
    orders: await rows<{ order_id: string; customer_id: string | null; status: string; amount: number; created_ms: number; paid_ms: number | null; dup: boolean }>(con, `
      SELECT order_id, customer_id,
        ${statusMap({ created: 'UNPAID', paid: 'PAID', shipped: 'SHIPPED', completed: 'DONE', cancelled: 'CANCELED', refunded: 'REFUND' })} AS status,
        amount::DOUBLE AS amount, epoch_ms(created_utc)::DOUBLE AS created_ms, epoch_ms(paid_utc)::DOUBLE AS paid_ms,
        (pid = 900016 OR (pid IS NOT NULL AND status <> 'created' AND hash(order_id || 'dup') % 50 = 0)) AS dup
      FROM t.ord WHERE src = 'mg' ORDER BY order_id`),
  }));
  const client = await MongoClient.connect(MONGO_ROOT);
  try {
    const db = client.db('rfm_mini');
    await db.dropDatabase();
    await db.collection('users').insertMany(data.users.map(u => ({
      member_no: u.customer_id,
      nickname: `小程序用户${u.pid}`,
      contact: { ...(u.email_raw && { email: u.email_raw }), ...(u.phone_raw && { mobile: u.phone_raw }) },
      created_at: new Date(u.created_ms),
      updated_at: new Date(u.created_ms + 86400000),
    })));
    // 金额一律存成 Double（整数金额默认会存成 int32，同一字段混两种类型）。2% 的订单另有一个更早的旧版本（同一订单号、待支付）：映射要按 order_id 去重、取 updated_at 最新的一份
    const docs = data.orders.flatMap(o => {
      const latest = {
        order_no: o.order_id,
        buyer: { member_no: o.customer_id },
        status: o.status,
        pay: { amount: new Double(o.amount), ...(o.paid_ms !== null && { paid_at: new Date(o.paid_ms) }) },
        created_at: new Date(o.created_ms),
        updated_at: new Date((o.paid_ms ?? o.created_ms) + 3600000),
      };
      if (!o.dup) return [latest];
      const old = { ...latest, status: 'UNPAID', pay: { amount: new Double(o.order_id === 'MG900000016' ? 999 : o.amount) }, updated_at: new Date(o.created_ms) };
      return [old, latest];
    });
    for (let i = 0; i < docs.length; i += 20000) await db.collection('orders').insertMany(docs.slice(i, i + 20000));
    log(`MongoDB rfm_mini 写好了：users ${data.users.length}，orders ${docs.length} 个文档（订单 ${data.orders.length}）`);
  } finally {
    await client.close();
  }
  execFileSync('container', ['exec', 'mongodb', 'mongosh', '--quiet', '-u', 'crm', '-p', 'crm-secret', '--authenticationDatabase', 'admin', '--eval', `
    const a = db.getSiblingDB('admin');
    if (!a.getUser('rfm_ro')) a.createUser({ user: 'rfm_ro', pwd: '${SECRETS.mg}', roles: [{ role: 'read', db: 'rfm_mini' }] });`], { stdio: 'inherit' });
}

// ---------- S3 Parquet：天猫导出 s3://crm-source/rfm/tmall/ ----------
async function s3Secret(con: DuckDBConnection) {
  await con.run(`INSTALL httpfs; LOAD httpfs; CREATE SECRET admin_s3 (TYPE s3, KEY_ID ${lit(s3.key)}, SECRET ${lit(s3.secret)},
    REGION ${lit(s3.region)}, ENDPOINT ${lit(s3.endpoint)}, URL_STYLE ${lit(s3.urlStyle)}, USE_SSL ${s3.useSsl})`);
}

async function tmall() {
  await withTruth(async con => {
    await s3Secret(con);
    await con.run(`COPY (
      SELECT customer_id AS buyer_id, 'tb_nick_' || pid AS buyer_nick, unionid_raw AS unionid, phone_raw AS receiver_mobile,
        epoch_ms(TIMESTAMP '2022-06-01' + to_days((pid % 1000)::INT)) AS created_ms
      FROM t.rec WHERE src = 's3' ORDER BY buyer_id
    ) TO '${S3_PREFIX}/tmall/buyers/buyers.parquet' (FORMAT parquet)`);
    await con.run(`COPY (
      SELECT order_id::BIGINT AS tid, customer_id AS buyer_id,
        ${statusMap({ created: 'WAIT_BUYER_PAY', paid: 'WAIT_SELLER_SEND_GOODS', shipped: 'WAIT_BUYER_CONFIRM_GOODS', completed: 'TRADE_FINISHED', cancelled: 'TRADE_CLOSED', refunded: 'REFUND_SUCCESS' })} AS trade_status,
        amount::DOUBLE AS payment, epoch_ms(created_utc) AS created_ms, epoch_ms(paid_utc) AS pay_ms,
        epoch_ms(coalesce(paid_utc, created_utc) + INTERVAL 1 HOUR) AS modified_ms
      FROM t.ord WHERE src = 's3' ORDER BY tid
    ) TO '${S3_PREFIX}/tmall/trades/trades.parquet' (FORMAT parquet)`);
  });
  log(`S3 Parquet ${S3_PREFIX}/tmall/ 写好了`);
}

// ---------- S3 上的 DuckDB 文件：直播间 s3://crm-source/rfm/live/live.duckdb ----------
async function live() {
  rmSync(LIVE, { force: true });
  rmSync(`${LIVE}.wal`, { force: true });
  await withTruth(async con => {
    await con.run(`ATTACH ${lit(LIVE)} AS live`);
    await con.run(`CREATE TABLE live.viewers (viewer_id INTEGER PRIMARY KEY, phone VARCHAR, level VARCHAR, joined_at TIMESTAMP NOT NULL, modified_at TIMESTAMP NOT NULL)`);
    await con.run(`INSERT INTO live.viewers SELECT customer_id::INT, phone_raw, ['粉丝', '铁粉', '真爱粉'][1 + (pid % 3)::INT],
        ${local(`TIMESTAMP '2024-01-01' + to_days((pid % 600)::INT)`)}, ${local(`TIMESTAMP '2024-01-02' + to_days((pid % 600)::INT)`)}
      FROM t.rec WHERE src = 'dk'`);
    await con.run(`CREATE TABLE live.live_orders (order_code VARCHAR PRIMARY KEY, viewer_id INTEGER, state VARCHAR NOT NULL, amount_cents BIGINT NOT NULL,
      ordered_at TIMESTAMP NOT NULL, paid_at TIMESTAMP, modified_at TIMESTAMP NOT NULL)`);
    await con.run(`INSERT INTO live.live_orders SELECT order_id, customer_id::INT,
        ${statusMap({ created: 'N', paid: 'P', shipped: 'S', completed: 'C', cancelled: 'X', refunded: 'R' })},
        (amount * 100)::BIGINT, ${local('created_utc')}, ${local('paid_utc')}, ${local('coalesce(paid_utc, created_utc) + INTERVAL 1 HOUR')}
      FROM t.ord WHERE src = 'dk'`);
    await con.run(`DETACH live`);
  });
  const size = statSync(LIVE).size;
  await putObject(s3, `${S3_PREFIX}/live/live.duckdb`, Readable.toWeb(createReadStream(LIVE)) as ReadableStream<Uint8Array>, size);
  log(`DuckDB 文件 ${S3_PREFIX}/live/live.duckdb 写好了（${(size / 1048576).toFixed(1)} MiB）`);
}

// ---------- S3 只读账号：只能读 crm-source/rfm/ ----------
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
  const UserName = 'src-rfm-ro';
  await iam('CreateUser', { UserName });
  for (const AccessKeyId of xmlTags(await iam('ListAccessKeys', { UserName }), 'AccessKeyId')) await iam('DeleteAccessKey', { UserName, AccessKeyId });
  await iam('PutUserPolicy', {
    UserName, PolicyName: 'rfm-source-read',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::crm-source/rfm/*'] },
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: ['arn:aws:s3:::crm-source'], Condition: { StringLike: { 's3:prefix': ['rfm/*'] } } },
      ],
    }),
  });
  const xml = await iam('CreateAccessKey', { UserName });
  const key = xmlTag(xml, 'AccessKeyId'), secret = xmlTag(xml, 'SecretAccessKey');
  const file = join(OUT, 'credentials.txt');
  writeFileSync(file, [
    `# RFM 测试数据源的只读账号（seed.ts 生成，不要提交）`,
    `Postgres  主机 localhost  端口 5432  库 crm  schema rfm_shop  用户 rfm_reader  密码 ${SECRETS.pg}`,
    `MySQL     主机 localhost  端口 3306  库 rfm_pos  用户 rfm_reader  密码 ${SECRETS.my}`,
    `MongoDB   主机 localhost  端口 27017  库 rfm_mini  认证库 admin  用户 rfm_ro  密码 ${SECRETS.mg}`,
    `S3        端点 ${s3.endpoint}  区域 ${s3.region}  路径风格 ${s3.urlStyle}  SSL ${s3.useSsl}  Access Key ${key}  Secret ${secret}`,
    `          Parquet 前缀 ${S3_PREFIX}/tmall/    DuckDB 文件 ${S3_PREFIX}/live/live.duckdb`,
    '',
  ].join('\n'));
  log(`只读账号写在 ${file}`);
}

if (step('truth') || !existsSync(TRUTH)) await truth();
if (step('pg')) await pg();
if (step('my')) await my();
if (step('mg')) await mg();
if (step('s3')) await tmall();
if (step('dk')) await live();
if (step('accounts')) await accounts();
log('完成');
