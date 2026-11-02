// scripts/drop-test-resources.ts —— 回收 Sandcastle 按票分配的测试资源（库名 / 前缀带 _i<n>，见 .sandcastle/main.ts 的 testEnv）。
// 每张票的沙箱关掉后由 main.ts 调用；下次再跑这张票时 test/global-setup.ts 与夹具会重新建库。
// 回收的范围：基准名加后缀、可能再加 worker 后缀 _w<i>：
// - PG：crm_platform_test、crm_source_test、crm_platform_browser 的库，以及这些库里租户的 catalog 角色 lake_<id>（集群级，
//   删库不会带走）。先记下依赖在库里的角色，删库后没有其他库再依赖的才删
// - 对象存储：TEST_S3_LAKE_URI 加后缀的前缀下的全部对象，以及策略只授权这些前缀的账号（租户的 lake-<id>[-ro]、源文件的 src-*-<id>）
// - MySQL / MongoDB：TEST_MYSQL_URL、TEST_MONGO_URL 的库名加后缀的库（MongoDB 删库不删库里的用户与角色，先删它们）
// 某一类回收失败时照样回收其余各类，最后以退出码 1 报告。
// 用法：node --env-file-if-exists=.env --env-file-if-exists=.env.test --import tsx scripts/drop-test-resources.ts _i336 [_i337 …]
//       加 --all 回收全部 _i<数字> 的资源（没有 Sandcastle 在跑时用）
import { DuckDBInstance } from '@duckdb/node-api';
import { MongoClient } from 'mongodb';
import pg from 'pg';
import { platformS3 } from '../app/.server/s3-accounts';
import { deleteObject, listObjects, signedFetch, xmlTag, xmlTags } from '../app/.server/s3-client';

const PG_URL = process.env.TEST_PLATFORM_DATABASE_URL ?? 'postgres://crm:crm@localhost:5432/crm_platform_test';
const PG_BASES = ['crm_platform_test', 'crm_source_test', 'crm_platform_browser'];

