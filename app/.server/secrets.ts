// app/.server/secrets.ts —— 信封加密：租户的凭据（数据源密码、对象存储密钥，以后还有模型服务 API Key）用租户数据密钥加密，
// 数据密钥用平台主密钥包裹后存在平台库（tenant_keys）。平台库泄露时拿不到明文；换用 KMS 时只改 wrapKey / unwrapKey。
// 只在平台进程里使用：工作进程只拿到任务启动时解密好的凭据（经 IPC 传入），拿不到主密钥
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from './db/client';
import { tenantKeys } from './db/schema';

const VERSION = 'v1';

/** 平台主密钥：PLATFORM_MASTER_KEY，32 字节的 base64（openssl rand -base64 32） */
function masterKey() {
  const raw = process.env.PLATFORM_MASTER_KEY;
  const key = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error('缺少或不合法的环境变量 PLATFORM_MASTER_KEY（凭据加密的主密钥，32 字节的 base64，可用 openssl rand -base64 32 生成）');
  return key;
}

/** AES-256-GCM；aad 把密文绑定到用途（哪个租户、哪条记录），换到别处解不开 */
function seal(key: Buffer, plaintext: Buffer, aad: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ct].map(p => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

function unseal(key: Buffer, sealed: string, aad: string) {
  const [version, iv, tag, ct] = sealed.split('.');
  if (version !== VERSION) throw new Error(`无法识别的密文版本：${version}`);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url')).setAAD(Buffer.from(aad)).setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
}

const wrapKey = (tenantId: string, dataKey: Buffer) => seal(masterKey(), dataKey, `tenant-data-key:${tenantId}`);
const unwrapKey = (tenantId: string, wrapped: string) => unseal(masterKey(), wrapped, `tenant-data-key:${tenantId}`);

/** 租户的数据密钥；还没有时生成一把（并发生成时以先写入的为准） */
async function tenantDataKey(tenantId: string) {
  const db = getDb();
  const [existing] = await db.select().from(tenantKeys).where(eq(tenantKeys.tenantId, tenantId));
  if (existing) return unwrapKey(tenantId, existing.wrappedKey);
  await db.insert(tenantKeys).values({ tenantId, wrappedKey: wrapKey(tenantId, randomBytes(32)) }).onConflictDoNothing();
  const [row] = await db.select().from(tenantKeys).where(eq(tenantKeys.tenantId, tenantId));
  return unwrapKey(tenantId, row.wrappedKey);
}

/** 用租户数据密钥加密一组凭据；context 标明用途（如 source:<数据源 ID>），解密时须给出同一个 */
export async function encryptForTenant(tenantId: string, context: string, value: Record<string, string>) {
  return seal(await tenantDataKey(tenantId), Buffer.from(JSON.stringify(value)), `${tenantId}:${context}`);
}

export async function decryptForTenant(tenantId: string, context: string, sealed: string): Promise<Record<string, string>> {
  return JSON.parse(unseal(await tenantDataKey(tenantId), sealed, `${tenantId}:${context}`).toString());
}

/**
 * 租户的敏感信息盐：标准层里敏感字段的哈希按它加盐（ADR-0005）。由租户数据密钥派生（HMAC），不另存；
 * 和凭据一样只在领取任务时交给工作进程，不写进任务参数
 */
export async function tenantPiiSalt(tenantId: string) {
  return createHmac('sha256', await tenantDataKey(tenantId)).update('pii-salt').digest('hex');
}
