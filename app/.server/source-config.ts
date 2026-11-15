// app/.server/source-config.ts —— 数据源的连接参数：把成员提交的表单拆成可展示的 config 与要加密的凭据，
// 以及把平台库里的一条数据源（解密凭据后）还原成连接用的 SourceSpec。登记、修改与任务派发共用
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from './db/client';
import { SOURCE_KINDS, sources, type SourceKind } from './db/schema';
import { lakeRow, lakeSpecOf } from './lake';
import { FILE_FORMATS, type FileFormat, type S3Connection, type SourceSpec, type UploadReadOptions } from './pipeline/source-engine';
import { decryptForTenant } from './secrets';
import { UPLOAD_DIR, UPLOAD_TABLE, UPLOAD_TABLE_RULE, uploadDirOf } from './uploads';

/** 可以展示给成员的业务错误（输入不合法、连接失败、账号可写、数据源不存在等），带对应的 HTTP 状态码 */
export class SourceError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

/** 成员提交的表单字段（与界面表单同名）；凭据字段为 password、keyId、secret */
export type SourceInput = Record<string, string | undefined>;

export const isSourceKind = (v: string): v is SourceKind => (SOURCE_KINDS as readonly string[]).includes(v);

const text = (input: SourceInput, key: string, label: string, fallback?: string) => {
  const v = (input[key] ?? '').trim() || fallback;
  if (!v) throw new SourceError(`请填写${label}`);
  return v;
};

function port(input: SourceInput, fallback: number) {
  const raw = (input.port ?? '').trim();
  const v = raw ? Number(raw) : fallback;
  if (!Number.isInteger(v) || v < 1 || v > 65535) throw new SourceError('端口必须是 1 到 65535 之间的整数');
  return String(v);
}

const isS3Path = (p: string) => p.startsWith('s3://');

const isOn = (v: string | undefined) => v === 'true' || v === 'on';