const args = process.argv.slice(2);
const all = args.includes('--all');
const suffixes = args.filter(a => a !== '--all');
if (!all && (suffixes.length === 0 || suffixes.some(s => !/^_i\w+$/.test(s)))) {
  console.error('用法：drop-test-resources.ts _i<n> [_i<n> …] | --all');
  process.exit(2);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const suffixRe = all ? '_i\\d+' : `(?:${suffixes.map(escapeRe).join('|')})`;
/** base 加票后缀、可能再加 worker 后缀的名字 */
const matcher = (bases: string[]) => new RegExp(`^(?:${bases.map(escapeRe).join('|')})${suffixRe}(?:_w\\d+)?$`);
const dbNameOf = (url: string) => new URL(url).pathname.slice(1);

async function dropPg() {
  const admin = new pg.Client({ connectionString: Object.assign(new URL(PG_URL), { pathname: '/postgres' }).toString() });
  await admin.connect();
  try {
    const re = matcher(PG_BASES);
    const dbs = (await admin.query<{ datname: string }>('SELECT datname FROM pg_database')).rows.map(r => r.datname).filter(n => re.test(n));
    const roles = new Set<string>();
    for (const db of dbs) {
      const { rows } = await admin.query<{ rolname: string }>(
        `SELECT DISTINCT r.rolname FROM pg_shdepend s JOIN pg_roles r ON r.oid = s.refobjid JOIN pg_database d ON d.oid = s.dbid
         WHERE d.datname = $1 AND r.rolname LIKE 'lake\\_%'`, [db]);
      for (const { rolname } of rows) roles.add(rolname);
      await admin.query(`DROP DATABASE IF EXISTS "${db.replace(/"/g, '""')}" WITH (FORCE)`);
    }
    let dropped = 0;
    for (const role of roles) {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_shdepend s JOIN pg_roles r ON r.oid = s.refobjid WHERE r.rolname = $1', [role]);
      if (rowCount) continue; // 别的库（如开发库）还在用
      await admin.query(`DROP ROLE IF EXISTS "${role.replace(/"/g, '""')}"`);
      dropped++;
    }
    console.log(`PG：删除 ${dbs.length} 个库、${dropped} 个角色`);
  } finally {
    await admin.end();
  }
}

async function iam(action: string, params: Record<string, string>) {
  const res = await signedFetch(platformS3(), 'iam', {
    method: 'POST',
    path: '/',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams({ Action: action, Version: '2010-05-08', ...params }).toString(),
  });
  const xml = await res.text();
  if (!res.ok && !/NoSuchEntity/.test(xml)) throw new Error(`IAM ${action} 失败：${xml}`);
  return xml;
}

/**
 * 删除策略只授权本票前缀（TEST_S3_LAKE_URI 加票后缀 [+ worker 后缀]）的对象存储账号：租户的 lake-<id>[-ro]（策略 tenant-lake）
 * 与源文件的 src-*-<id>（策略 source）。按策略里的前缀认，不靠 PG 里的租户行（测试清表后就没了）。
 * 先删密钥与策略，否则 DeleteUser 报 DeleteConflict
 */
async function dropS3Users() {
  const base = process.env.TEST_S3_LAKE_URI;
  if (!base || !process.env.S3_ACCESS_KEY) return;
  const re = new RegExp(`arn:aws:s3:::${escapeRe(base.replace(/^s3:\/\//, ''))}${suffixRe}(?:_w\\d+)?/`);
  const POLICIES = ['tenant-lake', 'source'];
  let dropped = 0;
  for (const UserName of xmlTags(await iam('ListUsers', {}), 'UserName')) {
    const docs = await Promise.all(POLICIES.map(async PolicyName => xmlTag(await iam('GetUserPolicy', { UserName, PolicyName }), 'PolicyDocument') ?? ''));
    if (!docs.some(d => re.test(d))) continue;
    for (const AccessKeyId of xmlTags(await iam('ListAccessKeys', { UserName }), 'AccessKeyId')) await iam('DeleteAccessKey', { UserName, AccessKeyId });
    for (const PolicyName of POLICIES) await iam('DeleteUserPolicy', { UserName, PolicyName });
    await iam('DeleteUser', { UserName });
    dropped++;
  }
  console.log(`对象存储：删除 ${dropped} 个账号`);
}

async function dropS3Objects() {
  const base = process.env.TEST_S3_LAKE_URI;
  if (!base || !process.env.S3_ACCESS_KEY) return;
  const creds = platformS3();
  // 列出以基准前缀开头的全部对象，再按「基准 + 票后缀 [+ worker 后缀] + /」筛：_i33 不能误删 _i336 的
  const re = new RegExp(`^${suffixRe}(?:_w\\d+)?/`);
  const objects = (await listObjects(creds, base)).filter(o => re.test(o.path));
  const queue = [...objects];
  await Promise.all(Array.from({ length: 16 }, async () => {
    for (let o = queue.shift(); o; o = queue.shift()) await deleteObject(creds, base + o.path);
  }));
  console.log(`对象存储：删除 ${objects.length} 个对象`);
}

async function dropMysql() {
  const url = process.env.TEST_MYSQL_URL && new URL(process.env.TEST_MYSQL_URL);
  if (!url) return;
  const re = matcher([dbNameOf(url.toString())]);
  const instance = await DuckDBInstance.create(':memory:');
  const con = await instance.connect();
  try {
    await con.run(`INSTALL mysql; LOAD mysql;
      ATTACH 'host=${url.hostname} port=${url.port || 3306} user=${decodeURIComponent(url.username)} password=${decodeURIComponent(url.password)}' AS admin (TYPE mysql)`);
    const rows = (await con.runAndReadAll(`SELECT * FROM mysql_query('admin', 'SHOW DATABASES')`)).getRowObjects();
    const dbs = rows.map(r => String(Object.values(r)[0])).filter(n => re.test(n));
    for (const db of dbs) await con.run(`CALL mysql_execute('admin', 'DROP DATABASE IF EXISTS \`${db}\`')`);
    console.log(`MySQL：删除 ${dbs.length} 个库`);
  } finally {
    con.closeSync();
    instance.closeSync();
  }
}

async function dropMongo() {
  const url = process.env.TEST_MONGO_URL;
  if (!url) return;
  const re = matcher([dbNameOf(url)]);
  const client = new MongoClient(url);
  try {
    const { databases } = await client.db().admin().listDatabases({ nameOnly: true });
    const dbs = databases.map(d => d.name).filter(n => re.test(n));
    for (const name of dbs) {
      const db = client.db(name);
      await db.command({ dropAllUsersFromDatabase: 1 });
      await db.command({ dropAllRolesFromDatabase: 1 });
      await db.dropDatabase();
    }
    console.log(`MongoDB：删除 ${dbs.length} 个库`);
  } finally {
    await client.close();
  }
}

let failed = false;
const step = async <T>(what: string, fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (e) {
    failed = true;
    console.error(`${what}回收失败：${e instanceof Error ? e.message : e}`);
    return undefined;
  }
};

console.log(`回收测试资源：${all ? '全部 _i<n>' : suffixes.join(' ')}`);
await step('PG ', dropPg);
await step('对象存储账号', dropS3Users);
await step('对象存储对象', dropS3Objects);
await step('MySQL ', dropMysql);
await step('MongoDB ', dropMongo);
process.exit(failed ? 1 : 0);
