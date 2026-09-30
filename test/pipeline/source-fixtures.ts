// test/pipeline/source-fixtures.ts —— 数据源夹具：本地 PostgreSQL 上的源库（与 src/01_seed.ts 一样用 hash 确定性造数），
// 一个只读账号与一个对订单表可写的账号；以及放在租户源文件目录下的 DuckDB 文件
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { MongoClient } from 'mongodb';
import pg from 'pg';
import { signedFetch, xmlTag } from '../../app/.server/s3-client';

export const SOURCE_DB_URL = process.env.TEST_SOURCE_DATABASE_URL!;
export const READER = { user: 'crm_src_reader', password: 'reader-p@ss\'word' };
export const WRITER = { user: 'crm_src_writer', password: 'writer-p@ss' };

const withClient = async <T>(url: string, run: (c: pg.Client) => Promise<T>) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
};

/**
 * 重建源库 shop schema：
 * - customers：自增主键 + updated_at（水位线候选：更新时间与自增主键）
 * - orders：identity 主键，没有更新时间（水位线候选：自增主键）
 * - events：没有水位线字段、行数超过测试设定的大表阈值（SOURCE_LARGE_TABLE_ROWS=1000），全量比对、默认每天同步
 * - regions：没有水位线字段的小表（全量比对）
 */
export async function seedPgSource() {
  const url = new URL(SOURCE_DB_URL);
  const dbName = url.pathname.slice(1);
  await withClient(Object.assign(new URL(url), { pathname: '/postgres' }).toString(), async c => {
    const { rowCount } = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!rowCount) await c.query(`CREATE DATABASE "${dbName}"`);
    for (const { user, password } of [READER, WRITER]) {
      const { rowCount: exists } = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
      const pw = password.replace(/'/g, "''");
      await c.query(exists ? `ALTER ROLE ${user} LOGIN PASSWORD '${pw}'` : `CREATE ROLE ${user} LOGIN PASSWORD '${pw}'`);
    }
  });
  await withClient(SOURCE_DB_URL, async c => {
    await c.query(`
      DROP SCHEMA IF EXISTS shop CASCADE;
      CREATE SCHEMA shop;
      REVOKE ALL ON DATABASE "${dbName}" FROM PUBLIC;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      CREATE TABLE shop.customers (
        customer_id serial PRIMARY KEY,
        name text NOT NULL,
        email text,
        phone text,
        city text,
        created_at timestamp NOT NULL,
        updated_at timestamp NOT NULL
      );
      INSERT INTO shop.customers (name, email, phone, city, created_at, updated_at)
      SELECT '消费者' || i,
             CASE WHEN i % 4 = 0 THEN NULL ELSE 'user' || i || '@example.com' END,
             '138' || lpad(i::text, 8, '0'),
             (ARRAY['北京','上海','广州','深圳'])[1 + i % 4],
             TIMESTAMP '2024-01-01' + i * INTERVAL '1 day',
             TIMESTAMP '2024-06-01' + i * INTERVAL '1 hour'
      FROM generate_series(1, 40) i;

      CREATE TABLE shop.orders (
        order_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        customer_id int NOT NULL,
        amount numeric(10, 2) NOT NULL,
        status text NOT NULL,
        created_at timestamp NOT NULL
      );
      INSERT INTO shop.orders (customer_id, amount, status, created_at)
      SELECT 1 + i % 40, 10 + i, (ARRAY['paid','refunded'])[1 + i % 2], TIMESTAMP '2024-02-01' + i * INTERVAL '1 day'
      FROM generate_series(1, 100) i;

      CREATE TABLE shop.events (event_type text NOT NULL, customer_id int, occurred_at timestamptz NOT NULL);
      INSERT INTO shop.events SELECT 'view', i % 40, TIMESTAMPTZ '2024-03-01' + i * INTERVAL '1 minute' FROM generate_series(1, 1500) i;

      CREATE TABLE shop.regions (code text NOT NULL, name text NOT NULL);
      INSERT INTO shop.regions VALUES ('N', '北方'), ('S', '南方');

      GRANT CONNECT ON DATABASE "${dbName}" TO ${READER.user}, ${WRITER.user};
      GRANT USAGE ON SCHEMA shop TO ${READER.user}, ${WRITER.user};
      GRANT SELECT ON ALL TABLES IN SCHEMA shop TO ${READER.user}, ${WRITER.user};
      GRANT INSERT, UPDATE ON shop.orders TO ${WRITER.user};
    `);
  });
  return { host: url.hostname, port: url.port || '5432', database: dbName, schema: 'shop' };
}

/** 以源库管理员身份执行语句（如登记之后再给账号授权） */
export const grantOnSource = (statement: string) => withClient(SOURCE_DB_URL, c => c.query(statement));

/** 登记 PostgreSQL 数据源时提交的字段（与界面表单同名） */
export async function pgSourceInput(account: { user: string; password: string }, name = '电商库') {
  const conn = await seedPgSource();
  return { kind: 'postgres', name, ...conn, ...account };
}

