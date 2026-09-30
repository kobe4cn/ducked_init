// app/.server/s3-accounts.ts —— 租户在对象存储上的账号（ADR-0008）：由存储服务按前缀策略执行租户隔离。
// 经存储服务的 IAM API（SeaweedFS 内置在 S3 端口上）用平台账号建用户、签发密钥、绑定只允许本租户前缀的策略。
// 凭据获取只在这里；以后换成按任务签发的临时凭据（STS）时只改这个模块
import { putObject, signedFetch, xmlTag as tag, xmlTags as tags, type S3Creds } from './s3-client';

const env = (k: string, d: string) => process.env[k] ?? d;

/** 对象存储的连接参数（取 S3_*）；key / secret 是平台账号，只在平台进程里使用，不交给工作进程 */
export function platformS3() {
  return {
    endpoint: env('S3_ENDPOINT', 'localhost:8333'),
    region: env('S3_REGION', 'us-east-1'),
    key: env('S3_ACCESS_KEY', ''),
    secret: env('S3_SECRET_KEY', ''),
    urlStyle: env('S3_URL_STYLE', 'path'),
    useSsl: env('S3_USE_SSL', 'false') === 'true',
  };
}

export const s3UserOf = (tenantId: string) => `lake-${tenantId}`;

/** 用平台账号调用 IAM API（表单 POST），返回响应 XML；出错时抛出带错误码的 IamError */
async function iam(action: string, params: Record<string, string>) {
  const body = new URLSearchParams({ Action: action, Version: '2010-05-08', ...params }).toString();
  const res = await signedFetch(platformS3(), 'iam', {
    method: 'POST',
    path: '/',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
  });
  const xml = await res.text();
  if (!res.ok) throw new IamError(action, tag(xml, 'Code') ?? String(res.status), tag(xml, 'Message') ?? xml);
  return xml;
}

export class IamError extends Error {
  constructor(action: string, readonly code: string, message: string) { super(`对象存储 IAM ${action} 失败（${code}）：${message}`); }
}

/** 只允许读写、删除、列出本租户存储前缀下的对象。迁移存储期间同时给出新旧两个前缀（都是本租户的） */
function prefixPolicy(dataPaths: string[]) {
  const prefixes = dataPaths.map(p => {
    const [bucket, ...rest] = p.replace(/^s3:\/\//, '').split('/');
    return { bucket, prefix: `${rest.filter(Boolean).join('/')}/*` };
  });
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: prefixes.flatMap(({ bucket, prefix }) => [
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [`arn:aws:s3:::${bucket}/${prefix}`] },
      { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [`arn:aws:s3:::${bucket}`], Condition: { StringLike: { 's3:prefix': [prefix] } } },
    ]),
  });
}

/**
 * 为租户建好存储服务上的账号与前缀策略，签发一把新密钥。可重复执行：账号已存在时沿用，
 * 此前签发、没来得及保存的密钥一并作废，策略按 dataPath 重新写入
 */
export async function issueTenantS3Account(tenantId: string, dataPath: string) {
  const UserName = s3UserOf(tenantId);
  await iam('CreateUser', { UserName }).catch(e => {
    if (!(e instanceof IamError && e.code === 'EntityAlreadyExists')) throw e;
  });
  for (const AccessKeyId of tags(await iam('ListAccessKeys', { UserName }), 'AccessKeyId')) {
    await iam('DeleteAccessKey', { UserName, AccessKeyId });
  }
  await setTenantS3Prefixes(tenantId, [dataPath]);
  const xml = await iam('CreateAccessKey', { UserName });
  const accessKey = tag(xml, 'AccessKeyId');
  const secretKey = tag(xml, 'SecretAccessKey');
  if (!accessKey || !secretKey) throw new Error(`对象存储 IAM CreateAccessKey 的响应里没有密钥：${xml}`);
  return { accessKey, secretKey };
}

/** 重写租户账号的前缀策略：只能访问给出的存储前缀（对象存储上的） */
export async function setTenantS3Prefixes(tenantId: string, dataPaths: string[]) {
  await iam('PutUserPolicy', { UserName: s3UserOf(tenantId), PolicyName: 'tenant-lake', PolicyDocument: prefixPolicy(dataPaths) });
}

/** 删除租户在存储服务上的账号（连同密钥与策略）；账号不存在时什么也不做 */
export async function deleteTenantS3Account(tenantId: string) {
  await iam('DeleteUser', { UserName: s3UserOf(tenantId) }).catch(e => {
    if (!(e instanceof IamError && e.code === 'NoSuchEntity')) throw e;
  });
}

/**
 * 用租户自己的账号在存储前缀下写入空的占位对象 .keep：对象存储没有真正的目录，还没有数据时前缀在存储服务上看不到。
 * 可重复执行（覆盖写入）
 */
export async function putPrefixPlaceholder(dataPath: string, creds: S3Creds) {
  await putObject(creds, `${dataPath}.keep`, '');
}
