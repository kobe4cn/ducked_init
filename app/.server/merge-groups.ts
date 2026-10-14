// app/.server/merge-groups.ts —— 合并组（ADR-0032）：把同一实体下描述同一批对象的几个映射绑在一起，同一主键在标准层只留一行。
// 每个实体最多一个组；一版登记组员（映射 ID 的有序数组，顺序即优先级）与存活规则。保存草稿与发布时都校验（checkMergeGroup）：
// 组员至少 2 个、都是这个实体已发布且未停用的映射、键空间相同、不重复；实体不能是 customer（ADR-0027 有自己的属性取舍）或只在同一数据源内唯一的实体；
// latest 的字段要是这个实体的字段。草稿按映射同样的规则双人发布（ADR-0015），也可以丢弃（回到最近的已发布版本，从没发布过时整个删除）。
// 本模块只管设置的存放、编辑与发布，合并引擎按组合并另见 ADR-0032。一律限定在操作者所属租户内
import { and, desc, eq, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { publishedCustomEntities, uniqueKeys } from './custom-entities';
import { getDb } from './db/client';
import { mappings, mappingVersions, mergeGroups, mergeGroupVersions, sources } from './db/schema';
import { lockTenant } from './mappings';
import { isStale, publishBlocker, publisherCount, publishReason, withAuthor } from './publish-rules';
import { entityOf } from '../lib/canonical-model';
import { MERGE_RULE_KINDS, type MergeRule, type MergeRuleKind, ruleText } from '../lib/merge-groups';

/** 可以展示给成员的业务错误 */
export class MergeGroupError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) { super(message); }
}

export type { MergeRule };

/** 保存草稿的输入：组员按优先级从高到低 */
export interface MergeGroupInput { members: string[]; rule: MergeRule }

/** 校验时要知道的一个映射：所属实体、名称（数据源与源表）、最新已发布版本的键空间与写的字段，是否发布过、是否已停用 */
export interface MergeCandidate { id: string; entity: string; name: string; published: boolean; disabled: boolean; keySpace?: string; columns: string[] }

/** 校验的上下文：本租户的映射（按 ID），各实体的主键与是否只在同一数据源内唯一（uniqueKeys），实体登记的字段（实体 → 字段名） */
export interface MergeGroupContext {
  mappings: Map<string, MergeCandidate>;
  unique: Map<string, { key: string[]; bySource: boolean }>;
  fields: (entity: string) => string[];
}

/**
 * 页面表单提交的一版合并组：每个候选映射一行，提交 candidate（映射 ID）与 rank（优先级，1 最高；留空即不在组里），按优先级排好；
 * rule 是规则种类，latestField 是取最新时比较的字段。优先级不是正整数或有重复时抛出 MergeGroupError
 */
export function mergeGroupInputOf(form: FormData): MergeGroupInput {
  const ranks = form.getAll('rank').map(r => String(r).trim());
  const ranked = form.getAll('candidate').map(String)
    .map((id, i) => ({ id, rank: ranks[i] ?? '' }))
    .filter(m => m.rank !== '');
  if (ranked.some(m => !/^[1-9]\d*$/.test(m.rank))) throw new MergeGroupError('优先级要填正整数（1 最高），不在组里的留空');
  if (new Set(ranked.map(m => m.rank)).size < ranked.length) throw new MergeGroupError('每个映射的优先级要各不相同');
  const members = ranked.sort((a, b) => Number(a.rank) - Number(b.rank)).map(m => m.id);
  const kind = String(form.get('rule') ?? '') as MergeRuleKind;
  const rule = kind === 'latest' ? { kind, field: String(form.get('latestField') ?? '').trim() } : { kind } as MergeRule;
  return { members, rule };
}

/** 这个实体不能建合并组的原因；能建时为 null */
function ungroupable(entity: string, ctx: MergeGroupContext) {
  if (entity === 'customer') return '消费者（customer）按属性取舍合并多个来源（ADR-0027），不能建合并组';
  const unique = ctx.unique.get(entity);
  if (!unique) return `${entity} 不是有主键的实体，不能建合并组`;
  if (unique.bySource) return `${entity} 的主键含指向消费者的字段，只在同一个数据源内唯一，不能建合并组`;
  return null;
}

/** 可以加进合并组的映射：已发布、未停用 */
const isLive = (m: MergeCandidate) => m.published && !m.disabled;

/** latest 可以比较的字段：实体登记的字段，加上这些映射写的扩展字段 */
const fieldsOf = (entity: string, ctx: MergeGroupContext, members: MergeCandidate[]) =>
  new Set([...ctx.fields(entity), ...members.flatMap(m => m.columns)]);

