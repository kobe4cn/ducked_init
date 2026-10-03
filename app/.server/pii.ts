// app/.server/pii.ts —— 解密敏感信息（仅管理员，ADR-0005）：管理员选一个已发布的映射、填源表主键与原因，平台从原始层读出这条记录敏感字段的明文。
// 在请求内以只读方式挂载本租户的数据湖读取（一条记录，不排队），明文只放在这次响应里，不进任务结果、审计日志或其他 PG 表；
// 每次解密都写一条审计 pii.revealed，记下操作人、实体、主键与原因，审计写入成功后才交出明文。一律限定在操作者所属租户内
import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { sources } from './db/schema';
import { lakeReady, lakeRow, lakeSpecOf } from './lake';
import { publishedPlans } from './mappings';
import { openTenantLake } from './pipeline/lake-engine';
import { sensitivePlanColumns } from './pipeline/merge-engine';
import { readSensitive, RevealError } from './pipeline/reveal-engine';
import { tenantPiiSalt } from './secrets';
import { entityLabel, entityOf } from '../lib/canonical-model';

/** 可以展示给管理员的业务错误 */
export class PiiError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) { super(message); }
}

/** 读一条记录用的计算资源 */
const REVEAL_LIMITS = { memoryLimitMb: 256, threads: 1 };

const fieldLabel = (entity: string, name: string) => entityOf(entity)?.fields.find(f => f.name === name)?.label ?? name;

/** 本租户已发布的映射（最新的已发布版本），带数据源名称 */
async function publishedMappings(tenantId: string, mappingIds?: string[]) {
  const plans = await publishedPlans(getDb(), tenantId, mappingIds);
  if (!plans.length) return [];
  const names = await getDb().select({ id: sources.id, name: sources.name }).from(sources)
    .where(inArray(sources.id, [...new Set(plans.map(p => p.sourceId))]));
  return plans.map(p => ({ ...p, sourceName: names.find(n => n.id === p.sourceId)?.name ?? '' }));
}

/** 可以申请解密的映射：本租户已发布、带敏感字段的映射 */
export async function revealableMappings(actor: CurrentMember) {
  assertCan(actor, 'pii:reveal');
  return (await publishedMappings(actor.tenant.id))
    .map(p => ({ id: p.mapping, sourceName: p.sourceName, table: p.table, entity: entityLabel(p.entity), fields: sensitivePlanColumns(p).map(c => fieldLabel(p.entity, c.name)) }))
    .filter(m => m.fields.length)
    .sort((a, b) => a.entity.localeCompare(b.entity) || a.sourceName.localeCompare(b.sourceName) || a.table.localeCompare(b.table));
}

/** 解密映射 mappingId 所在源表里主键为 key 的记录的敏感字段，写一条审计后返回明文 */
export async function revealPii(actor: CurrentMember, input: { mappingId: string; key: string; reason: string }) {
  assertCan(actor, 'pii:reveal');
  const reason = input.reason.trim();
  if (!reason) throw new PiiError('请填写解密原因');
  if (!input.key.trim()) throw new PiiError('请填写源表主键');
  if (!/^[0-9a-f-]{36}$/i.test(input.mappingId)) throw new PiiError('映射不存在', 404);
  const [mapping] = await publishedMappings(actor.tenant.id, [input.mappingId]);
  if (!mapping) throw new PiiError('映射不存在或还没有发布', 404);
  const lake = await lakeRow(actor.tenant.id);
  if (!lake || !lakeReady(lake)) throw new PiiError('本租户的数据湖还没有初始化');

  const session = await openTenantLake(lakeSpecOf(lake), REVEAL_LIMITS, undefined, { readOnly: true });
  let record;
  try {
    record = await readSensitive(session.con, mapping.sourceId, mapping, input.key);
  } catch (e) {
    if (e instanceof RevealError) throw new PiiError(e.message, e.status);
    throw e;
  } finally {
    session.close();
  }

  // 主键本身是敏感信息时，审计里记按租户加盐的哈希（同样的主键得到同样的哈希，可以对照，但看不出明文）
  const salt = record.sensitiveKeys.length ? await tenantPiiSalt(actor.tenant.id) : '';
  const auditedKey = Object.fromEntries(Object.entries(record.key).map(([k, v]) =>
    [k, record.sensitiveKeys.includes(k) ? `哈希 ${createHash('sha256').update(salt + v).digest('hex')}` : v]));
  const fields = record.fields.map(f => ({ ...f, label: fieldLabel(mapping.entity, f.name) }));
  await recordAudit(getDb(), {
    tenantId: actor.tenant.id,
    actor,
    action: 'pii.revealed',
    targetType: 'mapping',
    targetId: mapping.mapping,
    detail: { source: mapping.sourceName, table: mapping.table, entity: mapping.entity, key: auditedKey, fields: fields.map(f => f.label), reason },
  });
  return { sourceName: mapping.sourceName, table: mapping.table, entity: entityLabel(mapping.entity), key: record.key, fields };
}
