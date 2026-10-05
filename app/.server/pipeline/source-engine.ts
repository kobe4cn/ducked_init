// app/.server/pipeline/source-engine.ts —— 连接租户的数据源：只读挂载、探测账号写权限、列出源表（不读行）、采集给定表的列统计与水位线候选。
// 平台进程（登记、测试连接）与工作进程（采集任务）共用。凭据以临时 secret 注入独立的内存 DuckDB，不落盘；
// 挂载后锁住配置：不能再挂载其他库、读其他路径。平台从不向源端发送写语句：PostgreSQL 的只读挂载把一切语句都放在只读事务里，
// 发往源端的只有这里写死的只读查询（成员与模型都不能给出发往源端的 SQL）。MongoDB 经社区扩展 mongo 只读挂载，
// 账号的读写权限另用 MongoDB 驱动执行 connectionStatus 查询（扩展不能执行命令）
import { randomUUID } from 'node:crypto';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { MongoClient, type MongoClientOptions } from 'mongodb';
import { objectPath, signedFetch, xmlTag } from '../s3-client';
import type { EngineLimits } from './lake-engine';
import { SENSITIVE_FORMATS, SENSITIVE_NAME } from '../../lib/sensitive';

export interface S3Connection { endpoint: string; region: string; urlStyle: string; useSsl: boolean; keyId: string; secret: string }

export const FILE_FORMATS = ['parquet', 'csv', 'json'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

/** 连接一个数据源所需的全部信息（含解密后的凭据）。只在内存里传递：平台进程解密后直接使用，或经 IPC 交给工作进程 */
export type SourceSpec =
  | { kind: 'postgres'; host: string; port: number; database: string; schema: string; user: string; password: string }
  | { kind: 'mysql'; host: string; port: number; database: string; user: string; password: string }
  /** srv：以 mongodb+srv:// 连接（MongoDB Atlas），端口由 DNS 给出，并默认使用 TLS；authSource 是账号所在的认证库 */
  | { kind: 'mongodb'; host: string; port: number; srv: boolean; tls: boolean; database: string; authSource: string; user: string; password: string }
  /** path 是以 / 结尾的前缀：其下每个子目录（或顶层的每个文件）是一张表 */
  | { kind: 's3'; path: string; format: FileFormat; s3: S3Connection }
  /** path 是对象存储上的文件（带 s3）或平台本机上租户源文件目录里的文件 */
  | { kind: 'duckdb'; path: string; s3?: S3Connection };

/** 账号在源端可以写入的对象与权限 */
export interface WriteGrant { object: string; privileges: string[] }

export interface ColumnProfile {
  name: string;
  type: string;
  /** 样本中的空值比例（0–1） */
  nullRate: number;
  /** 样本中不同取值的个数（近似） */
  distinct: number;
  /** 数值与时间列的取值范围；文本列不给取值范围（可能是手机号等敏感信息），只给长度范围 */
  min: string | null;
  max: string | null;
  length?: { min: number; max: number };
  /** 文本列的格式特征：样本中符合各格式的比例，只列出至少一半符合的 */
  formats?: { format: TextFormat; share: number }[];
  /** 低基数、不像敏感信息的文本列：样本中最常见的取值与各自的行数（ADR-0016） */
  top?: { value: string; rows: number }[];
}

export type WatermarkKind = 'updated_at' | 'increment';
export interface WatermarkCandidate { column: string; kind: WatermarkKind; reason: string }

export interface TableProfile {
  name: string;
  rows: number;
  /** 列统计基于的样本行数 */
  sampleRows: number;
  columns: ColumnProfile[];
  watermarkCandidates: WatermarkCandidate[];
  /** 源端主键（按主键中的顺序）；没有时为空 */
  primaryKey: string[];
  /** 没有主键时可作业务主键的列：样本中非空、取值（近似）唯一的整数、文本或 UUID 列 */
  keyCandidates: string[];
}

export const TEXT_FORMATS = {
  email: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
  mobile: '^(\\+?86)?1[3-9][0-9]{9}$',
  integer: '^-?[0-9]+$',
  decimal: '^-?[0-9]+\\.[0-9]+$',
  date: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
  datetime: '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}',
  uuid: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  json: '^\\s*[\\[{]',
  objectid: '^[0-9a-f]{24}$',
} as const;
export type TextFormat = keyof typeof TEXT_FORMATS;

/** 文本列不同取值（近似）不超过这个数，才保存常见取值；近似计数可能偏少，保存时也以此为上限 */
const TOP_MAX_DISTINCT = 50;
/** 常见取值的最大长度：更长的多半是备注等自由文本 */
const TOP_VALUE_MAX_LENGTH = 64;

/** 更新时间字段的常见命名 */
const UPDATED_AT_NAME = /upd|modif|mtime|chang|last_?edit/i;

/** SQL 字符串字面量（DuckDB 与 PostgreSQL、MySQL 的写法相同） */
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];