/** 一版合并组的问题（纯函数，保存与发布共用）；没有问题时为空数组 */
export function checkMergeGroup(entity: string, input: MergeGroupInput, ctx: MergeGroupContext): string[] {
  const blocked = ungroupable(entity, ctx);
  if (blocked) return [blocked];
  const problems: string[] = [];
  if (new Set(input.members).size < 2) problems.push('合并组至少要有 2 个映射');
  const repeated = [...new Set(input.members.filter((id, i) => input.members.indexOf(id) !== i))];
  if (repeated.length) problems.push(`每个映射在组里只能出现一次：${repeated.map(id => ctx.mappings.get(id)?.name ?? id).join('、')}`);
  const members = [...new Set(input.members)].map(id => ({ id, m: ctx.mappings.get(id) }));
  const missing = members.filter(({ m }) => !m || m.entity !== entity);
  if (missing.length) problems.push(`不是写入 ${entity} 的映射：${missing.map(({ id, m }) => m?.name ?? id).join('、')}`);
  const present = members.flatMap(({ m }) => (m && m.entity === entity ? [m] : []));
  const unpublished = present.filter(m => !m.published);
  if (unpublished.length) problems.push(`还没发布的映射不能加进合并组：${unpublished.map(m => m.name).join('、')}`);
  const disabled = present.filter(m => m.published && m.disabled);
  if (disabled.length) problems.push(`已停用的映射不能加进合并组：${disabled.map(m => m.name).join('、')}`);
  const live = present.filter(isLive);
  if (new Set(live.map(m => m.keySpace ?? '')).size > 1) {
    problems.push(`组员的键空间要一致：${live.map(m => `${m.name}（${m.keySpace ? `key_space: ${m.keySpace}` : '没写键空间'}）`).join('、')}`);
  }
  if (!(MERGE_RULE_KINDS as readonly string[]).includes(input.rule.kind)) problems.push('请选择存活规则');
  else if (input.rule.kind === 'latest') {
    const fields = fieldsOf(entity, ctx, live);
    if (!input.rule.field) problems.push('取最新要选比较哪个字段');
    else if (!fields.has(input.rule.field)) problems.push(`${entity} 没有字段 ${input.rule.field}`);
  }
  return problems;
}

