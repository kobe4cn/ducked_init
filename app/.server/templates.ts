// app/.server/templates.ts —— 分析模板定义：成员调整分析模板（如 RFM）的参数，校验通过才能保存为草稿；草稿按映射同样的规则双人发布——
// 由最后保存它的人以外的另一位有发布权限的成员发布，也可以丢弃（回到最近的已发布版本，从没发布过时回到注册表里的默认参数）。
// 发布后版本锁定，并以新参数（加上当天的 asOf）入队一次模板任务，快照登记时记下定义版本（ADR-0004、0015）。一律限定在操作者所属租户内
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { templateDefinitions, templateVersions } from './db/schema';
import { publishBlocker, publisherCount } from './mappings';
import { TEMPLATES } from './pipeline/templates';
import { insertTask } from './tasks';

export type TemplateId = keyof typeof TEMPLATES;

/** 模板 → 运行它的任务类型 */
const TASK_KINDS = { rfm: 'gold.rfm' } as const satisfies Record<TemplateId, string>;

/** 可以展示给成员的业务错误 */
export class TemplateError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) { super(message); }
}

function requireTemplate(id: string): TemplateId {
  if (!Object.hasOwn(TEMPLATES, id)) throw new TemplateError(`没有分析模板 ${id}`, 404);
  return id as TemplateId;
}

/** 校验定义的参数并补上默认值 */
function checked(template: TemplateId, params: Record<string, unknown>) {
  try {
    return TEMPLATES[template].parseDefinition(params) as Record<string, unknown>;
  } catch (e) {
    throw new TemplateError((e as Error).message);
  }
}

const ofDefinition = (tenantId: string, template: TemplateId) =>
  and(eq(templateDefinitions.tenantId, tenantId), eq(templateDefinitions.template, template));

/**
 * 本租户某个模板的定义：各版本（最新的在前）、草稿与最近的已发布版本，当前生效的参数（没有已发布版本时为注册表里的默认参数），
 * 以及本租户有发布权限的成员人数
 */
export async function getTemplate(actor: CurrentMember, id: string) {
  assertCan(actor, 'definitions:read');
  const template = requireTemplate(id);
  const versions = await getDb().select({
    version: templateVersions.version, status: templateVersions.status, params: templateVersions.params,
    authors: templateVersions.authors, lastEditor: templateVersions.lastEditor,
    publishedByEmail: templateVersions.publishedByEmail, publishedAt: templateVersions.publishedAt, updatedAt: templateVersions.updatedAt,
  }).from(templateVersions)
    .innerJoin(templateDefinitions, eq(templateDefinitions.id, templateVersions.definitionId))
    .where(ofDefinition(actor.tenant.id, template))
    .orderBy(desc(templateVersions.version));
  const published = versions.find(v => v.status === 'published') ?? null;
  return {
    template,
    label: TEMPLATES[template].label,
    versions: versions.map(v => ({ ...v, publishBlocker: publishBlocker(actor, v) })),
    draft: versions.find(v => v.status === 'draft') ?? null,
    published,
    params: published?.params ?? (TEMPLATES[template].defaults as Record<string, unknown>),
    publishers: await publisherCount(actor.tenant.id),
  };
}

/**
 * 保存草稿：已有草稿时改它（记下又一位作者与最后保存的人），否则在最新版本之上新建一版草稿（已发布的版本不变）。
 * 第一次保存时建立本租户这个模板的定义。返回草稿的版本号
 */
export async function saveDraft(actor: CurrentMember, id: string, params: Record<string, unknown>) {
  assertCan(actor, 'definitions:draft');
  const template = requireTemplate(id);
  const definition = checked(template, params);
  return getDb().transaction(async tx => {
    await tx.insert(templateDefinitions).values({ tenantId: actor.tenant.id, template }).onConflictDoNothing();
    // 锁住定义行：与发布、丢弃互斥
    const [locked] = await tx.select({ id: templateDefinitions.id }).from(templateDefinitions)
      .where(ofDefinition(actor.tenant.id, template)).for('update');
    // 插入与加锁之间定义可能因丢弃草稿被删除
    if (!locked) throw new TemplateError('模板定义刚被修改，请刷新后重试');
    const definitionId = locked.id;
    const [latest] = await tx.select().from(templateVersions)
      .where(eq(templateVersions.definitionId, definitionId)).orderBy(desc(templateVersions.version)).limit(1);
    if (latest?.status === 'draft') {
      const authors = latest.authors.includes(actor.email) ? latest.authors : [...latest.authors, actor.email];
      await tx.update(templateVersions).set({ params: definition, authors, lastEditor: actor.email, updatedAt: new Date() })
        .where(eq(templateVersions.id, latest.id));
      return latest.version;
    }
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(templateVersions).values({ definitionId, version, params: definition, authors: [actor.email], lastEditor: actor.email });
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'template.drafted',
      targetType: 'template',
      targetId: definitionId,
      detail: { template, version },
    });
    return version;
  });
}