const FILE_EXTENSIONS: Record<FileFormat, RegExp> = {
  parquet: /\.parquet$/i,
  csv: /\.(csv|tsv)(\.gz)?$/i,
  json: /\.(json|jsonl|ndjson)(\.gz)?$/i,
};
const READERS: Record<FileFormat, string> = { parquet: 'read_parquet', csv: 'read_csv', json: 'read_json_auto' };

/**
 * 源表：名称、所在 schema 与源端的表名（对象存储文件没有）、在会话里读取它的 FROM 子句，
 * 以及账号能否读取（PostgreSQL 目录里看得到没有读权限的表，MongoDB 同理）
 */
export interface SourceTable { name: string; schema: string; table: string; from: string; readable: boolean }

export interface SourceSession {
  /** 源端已只读挂载为 src，配置已锁定 */
  con: DuckDBConnection;
  /** MongoDB 账号的权限（挂载前查询） */
  mongo?: MongoAccess;
  tables(): Promise<SourceTable[]>;
  close(): void;
}

/** 错误信息会展示给成员：抹掉其中的凭据 */
export function redactSourceSecrets(message: string, spec: SourceSpec) {
  // MongoDB 的连接串里密码经过百分号编码
  const secrets = ('password' in spec ? [spec.password, encodeURIComponent(spec.password)] : [spec.s3?.secret, spec.s3?.keyId])
    .filter((s): s is string => !!s);
  return secrets.reduce((m, s) => m.replaceAll(s, '***'), message);
}

/** 对象存储凭据只用于 scope 下的路径：同一个 DuckDB 里还挂着租户数据湖时（同步任务），两把凭据各管各的前缀 */
function s3Secret(s3: S3Connection, scope: string) {
  return `INSTALL httpfs; LOAD httpfs;
    CREATE TEMPORARY SECRET src_s3 (TYPE s3, KEY_ID ${lit(s3.keyId)}, SECRET ${lit(s3.secret)}, REGION ${lit(s3.region)},
      ENDPOINT ${lit(s3.endpoint)}, URL_STYLE ${lit(s3.urlStyle)}, USE_SSL ${s3.useSsl}, SCOPE ${lit(scope)})`;
}

/** 在已有的 DuckDB 里以 src 只读挂载数据源，返回锁定配置时要放行的路径。调用方负责随后锁住配置 */
export async function attachSource(con: DuckDBConnection, spec: SourceSpec): Promise<{ allowed: string[]; mongo?: MongoAccess }> {
  switch (spec.kind) {
    case 'postgres':
      await con.run(`INSTALL postgres; LOAD postgres;
        CREATE TEMPORARY SECRET src_pg (TYPE postgres, HOST ${lit(spec.host)}, PORT ${spec.port}, DATABASE ${lit(spec.database)},
          USER ${lit(spec.user)}, PASSWORD ${lit(spec.password)});
        ATTACH 'connect_timeout=10' AS src (TYPE postgres, SECRET src_pg, SCHEMA ${lit(spec.schema)}, READ_ONLY)`);
      return { allowed: [] };
    case 'mysql':
      await con.run(`INSTALL mysql; LOAD mysql;
        CREATE TEMPORARY SECRET src_mysql (TYPE mysql, HOST ${lit(spec.host)}, PORT ${spec.port}, DATABASE ${lit(spec.database)},
          USER ${lit(spec.user)}, PASSWORD ${lit(spec.password)});
        ATTACH '' AS src (TYPE mysql, SECRET src_mysql, READ_ONLY)`);
      return { allowed: [] };
    case 'mongodb': {
      // 先用驱动登录并查权限：密码错误等连接问题在这里报出（扩展列集合失败时只会返回空清单）
      const mongo = await mongoAccess(spec);
      await con.run(`INSTALL mongo FROM community; LOAD mongo;
        CREATE TEMPORARY SECRET src_mongo (TYPE mongo, HOST ${lit(spec.host)}, PORT ${lit(String(spec.port))},
          USER ${lit(spec.user)}, PASSWORD ${lit(spec.password)}, AUTHSOURCE ${lit(spec.authSource)},
          SRV ${lit(String(spec.srv))}, TLS ${lit(String(spec.tls))});
        ATTACH ${lit(`dbname=${spec.database}`)} AS src (TYPE mongo, SECRET src_mongo, READ_ONLY);
        SET mongo_enable_direct_scan = false`);
      return { allowed: [], mongo };
    }
    case 's3':
      await con.run(s3Secret(spec.s3, spec.path));
      return { allowed: [spec.path] };
    case 'duckdb':
      if (spec.s3) await con.run(s3Secret(spec.s3, spec.path));
      await con.run(`ATTACH ${lit(spec.path)} AS src (READ_ONLY)`);
      return { allowed: [spec.path] };
  }
}

