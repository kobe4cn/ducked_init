// app/.server/api-keys.ts —— 租户管理员管理外部系统的 API Key：创建（明文只返回这一次，库里只存哈希）、修改范围（#977）、吊销、列出。一律限定在操作者所属租户内
// 创建时选接口范围（ADR-0061）：三类接口的非空子集，去重后按固定顺序存；创建时还选数据范围（#976）：「全部」或本租户已发布定义的白名单
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ApiDataScope } from '../lib/api-data-scope';
import { API_SCOPES, type ApiScope } from '../lib/api-scopes';
import { cmp } from '../lib/compare';
import { msg, MsgError, type Msg } from '../lib/i18n';
import { assertCan } from './access';
import { apiCatalog } from './api-catalog';
import { recordAudit } from './audit';
import { newToken, sha256, type CurrentMember } from './auth';
import { getDb } from './db/client';
import { apiKeys } from './db/schema';
import { UUID } from './tenants';

/** 可以展示给管理员的业务错误，带对应的 HTTP 状态码。detail 是句式，路由 catch 点用 errorTextFor 按界面语言出报错文字（ADR-0060），message 固定中文 */
export class ApiKeyError extends MsgError {
  constructor(detail: Msg, readonly status: 400 | 404 = 400) {
    super(detail);
  }
}

/** 前缀：明文前 8 位，列表与审计里用来辨认是哪一把 */
const PREFIX_LENGTH = 8;
const NAME_MAX = 100;
const notFound = () => new ApiKeyError(msg('API Key 不存在或已吊销'), 404);

/** 表单勾选的接口范围收敛成要存的值：只认三类（白名单），去重、按固定顺序；一类都没有是业务错误 */
function normalizeScopes(raw: string[]): ApiScope[] {
  const scopes = API_SCOPES.filter(s => raw.includes(s));
  if (scopes.length === 0) throw new ApiKeyError(msg('请至少勾选一类接口'));
  return scopes;
}

/** 创建表单提交的数据范围原样：单选「全部」或勾选的标签、指标与 RFM 开关，还没做白名单校验 */
export interface RawDataScope { all: boolean; tags: string[]; metrics: string[]; rfm: boolean }

/** 表单选的数据范围收敛成要存的值：「全部」原样；「指定」时标签、指标去重排序，每个 key 必须是本租户已发布的（拿 apiCatalog 当
 *  白名单，别租户、未发布、不存在的 key 报同一句，只带 key 名，不泄露是哪一种）；一样都没选是业务错误 */
async function normalizeDataScope(tenantId: string, raw: RawDataScope): Promise<ApiDataScope> {
  if (raw.all) return { all: true };
  const tags = [...new Set(raw.tags)].sort(cmp);
  const metrics = [...new Set(raw.metrics)].sort(cmp);
  if (tags.length === 0 && metrics.length === 0 && !raw.rfm) throw new ApiKeyError(msg('请至少选择一个标签、指标或 RFM'));
  const { definitions } = await apiCatalog(tenantId);
  for (const [kind, keys] of [['tag', tags], ['metric', metrics]] as const) {
    const published = new Set(definitions.filter(d => d.kind === kind).map(d => d.key));
    for (const key of keys) {
      if (!published.has(key)) throw new ApiKeyError(msg('{key} 不在已发布的标签与指标里', { key }));
    }
  }
  return { all: false, tags, metrics, rfm: raw.rfm };
}

export async function listApiKeys(actor: CurrentMember) {
  assertCan(actor, 'api_keys:manage');
  return getDb()
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      dataScope: apiKeys.dataScope,
      createdByEmail: apiKeys.createdByEmail,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, actor.tenant.id))
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
}

/** 创建一把 Key：返回的 key 是明文，调用方只能把它展示给管理员这一次；scopes 是勾选的接口范围（三类之外的被忽略），
 *  dataScope 是选的数据范围（「指定」时 key 之外的被拒绝） */
export async function createApiKey(actor: CurrentMember, rawName: string, rawScopes: string[], rawDataScope: RawDataScope) {
  assertCan(actor, 'api_keys:manage');
  const name = rawName.trim();
  if (!name) throw new ApiKeyError(msg('请填写名称，用来辨认是哪个外部系统'));
  if (name.length > NAME_MAX) throw new ApiKeyError(msg('名称不能超过 {max} 个字', { max: NAME_MAX }));
  const scopes = normalizeScopes(rawScopes);
  const dataScope = await normalizeDataScope(actor.tenant.id, rawDataScope);
  const key = newToken();
  const prefix = key.slice(0, PREFIX_LENGTH);
  const row = await getDb().transaction(async tx => {
    const [created] = await tx
      .insert(apiKeys)
      .values({ tenantId: actor.tenant.id, name, prefix, tokenHash: sha256(key), scopes, dataScope, createdByEmail: actor.email })
      .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt });
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: created.id,
      detail: { name, prefix, scopes, dataScope },
    });
    return created;
  });
  return { key, row };
}

/** 两个数据范围是否一样：jsonb 读回来键序会变，不能 JSON.stringify，逐字段比（存进去时标签、指标已排好序，这里仍排一遍稳妥） */
function sameDataScope(a: ApiDataScope, b: ApiDataScope): boolean {
  if (a.all === true || b.all === true) return a.all === b.all; // 「全部」只与「全部」相同
  const sameKeys = (x: string[], y: string[]) => {
    const [sx, sy] = [[...x].sort(cmp), [...y].sort(cmp)];
    return sx.length === sy.length && sx.every((v, i) => v === sy[i]);
  };
  return sameKeys(a.tags ?? [], b.tags ?? []) && sameKeys(a.metrics ?? [], b.metrics ?? []) && a.rfm === b.rfm;
}

/** 修改已有 Key 的接口与数据范围（#977）：校验与创建相同；提交后这把 Key 的下一个请求即按新范围（requireApiKey 每次请求读库，无缓存）。
 *  范围没变时不写审计、不报错；不在本租户、已吊销的 Key 与不存在一样处理 */
export async function updateApiKeyScope(actor: CurrentMember, id: string, rawScopes: string[], rawDataScope: RawDataScope) {
  assertCan(actor, 'api_keys:manage');
  if (!UUID.test(id)) throw notFound();
  const scopes = normalizeScopes(rawScopes);
  const dataScope = await normalizeDataScope(actor.tenant.id, rawDataScope);
  await getDb().transaction(async tx => {
    const [row] = await tx
      .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, scopes: apiKeys.scopes, dataScope: apiKeys.dataScope })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.tenantId, actor.tenant.id), isNull(apiKeys.revokedAt)))
      .for('update');
    if (!row) throw notFound();
    const before = { scopes: row.scopes, dataScope: row.dataScope };
    const changed = before.scopes.length !== scopes.length || before.scopes.some((s, i) => s !== scopes[i]) || !sameDataScope(before.dataScope, dataScope);
    if (!changed) return; // 范围没变：不写审计、不报错
    await tx.update(apiKeys).set({ scopes, dataScope }).where(eq(apiKeys.id, row.id));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'api_key.scope_changed',
      targetType: 'api_key',
      targetId: row.id,
      detail: { name: row.name, prefix: row.prefix, before, after: { scopes, dataScope } },
    });
  });
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
