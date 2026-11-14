// scripts/drop-test-resources.ts —— 回收 Sandcastle 按票分配的测试资源（库名 / 前缀带 _i<n>，见 .sandcastle/main.ts 的 testEnv）。
// 每张票的沙箱关掉后由 main.ts 调用；下次再跑这张票时 test/global-setup.ts 与夹具会重新建库。
// 回收的范围：基准名加后缀、可能再加 worker 后缀 _w<i>：
// - PG：crm_platform_test、crm_source_test、crm_platform_browser 的库，以及这些库里租户的 catalog 角色 lake_<id>（集群级，
//   删库不会带走）。先记下依赖在库里的角色，删库后没有其他库再依赖的才删
// - 对象存储：TEST_S3_LAKE_URI 加后缀的前缀下的全部对象，以及策略只授权这些前缀的账号（租户的 lake-<id>[-ro]、源文件的 src-*-<id>）；
//   每租户一桶（ADR-0008）的桶租户另有独占的桶 lake-<租户 ID>——桶名不含票后缀、开发租户的桶同名，不能按 lake-* 列桶全删，
//   只能按测试库 platform.tenant_lakes 里记的 data_path 连桶带账号删（删库前先记下）
// - MySQL / MongoDB：TEST_MYSQL_URL、TEST_MONGO_URL 的库名加后缀的库（MongoDB 删库不删库里的用户与角色，先删它们）
// - PG / MySQL：源端测试账号 crm_src_reader|writer_i<n>_w<i>（集群级，test/pipeline/source-fixtures.ts 建的，
//   名字见 scripts/test-resource-names.ts；只在删库之后回收，还有依赖（如开发库在用）就跳过。MongoDB 的同名账号
//   与 crm_src_partial|stranger 建在各自票的源库里，删库时已一并清掉，这里不回收）
// 某一类回收失败时照样回收其余各类，最后以退出码 1 报告。
// 用法：node --env-file-if-exists=.env --env-file-if-exists=.env.test --import tsx scripts/drop-test-resources.ts _i336 [_i337 …]
//       加 --all 回收全部 _i<数字> 的资源（没有 Sandcastle 在跑时用）
import { DuckDBInstance } from '@duckdb/node-api';
import { MongoClient } from 'mongodb';
import pg from 'pg';
import { platformS3, deleteTenantS3Account } from '../app/.server/s3-accounts';
import { deleteBucket, deleteObject, listObjects, signedFetch, xmlTag, xmlTags } from '../app/.server/s3-client';
import { accountsToDrop, escapeRe, nameMatcher, suffixPattern } from './test-resource-names';

const PG_URL = process.env.TEST_PLATFORM_DATABASE_URL ?? 'postgres://crm:crm@localhost:5432/crm_platform_test';
const PG_BASES = ['crm_platform_test', 'crm_source_test', 'crm_platform_browser'];

const args = process.argv.slice(2);
const all = args.includes('--all');
const suffixes = args.filter(a => a !== '--all');
if (!all && (suffixes.length === 0 || suffixes.some(s => !/^_i\w+$/.test(s)))) {
  console.error('用法：drop-test-resources.ts _i<n> [_i<n> …] | --all');
  process.exit(2);
}

const suffixRe = suffixPattern(all ? 'all' : suffixes);
/** base 加票后缀、可能再加 worker 后缀的名字 */
const matcher = (bases: string[]) => nameMatcher(bases, suffixRe);
const dbNameOf = (url: string) => new URL(url).pathname.slice(1);

/** 测试库 tenant_lakes 里登记的桶租户（每租户一桶），以及 lake_migrations 里迁离的旧桶：删库后没人知道它们，先记下来交给 dropS3Buckets 回收 */
const bucketTenants: { tenantId: string | null; dataPath: string }[] = [];

async function dropPg() {
  const admin = new pg.Client({ connectionString: Object.assign(new URL(PG_URL), { pathname: '/postgres' }).toString() });
  await admin.connect();
  try {
    const re = matcher(PG_BASES);
    const dbs = (await admin.query<{ datname: string }>('SELECT datname FROM pg_database')).rows.map(r => r.datname).filter(n => re.test(n));
    const roles = new Set<string>();
    for (const db of dbs) {
      await collectBucketTenants(db);
      const { rows } = await admin.query<{ rolname: string }>(
        `SELECT DISTINCT r.rolname FROM pg_shdepend s JOIN pg_roles r ON r.oid = s.refobjid JOIN pg_database d ON d.oid = s.dbid
         WHERE d.datname = $1 AND r.rolname LIKE 'lake\\_%'`, [db]);
      for (const { rolname } of rows) roles.add(rolname);
      await admin.query(`DROP DATABASE IF EXISTS "${db.replace(/"/g, '""')}" WITH (FORCE)`);
    }
    /** 集群级角色：还有库依赖（如开发库在用）就跳过，不 DROP OWNED */
    const dropRoleIfUnused = async (role: string) => {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_shdepend s JOIN pg_roles r ON r.oid = s.refobjid WHERE r.rolname = $1', [role]);
      if (rowCount) return false;
      await admin.query(`DROP ROLE IF EXISTS "${role.replace(/"/g, '""')}"`);
      return true;
    };
    let dropped = 0;
    for (const role of roles) if (await dropRoleIfUnused(role)) dropped++;
    // 源端测试账号（集群级，删库带不走）：LIKE 里的 _ 要转义粗筛，最终以带锚点的 accountsToDrop 为准
    const accounts = accountsToDrop(
      (await admin.query<{ rolname: string }>(`SELECT rolname FROM pg_roles WHERE rolname LIKE 'crm\\_src\\_%'`)).rows.map(r => r.rolname),
      suffixRe,
    );
    let accountsDropped = 0;
    for (const account of accounts) if (await dropRoleIfUnused(account)) accountsDropped++;
    console.log(`PG：删除 ${dbs.length} 个库、${dropped} 个 lake 角色、${accountsDropped} 个源端账号`);
  } finally {
    await admin.end();
  }
}