/** 锁住配置：此后只能读 allowed 下的路径，不能再挂载其他库，也不能改回这些设置 */
export async function lockConfiguration(con: DuckDBConnection, allowed: string[]) {
  await con.run(`SET allowed_directories = [${allowed.map(lit).join(', ')}];
    SET enable_external_access = false;
    SET lock_configuration = true;`);
}

/** 只读挂载数据源并锁住配置 */
export async function openSource(spec: SourceSpec, limits: EngineLimits): Promise<SourceSession> {
  const instance = await DuckDBInstance.create(':memory:', {
    memory_limit: `${limits.memoryLimitMb}MiB`,
    threads: String(limits.threads),
  });
  const con = await instance.connect();
  const close = () => { con.closeSync(); instance.closeSync(); };
  let mongo: MongoAccess | undefined;
  try {
    const attached = await attachSource(con, spec);
    mongo = attached.mongo;
    await lockConfiguration(con, attached.allowed);
  } catch (e) {
    close();
    throw new Error(redactSourceSecrets((e as Error).message, spec));
  }
  return { con, mongo, tables: () => listTables(con, spec, mongo), close };
}

export async function listTables(con: DuckDBConnection, spec: SourceSpec, mongo?: MongoAccess): Promise<SourceTable[]> {
  if (spec.kind === 's3') {
    const files = await rows<{ file: string }>(con, `SELECT file FROM glob(${lit(`${spec.path}**`)}) ORDER BY file`);
    const byTable = new Map<string, string[]>();
    for (const { file } of files) {
      if (!FILE_EXTENSIONS[spec.format].test(file)) continue;
      const rel = file.slice(spec.path.length);
      const name = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel.replace(FILE_EXTENSIONS[spec.format], '');
      byTable.set(name, [...(byTable.get(name) ?? []), file]);
    }
    return [...byTable].map(([name, list]) => ({ name, schema: '', table: name, from: `${READERS[spec.format]}([${list.map(lit).join(', ')}])`, readable: true }));
  }
  if (spec.kind === 'mongodb' && !mongo!.can('listCollections', spec.database, '')) {
    throw new Error(`账号 ${spec.user} 没有库 ${spec.database} 的读权限，列不出集合。请在 MongoDB 授予：${mongoReadGrant(spec)}`);
  }
  const schema = spec.kind === 'postgres' ? spec.schema : spec.kind === 'mysql' || spec.kind === 'mongodb' ? spec.database : null;
  const found = await rows<{ schema: string; name: string }>(con, `
    SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
    WHERE table_catalog = 'src' ${schema ? `AND table_schema = ${lit(schema)}` : ''} ORDER BY ALL`);
  const readable = spec.kind === 'postgres'
    ? new Set((await rows<{ schema: string; name: string }>(con, `SELECT * FROM postgres_query('src', ${lit(PG_READABLE_TABLES)})`)).map(t => `${t.schema}.${t.name}`))
    : null;
  return found.map(t => ({
    name: schema || t.schema === 'main' ? t.name : `${t.schema}.${t.name}`,
    schema: t.schema,
    table: t.name,
    from: `src.${ident(t.schema)}.${ident(t.name)}`,
    readable: mongo ? mongo.can('find', t.schema, t.name) : !readable || readable.has(`${t.schema}.${t.name}`),
  }));
}

/** 账号能读取的表：schema 有 USAGE 且表有 SELECT */
const PG_READABLE_TABLES = `
  SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT')`;

/** MongoDB 权限的作用对象（connectionStatus 返回的 resource；system_buckets 是时序集合的底层桶） */
interface MongoResource { db?: string; collection?: string; system_buckets?: string; cluster?: boolean; anyResource?: boolean }
interface MongoPrivilege { resource: MongoResource; actions: string[] }

/** MongoDB 账号的权限：accessControl 为 false 表示服务没有开启访问控制，任何连接都能做任何操作 */
export interface MongoAccess {
  accessControl: boolean;
  privileges: MongoPrivilege[];
  /** 账号能否在 db.collection 上执行 action（collection 为空串表示整个库） */
  can(action: string, db: string, collection: string): boolean;
}