/** MongoDB 的主机与库名会拼进连接串：只接受主机名字符与合法的库名，防止借此注入连接选项（如让驱动读取本机文件的 tlsCAFile） */
function mongoName(input: SourceInput, key: string, label: string, fallback?: string) {
  const v = text(input, key, label, fallback);
  if (!/^[^\s/\\."$*<>:|?=&]+$/.test(v)) throw new SourceError(`${label}不合法：不能包含空格与 / \\ . " $ * < > : | ? = &`);
  return v;
}

function s3Config(input: SourceInput) {
  return {
    endpoint: text(input, 'endpoint', '对象存储地址', 's3.amazonaws.com').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    region: text(input, 'region', '区域', 'us-east-1'),
    urlStyle: input.urlStyle === 'vhost' ? 'vhost' : 'path',
    useSsl: isOn(input.useSsl) ? 'true' : 'false',
  };
}

/** 本机上租户源文件目录：PLATFORM_SOURCE_FILES_DIR/<租户 ID>/ */
function tenantFilesDir(tenantId: string) {
  const root = process.env.PLATFORM_SOURCE_FILES_DIR;
  if (!root) throw new SourceError('平台没有配置本机源文件目录，只能登记对象存储上的 DuckDB 文件（s3://…）');
  return join(root, tenantId);
}

/** 本机上的 DuckDB 文件只能放在租户自己的源文件目录里：返回真实路径，以及相对该目录的路径（保存在 config 里） */
async function localFile(tenantId: string, path: string) {
  const dir = tenantFilesDir(tenantId);
  const outside = () => new SourceError(`DuckDB 文件必须位于本租户的源文件目录中（${dir}）`);
  const full = await realpath(isAbsolute(path) ? path : join(dir, path)).catch(() => {
    throw new SourceError(`找不到 DuckDB 文件：${path}`);
  });
  const base = await realpath(dir).catch(() => { throw outside(); });
  if (!full.startsWith(base + sep)) throw outside();
  return { full, relative: relative(base, full).split(sep).join('/') };
}

/** 列类型的白名单（ADR-0037）：成员能替上传表指定的 DuckDB 类型；DECIMAL 另查精度（1≤p≤38、0≤s≤p）。大小写不敏感，存成大写 */
const COLUMN_TYPES = new Set(['VARCHAR', 'BIGINT', 'DOUBLE', 'BOOLEAN', 'DATE', 'TIMESTAMP']);
const columnType = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toUpperCase();
  if (COLUMN_TYPES.has(t)) return t;
  const m = /^DECIMAL\((\d+),(\d+)\)$/.exec(t);
  if (!m) return null;
  const [p, s] = [Number(m[1]), Number(m[2])];
  return p >= 1 && p <= 38 && s <= p ? `DECIMAL(${p},${s})` : null;
};

/**
 * 解析上传登记表单的 options 字段（每张表的读取选项，ADR-0037）：JSON 字符串 `{ "<表名>": { encoding, delim, header, skip, columns } }`，
 * 只允许一个键且必须是本次登记的表名。不合法抛 SourceError（400）；空串 / 未给返回 undefined
 */
export function parseUploadOptions(json: string | undefined, table: string): Record<string, UploadReadOptions> | undefined {
  const raw = (json ?? '').trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SourceError('读取选项不是合法的 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SourceError('读取选项必须是 { "表名": { … } } 形式的对象');
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== table) throw new SourceError(`读取选项的键只能是本次登记的表名 ${table}`);
  const value = (parsed as Record<string, unknown>)[table];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SourceError(`表 ${table} 的读取选项必须是对象`);
  const opts: UploadReadOptions = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'encoding') {
      if (v !== 'utf-8' && v !== 'gbk') throw new SourceError('编码只能是 utf-8 或 gbk');
      opts.encoding = v;
    } else if (key === 'delim') {
      if (typeof v !== 'string' || v.length !== 1 || /[\r\n"]/.test(v)) throw new SourceError('分隔符必须是单个字符，且不能是换行、回车或双引号');
      opts.delim = v;
    } else if (key === 'header') {
      if (typeof v !== 'boolean') throw new SourceError('header 只能是 true 或 false');
      opts.header = v;
    } else if (key === 'skip') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1000) throw new SourceError('skip 必须是 0 到 1000 之间的整数');
      opts.skip = v;
    } else if (key === 'columns') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SourceError('columns 必须是 { 列名: 类型 } 形式的对象');
      const columns: Record<string, string> = {};
      const seen = new Set<string>();
      for (const [name, type] of Object.entries(v as Record<string, unknown>)) {
        const normalized = name.trim();
        if (!normalized) throw new SourceError('columns 的列名不能为空');
        if (seen.has(normalized)) throw new SourceError(`columns 的列名重复：${normalized}`);
        seen.add(normalized);
        const t = columnType(type);
        if (!t) throw new SourceError(`列类型只能是 VARCHAR、BIGINT、DOUBLE、BOOLEAN、DATE、TIMESTAMP 或 DECIMAL(p,s)：${name}`);
        columns[name] = t;
      }
      if (!Object.keys(columns).length) throw new SourceError('columns 不能为空');
      opts.columns = columns;
    } else {
      throw new SourceError(`不支持的读取选项：${key}`);
    }
  }
  return { [table]: opts };
}

/**
 * 校验表单并拆成 config（可展示）与凭据（加密保存）。修改时 previous 是原有的凭据：凭据字段留空表示不变，
 * 连接的目标（主机、库、用户名、路径、对象存储地址）变了时须重新填写
 */
export async function parseSourceInput(tenantId: string, kind: SourceKind, input: SourceInput, previous?: { config: Record<string, string>; credentials: Record<string, string> }) {
  let config: Record<string, string>;
  let secretKeys: string[];
  switch (kind) {
    case 'postgres':
    case 'mysql':
      config = {
        host: text(input, 'host', '主机'),
        port: port(input, kind === 'postgres' ? 5432 : 3306),
        database: text(input, 'database', '数据库名'),
        ...(kind === 'postgres' && { schema: text(input, 'schema', 'schema', 'public') }),
        user: text(input, 'user', '用户名'),
      };
      secretKeys = ['password'];
      break;
    case 'mongodb': {
      const host = text(input, 'host', '主机');
      if (!/^[A-Za-z0-9.-]+$/.test(host)) throw new SourceError('主机只能包含字母、数字、点与连字符');
      const database = mongoName(input, 'database', '数据库名');
      config = {
        host,
        port: port(input, 27017),
        srv: isOn(input.srv) ? 'true' : 'false',
        tls: isOn(input.tls) ? 'true' : 'false',
        database,
        authSource: mongoName(input, 'authSource', '认证库', 'admin'),
        user: text(input, 'user', '用户名'),
      };
      secretKeys = ['password'];
      break;
    }
    case 's3': {
      const path = text(input, 'path', '文件前缀').replace(/\/*$/, '/');
      if (!/^s3:\/\/[^/]+\//.test(path)) throw new SourceError('文件前缀必须形如 s3://存储桶/前缀/');
      const format = text(input, 'format', '文件格式', 'parquet');
      if (!(FILE_FORMATS as readonly string[]).includes(format)) throw new SourceError('文件格式只能是 Parquet、CSV 或 JSON');
      config = { path, format, ...s3Config(input) };
      secretKeys = ['keyId', 'secret'];
      break;
    }
    case 'duckdb': {
      const raw = text(input, 'path', 'DuckDB 文件路径');
      if (isS3Path(raw)) {
        if (!/^s3:\/\/[^/]+\/.+[^/]$/.test(raw)) throw new SourceError('DuckDB 文件路径必须形如 s3://存储桶/路径/文件.duckdb');
        config = { path: raw, ...s3Config(input) };
        secretKeys = ['keyId', 'secret'];
      } else {
        config = { path: (await localFile(tenantId, raw)).relative };
        secretKeys = [];
      }
      break;
    }
    case 'upload': {
      // 修改时上传目录与表名不变：文件已经存在那里（ADR-0037）；读取选项同样沿用原 config.options，修改时不接受改
      const dir = previous?.config.dir ?? text(input, 'dir', '上传目录');
      const table = previous?.config.table ?? text(input, 'table', '表名');
      if (!UPLOAD_DIR.test(dir)) throw new SourceError('上传目录不合法');
      if (!UPLOAD_TABLE.test(table)) throw new SourceError(UPLOAD_TABLE_RULE);
      const parsed = previous ? undefined : parseUploadOptions(input.options, table);
      // config 只能存字符串：登记时把解析后的选项存成 JSON 字符串，修改时沿用原字符串
      const options = previous ? previous.config.options : parsed && JSON.stringify(parsed);
      config = { dir, table, ...(options && { options }) };
      secretKeys = [];
      break;
    }
  }
  const sameTarget = previous && JSON.stringify(connectionTarget(previous.config)) === JSON.stringify(connectionTarget(config));
  const credentials: Record<string, string> = {};
  for (const key of secretKeys) {
    const v = input[key] ?? '';
    if (v) credentials[key] = v;
    else if (sameTarget && previous.credentials[key]) credentials[key] = previous.credentials[key];
    else throw new SourceError(key === 'password' ? '请填写密码' : '请填写对象存储的 Access Key 与 Secret Key');
  }
  return { config, credentials };
}

/** 决定凭据归属的连接参数：这些变了，原有的凭据不再沿用 */
const connectionTarget = (c: Record<string, string>) =>
  [c.host, c.port, c.database, c.authSource, c.user, c.endpoint, isS3Path(c.path ?? '') ? c.path.split('/')[2] : c.path];

/**
 * 由 config 与凭据得到连接参数。本机上的 DuckDB 文件每次都重新解析真实路径并校验仍在租户目录内：
 * 登记之后文件被换成指向目录外的符号链接时拒绝
 */
export async function resolveSourceSpec(tenantId: string, kind: SourceKind, config: Record<string, string>, credentials: Record<string, string>): Promise<SourceSpec> {
  const s3 = (): S3Connection => ({
    endpoint: config.endpoint,
    region: config.region,
    urlStyle: config.urlStyle,
    useSsl: config.useSsl === 'true',
    keyId: credentials.keyId,
    secret: credentials.secret,
  });
  switch (kind) {
    case 'postgres':
      return { kind, host: config.host, port: Number(config.port), database: config.database, schema: config.schema, user: config.user, password: credentials.password };
    case 'mysql':
      return { kind, host: config.host, port: Number(config.port), database: config.database, user: config.user, password: credentials.password };
    case 'mongodb':
      return {
        kind, host: config.host, port: Number(config.port), srv: config.srv === 'true', tls: config.tls === 'true',
        database: config.database, authSource: config.authSource, user: config.user, password: credentials.password,
      };
    case 's3':
      return { kind, path: config.path, format: config.format as FileFormat, s3: s3() };
    case 'duckdb':
      return isS3Path(config.path) ? { kind, path: config.path, s3: s3() } : { kind, path: (await localFile(tenantId, config.path)).full };
    case 'upload':
      return uploadSpec(tenantId, config.dir, config.options);
  }
}

/** 上传目录按当前数据湖前缀拼出；数据湖在对象存储时带上租户数据湖的凭据（平台账号不能进 SourceSpec）；options 是存成 JSON 字符串的读取选项 */
async function uploadSpec(tenantId: string, dir: string, options?: string): Promise<SourceSpec> {
  const lake = await lakeRow(tenantId);
  if (!lake) throw new SourceError('本租户还没有开通数据湖，读不到上传的文件');
  const path = uploadDirOf(lake.dataPath, dir);
  const s3 = (() => {
    try {
      return lakeSpecOf(lake).s3;
    } catch (e) {
      throw new SourceError((e as Error).message);
    }
  })();
  // 登记时已校验过，这里只解析回对象放进 spec，采集、同步、校验经 SourceTable.from 都按它读（ADR-0037）
  const opts = options ? (JSON.parse(options) as Record<string, UploadReadOptions>) : undefined;
  const withOptions = { ...(opts && { options: opts }) };
  if (!s3) return { kind: 'upload', path, ...withOptions };
  return { kind: 'upload', path, ...withOptions, s3: { endpoint: s3.endpoint, region: s3.region, urlStyle: s3.urlStyle, useSsl: s3.useSsl, keyId: s3.key, secret: s3.secret } };
}

/** 凭据加密时绑定的用途：换到别的数据源上解不开 */
export const credentialsContext = (sourceId: string) => `source:${sourceId}`;

/** 本租户的一条数据源；不存在、已删除（ADR-0044）或属于其他租户时抛出 404 */
export async function requireSource(tenantId: string, sourceId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new SourceError('数据源不存在', 404);
  const [row] = await getDb().select().from(sources).where(and(eq(sources.id, sourceId), eq(sources.tenantId, tenantId), isNull(sources.deletedAt)));
  if (!row) throw new SourceError('数据源不存在', 404);
  return row;
}

/** 本租户按登记名（区分大小写，按原样比较）找没删除的数据源 ID；没有时为 null */
export async function sourceIdByName(tenantId: string, name: string): Promise<string | null> {
  const [row] = await getDb().select({ id: sources.id }).from(sources).where(and(eq(sources.tenantId, tenantId), eq(sources.name, name), isNull(sources.deletedAt)));
  return row?.id ?? null;
}

/** 解密凭据，还原成连接参数（任务派发时交给工作进程） */
export async function loadSourceSpec(tenantId: string, sourceId: string): Promise<SourceSpec> {
  const row = await requireSource(tenantId, sourceId);
  return resolveSourceSpec(tenantId, row.kind, row.config, await decryptForTenant(tenantId, credentialsContext(row.id), row.credentials));
}