/** 在租户的源文件目录下（PLATFORM_SOURCE_FILES_DIR/<租户 ID>/）生成一个 DuckDB 文件，返回其路径 */
export async function duckdbSourceFile(tenantId: string, file = 'shop.duckdb') {
  const dir = join(process.env.PLATFORM_SOURCE_FILES_DIR!, tenantId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  await rm(path, { force: true });
  const instance = await DuckDBInstance.create(path);
  const con = await instance.connect();
  await con.run(`
    CREATE SEQUENCE member_seq;
    CREATE TABLE members (member_id BIGINT PRIMARY KEY DEFAULT nextval('member_seq'), mobile VARCHAR, level VARCHAR, modified_at TIMESTAMP);
    INSERT INTO members (mobile, level, modified_at)
    SELECT '139' || lpad(i::VARCHAR, 8, '0'), ['gold','silver'][1 + i % 2], TIMESTAMP '2024-05-01' + to_hours(i) FROM range(30) t(i);`);
  con.closeSync();
  instance.closeSync();
  return path;
}

const platformS3Creds = () => ({
  endpoint: process.env.S3_ENDPOINT ?? 'localhost:8333',
  region: process.env.S3_REGION ?? 'us-east-1',
  key: process.env.S3_ACCESS_KEY!,
  secret: process.env.S3_SECRET_KEY!,
  useSsl: (process.env.S3_USE_SSL ?? 'false') === 'true',
});

async function iam(action: string, params: Record<string, string>) {
  const res = await signedFetch(platformS3Creds(), 'iam', {
    method: 'POST',
    path: '/',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams({ Action: action, Version: '2010-05-08', ...params }).toString(),
  });
  const xml = await res.text();
  if (!res.ok && !/EntityAlreadyExists|NoSuchEntity/.test(xml)) throw new Error(`IAM ${action} 失败：${xml}`);
  return xml;
}

/** 在对象存储上建一个只能访问 prefix 的账号：能读、列目录，另加 extra 中的权限（如 s3:PutObject），返回新签发的密钥 */
async function s3Account(user: string, prefix: string, extra: string[] = []) {
  const [bucket, ...rest] = prefix.replace(/^s3:\/\//, '').split('/');
  const objects = `${rest.filter(Boolean).join('/')}/*`;
  await iam('DeleteUser', { UserName: user });
  await iam('CreateUser', { UserName: user });
  await iam('PutUserPolicy', {
    UserName: user,
    PolicyName: 'source',
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: ['s3:GetObject', ...extra], Resource: [`arn:aws:s3:::${bucket}/${objects}`] },
        { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [`arn:aws:s3:::${bucket}`], Condition: { StringLike: { 's3:prefix': [objects] } } },
      ],
    }),
  });
  const xml = await iam('CreateAccessKey', { UserName: user });
  return { keyId: xmlTag(xml, 'AccessKeyId')!, secret: xmlTag(xml, 'SecretAccessKey')! };
}

/**
 * 对象存储上的源文件（TEST_S3_LAKE_URI 下的 sources/<租户 ID>/）：顶层的 customers.parquet 与 orders/ 目录下的两个分片；
 * 以及只读、可写、可删除三个只能访问该前缀的账号。返回登记时提交的公共字段（不含账号）
 */
export async function s3SourceFiles(tenantId: string) {
  const prefix = `${process.env.TEST_S3_LAKE_URI}/sources/${tenantId}/`;
  const c = platformS3Creds();
  const instance = await DuckDBInstance.create(':memory:');
  const con = await instance.connect();
  await con.run(`INSTALL httpfs; LOAD httpfs;
    CREATE SECRET (TYPE s3, KEY_ID '${c.key}', SECRET '${c.secret}', REGION '${c.region}', ENDPOINT '${c.endpoint}', URL_STYLE 'path', USE_SSL ${c.useSsl});
    COPY (SELECT i AS customer_id, 'user' || i || '@example.com' AS email, TIMESTAMP '2024-06-01' + to_hours(i) AS updated_at FROM range(20) t(i))
      TO '${prefix}customers.parquet';
    COPY (SELECT i AS order_id, i % 20 AS customer_id FROM range(10) t(i)) TO '${prefix}orders/part-0.parquet';
    COPY (SELECT i AS order_id, i % 20 AS customer_id FROM range(10, 25) t(i)) TO '${prefix}orders/part-1.parquet';`);
  con.closeSync();
  instance.closeSync();
  const base = { kind: 's3', path: prefix, format: 'parquet', endpoint: c.endpoint, region: c.region, urlStyle: 'path', useSsl: String(c.useSsl) };
  return {
    base,
    reader: await s3Account(`src-ro-${tenantId}`, prefix),
    writer: await s3Account(`src-rw-${tenantId}`, prefix, ['s3:PutObject']),
    deleter: await s3Account(`src-rd-${tenantId}`, prefix, ['s3:DeleteObject']),
    async cleanup() {
      for (const kind of ['ro', 'rw', 'rd']) await iam('DeleteUser', { UserName: `src-${kind}-${tenantId}` });
    },
  };
}