/** 让账号能读整个源库的授权语句（在账号所在的认证库上执行） */
export const mongoReadGrant = (spec: { user: string; authSource: string; database: string }) =>
  `db.getSiblingDB(${lit(spec.authSource)}).grantRolesToUser(${lit(spec.user)}, [{ role: 'read', db: ${lit(spec.database)} }])`;

const covers = (r: MongoResource, db: string, collection: string) =>
  !!r.anyResource || (r.db !== undefined && (r.db === '' || r.db === db) && (r.collection === '' || r.collection === collection));

function mongoClient(spec: Extract<SourceSpec, { kind: 'mongodb' }>, withAccount: boolean) {
  const url = spec.srv ? `mongodb+srv://${spec.host}/` : `mongodb://${spec.host}:${spec.port}/`;
  const options: MongoClientOptions = { serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000, tls: spec.srv || spec.tls };
  if (withAccount) Object.assign(options, { auth: { username: spec.user, password: spec.password }, authSource: spec.authSource });
  return new MongoClient(url, options);
}

/** 用 connectionStatus 查账号的全部权限；再以不带账号的连接列库，能列出即服务没有开启访问控制 */
async function mongoAccess(spec: Extract<SourceSpec, { kind: 'mongodb' }>): Promise<MongoAccess> {
  const client = mongoClient(spec, true);
  let privileges: MongoPrivilege[];
  try {
    const status = await client.db(spec.authSource).command({ connectionStatus: 1, showPrivileges: true });
    privileges = status.authInfo?.authenticatedUserPrivileges ?? [];
  } finally {
    await client.close();
  }
  const anonymous = mongoClient(spec, false);
  const accessControl = await anonymous.db('admin').command({ listDatabases: 1, nameOnly: true })
    .then(() => false, () => true)
    .finally(() => anonymous.close());
  return {
    accessControl,
    privileges,
    can: (action, db, collection) => !accessControl
      || privileges.some(p => covers(p.resource, db, collection) && (p.actions.includes(action) || p.actions.includes('anyAction'))),
  };
}

/** 写入数据、改结构，以及能给自己授权（userAdmin 类）的操作 */
const MONGO_WRITE_ACTIONS = new Set(['insert', 'update', 'remove', 'createCollection', 'dropCollection', 'dropDatabase', 'createIndex',
  'dropIndex', 'collMod', 'convertToCapped', 'renameCollectionSameDB', 'emptycapped', 'compact', 'createSearchIndexes', 'dropSearchIndex',
  'updateSearchIndex', 'applyOps', 'createUser', 'grantRole', 'createRole', 'grantRolesToUser', 'anyAction']);

function mongoResourceLabel(r: MongoResource) {
  if (r.anyResource) return '整个服务';
  if (r.cluster) return '集群';
  const db = r.db ? `库 ${r.db}` : '所有库';
  if (r.system_buckets !== undefined) return `${db}的时序集合${r.system_buckets ? ` ${r.system_buckets}` : ''}`;
  if (!r.collection) return db;
  return r.db ? `${r.db}.${r.collection}` : `所有库的集合 ${r.collection}`;
}

/** 范围越大越靠前：拒绝登记时只举前几个例子，要让成员先看到最要紧的 */
const mongoResourceRank = (r: MongoResource) =>
  r.anyResource ? 0 : r.cluster ? 1 : r.db === '' && r.collection === '' ? 2 : r.collection === '' ? 3 : 4;

function mongoWriteGrants({ accessControl, privileges }: MongoAccess): WriteGrant[] {
  if (!accessControl) return [{ object: '整个服务（没有开启访问控制，任何连接都能写入）', privileges: ['全部操作'] }];
  const writes = privileges
    .map(p => ({ resource: p.resource, actions: p.actions.filter(a => MONGO_WRITE_ACTIONS.has(a)) }))
    .filter(p => p.actions.length);
  // 内置角色对整个库授权时，另对 system.js 等系统集合单列一条同样的权限，归到库上即可
  const wholeDb = new Set(writes.filter(p => p.resource.db && p.resource.collection === '').map(p => p.resource.db));
  return writes
    .filter(p => !(p.resource.collection?.startsWith('system.') && wholeDb.has(p.resource.db)))
    .sort((a, b) => mongoResourceRank(a.resource) - mongoResourceRank(b.resource))
    .map(p => ({ object: mongoResourceLabel(p.resource), privileges: p.actions }));
}

