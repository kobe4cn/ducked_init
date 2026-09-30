// app/.server/pipeline/source-engine.ts —— 连接租户的数据源：只读挂载、探测账号写权限、列出源表、采集列统计与水位线候选。
// 平台进程（登记、测试连接）与工作进程（采集任务）共用。凭据以临时 secret 注入独立的内存 DuckDB，不落盘；
// 挂载后锁住配置：不能再挂载其他库、读其他路径。平台从不向源端发送写语句：PostgreSQL 的只读挂载把一切语句都放在只读事务里，
// 发往源端的只有这里写死的只读查询（成员与模型都不能给出发往源端的 SQL）
import { randomUUID } from 'node:crypto';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { objectPath, signedFetch, xmlTag } from '../s3-client';
import type { EngineLimits } from './lake-engine';

export interface S3Connection { endpoint: string; region: string; urlStyle: string; useSsl: boolean; keyId: string; secret: string }

export const FILE_FORMATS = ['parquet', 'csv', 'json'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

/** 连接一个数据源所需的全部信息（含解密后的凭据）。只在内存里传递：平台进程解密后直接使用，或经 IPC 交给工作进程 */
export type SourceSpec =
  | { kind: 'postgres'; host: string; port: number; database: string; schema: string; user: string; password: string }
  | { kind: 'mysql'; host: string; port: number; database: string; user: string; password: string }
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
  /** 数值与时间列的取值范围；文本列不给取值（可能是手机号等敏感信息），只给长度范围 */
  min: string | null;
  max: string | null;
  length?: { min: number; max: number };
  /** 文本列的格式特征：样本中符合各格式的比例，只列出至少一半符合的 */
  formats?: { format: TextFormat; share: number }[];
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
}

const TEXT_FORMATS = {
  email: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
  mobile: '^(\\+?86)?1[3-9][0-9]{9}$',
  integer: '^-?[0-9]+$',
  decimal: '^-?[0-9]+\\.[0-9]+$',
  date: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
  datetime: '^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}',
  uuid: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  json: '^\\s*[\\[{]',
} as const;
export type TextFormat = keyof typeof TEXT_FORMATS;

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

/** 源表：名称、所在 schema、在会话里读取它的 FROM 子句，以及账号能否读取（PostgreSQL 目录里看得到没有读权限的表） */
interface SourceTable { name: string; schema: string; from: string; readable: boolean }

export interface SourceSession {
  /** 源端已只读挂载为 src，配置已锁定 */
  con: DuckDBConnection;
  tables(): Promise<SourceTable[]>;
  close(): void;
}

/** 错误信息会展示给成员：抹掉其中的凭据 */
export function redactSourceSecrets(message: string, spec: SourceSpec) {
  const secrets = (spec.kind === 'postgres' || spec.kind === 'mysql' ? [spec.password] : [spec.s3?.secret, spec.s3?.keyId])
    .filter((s): s is string => !!s);
  return secrets.reduce((m, s) => m.replaceAll(s, '***'), message);
}

function s3Secret(s3: S3Connection) {
  return `INSTALL httpfs; LOAD httpfs;
    CREATE TEMPORARY SECRET src_s3 (TYPE s3, KEY_ID ${lit(s3.keyId)}, SECRET ${lit(s3.secret)}, REGION ${lit(s3.region)},
      ENDPOINT ${lit(s3.endpoint)}, URL_STYLE ${lit(s3.urlStyle)}, USE_SSL ${s3.useSsl})`;
}

/** 只读挂载数据源并锁住配置 */
export async function openSource(spec: SourceSpec, limits: EngineLimits): Promise<SourceSession> {
  const instance = await DuckDBInstance.create(':memory:', {
    memory_limit: `${limits.memoryLimitMb}MiB`,
    threads: String(limits.threads),
  });
  const con = await instance.connect();
  const close = () => { con.closeSync(); instance.closeSync(); };
  try {
    let allowed: string[] = [];
    switch (spec.kind) {
      case 'postgres':
        await con.run(`INSTALL postgres; LOAD postgres;
          CREATE TEMPORARY SECRET src_pg (TYPE postgres, HOST ${lit(spec.host)}, PORT ${spec.port}, DATABASE ${lit(spec.database)},
            USER ${lit(spec.user)}, PASSWORD ${lit(spec.password)});
          ATTACH 'connect_timeout=10' AS src (TYPE postgres, SECRET src_pg, SCHEMA ${lit(spec.schema)}, READ_ONLY)`);
        break;
      case 'mysql':
        await con.run(`INSTALL mysql; LOAD mysql;
          CREATE TEMPORARY SECRET src_mysql (TYPE mysql, HOST ${lit(spec.host)}, PORT ${spec.port}, DATABASE ${lit(spec.database)},
            USER ${lit(spec.user)}, PASSWORD ${lit(spec.password)});
          ATTACH '' AS src (TYPE mysql, SECRET src_mysql, READ_ONLY)`);
        break;
      case 's3':
        await con.run(s3Secret(spec.s3));
        allowed = [spec.path];
        break;
      case 'duckdb':
        if (spec.s3) await con.run(s3Secret(spec.s3));
        await con.run(`ATTACH ${lit(spec.path)} AS src (READ_ONLY)`);
        allowed = [spec.path];
        break;
    }
    await con.run(`SET allowed_directories = [${allowed.map(lit).join(', ')}];
      SET enable_external_access = false;
      SET lock_configuration = true;`);
  } catch (e) {
    close();
    throw new Error(redactSourceSecrets((e as Error).message, spec));
  }
  return { con, tables: () => listTables(con, spec), close };
}