/** 读出校验的上下文：本租户全部映射及其最新已发布版本、实体主键与字段 */
async function contextOf(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<MergeGroupContext> {
  const all = await db.select({ id: mappings.id, entity: mappings.entity, table: mappings.tableName, source: sources.name, disabledAt: mappings.disabledAt })
    .from(mappings).innerJoin(sources, eq(sources.id, mappings.sourceId)).where(eq(mappings.tenantId, tenantId));
  const plans = await db.selectDistinctOn([mappingVersions.mappingId], { id: mappingVersions.mappingId, plan: mappingVersions.plan })
    .from(mappingVersions).innerJoin(mappings, eq(mappings.id, mappingVersions.mappingId))
    .where(and(eq(mappings.tenantId, tenantId), eq(mappingVersions.status, 'published')))
    .orderBy(mappingVersions.mappingId, desc(mappingVersions.version));
  const planOf = new Map(plans.map(p => [p.id, p.plan]));
  const registered = await publishedCustomEntities(db, tenantId);
  return {
    mappings: new Map(all.map(m => {
      const plan = planOf.get(m.id);
      return [m.id, {
        id: m.id, entity: m.entity, name: `「${m.source}」${m.table} → ${m.entity}`, published: !!plan, disabled: !!m.disabledAt,
        ...(plan?.keySpace && { keySpace: plan.keySpace }), columns: plan?.columns.map(c => c.name) ?? [],
      }];
    })),
    unique: uniqueKeys(registered),
    fields: entity => (entityOf(entity)?.fields ?? registered.get(entity)?.fields ?? []).map(f => f.name),
  };
}

/** 校验不通过时抛出 MergeGroupError，列出全部问题 */
async function assertMergeGroup(db: Tx | ReturnType<typeof getDb>, tenantId: string, entity: string, input: MergeGroupInput) {
  const problems = checkMergeGroup(entity, input, await contextOf(db, tenantId));
  if (problems.length) throw new MergeGroupError(problems.join('；'));
}

/** 页面上的一个实体：可选的映射（已发布、未停用，按名称排）、合并组的各版本（最新的在前，带当前成员发布不了的原因）、草稿与最近的已发布版本 */
export interface MergeGroupEntity {
  entity: string;
  candidates: { id: string; name: string; keySpace: string | null }[];
  fields: string[];
  versions: (Omit<typeof mergeGroupVersions.$inferSelect, 'id' | 'groupId' | 'createdAt'> & { publishBlocker: string | null })[];
}

/**
 * 合并组页：能建合并组（有主键、不是 customer、不只在同一数据源内唯一）且有至少 2 个已发布未停用映射的实体，以及已有合并组的实体，按名称排序。
 * 各版本的 publishBlocker 是给成员看的发布不了的原因（publishReason）
 */
export async function listMergeGroups(actor: CurrentMember): Promise<MergeGroupEntity[]> {
  assertCan(actor, 'sources:read');
  const ctx = await contextOf(getDb(), actor.tenant.id);
  const versions = await getDb().select({
    entity: mergeGroups.entity, version: mergeGroupVersions.version, status: mergeGroupVersions.status,
    members: mergeGroupVersions.members, rule: mergeGroupVersions.rule, authors: mergeGroupVersions.authors, lastEditor: mergeGroupVersions.lastEditor,
    publishedByEmail: mergeGroupVersions.publishedByEmail, publishedAt: mergeGroupVersions.publishedAt, updatedAt: mergeGroupVersions.updatedAt,
  })
    .from(mergeGroupVersions).innerJoin(mergeGroups, eq(mergeGroups.id, mergeGroupVersions.groupId))
    .where(eq(mergeGroups.tenantId, actor.tenant.id))
    .orderBy(desc(mergeGroupVersions.version));
  const publishers = await publisherCount(actor.tenant.id);
  const live = [...ctx.mappings.values()].filter(isLive).sort((a, b) => a.name.localeCompare(b.name));
  const entities = new Set([
    ...live.map(m => m.entity).filter((e, _, all) => !ungroupable(e, ctx) && all.filter(x => x === e).length >= 2),
    ...versions.map(v => v.entity),
  ]);
  return [...entities].sort().map(entity => {
    const candidates = live.filter(m => m.entity === entity);
    return {
      entity,
      candidates: candidates.map(m => ({ id: m.id, name: m.name, keySpace: m.keySpace ?? null })),
      fields: [...fieldsOf(entity, ctx, candidates)].sort(),
      versions: versions.filter(v => v.entity === entity).map(({ entity: _, ...v }) => ({
        ...v, publishBlocker: publishReason(actor, { ...v, publishBlocker: publishBlocker(actor, v) }, publishers),
      })),
    };
  });
}

/** 本租户这个实体的合并组 */
const groupOf = (tenantId: string, entity: string) => and(eq(mergeGroups.tenantId, tenantId), eq(mergeGroups.entity, entity));

/** 锁住本租户这个实体的合并组行（没有时为 undefined）：保存、发布与丢弃互斥 */
async function lockGroup(tx: Tx, tenantId: string, entity: string) {
  const [group] = await tx.select().from(mergeGroups).where(groupOf(tenantId, entity)).for('update');
  return group;
}

/**
 * 保存草稿：校验通过后，已有草稿时改它（记下又一位作者与最后保存的人），否则在最新版本之上新建一版草稿（已发布的版本不变）；
 * 这个实体还没有合并组时先建立。不通过时什么也不存。先锁租户行再校验，与停用、发布映射互斥，存下的组员在保存时一定合格。返回草稿的版本号
 */
export async function saveMergeGroupDraft(actor: CurrentMember, entity: string, { members, rule: input }: MergeGroupInput) {
  assertCan(actor, 'sources:write');
  // 只存规则认得的键
  const rule: MergeRule = input.kind === 'latest' ? { kind: 'latest', field: input.field } : { kind: input.kind };
  return getDb().transaction(async tx => {
    await lockTenant(tx, actor.tenant.id);
    await assertMergeGroup(tx, actor.tenant.id, entity, { members, rule });
    await tx.insert(mergeGroups).values({ tenantId: actor.tenant.id, entity }).onConflictDoNothing();
    const group = (await lockGroup(tx, actor.tenant.id, entity))!;
    const [latest] = await tx.select().from(mergeGroupVersions)
      .where(eq(mergeGroupVersions.groupId, group.id)).orderBy(desc(mergeGroupVersions.version)).limit(1);
    let version: number;
    if (latest?.status === 'draft') {
      version = latest.version;
      await tx.update(mergeGroupVersions)
        .set({ members, rule, authors: withAuthor(latest.authors, actor.email), lastEditor: actor.email, updatedAt: new Date() })
        .where(eq(mergeGroupVersions.id, latest.id));
    } else {
      version = (latest?.version ?? 0) + 1;
      await tx.insert(mergeGroupVersions).values({ groupId: group.id, version, members, rule, authors: [actor.email], lastEditor: actor.email });
    }
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'merge_group.saved',
      targetType: 'merge_group',
      targetId: group.id,
      detail: { entity, version, members, rule: ruleText(rule) },
    });
    return version;
  });
}