/** 按对象归并 (权限, 对象) 行 */
function groupGrants(list: { privilege: string; object: string }[]): WriteGrant[] {
  const byObject = new Map<string, string[]>();
  for (const { privilege, object } of list) byObject.set(object, [...new Set([...(byObject.get(object) ?? []), privilege])]);
  return [...byObject].map(([object, privileges]) => ({ object, privileges }));
}

const PG_WRITE_GRANTS = `
  SELECT 'SUPERUSER' AS privilege, current_user::text AS object FROM pg_roles WHERE rolname = current_user AND rolsuper
  UNION ALL
  SELECT 'CREATE', '库 ' || current_database() WHERE has_database_privilege(current_database(), 'CREATE')
  UNION ALL
  SELECT 'CREATE', 'schema ' || n.nspname FROM pg_namespace n
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%' AND has_schema_privilege(n.oid, 'CREATE')
  UNION ALL
  SELECT p.priv, n.nspname || '.' || c.relname
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
  WHERE c.relkind IN ('r', 'p', 'v', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    AND CASE WHEN p.priv IN ('INSERT', 'UPDATE') THEN has_any_column_privilege(c.oid, p.priv) ELSE has_table_privilege(c.oid, p.priv) END`;

const MYSQL_WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'INDEX', 'CREATE VIEW', 'CREATE ROUTINE',
  'ALTER ROUTINE', 'EVENT', 'TRIGGER', 'FILE', 'SUPER', 'CREATE USER'];
// 经角色（MySQL 8）获得的权限不在各级权限表里：账号有可用的角色时无法确认只读，一并列出
const MYSQL_WRITE_GRANTS = (() => {
  const grantee = `CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''', SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''')`;
  const where = `GRANTEE = ${grantee} AND PRIVILEGE_TYPE IN (${MYSQL_WRITE_PRIVILEGES.map(lit).join(', ')})`;
  return `
    SELECT PRIVILEGE_TYPE AS privilege, '*.*' AS object FROM information_schema.USER_PRIVILEGES WHERE ${where}
    UNION ALL SELECT PRIVILEGE_TYPE, CONCAT(TABLE_SCHEMA, '.*') FROM information_schema.SCHEMA_PRIVILEGES WHERE ${where}
    UNION ALL SELECT PRIVILEGE_TYPE, CONCAT(TABLE_SCHEMA, '.', TABLE_NAME) FROM information_schema.TABLE_PRIVILEGES WHERE ${where}
    UNION ALL SELECT PRIVILEGE_TYPE, CONCAT(TABLE_SCHEMA, '.', TABLE_NAME, '.', COLUMN_NAME) FROM information_schema.COLUMN_PRIVILEGES WHERE ${where}
    UNION ALL SELECT '经角色授予（无法逐项核对，请直接授予 SELECT）', CONCAT('角色 ', ROLE_NAME) FROM information_schema.APPLICABLE_ROLES`;
})();

/**
 * 对象存储：对一个不存在的随机键发起分段上传并立即取消，再删除这个键——有写入 / 删除权限时存储服务受理
 * （不留下任何对象，也不碰已有的对象），没有时拒绝（403）。不上传任何数据
 */
async function s3WriteGrants(s3: S3Connection, prefix: string): Promise<WriteGrant[]> {
  const creds = { endpoint: s3.endpoint, region: s3.region, key: s3.keyId, secret: s3.secret, useSsl: s3.useSsl };
  const path = objectPath(`${prefix}.crm-write-probe-${randomUUID()}`);
  /** 受理时返回响应内容，拒绝时返回 null；其他错误只给出状态与错误码，不回显存储服务的响应 */
  const permitted = async (what: string, res: Response) => {
    const body = await res.text();
    if (res.status === 403) return null;
    if (!res.ok) throw new Error(`无法校验对象存储账号的${what}权限（HTTP ${res.status}${xmlTag(body, 'Code') ? ` ${xmlTag(body, 'Code')}` : ''}）`);
    return body;
  };
  const privileges: string[] = [];
  const upload = await permitted('写入', await signedFetch(creds, 's3', { method: 'POST', path, query: { uploads: '' } }));
  if (upload !== null) {
    privileges.push('PutObject');
    const uploadId = xmlTag(upload, 'UploadId');
    if (uploadId) await signedFetch(creds, 's3', { method: 'DELETE', path, query: { uploadId } });
  }
  if (await permitted('删除', await signedFetch(creds, 's3', { method: 'DELETE', path })) !== null) privileges.push('DeleteObject');
  return privileges.length ? [{ object: prefix, privileges }] : [];
}

