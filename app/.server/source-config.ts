// app/.server/source-config.ts —— 数据源的连接参数：把成员提交的表单拆成可展示的 config 与要加密的凭据，
// 以及把平台库里的一条数据源（解密凭据后）还原成连接用的 SourceSpec。登记、修改与任务派发共用
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { getDb } from './db/client';
import { SOURCE_KINDS, sources, type SourceKind } from './db/schema';
import { FILE_FORMATS, type FileFormat, type S3Connection, type SourceSpec } from './pipeline/source-engine';
import { decryptForTenant } from './secrets';

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
  }
}

/** 凭据加密时绑定的用途：换到别的数据源上解不开 */
export const credentialsContext = (sourceId: string) => `source:${sourceId}`;

/** 本租户的一条数据源；不存在（或属于其他租户）时抛出 404 */
export async function requireSource(tenantId: string, sourceId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new SourceError('数据源不存在', 404);
  const [row] = await getDb().select().from(sources).where(and(eq(sources.id, sourceId), eq(sources.tenantId, tenantId)));
  if (!row) throw new SourceError('数据源不存在', 404);
  return row;
}

/** 解密凭据，还原成连接参数（任务派发时交给工作进程） */
export async function loadSourceSpec(tenantId: string, sourceId: string): Promise<SourceSpec> {
  const row = await requireSource(tenantId, sourceId);
  return resolveSourceSpec(tenantId, row.kind, row.config, await decryptForTenant(tenantId, credentialsContext(row.id), row.credentials));
}