/**
 * 发布草稿：需要发布权限，且发布者不能是最后保存这一版草稿的人（双人发布）。发布前再校验一次参数。
 * 发布后版本锁定，并以这一版的参数加上当天（UTC）的 asOf 入队一次模板任务，任务参数带上 definitionVersion。返回入队的任务
 */
export async function publishTemplate(actor: CurrentMember, id: string, version: number) {
  assertCan(actor, 'publish');
  const template = requireTemplate(id);
  const [draft] = await getDb().select(getTableColumns(templateVersions)).from(templateVersions)
    .innerJoin(templateDefinitions, eq(templateDefinitions.id, templateVersions.definitionId))
    .where(and(ofDefinition(actor.tenant.id, template), eq(templateVersions.version, version)));
  if (!draft) throw new TemplateError(`没有第 ${version} 版`, 404);
  const blocker = publishBlocker(actor, draft);
  if (blocker) throw new TemplateError(blocker, draft.status === 'draft' ? 403 : 400);
  const definition = checked(template, draft.params);
  return getDb().transaction(async tx => {
    // 锁住定义行：与保存草稿、丢弃互斥，发布的正是检查过的那份草稿。不像发布映射那样锁租户行：模板任务不合并进排队中的任务，没有要互斥的入队检查
    await tx.select({ id: templateDefinitions.id }).from(templateDefinitions).where(eq(templateDefinitions.id, draft.definitionId)).for('update');
    const [current] = await tx.select().from(templateVersions).where(eq(templateVersions.id, draft.id));
    if (!current || current.status !== 'draft' || current.updatedAt.getTime() !== draft.updatedAt.getTime()) {
      throw new TemplateError('草稿在你发布前被修改、发布或丢弃，请刷新后重新检查');
    }
    await tx.update(templateVersions)
      .set({ status: 'published', params: definition, publishedByEmail: actor.email, publishedAt: sql`now()` })
      .where(eq(templateVersions.id, draft.id));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'template.published',
      targetType: 'template',
      targetId: draft.definitionId,
      detail: { template, version, authors: draft.authors, lastEditor: draft.lastEditor },
    });
    const asOf = new Date().toISOString().slice(0, 10);
    return insertTask(tx, actor.tenant.id, TASK_KINDS[template], { ...definition, asOf, definitionVersion: version });
  });
}

/**
 * 丢弃草稿：回到最近的已发布版本；从没发布过的定义整个删除（回到注册表里的默认参数）。
 * 用于草稿卡住（如最后保存的人离职）的情况。返回回到的已发布版本号（没有时为 null）
 */
export async function discardDraft(actor: CurrentMember, id: string) {
  assertCan(actor, 'definitions:draft');
  const template = requireTemplate(id);
  return getDb().transaction(async tx => {
    // 锁住定义行：与保存、发布互斥
    const [definition] = await tx.select({ id: templateDefinitions.id }).from(templateDefinitions)
      .where(ofDefinition(actor.tenant.id, template)).for('update');
    const versions = definition
      ? await tx.select({ id: templateVersions.id, version: templateVersions.version, status: templateVersions.status })
        .from(templateVersions).where(eq(templateVersions.definitionId, definition.id)).orderBy(desc(templateVersions.version))
      : [];
    const draft = versions.find(v => v.status === 'draft');
    if (!definition || !draft) throw new TemplateError('这个模板没有草稿');
    const published = versions.find(v => v.status === 'published')?.version ?? null;
    // 从没发布过时删除定义，各版本随之级联删除
    if (published) await tx.delete(templateVersions).where(eq(templateVersions.id, draft.id));
    else await tx.delete(templateDefinitions).where(eq(templateDefinitions.id, definition.id));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'template.draft_discarded',
      targetType: 'template',
      targetId: definition.id,
      detail: { template, version: draft.version, published },
    });
    return { published };
  });
}