/** 账号在源端可以写入的对象；空数组表示只读。本机上的 DuckDB 文件没有账号，只读挂载即可 */
export async function writeGrants(session: Pick<SourceSession, 'con' | 'mongo'>, spec: SourceSpec): Promise<WriteGrant[]> {
  switch (spec.kind) {
    case 'postgres':
      return groupGrants(await rows(session.con, `SELECT * FROM postgres_query('src', ${lit(PG_WRITE_GRANTS)})`));
    case 'mysql':
      return groupGrants(await rows(session.con, `SELECT * FROM mysql_query('src', ${lit(MYSQL_WRITE_GRANTS)})`));
    case 'mongodb':
      return mongoWriteGrants(session.mongo!);
    case 's3':
      return s3WriteGrants(spec.s3, spec.path);
    case 'duckdb':
      return spec.s3 ? s3WriteGrants(spec.s3, spec.path.slice(0, spec.path.lastIndexOf('/') + 1)) : [];
  }
}

/** 列出表得到的一张表：名称、所在 schema、账号能否读取，以及源端廉价给出的估算行数（没有时为 null） */
export interface ListedTable { name: string; schema: string; readable: boolean; estimatedRows: number | null }

/**
 * 源端统计信息里的估算行数（表名 → 行数），不读任何行：PostgreSQL 取 pg_class.reltuples（从没统计过的表为 -1，不给），
 * MySQL 取 information_schema.TABLES.TABLE_ROWS。其他数据源不给
 */
export async function estimatedRows(con: DuckDBConnection, spec: SourceSpec): Promise<Map<string, number>> {
  let found: { name: string; n: string | number }[] = [];
  if (spec.kind === 'postgres') {
    found = await rows(con, `SELECT * FROM postgres_query('src', ${lit(`
      SELECT c.relname::text AS name, c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${lit(spec.schema)} AND c.relkind IN ('r', 'p', 'm', 'f') AND c.reltuples >= 0`)})`);
  } else if (spec.kind === 'mysql') {
    found = await rows(con, `SELECT * FROM mysql_query('src', ${lit(`
      SELECT TABLE_NAME AS name, TABLE_ROWS AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ${lit(spec.database)} AND TABLE_ROWS IS NOT NULL`)})`);
  }
  return new Map(found.map(r => [r.name, Number(r.n)]));
}

/** 测试连接与列出表：能否挂载、各表（含读权限与估算行数）、哪些表没有读权限（及其 schema）、账号是否可写。不读任何行 */
export async function inspectSource(spec: SourceSpec, limits: EngineLimits) {
  const session = await openSource(spec, limits);
  try {
    const all = await session.tables();
    const unreadable = all.filter(t => !t.readable);
    const estimates = await estimatedRows(session.con, spec);
    return {
      tables: all.filter(t => t.readable).map(t => t.name),
      unreadable: unreadable.map(t => t.name),
      unreadableSchemas: [...new Set(unreadable.map(t => t.schema))],
      listed: all.map((t): ListedTable => ({ name: t.name, schema: t.schema, readable: t.readable, estimatedRows: estimates.get(t.table) ?? null })),
      writable: await writeGrants(session, spec),
    };
  } catch (e) {
    throw new Error(redactSourceSecrets((e as Error).message, spec));
  } finally {
    session.close();
  }
}

