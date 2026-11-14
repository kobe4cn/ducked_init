// app/.server/knowledge/basis.ts —— 业务知识的目标与依据摘要（ADR-0046）。目标是目录条目标识：entity:x、field:e.f、metric:k、tag:k，
// 映射字段是 field:e.f 再带映射 ID。依据摘要（basedOn）是知识写下时它依据的内容的摘要 [{id, hash}]：指标与标签是当前已发布版本 YAML 的 sha256（id 是条目标识），
// 映射字段是该映射当前已发布计划稳定 JSON（不含版本号）的 sha256（id 是 mapping:<映射 ID>），实体与普通字段没有依据。
// 只存依据，不存「需复核」：读的时候与 currentBases 比较，不一样就是需复核。
// 新知识不能挂在敏感字段上（ADR-0005），目标必须是本租户目录里有的：标准实体或已发布的自定义实体与它们的字段、已发布的指标与标签、已发布映射写入的字段
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../audit';
import { sha256 } from '../auth';
import { publishedCustomEntities } from '../custom-entities';
import type { getDb } from '../db/client';
import { mappings } from '../db/schema';
import { publishedDependents } from '../dsl-dependencies';
import { publishedPlans } from '../mappings';
import { isSensitiveField, type PublishedPlan } from '../pipeline/mapping-spec';
import { UUID } from '../tenants';
import { entityOf } from '../../lib/canonical-model';
import { cmp } from '../../lib/compare';

type Db = Tx | ReturnType<typeof getDb>;

/** 一项依据：依据的标识与内容摘要 */
export interface Basis { id: string; hash: string }

/** 可以展示给成员的业务错误 */
export class KnowledgeError extends Error {
  readonly status = 400;
}

/** 键排好序的 JSON：键顺序不同视为相同。与 catalog/versions.ts 的 stable 相同（那个文件本票不动），是合并成一处的候选 */
export const stableJson = (v: unknown): string => JSON.stringify(v, (_, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => cmp(a, b))) : x);

/** 指标与标签的依据摘要：已发布版本 YAML 的 sha256 */
export const definitionHash = (yaml: string) => sha256(yaml);

/**
 * 映射的依据摘要：已发布计划的稳定 JSON 的 sha256。只看这个映射自己的内容：不含版本号（映射与源视图内容不变地重新发布不算变）；
 * PublishedPlan 本来就不带来自别处的合并组与实体主键（uniqueKey / uniqueBySource，随自定义实体发布而变）
 */
export function planHash(plan: PublishedPlan): string {
  const { version: _version, sourceView, ...rest } = plan;
  return sha256(stableJson({ ...rest, ...(sourceView && { sourceView: { sql: sourceView.sql, tables: sourceView.tables } }) }));
}

export const mappingBasisId = (mappingId: string) => `mapping:${mappingId}`;

/** 解析目标标识；不是 entity / field / metric / tag 时为 null */
type Target = { kind: 'entity' | 'metric' | 'tag'; key: string } | { kind: 'field'; entity: string; field: string };
function parseTarget(targetId: string): Target | null {
  const m = /^(entity|field|metric|tag):(.+)$/.exec(targetId);
  if (!m) return null;
  const [, kind, rest] = m;
  if (kind !== 'field') return { kind: kind as 'entity' | 'metric' | 'tag', key: rest! };
  const dot = rest!.indexOf('.');
  return dot > 0 && dot < rest!.length - 1 ? { kind: 'field', entity: rest!.slice(0, dot), field: rest!.slice(dot + 1) } : null;
}

/** 当前的依据摘要：已发布的每个指标与标签、每个已发布映射，id → hash；给需复核比较用 */
export async function currentBases(db: Db, tenantId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const d of await publishedDependents(db, tenantId)) out.set(`${d.kind}:${d.key}`, definitionHash(d.yaml));
  for (const p of await publishedPlans(db, tenantId)) out.set(mappingBasisId(p.mapping), planHash(p));
  return out;
}

/** 知识挂在这个目标上时的依据摘要；目标不存在时为 []（先用 assertTarget 校验） */
export async function basisOf(tx: Db, tenantId: string, targetId: string, mappingId: string | null = null): Promise<Basis[]> {
  const t = parseTarget(targetId);
  if (t?.kind === 'metric' || t?.kind === 'tag') {
    const d = (await publishedDependents(tx, tenantId)).find(x => x.kind === t.kind && x.key === t.key);
    return d ? [{ id: targetId, hash: definitionHash(d.yaml) }] : [];
  }
  if (t?.kind === 'field' && mappingId) {
    const plan = (await publishedPlans(tx, tenantId, [mappingId])).find(p => p.mapping === mappingId);
    return plan ? [{ id: mappingBasisId(mappingId), hash: planHash(plan) }] : [];
  }
  return [];
}

/**
 * 校验知识的目标是本租户目录里有的、不是敏感字段，不合法时抛 KnowledgeError。
 * 字段是实体登记的字段或已发布映射写入的扩展字段；映射字段的映射必须已发布（未停用）且写入了这个字段，锁住映射行，与发布、停用互斥。
 * 指标、标签与自定义实体不加锁：与删除并发时可能留下挂不上的知识，目录会把它丢掉（同映射停用后的知识），不影响正确性
 */
export async function assertTarget(tx: Tx, tenantId: string, targetId: string, mappingId: string | null = null): Promise<void> {
  const t = parseTarget(targetId);
  if (!t) throw new KnowledgeError(`没有目录条目 ${targetId}`);
  if (mappingId && t.kind !== 'field') throw new KnowledgeError('只有字段可以指定映射');
  if (t.kind === 'metric' || t.kind === 'tag') {
    const published = (await publishedDependents(tx, tenantId)).some(d => d.kind === t.kind && d.key === t.key);
    if (!published) throw new KnowledgeError(`${t.kind === 'metric' ? '指标' : '标签'} ${t.key} 没有已发布的版本`);
    return;
  }
  const custom = await publishedCustomEntities(tx, tenantId);
  const entity = t.kind === 'field' ? t.entity : t.key;
  const fields = entityOf(entity)?.fields ?? custom.get(entity)?.fields;
  if (!fields) throw new KnowledgeError(`没有实体 ${entity}`);
  if (t.kind !== 'field') return;

  const { field } = t;
  const notMapped = () => new KnowledgeError(`映射 ${mappingId} 没有写入 ${entity}.${field}`);
  if (mappingId) {
    const [own] = UUID.test(mappingId)
      ? await tx.select({ id: mappings.id }).from(mappings).where(and(eq(mappings.id, mappingId), eq(mappings.tenantId, tenantId))).for('update')
      : [];
    if (!own) throw notMapped();
  }
  const plans = await publishedPlans(tx, tenantId);
  const writes = (p: PublishedPlan) => p.entity === entity && p.columns.some(c => c.name === field);
  if (!fields.some(f => f.name === field) && !plans.some(writes)) throw new KnowledgeError(`实体 ${entity} 没有字段 ${field}`);
  if (isSensitiveField({ entity, field }, e => custom.get(e)?.fields, plans)) throw new KnowledgeError(`${entity}.${field} 是敏感字段，不能挂业务知识`);
  if (mappingId && !plans.some(p => p.mapping === mappingId && writes(p))) throw notMapped();
}