/** 本租户这个实体的合并组；没有时 404 */
async function requireGroup(tenantId: string, entity: string) {
  const [group] = await getDb().select().from(mergeGroups).where(groupOf(tenantId, entity));
  if (!group) throw new MergeGroupError(`${entity} 没有合并组`, 404);
  return group;
}

/**
 * 发布草稿：需要发布权限，且发布者不能是最后保存这一版草稿的人（双人发布）。只由成员在页面上调用，没有自动发布。
 * 先锁租户行（与发布、停用映射互斥）再锁组行，组员在保存后可能被停用或改了键空间，发布时再校验一次。发布后版本锁定
 */
export async function publishMergeGroup(actor: CurrentMember, entity: string, version: number) {
  assertCan(actor, 'publish');
  const group = await requireGroup(actor.tenant.id, entity);
  const [draft] = await getDb().select().from(mergeGroupVersions)
    .where(and(eq(mergeGroupVersions.groupId, group.id), eq(mergeGroupVersions.version, version)));
  if (!draft) throw new MergeGroupError(`没有第 ${version} 版`, 404);
  const blocker = publishBlocker(actor, draft);
  if (blocker) throw new MergeGroupError(blocker, draft.status === 'draft' ? 403 : 400);
  await getDb().transaction(async tx => {
    await lockTenant(tx, actor.tenant.id);
    await lockGroup(tx, actor.tenant.id, entity);
    const [current] = await tx.select().from(mergeGroupVersions).where(eq(mergeGroupVersions.id, draft.id));
    if (isStale(current, draft)) throw new MergeGroupError('草稿在你发布前被修改、发布或丢弃，请刷新后重新检查');
    await assertMergeGroup(tx, actor.tenant.id, entity, current);
    await tx.update(mergeGroupVersions)
      .set({ status: 'published', publishedByEmail: actor.email, publishedAt: sql`now()` })
      .where(eq(mergeGroupVersions.id, draft.id));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'merge_group.published',
      targetType: 'merge_group',
      targetId: group.id,
      detail: { entity, version, members: current.members, rule: ruleText(current.rule), authors: current.authors, lastEditor: current.lastEditor },
    });
  });
}

/** 丢弃草稿：回到最近的已发布版本；从没发布过的合并组整个删除。返回合并组是否还在 */
export async function discardMergeGroupDraft(actor: CurrentMember, entity: string) {
  assertCan(actor, 'sources:write');
  return getDb().transaction(async tx => {
    const group = await lockGroup(tx, actor.tenant.id, entity);
    if (!group) throw new MergeGroupError(`${entity} 没有合并组`, 404);
    const versions = await tx.select({ id: mergeGroupVersions.id, version: mergeGroupVersions.version, status: mergeGroupVersions.status })
      .from(mergeGroupVersions).where(eq(mergeGroupVersions.groupId, group.id)).orderBy(desc(mergeGroupVersions.version));
    const draft = versions.find(v => v.status === 'draft');
    if (!draft) throw new MergeGroupError(`${entity} 的合并组没有草稿`);
    const published = versions.find(v => v.status === 'published')?.version ?? null;
    if (published) await tx.delete(mergeGroupVersions).where(eq(mergeGroupVersions.id, draft.id));
    else await tx.delete(mergeGroups).where(eq(mergeGroups.id, group.id));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'merge_group.draft_discarded',
      targetType: 'merge_group',
      targetId: group.id,
      detail: { entity, version: draft.version, published },
    });
    return { kept: published !== null };
  });
}

/** 一个实体的合并组最新的已发布版本：组 ID、版本号、组员（按优先级）与存活规则 */
export interface PublishedMergeGroup { id: string; version: number; members: string[]; rule: MergeRule }

/** 本租户每个实体的合并组最新的已发布版本，按实体索引（合并用）；从没发布过的组不在其中 */
export async function publishedMergeGroups(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<Map<string, PublishedMergeGroup>> {
  const rows = await db
    .selectDistinctOn([mergeGroupVersions.groupId], {
      id: mergeGroups.id, entity: mergeGroups.entity, version: mergeGroupVersions.version, members: mergeGroupVersions.members, rule: mergeGroupVersions.rule,
    })
    .from(mergeGroupVersions)
    .innerJoin(mergeGroups, eq(mergeGroups.id, mergeGroupVersions.groupId))
    .where(and(eq(mergeGroups.tenantId, tenantId), eq(mergeGroupVersions.status, 'published')))
    .orderBy(mergeGroupVersions.groupId, desc(mergeGroupVersions.version));
  return new Map(rows.map(({ entity, ...g }) => [entity, g]));
}