/** 由自增序列生成的单列主键（表名 → 列名） */
async function incrementKeys(con: DuckDBConnection, spec: SourceSpec): Promise<Map<string, string>> {
  let found: { table_name: string; column_name: string }[] = [];
  if (spec.kind === 'postgres') {
    found = await rows(con, `SELECT * FROM postgres_query('src', ${lit(`
      SELECT c.relname::text AS table_name, a.attname::text AS column_name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE i.indisprimary AND i.indnatts = 1 AND n.nspname = ${lit(spec.schema)}
        AND (a.attidentity IN ('a', 'd') OR pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%')`)})`);
  } else if (spec.kind === 'mysql') {
    found = await rows(con, `SELECT * FROM mysql_query('src', ${lit(`
      SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ${lit(spec.database)} AND EXTRA LIKE '%auto_increment%'`)})`);
  } else if (spec.kind === 'duckdb') {
    found = await rows(con, `
      SELECT CASE WHEN k.schema_name = 'main' THEN k.table_name ELSE k.schema_name || '.' || k.table_name END AS table_name,
             k.constraint_column_names[1] AS column_name
      FROM duckdb_constraints() k
      JOIN duckdb_columns() c ON c.database_name = k.database_name AND c.schema_name = k.schema_name
        AND c.table_name = k.table_name AND c.column_name = k.constraint_column_names[1]
      WHERE k.database_name = 'src' AND k.constraint_type = 'PRIMARY KEY' AND len(k.constraint_column_names) = 1
        AND c.column_default LIKE 'nextval(%'`);
  }
  return new Map(found.map(r => [r.table_name, r.column_name]));
}

/** 各表的主键列（表名 → 列名，按主键中的顺序）；对象存储文件没有主键，MongoDB 集合的主键是 _id */
export async function primaryKeys(con: DuckDBConnection, spec: SourceSpec, tables: SourceTable[]): Promise<Map<string, string[]>> {
  let found: { table_name: string; column_name: string }[] = [];
  if (spec.kind === 'postgres') {
    found = await rows(con, `SELECT * FROM postgres_query('src', ${lit(`
      SELECT c.relname::text AS table_name, a.attname::text AS column_name
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, pos)
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE i.indisprimary AND n.nspname = ${lit(spec.schema)}
      ORDER BY c.relname, k.pos`)})`);
  } else if (spec.kind === 'mysql') {
    found = await rows(con, `SELECT * FROM mysql_query('src', ${lit(`
      SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ${lit(spec.database)} AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION`)})`);
  } else if (spec.kind === 'duckdb') {
    found = await rows(con, `
      SELECT CASE WHEN schema_name = 'main' THEN table_name ELSE schema_name || '.' || table_name END AS table_name, unnest(constraint_column_names) AS column_name
      FROM duckdb_constraints() WHERE database_name = 'src' AND constraint_type = 'PRIMARY KEY'`);
  } else if (spec.kind === 'mongodb') {
    found = tables.map(t => ({ table_name: t.name, column_name: '_id' }));
  }
  const keys = new Map<string, string[]>();
  for (const r of found) keys.set(r.table_name, [...(keys.get(r.table_name) ?? []), r.column_name]);
  return keys;
}

interface SummaryRow { column_name: string; column_type: string; min: string | null; max: string | null; approx_unique: string; count: string; null_percentage: string }

const isTemporal = (type: string) => /^(TIMESTAMP|DATE|TIME)/.test(type);
const isNumeric = (type: string) => /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|U|FLOAT|DOUBLE|DECIMAL)/.test(type);
const isText = (type: string) => type === 'VARCHAR';
/** 可作业务主键的列类型：整数、文本与 UUID */
export const isKeyType = (type: string) => /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|VARCHAR|UUID)$/.test(type);
/** 可作软删除字段的列类型：布尔（为真即删除）、整数（非零即删除）、日期与时间（非空即删除） */
export const isSoftDeleteType = (type: string) => /^(BOOLEAN|U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|DATE|TIMESTAMP.*)$/.test(type);
/** 软删除字段的常见命名 */
export const SOFT_DELETE_NAME = /delet|remov/i;
/** 样本中不同取值的个数（近似计数）至少占样本行数的这个比例，才算取值唯一 */
const KEY_DISTINCT_SHARE = 0.98;

