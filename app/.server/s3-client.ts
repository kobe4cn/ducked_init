// app/.server/s3-client.ts —— 用 AWS Signature V4 直接调用对象存储（S3 协议与存储服务的 IAM API），不引入 SDK。
// 只在平台进程里使用；凭据由调用方传入（平台账号或某个租户的账号）
import { createHash, createHmac } from 'node:crypto';

export interface S3Creds { endpoint: string; region: string; key: string; secret: string; useSsl: boolean }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s).digest();

/** RFC 3986 编码（SigV4 要求 !'()* 也编码） */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** s3://bucket/a/b → path-style 的已编码路径 /bucket/a/b */
export const objectPath = (uri: string) => `/${uri.replace(/^s3:\/\//, '').split('/').map(rfc3986).join('/')}`;

export interface SignedRequest {
  method: string;
  /** 已编码的路径（path-style：/bucket/key） */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** 字符串按内容签名；流式内容不签名（UNSIGNED-PAYLOAD），须在 headers 里给出 content-length */
  body?: string | ReadableStream<Uint8Array>;
  /** 调用方可能正持有平台 PG 的行锁，存储服务无响应时不能一直等下去；传输大文件时由调用方放宽 */
  timeoutMs?: number;
}

/** 向存储服务发一个 AWS Signature V4 签名的请求 */
export function signedFetch(creds: S3Creds, service: 'iam' | 's3', req: SignedRequest) {
  const url = new URL(`${creds.useSsl ? 'https' : 'http'}://${creds.endpoint}${req.path}`);
  const query = Object.entries(req.query ?? {}).map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).sort().join('&');
  url.search = query;
  const body = req.body ?? '';
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const scope = `${amzDate.slice(0, 8)}/${creds.region}/${service}/aws4_request`;
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    host: url.host,
    'x-amz-content-sha256': typeof body === 'string' ? sha256(body) : 'UNSIGNED-PAYLOAD',
    'x-amz-date': amzDate,
  };
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map(k => `${k}:${headers[k]}\n`).join('');
  const canonical = [req.method, url.pathname, query, canonicalHeaders, signed.join(';'), headers['x-amz-content-sha256']].join('\n');
  const signingKey = [amzDate.slice(0, 8), creds.region, service, 'aws4_request'].reduce<string | Buffer>((k, part) => hmac(k, part), `AWS4${creds.secret}`);
  const signature = hmac(signingKey, ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')).toString('hex');
  const { host: _host, ...sent } = headers;
  return fetch(url, {
    method: req.method,
    headers: { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${creds.key}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}` },
    body: req.method === 'GET' ? undefined : body,
    ...(typeof body !== 'string' && { duplex: 'half' }),
    signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
  } as RequestInit);
}

export const xmlTag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
export const xmlTags = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map(m => m[1]);

const unescapeXml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]!);

async function ensureOk(res: Response, what: string) {
  if (!res.ok) throw new Error(`${what}失败（HTTP ${res.status}）：${await res.text()}`);
  return res;
}

// 复制单个数据文件的时限：大文件在慢速网络上要传很久
const TRANSFER_TIMEOUT_MS = 60 * 60_000;

/** 列出 s3://bucket/prefix/ 下的全部对象：相对 prefix 的路径与字节数 */
export async function listObjects(creds: S3Creds, prefixUri: string) {
  const [bucket, ...rest] = prefixUri.replace(/^s3:\/\//, '').split('/');
  const prefix = rest.join('/');
  const out: { path: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const res = await ensureOk(await signedFetch(creds, 's3', {
      method: 'GET',
      path: objectPath(bucket),
      query: { 'list-type': '2', prefix, ...(token && { 'continuation-token': token }) },
    }), `列出 ${prefixUri} `);
    const xml = await res.text();
    for (const c of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      out.push({ path: unescapeXml(xmlTag(c[1], 'Key')!).slice(prefix.length), size: Number(xmlTag(c[1], 'Size')) });
    }
    token = xmlTag(xml, 'IsTruncated') === 'true' ? unescapeXml(xmlTag(xml, 'NextContinuationToken')!) : undefined;
  } while (token);
  return out;
}

/** 读取对象，返回内容流 */
export async function getObject(creds: S3Creds, uri: string) {
  const res = await ensureOk(await signedFetch(creds, 's3', { method: 'GET', path: objectPath(uri), timeoutMs: TRANSFER_TIMEOUT_MS }), `读取 ${uri} `);
  return res.body!;
}

/** 写入对象（覆盖）；流式内容须给出字节数 */
export async function putObject(creds: S3Creds, uri: string, body: string | ReadableStream<Uint8Array>, size?: number) {
  await ensureOk(await signedFetch(creds, 's3', {
    method: 'PUT',
    path: objectPath(uri),
    headers: { 'content-type': 'application/octet-stream', ...(size !== undefined && { 'content-length': String(size) }) },
    body,
    timeoutMs: TRANSFER_TIMEOUT_MS,
  }), `写入 ${uri} `);
}
