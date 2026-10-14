// app/.server/api-keys.ts —— 租户管理员管理外部系统的 API Key：创建（明文只返回这一次，库里只存哈希）、吊销、列出。一律限定在操作者所属租户内
import { and, desc, eq, isNull } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit } from './audit';
import { newToken, sha256, type CurrentMember } from './auth';
import { getDb } from './db/client';
import { apiKeys } from './db/schema';
import { UUID } from './tenants';

/** 可以展示给管理员的业务错误，带对应的 HTTP 状态码 */
export class ApiKeyError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

/** 前缀：明文前 8 位，列表与审计里用来辨认是哪一把 */
const PREFIX_LENGTH = 8;
const NAME_MAX = 100;
const notFound = () => new ApiKeyError('API Key 不存在或已吊销', 404);

export async function listApiKeys(actor: CurrentMember) {
  assertCan(actor, 'api_keys:manage');
  return getDb()
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      createdByEmail: apiKeys.createdByEmail,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, actor.tenant.id))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
}

/** 创建一把 Key：返回的 key 是明文，调用方只能把它展示给管理员这一次 */
export async function createApiKey(actor: CurrentMember, rawName: string) {
  assertCan(actor, 'api_keys:manage');
  const name = rawName.trim();
  if (!name) throw new ApiKeyError('请填写名称，用来辨认是哪个外部系统');
  if (name.length > NAME_MAX) throw new ApiKeyError(`名称不能超过 ${NAME_MAX} 个字`);
  const key = newToken();
  const prefix = key.slice(0, PREFIX_LENGTH);
  const row = await getDb().transaction(async tx => {
    const [created] = await tx
      .insert(apiKeys)
      .values({ tenantId: actor.tenant.id, name, prefix, tokenHash: sha256(key), createdByEmail: actor.email })
      .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt });
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: created.id,
      detail: { name, prefix },
    });
    return created;
  });
  return { key, row };
}

/** 吊销：用这把 Key 的下一个请求即被拒绝。不在本租户、或已吊销的 Key 与不存在一样处理 */
export async function revokeApiKey(actor: CurrentMember, id: string) {
  assertCan(actor, 'api_keys:manage');
  if (!UUID.test(id)) throw notFound();
  await getDb().transaction(async tx => {
    const [row] = await tx
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, actor.tenant.id), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix });
    if (!row) throw notFound();
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: row.id,
      detail: { name: row.name, prefix: row.prefix },
    });
  });
}