/** 在会话里采集一张表：总行数，以及基于前 sampleRows 行样本的列统计、水位线候选与业务主键候选 */
async function profileTable(
  con: DuckDBConnection, table: SourceTable, keys: { increment?: string; primary: string[] }, sampleRows: number, objectIdKey = false,
): Promise<TableProfile> {
  const { increment, primary } = keys;
  const [{ n }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM ${table.from}`);
  await con.run(`CREATE OR REPLACE TEMP TABLE profile_sample AS SELECT * FROM ${table.from} LIMIT ${sampleRows}`);
  try {
    const summary = await rows<SummaryRow>(con, 'SUMMARIZE profile_sample');
    const texts = summary.filter(c => isText(c.column_type));
    const textStats = texts.length
      ? (await rows<Record<string, number | null>>(con, `SELECT ${texts.flatMap((c, i) => [
          `min(length(${ident(c.column_name)})) AS "min${i}"`,
          `max(length(${ident(c.column_name)})) AS "max${i}"`,
          ...Object.entries(TEXT_FORMATS).map(([f, re]) =>
            `avg(regexp_full_match(${ident(c.column_name)}, ${lit(re)})::INT) FILTER (WHERE ${ident(c.column_name)} IS NOT NULL) AS "${f}${i}"`),
        ]).join(', ')} FROM profile_sample`))[0]
      : {};
    const columns = summary.map((c): ColumnProfile => {
      const count = Number(c.count);
      const nullRate = Number(c.null_percentage) / 100;
      const profile: ColumnProfile = {
        name: c.column_name,
        type: c.column_type,
        nullRate,
        distinct: Math.min(Number(c.approx_unique), Math.round(count * (1 - nullRate))),
        min: isNumeric(c.column_type) || isTemporal(c.column_type) ? c.min : null,
        max: isNumeric(c.column_type) || isTemporal(c.column_type) ? c.max : null,
      };
      const i = texts.indexOf(c);
      if (i >= 0 && textStats[`min${i}`] !== null) {
        profile.length = { min: Number(textStats[`min${i}`]), max: Number(textStats[`max${i}`]) };
        profile.formats = (Object.keys(TEXT_FORMATS) as TextFormat[])
          .map(format => ({ format, share: Math.round(Number(textStats[`${format}${i}`] ?? 0) * 1000) / 1000 }))
          .filter(f => f.share >= 0.5)
          .sort((a, b) => b.share - a.share);
      }
      return profile;
    });
    for (const [i, c] of texts.entries()) {
      const profile = columns[summary.indexOf(c)];
      // 列名像敏感信息，或样本中有任何一个取值像邮箱、手机号，就不保存取值
      const looksSensitive = SENSITIVE_NAME.test(c.column_name) || SENSITIVE_FORMATS.some(f => Number(textStats[`${f}${i}`] ?? 0) > 0);
      if (looksSensitive || !profile.length || profile.length.max > TOP_VALUE_MAX_LENGTH || profile.distinct > TOP_MAX_DISTINCT) continue;
      profile.top = (await rows<{ value: string; rows: string }>(con, `
        SELECT ${ident(c.column_name)} AS value, count(*) AS rows FROM profile_sample WHERE ${ident(c.column_name)} IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${TOP_MAX_DISTINCT}`)).map(r => ({ value: r.value, rows: Number(r.rows) }));
    }
    const candidates: WatermarkCandidate[] = columns
      .filter(c => c.type.startsWith('TIMESTAMP') && UPDATED_AT_NAME.test(c.name) && c.nullRate === 0)
      .map(c => ({ column: c.name, kind: 'updated_at', reason: `时间类型、按命名是更新时间，样本中无空值` }));
    if (increment) candidates.push({ column: increment, kind: 'increment', reason: '由自增序列生成的主键' });
    const id = objectIdKey ? columns.find(c => c.name === '_id') : undefined;
    if (id && id.nullRate === 0 && id.formats?.some(f => f.format === 'objectid' && f.share === 1)) {
      candidates.push({ column: '_id', kind: 'increment', reason: 'ObjectId 主键：前 4 字节是创建时间，大体按插入顺序递增' });
    }
    const sampled = Math.min(Number(n), sampleRows);
    const keyCandidates = primary.length || !sampled ? [] : columns
      .filter(c => isKeyType(c.type) && c.nullRate === 0 && c.distinct >= sampled * KEY_DISTINCT_SHARE)
      .map(c => c.name);
    return { name: table.name, rows: Number(n), sampleRows: sampled, columns, watermarkCandidates: candidates, primaryKey: primary, keyCandidates };
  } finally {
    await con.run('DROP TABLE IF EXISTS profile_sample');
  }
}

/**
 * 采集给定的源表（同步范围内的表）的列统计与水位线候选，不碰其他表；列出其中跳过的无读权限的表。
 * 账号可写时拒绝采集（登记之后才被授予写权限的账号）
 */
export async function profileSource(spec: SourceSpec, limits: EngineLimits, { tables: names, sampleRows = 100_000 }: { tables: string[]; sampleRows?: number }) {
  const session = await openSource(spec, limits);
  try {
    const writable = await writeGrants(session, spec);
    if (writable.length) throw new Error(`账号可以写入数据源（${writable.map(g => g.object).join('、')}），平台只使用只读账号，请更换账号`);
    const increments = await incrementKeys(session.con, spec);
    const all = await session.tables();
    const selected = all.filter(t => names.includes(t.name));
    const primary = await primaryKeys(session.con, spec, selected);
    const tables: TableProfile[] = [];
    for (const t of selected.filter(t => t.readable)) {
      const keys = { increment: increments.get(t.name), primary: primary.get(t.name) ?? [] };
      tables.push(await profileTable(session.con, t, keys, sampleRows, spec.kind === 'mongodb'));
    }
    return { tables, unreadable: selected.filter(t => !t.readable).map(t => t.name) };
  } catch (e) {
    throw new Error(redactSourceSecrets((e as Error).message, spec));
  } finally {
    session.close();
  }
}