async function listTables(con: DuckDBConnection, spec: SourceSpec): Promise<SourceTable[]> {
  if (spec.kind === 's3') {
    const files = await rows<{ file: string }>(con, `SELECT file FROM glob(${lit(`${spec.path}**`)}) ORDER BY file`);
    const byTable = new Map<string, string[]>();
    for (const { file } of files) {
      if (!FILE_EXTENSIONS[spec.format].test(file)) continue;
      const rel = file.slice(spec.path.length);
      const name = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : rel.replace(FILE_EXTENSIONS[spec.format], '');
      byTable.set(name, [...(byTable.get(name) ?? []), file]);
    }
    return [...byTable].map(([name, list]) => ({ name, schema: '', from: `${READERS[spec.format]}([${list.map(lit).join(', ')}])`, readable: true }));
  }
  const schema = spec.kind === 'postgres' ? spec.schema : spec.kind === 'mysql' ? spec.database : null;
  const found = await rows<{ schema: string; name: string }>(con, `
    SELECT table_schema AS schema, table_name AS name FROM information_schema.tables
    WHERE table_catalog = 'src' ${schema ? `AND table_schema = ${lit(schema)}` : ''} ORDER BY ALL`);
  const readable = spec.kind === 'postgres'
    ? new Set((await rows<{ schema: string; name: string }>(con, `SELECT * FROM postgres_query('src', ${lit(PG_READABLE_TABLES)})`)).map(t => `${t.schema}.${t.name}`))
    : null;
  return found.map(t => ({
    name: schema || t.schema === 'main' ? t.name : `${t.schema}.${t.name}`,
    schema: t.schema,
    from: `src.${ident(t.schema)}.${ident(t.name)}`,
    readable: !readable || readable.has(`${t.schema}.${t.name}`),
  }));
}

/** 账号能读取的表：schema 有 USAGE 且表有 SELECT */
const PG_READABLE_TABLES = `
  SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT')`;

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
export async function writeGrants(session: SourceSession, spec: SourceSpec): Promise<WriteGrant[]> {
  switch (spec.kind) {
    case 'postgres':
      return groupGrants(await rows(session.con, `SELECT * FROM postgres_query('src', ${lit(PG_WRITE_GRANTS)})`));
    case 'mysql':
      return groupGrants(await rows(session.con, `SELECT * FROM mysql_query('src', ${lit(MYSQL_WRITE_GRANTS)})`));
    case 's3':
      return s3WriteGrants(spec.s3, spec.path);
    case 'duckdb':
      return spec.s3 ? s3WriteGrants(spec.s3, spec.path.slice(0, spec.path.lastIndexOf('/') + 1)) : [];
  }
}

/** 测试连接：能否挂载、哪些表可读、哪些表没有读权限（及其 schema）、账号是否可写 */
export async function inspectSource(spec: SourceSpec, limits: EngineLimits) {
  const session = await openSource(spec, limits);
  try {
    const all = await session.tables();
    const unreadable = all.filter(t => !t.readable);
    return {
      tables: all.filter(t => t.readable).map(t => t.name),
      unreadable: unreadable.map(t => t.name),
      unreadableSchemas: [...new Set(unreadable.map(t => t.schema))],
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

interface SummaryRow { column_name: string; column_type: string; min: string | null; max: string | null; approx_unique: string; count: string; null_percentage: string }

const isTemporal = (type: string) => /^(TIMESTAMP|DATE|TIME)/.test(type);
const isNumeric = (type: string) => /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|U|FLOAT|DOUBLE|DECIMAL)/.test(type);
const isText = (type: string) => type === 'VARCHAR';

/** 在会话里采集一张表：总行数，以及基于前 sampleRows 行样本的列统计与水位线候选 */
async function profileTable(con: DuckDBConnection, table: SourceTable, increment: string | undefined, sampleRows: number): Promise<TableProfile> {
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
    const candidates: WatermarkCandidate[] = columns
      .filter(c => c.type.startsWith('TIMESTAMP') && UPDATED_AT_NAME.test(c.name) && c.nullRate === 0)
      .map(c => ({ column: c.name, kind: 'updated_at', reason: `时间类型、按命名是更新时间，样本中无空值` }));
    if (increment) candidates.push({ column: increment, kind: 'increment', reason: '由自增序列生成的主键' });
    return { name: table.name, rows: Number(n), sampleRows: Math.min(Number(n), sampleRows), columns, watermarkCandidates: candidates };
  } finally {
    await con.run('DROP TABLE IF EXISTS profile_sample');
  }
}

/** 采集可读源表的列统计与水位线候选，并列出跳过的无读权限的表。账号可写时拒绝采集（登记之后才被授予写权限的账号） */
export async function profileSource(spec: SourceSpec, limits: EngineLimits, { sampleRows = 100_000 } = {}) {
  const session = await openSource(spec, limits);
  try {
    const writable = await writeGrants(session, spec);
    if (writable.length) throw new Error(`账号可以写入数据源（${writable.map(g => g.object).join('、')}），平台只使用只读账号，请更换账号`);
    const increments = await incrementKeys(session.con, spec);
    const all = await session.tables();
    const tables: TableProfile[] = [];
    for (const t of all.filter(t => t.readable)) tables.push(await profileTable(session.con, t, increments.get(t.name), sampleRows));
    return { tables, unreadable: all.filter(t => !t.readable).map(t => t.name) };
  } catch (e) {
    throw new Error(redactSourceSecrets((e as Error).message, spec));
  } finally {
    session.close();
  }
}