/**
 * MySQL 源库（TEST_MYSQL_URL，如 mysql://root:密码@localhost:3306/crm_source_test，账号须能建库建用户）：
 * orders 表带自增主键与 updated_at；只读账号与对 orders 可写的账号。返回登记时提交的公共字段（不含账号）
 */
export async function seedMysqlSource() {
  const url = new URL(process.env.TEST_MYSQL_URL!);
  const db = url.pathname.slice(1);
  const instance = await DuckDBInstance.create(':memory:');
  const con = await instance.connect();
  const exec = (sql: string) => con.run(`CALL mysql_execute('admin', '${sql.replace(/'/g, "''")}')`);
  try {
    await con.run(`INSTALL mysql; LOAD mysql;
      ATTACH 'host=${url.hostname} port=${url.port || 3306} user=${decodeURIComponent(url.username)} password=${decodeURIComponent(url.password)}' AS admin (TYPE mysql)`);
    await exec(`DROP DATABASE IF EXISTS ${db}`);
    await exec(`CREATE DATABASE ${db}`);
    await exec(`CREATE TABLE ${db}.orders (order_id BIGINT AUTO_INCREMENT PRIMARY KEY, amount DECIMAL(10, 2) NOT NULL, updated_at DATETIME NOT NULL)`);
    await exec(`INSERT INTO ${db}.orders (amount, updated_at) VALUES (10, '2024-06-01 10:00:00'), (20, '2024-06-02 10:00:00'), (30, '2024-06-03 10:00:00')`);
    for (const { user, password } of [READER, WRITER]) {
      await exec(`DROP USER IF EXISTS '${user}'@'%'`);
      await exec(`CREATE USER '${user}'@'%' IDENTIFIED BY '${password.replace(/'/g, "''")}'`);
      await exec(`GRANT SELECT ON ${db}.* TO '${user}'@'%'`);
    }
    await exec(`GRANT INSERT, UPDATE ON ${db}.orders TO '${WRITER.user}'@'%'`);
  } finally {
    con.closeSync();
    instance.closeSync();
  }
  return { kind: 'mysql', host: url.hostname, port: url.port || '3306', database: db };
}

/**
 * MongoDB 源库（TEST_MONGO_URL，如 mongodb://crm:密码@localhost:27017/crm_source_test?authSource=admin，账号须能建库建用户）：
 * - customers：ObjectId 主键 + updated_at（水位线候选：更新时间与 ObjectId），嵌套的 address 与数组 tags
 * - orders：ObjectId 主键，没有更新时间（水位线候选：ObjectId）
 * - events：字符串主键、没有更新时间，行数超过测试设定的大表阈值（全量比对、默认每天同步）
 * 账号都建在源库里（认证库即源库）：只读、可写、只能列集合与读 customers 的、以及对源库没有任何权限的。
 * 返回登记时提交的公共字段（不含账号）
 */
export async function seedMongoSource() {
  const url = new URL(process.env.TEST_MONGO_URL!);
  const db = url.pathname.slice(1);
  const client = new MongoClient(url.toString());
  try {
    const source = client.db(db);
    await source.dropDatabase();
    for (const user of [...Object.values(MONGO_USERS)].map(u => u.user)) await source.command({ dropUser: user }).catch(() => undefined);
    await source.command({ dropRole: 'customers_only' }).catch(() => undefined);
    await source.collection('customers').insertMany(Array.from({ length: 40 }, (_, i) => ({
      name: `消费者${i}`,
      email: i % 4 === 0 ? null : `user${i}@example.com`,
      address: { city: ['北京', '上海', '广州', '深圳'][i % 4], street: `路${i}号` },
      tags: i % 2 ? ['vip'] : [],
      updated_at: new Date(Date.UTC(2024, 5, 1, i)),
    })));
    await source.collection('orders').insertMany(Array.from({ length: 100 }, (_, i) => ({ customer: i % 40, amount: 10 + i, status: i % 2 ? 'paid' : 'refunded' })));
    await source.collection<{ _id: string }>('events').insertMany(Array.from({ length: 1500 }, (_, i) => ({ _id: `evt-${i}`, type: 'view', occurred_at: new Date(Date.UTC(2024, 2, 1, 0, i)) })));
    await source.command({
      createRole: 'customers_only',
      privileges: [
        { resource: { db, collection: '' }, actions: ['listCollections'] },
        { resource: { db, collection: 'customers' }, actions: ['find'] },
      ],
      roles: [],
    });
    const roles = { reader: [{ role: 'read', db }], writer: [{ role: 'readWrite', db }], partial: ['customers_only'], stranger: [] };
    for (const [key, { user, password }] of Object.entries(MONGO_USERS)) {
      await source.command({ createUser: user, pwd: password, roles: roles[key as keyof typeof MONGO_USERS] });
    }
  } finally {
    await client.close();
  }
  return { kind: 'mongodb', host: url.hostname, port: url.port || '27017', database: db, authSource: db };
}

export const MONGO_USERS = {
  reader: READER,
  writer: WRITER,
  partial: { user: 'crm_src_partial', password: 'partial-p@ss' },
  stranger: { user: 'crm_src_stranger', password: 'stranger-p@ss' },
};
