// test/pipeline/s3-accounts.test.ts —— 租户对象存储账号的接缝：每租户一桶的策略只放本桶、桶随开通幂等地建（ADR-0008、#663）；
// 删除接缝：IAM 建号 → deleteTenantS3Account → 账号与内联策略都不留（#621）
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { initTenantCatalog, lakeRow } from '../../app/.server/lake';
import {
  deleteTenantS3Account, issueTenantReadOnlyS3Account, issueTenantS3Account, platformS3, s3ReadOnlyUserOf, s3UserOf,
} from '../../app/.server/s3-accounts';
import { signedFetch, xmlTag, xmlTags } from '../../app/.server/s3-client';
import { resetDb } from '../http/harness';
import { newTenant } from './fixtures';

async function iam(action: string, params: Record<string, string>) {
  const body = new URLSearchParams({ Action: action, Version: '2010-05-08', ...params }).toString();
  const res = await signedFetch(platformS3(), 'iam', {
    method: 'POST',
    path: '/',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body,
  });
  return { ok: res.ok, xml: await res.text() };
}

/** 读 filer 上 policies.json 的 inlinePolicies 用户名（CI 的 4.50 不发布 filer 端口，连不上返回 null，文件断言只在本地跑） */
async function inlinePolicyUsers(): Promise<string[] | null> {
  const host = process.env.S3_ENDPOINT?.split(':')[0];
  if (!host) return null;
  try {
    const res = await fetch(`http://${host}:8888/etc/iam/policies.json`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return Object.keys((await res.json()).inlinePolicies ?? {});
  } catch {
    return null;
  }
}

const lakePathOf = (tenantId: string) => `${process.env.TEST_S3_LAKE_URI}/tenants/${tenantId}`;

/** GetUserPolicy 拿回的策略文档：还原 XML 转义（含 &#34; 这类数字实体），URL 编码过时再解码 */
async function policyDocOf(UserName: string) {
  const { xml } = await iam('GetUserPolicy', { UserName, PolicyName: 'tenant-lake' });
  const raw = xmlTag(xml, 'PolicyDocument')!;
  const unescaped = raw
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&(quot|apos|lt|gt|amp);/g, (_, e: string) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[e]!);
  try { return decodeURIComponent(unescaped); } catch { return unescaped; }
}

describe.skipIf(!process.env.TEST_S3_LAKE_URI || !process.env.S3_ACCESS_KEY)('租户对象存储账号的删除', () => {
  it('删掉租户的读写与只读账号后，GetUserPolicy 返回 NoSuchEntity，filer 的 policies.json 里也没有这两个用户', async () => {
    const tenantId = crypto.randomUUID();
    const users = [s3UserOf(tenantId), s3ReadOnlyUserOf(tenantId)];
    await issueTenantS3Account(tenantId, lakePathOf(tenantId));
    await issueTenantReadOnlyS3Account(tenantId, lakePathOf(tenantId));
    // 账号还在时策略要真的挂上（CI 的 4.50 上它会写进 policies.json 的 inlinePolicies，删号后才谈得上不留残留）
    for (const UserName of users) {
      expect((await iam('GetUserPolicy', { UserName, PolicyName: 'tenant-lake' })).ok).toBe(true);
    }

    await deleteTenantS3Account(tenantId);

    for (const UserName of users) {
      const got = await iam('GetUserPolicy', { UserName, PolicyName: 'tenant-lake' });
      expect(got.ok).toBe(false);
      expect(xmlTag(got.xml, 'Code')).toBe('NoSuchEntity');
    }
    const listed = xmlTags((await iam('ListUsers', {})).xml, 'UserName');
    expect(listed).not.toContain(users[0]);
    expect(listed).not.toContain(users[1]);
    const inline = await inlinePolicyUsers();
    if (inline) for (const user of users) expect(inline, `policies.json 里不应再有 ${user}`).not.toContain(user);
  });

  it('账号被别的路径删掉一半（密钥没了、策略没删）时，再删一次不报错，账号与策略查询都是 NoSuchEntity', async () => {
    const tenantId = crypto.randomUUID();
    const UserName = s3UserOf(tenantId);
    const { accessKey } = await issueTenantS3Account(tenantId, lakePathOf(tenantId));
    // 模拟中断或别处删除：密钥与账号先删、策略留下。4.47 上账号真被删掉（策略不落盘），
    // 走「账号不在」分支；4.50 上策略还在会让 DeleteUser 报 DeleteConflict、账号仍在，走正常删除分支
    await iam('DeleteAccessKey', { UserName, AccessKeyId: accessKey });
    await iam('DeleteUser', { UserName }).catch(() => {});

    await expect(deleteTenantS3Account(tenantId)).resolves.toBeUndefined();

    const got = await iam('GetUserPolicy', { UserName, PolicyName: 'tenant-lake' });
    expect(got.ok).toBe(false);
    expect(xmlTag(got.xml, 'Code')).toBe('NoSuchEntity');
    expect(xmlTags((await iam('ListUsers', {})).xml, 'UserName')).not.toContain(UserName);
  });
});

// 每租户一桶（ADR-0008、#663）：新租户在对象存储上得到独占的桶，账号策略只放行本桶、不带前缀 Condition
describe.skipIf(!process.env.TEST_S3_LAKE_URI || !process.env.S3_ACCESS_KEY)('每租户一桶的开通与跨桶拒绝', () => {
  const defaultLakeUri = process.env.PLATFORM_LAKE_URI;
  beforeAll(() => { process.env.PLATFORM_LAKE_URI = process.env.TEST_S3_LAKE_URI; });
  beforeEach(async () => { await resetDb(); });
  afterAll(async () => { process.env.PLATFORM_LAKE_URI = defaultLakeUri; await closeDb(); });

  it('新租户的策略只放行本桶（对象与 ListBucket，不带 Condition），跨桶读对象与列桶都是 403；再初始化一次建桶幂等', async () => {
    const acme = await newTenant('acme');
    const globex = await newTenant('globex');

    // 存储服务存回的策略会把单元素数组规范化成裸字符串，断言前展平
    const rawDoc = await policyDocOf(s3UserOf(acme));
    expect(rawDoc).not.toContain('Condition');
    const doc = JSON.parse(rawDoc) as { Statement: { Action: string | string[]; Resource: string | string[] }[] };
    const asList = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
    const resources = doc.Statement.flatMap(s => asList(s.Resource));
    expect(resources).toHaveLength(2);
    expect(resources).toEqual(expect.arrayContaining([`arn:aws:s3:::lake-${acme}/*`, `arn:aws:s3:::lake-${acme}`]));
    expect(doc.Statement.some(s => asList(s.Action).includes('s3:ListBucket'))).toBe(true);

    // acme 的凭据碰不到 globex 的桶：读对象（.keep 是开通时写入的）与列桶都由存储服务拒绝
    const a = (await lakeRow(acme))!;
    const creds = { ...platformS3(), key: a.s3AccessKey!, secret: a.s3SecretKey! };
    const read = await signedFetch(creds, 's3', { method: 'GET', path: `/lake-${globex}/.keep` });
    expect(read.status).toBe(403);
    const list = await signedFetch(creds, 's3', { method: 'GET', path: `/lake-${globex}`, query: { 'list-type': '2' } });
    expect(list.status).toBe(403);

    // 桶已存在时再初始化（重试补建账号的路径）也算成功
    await expect(initTenantCatalog(acme, null)).resolves.toBeUndefined();
  });
});