/** 连到库里记下桶租户（tenant_lakes.data_path 或 lake_migrations.from_path 是桶根的行）：表不存在（如 crm_source_test 没有 platform schema）或连不上就跳过 */
async function collectBucketTenants(db: string) {
  const client = new pg.Client({ connectionString: Object.assign(new URL(PG_URL), { pathname: `/${db}` }).toString() });
  try {
    await client.connect();
    const { rows } = await client.query<{ tenant_id: string; data_path: string }>(
      `SELECT tenant_id, data_path FROM platform.tenant_lakes WHERE data_path LIKE 's3://lake-%'`);
    for (const r of rows) if (/^s3:\/\/lake-[^/]+\/$/.test(r.data_path)) bucketTenants.push({ tenantId: r.tenant_id, dataPath: r.data_path });
    // 迁移离开旧桶的租户（迁移不删旧位置的文件）：桶同样要回收，账号已随 tenant_lakes 那边处理，这里只记桶
    const { rows: migrated } = await client.query<{ from_path: string }>(
      `SELECT DISTINCT from_path FROM platform.lake_migrations WHERE from_path LIKE 's3://lake-%'`);
    for (const r of migrated) if (/^s3:\/\/lake-[^/]+\/$/.test(r.from_path)) bucketTenants.push({ tenantId: null, dataPath: r.from_path });
  } catch (e) {
    console.log(`PG：${db} 里没有可回收的桶租户（${e instanceof Error ? e.message : e}）`);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * 删除桶租户的桶（先清空对象）与账号（dropS3Users 的正则只认共享前缀，认不出桶租户的账号，所以账号也在这里按租户 ID 删）。
 * 单个租户失败不挡其余：桶只在 tenant_lakes / lake_migrations 里有记录、库马上要删，中途放弃会留下删不掉的孤儿桶
 */
async function dropS3Buckets() {
  if (!process.env.S3_ACCESS_KEY) return;
  let dropped = 0;
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const { tenantId, dataPath } of bucketTenants) {
    if (seen.has(dataPath)) continue;
    seen.add(dataPath);
    try {
      await deleteBucket(platformS3(), dataPath);
      if (tenantId) await deleteTenantS3Account(tenantId);
      dropped++;
    } catch (e) {
      errors.push(`${dataPath}：${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`对象存储：删除 ${dropped} 个桶租户的桶${errors.length ? `，${errors.length} 个失败` : ''}`);
  for (const e of errors) console.error(e);
  if (errors.length) throw new Error(`${errors.length} 个桶租户回收失败`);
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
    // 源端测试账号（集群级，与 PG 共用名字）：LIKE 里的 _ 要转义粗筛，最终以带锚点的 accountsToDrop 为准；
    // 用户是 'user'@'host'，按查出来的 host 逐个删，不假定是 %
    const users = (await con.runAndReadAll(
      `SELECT * FROM mysql_query('admin', 'SELECT user, host FROM mysql.user WHERE user LIKE ''crm\\_src\\_%''')`,
    )).getRowObjects();
    const sqlStr = (v: unknown) => String(v).replace(/'/g, "''");
    let usersDropped = 0;
    for (const user of accountsToDrop(users.map(r => String(r.user)), suffixRe)) {
      for (const host of new Set(users.filter(r => String(r.user) === user).map(r => String(r.host)))) {
        await con.run(`CALL mysql_execute('admin', 'DROP USER IF EXISTS ''${sqlStr(user)}''@''${sqlStr(host)}''')`);
        usersDropped++;
      }
    }
    console.log(`MySQL：删除 ${dbs.length} 个库、${usersDropped} 个源端账号`);
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
await step('对象存储桶租户', dropS3Buckets);
await step('对象存储账号', dropS3Users);
await step('对象存储对象', dropS3Objects);
await step('MySQL ', dropMysql);
await step('MongoDB ', dropMongo);
process.exit(failed ? 1 : 0);
