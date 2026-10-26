// app/.server/templates.ts —— 分析模板定义：成员调整分析模板（如 RFM）的参数，校验通过才能保存为草稿；草稿按映射同样的规则双人发布——
// 由最后保存它的人以外的另一位有发布权限的成员发布，也可以丢弃（回到最近的已发布版本，从没发布过时回到注册表里的默认参数）。
// 发布后版本锁定，并以新参数（加上当天的 asOf）入队一次模板任务，快照登记时记下定义版本（ADR-0004、0015）。
// 也可以按当前生效的版本重新计算（可指定参考日期），不产生新版本；依赖的实体有新合并后调度器按当天以生效版本重算（refresh.ts，ADR-0028）。
// 任务参数与快照记下来源（发布、手动重新计算、定时刷新、平台自动启用时的发布）。映射合并成功后，平台以注册表里的默认参数自动启用
// 本租户还没有定义、依赖的实体都已有已发布映射的模板（enableDefaultTemplates，不经双人发布，ADR-0021）。
// 注册表有了比生效版本锁定的更新的模板版本时，成员可以预览升级后的差异（只读、只出计数），确认后起草一版锁定新模板版本的草稿，照常双人发布。
// 一律限定在操作者所属租户内
import { and, desc, eq, getTableColumns, inArray, isNull, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb, type Db } from './db/client';
import { DslError, onReadOnlyLake, type DiffCounts, type TagTransition } from './dsl-definitions';
import { mappings, mappingVersions, tasks, templateDefinitions, templateVersions, tenants, type SnapshotTrigger } from './db/schema';
import { pendingMerge } from './mappings';
import { isStale, publishBlocker, publisherCount, withAuthor } from './publish-rules';
import { compileMetricDiff, compileTagDiff } from './pipeline/dsl/impact';
import { lit, rows } from './pipeline/merge-engine';
import { latestTemplate, missingTableHint, TASK_KINDS, templateAt, TEMPLATES, type Template, type TemplateId } from './pipeline/templates';
import { insertTask } from './tasks';

export { TASK_KINDS, templateOfKind, type TemplateId } from './pipeline/templates';

/** 可以展示给成员的业务错误 */
export class TemplateError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) { super(message); }
}

function requireTemplate(id: string): TemplateId {
  if (!Object.hasOwn(TEMPLATES, id)) throw new TemplateError(`没有分析模板 ${id}`, 404);
  return id as TemplateId;
}

/** 校验参数，不合法时把说明原因的错误转成 TemplateError（带上前缀 prefix） */
function validated<T>(parse: () => T, prefix = '') {
  try {
    return parse();
  } catch (e) {
    throw new TemplateError(`${prefix}${(e as Error).message}`);
  }
}

/** 按模板的某个版本校验定义的参数并补上默认值 */
const checked = (template: Template<unknown, unknown>, params: Record<string, unknown>) =>
  validated(() => template.parseDefinition(params) as Record<string, unknown>);

/** 按锁定的模板版本取模板；注册表里没有这个版本时转成 TemplateError */
const lockedTemplate = (template: TemplateId, templateVersion: number) => validated(() => templateAt(template, templateVersion));

/** 今天（UTC），模板任务 asOf 的默认值与上限 */
export const todayUtc = () => new Date().toISOString().slice(0, 10);

const ofDefinition = (tenantId: string, template: TemplateId) =>
  and(eq(templateDefinitions.tenantId, tenantId), eq(templateDefinitions.template, template));

/**
 * 在调用方的事务里以模板定义一版的参数加上 asOf 入队一次模板任务，任务参数带上定义版本 definitionVersion、来源 trigger（登记快照时记下）
 * 与这一版锁定的模板版本 templateVersion（任务按它编译）
 */
export async function enqueueTemplate(
  tx: Tx, tenantId: string, template: TemplateId, params: Record<string, unknown>, version: number, asOf: string, trigger: SnapshotTrigger,
) {
  const [locked] = await tx.select({ templateVersion: templateVersions.templateVersion }).from(templateVersions)
    .innerJoin(templateDefinitions, eq(templateDefinitions.id, templateVersions.definitionId))
    .where(and(ofDefinition(tenantId, template), eq(templateVersions.version, version)));
  if (!locked) throw new Error(`模板 ${template} 的定义没有第 ${version} 版`);
  return insertTask(tx, tenantId, TASK_KINDS[template], { ...params, asOf, definitionVersion: version, trigger, templateVersion: locked.templateVersion });
}

/**
 * 本租户某个模板的定义：各版本（最新的在前）、草稿与最近的已发布版本，当前生效的参数（没有已发布版本时为注册表里的默认参数），
 * 以及本租户有发布权限的成员人数
 */
export async function getTemplate(actor: CurrentMember, id: string) {
  assertCan(actor, 'definitions:read');
  const template = requireTemplate(id);
  const versions = await getDb().select({
    version: templateVersions.version, status: templateVersions.status, params: templateVersions.params, templateVersion: templateVersions.templateVersion,
    authors: templateVersions.authors, lastEditor: templateVersions.lastEditor,
    publishedByEmail: templateVersions.publishedByEmail, publishedAt: templateVersions.publishedAt, updatedAt: templateVersions.updatedAt,
  }).from(templateVersions)
    .innerJoin(templateDefinitions, eq(templateDefinitions.id, templateVersions.definitionId))
    .where(ofDefinition(actor.tenant.id, template))
    .orderBy(desc(templateVersions.version));
  const published = versions.find(v => v.status === 'published') ?? null;
  const draft = versions.find(v => v.status === 'draft') ?? null;
  const latestTemplateVersion = latestTemplate(template).version;
  return {
    template,
    label: TEMPLATES[template].label,
    /** 注册表里模板的当前版本 */
    latestTemplateVersion,
    /** 生效的已发布版本锁定的模板版本比当前版本旧：可以预览升级差异、起草升级 */
    upgradeAvailable: published !== null && published.templateVersion < latestTemplateVersion,
    versions: versions.map(v => ({ ...v, publishBlocker: publishBlocker(actor, v) })),
    draft,
    published,
    // 没有已发布版本时为草稿锁定的模板版本（没有草稿时为当前版本）的默认参数
    params: published?.params ?? (lockedTemplate(template, draft?.templateVersion ?? latestTemplate(template).version).defaults as Record<string, unknown>),
    publishers: await publisherCount(actor.tenant.id),
  };
}

/**
 * 保存草稿：已有草稿时改它（记下又一位作者与最后保存的人），否则在最新版本之上新建一版草稿（已发布的版本不变）。
 * 第一次保存时建立本租户这个模板的定义。草稿锁定的模板版本：已有草稿时不变，否则沿用最近的已发布版本锁定的，
 * 从没发布过时为注册表的当前版本（不随注册表升级，ADR-0021）；参数按这个版本校验。返回草稿的版本号
 */
export async function saveDraft(actor: CurrentMember, id: string, params: Record<string, unknown>) {
  assertCan(actor, 'definitions:draft');
  const template = requireTemplate(id);
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
    // 最新一版是草稿时沿用草稿的（草稿新建时已沿用最近的已发布版本），否则它就是最近的已发布版本
    const templateVersion = latest?.templateVersion ?? latestTemplate(template).version;
    const definition = checked(lockedTemplate(template, templateVersion), params);
    if (latest?.status === 'draft') {
      await tx.update(templateVersions).set({ params: definition, authors: withAuthor(latest.authors, actor.email), lastEditor: actor.email, updatedAt: new Date() })
        .where(eq(templateVersions.id, latest.id));
      return latest.version;
    }
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(templateVersions).values({ definitionId, version, params: definition, templateVersion, authors: [actor.email], lastEditor: actor.email });
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
 * 发布后版本锁定，并以这一版的参数加上当天（UTC）的 asOf 入队一次模板任务（来源 publish）。返回入队的任务
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
  const definition = checked(lockedTemplate(template, draft.templateVersion), draft.params);
  return getDb().transaction(async tx => {
    // 锁住定义行：与保存草稿、丢弃互斥，发布的正是检查过的那份草稿。不锁租户行、不查排队中的任务：发布总要按新参数算一次（ADR-0021）
    await tx.select({ id: templateDefinitions.id }).from(templateDefinitions).where(eq(templateDefinitions.id, draft.definitionId)).for('update');
    const [current] = await tx.select().from(templateVersions).where(eq(templateVersions.id, draft.id));
    if (isStale(current, draft)) {
      throw new TemplateError('草稿在你发布前被修改、发布或丢弃，请刷新后重新检查');
    }
    await tx.update(templateVersions)
      .set({ status: 'published', params: definition, publishedByEmail: actor.email, publishedAt: sql`now()` })
      .where(eq(templateVersions.id, draft.id));
    const task = await enqueueTemplate(tx, actor.tenant.id, template, definition, version, todayUtc(), 'publish');
    // 审计放在入队之后：记目录版本拿的锁要是事务里最后一个锁（见 catalog/versions.ts）
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'template.published',
      targetType: 'template',
      targetId: draft.definitionId,
      detail: { template, version, authors: draft.authors, lastEditor: draft.lastEditor },
    });
    return task;
  });
}

/**
 * 重新计算：需要发布权限。以当前生效的已发布版本的参数，加上参考日期 asOf（不给时为当天，UTC；不能晚于今天）入队一次模板任务，
 * 来源 manual，不产生新版本。还没有已发布版本时不能重新计算（第一次计算由发布入队）。
 * 锁住租户行后检查：本租户已有同一模板的任务在排队或运行时拒绝。返回按的版本号与入队的任务
 */
export async function recomputeTemplate(actor: CurrentMember, id: string, asOf?: string) {
  assertCan(actor, 'publish');
  const template = requireTemplate(id);
  const day = asOf || todayUtc();
  const kind = TASK_KINDS[template];
  return getDb().transaction(async tx => {
    // 锁住租户行：与另一次重新计算互斥；同时发布的入队要等这里提交（insertTask 的共享锁），锁到以后读到的就是当前生效的版本
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, actor.tenant.id)).for('update');
    const [published] = await tx.select({
      definitionId: templateVersions.definitionId, version: templateVersions.version, params: templateVersions.params,
      templateVersion: templateVersions.templateVersion,
    })
      .from(templateVersions)
      .innerJoin(templateDefinitions, eq(templateDefinitions.id, templateVersions.definitionId))
      .where(and(ofDefinition(actor.tenant.id, template), eq(templateVersions.status, 'published')))
      .orderBy(desc(templateVersions.version)).limit(1);
    if (!published) throw new TemplateError('还没有发布过参数，发布第一版后会自动计算一次');
    const locked = lockedTemplate(template, published.templateVersion);
    validated(() => locked.parse({ ...published.params, asOf: day }));
    // 校验过格式后两边都是 YYYY-MM-DD，可以直接比较字符串
    if (day > todayUtc()) throw new TemplateError(`参考日期 ${day} 晚于今天（UTC ${todayUtc()}）`);
    const [pending] = await tx.select({ id: tasks.id }).from(tasks)
      .where(and(eq(tasks.tenantId, actor.tenant.id), eq(tasks.kind, kind), inArray(tasks.status, ['queued', 'running']))).limit(1);
    if (pending) throw new TemplateError(`${TEMPLATES[template].label}已在排队或运行中，完成后再重新计算`);
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'template.recomputed',
      targetType: 'template',
      targetId: published.definitionId,
      detail: { template, version: published.version, asOf: day },
    });
    const task = await enqueueTemplate(tx, actor.tenant.id, template, published.params, published.version, day, 'manual');
    return { version: published.version, task };
  });
}

/** 升级的起点：生效的已发布版本锁定的模板版本比当前版本旧；没有已发布版本或已是当前版本时报错 */
async function requireUpgradable(db: Tx | Db, tenantId: string, template: TemplateId) {
  const [published] = await db.select({ version: templateVersions.version, params: templateVersions.params, templateVersion: templateVersions.templateVersion })
    .from(templateVersions)
    .innerJoin(templateDefinitions, eq(templateDefinitions.id, templateVersions.definitionId))
    .where(and(ofDefinition(tenantId, template), eq(templateVersions.status, 'published')))
    .orderBy(desc(templateVersions.version)).limit(1);
  const latest = latestTemplate(template);
  if (!published || published.templateVersion >= latest.version) throw new TemplateError('已是最新模板版本');
  return { published, latest };
}

/**
 * 预览升级差异：需要定义查看权限。以生效版本的参数加上参考日期 asOf（不给时为当天，UTC；不能晚于今天），分别按它锁定的模板版本与当前版本编译，
 * 在只读挂载的数据湖上按 consumer_id 对比，只给计数（ADR-0025）：RFM 是分群迁移（原分群 → 新分群的人数），其他模板是换了取值、新增、移出的人数。
 * 不出 consumer_id，不建表、不入队任务、不登记快照。已是当前版本时报「已是最新模板版本」，当前版本不接受生效的参数时说明原因
 */
export async function previewTemplateUpgrade(actor: CurrentMember, id: string, asOf?: string) {
  assertCan(actor, 'definitions:read');
  const template = requireTemplate(id);
  const { published, latest } = await requireUpgradable(getDb(), actor.tenant.id, template);
  const locked = lockedTemplate(template, published.templateVersion);
  const day = asOf || todayUtc();
  const before = validated(() => locked.parse({ ...published.params, asOf: day }));
  // 校验过格式后两边都是 YYYY-MM-DD，可以直接比较字符串
  if (day > todayUtc()) throw new TemplateError(`参考日期 ${day} 晚于今天（UTC ${todayUtc()}）`);
  const after = validated(() => latest.parse({ ...published.params, asOf: day }), `模板第 ${latest.version} 版不接受生效的参数：`);
  const tables = [...new Set([...locked.requires, ...locked.optional ?? [], ...latest.requires, ...latest.optional ?? []])];
  const entities = [...new Set([...locked.entities, ...latest.entities])];
  try {
    return await onReadOnlyLake(actor.tenant.id, entities, [], '预览升级差异', async con => {
      const present = new Set((await rows<{ name: string }>(con, `
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_catalog = 'lake' AND table_schema = 'silver' AND table_name IN (${tables.map(lit).join(', ')})`)).map(t => t.name));
      const missing = [...locked.requires, ...latest.requires].find(t => !present.has(t));
      if (missing) throw new DslError(`${missingTableHint(missing)}，再预览升级差异`);
      const has = (t: string) => present.has(t);
      const oldSql = locked.compile(before, has), newSql = latest.compile(after, has);
      const segment = (sql: string) => `SELECT consumer_id, segment AS tag_value FROM (${sql})`;
      return {
        template,
        from: published.templateVersion,
        to: latest.version,
        asOf: day,
        /** RFM：分群迁移，取值没变的人不出现 */
        segments: template === 'rfm' ? await rows<TagTransition>(con, compileTagDiff(segment(oldSql), segment(newSql))) : null,
        metric: template === 'rfm' ? null : (await rows<DiffCounts>(con, compileMetricDiff(oldSql, newSql)))[0]!,
      };
    });
  } catch (e) {
    if (e instanceof DslError) throw new TemplateError(e.message);
    throw e;
  }
}

/**
 * 确认升级：需要起草权限。已有草稿时把它锁定的模板版本改成当前版本，没有时以生效的参数新建一版锁定当前版本的草稿；
 * 参数按当前版本校验（不接受时说明原因），作者照常记下。之后照常双人发布，发布前计算仍按生效版本锁定的旧版本；丢弃草稿即回到旧版本。
 * 已是当前版本时报「已是最新模板版本」，草稿已锁定当前版本时报错、不重复升级。返回草稿的版本号与升级前后的模板版本
 */
export async function upgradeTemplateDraft(actor: CurrentMember, id: string) {
  assertCan(actor, 'definitions:draft');
  const template = requireTemplate(id);
  return getDb().transaction(async tx => {
    // 锁住定义行：与保存、发布、丢弃互斥，一个定义只有一份草稿
    const [definition] = await tx.select({ id: templateDefinitions.id }).from(templateDefinitions)
      .where(ofDefinition(actor.tenant.id, template)).for('update');
    if (!definition) throw new TemplateError('已是最新模板版本');
    const { published, latest } = await requireUpgradable(tx, actor.tenant.id, template);
    const [newest] = await tx.select().from(templateVersions)
      .where(eq(templateVersions.definitionId, definition.id)).orderBy(desc(templateVersions.version)).limit(1);
    const draft = newest?.status === 'draft' ? newest : null;
    if (draft?.templateVersion === latest.version) throw new TemplateError(`第 ${draft.version} 版草稿已锁定模板第 ${latest.version} 版，发布后生效`);
    const from = draft?.templateVersion ?? published.templateVersion;
    const params = validated(() => latest.parseDefinition(draft?.params ?? published.params) as Record<string, unknown>,
      `模板第 ${latest.version} 版不接受${draft ? '草稿' : '生效'}的参数：`);
    let version: number;
    if (draft) {
      await tx.update(templateVersions).set({
        params, templateVersion: latest.version, authors: withAuthor(draft.authors, actor.email), lastEditor: actor.email, updatedAt: new Date(),
      }).where(eq(templateVersions.id, draft.id));
      version = draft.version;
    } else {
      version = newest!.version + 1;
      await tx.insert(templateVersions).values({
        definitionId: definition.id, version, params, templateVersion: latest.version, authors: [actor.email], lastEditor: actor.email,
      });
    }
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'template.upgrade_drafted',
      targetType: 'template',
      targetId: definition.id,
      detail: { template, version, from, to: latest.version },
    });
    return { version, from, to: latest.version };
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

/** 平台自动启用模板时的作者与发布者（不是成员） */
const PLATFORM = 'platform';

/**
 * 映射合并成功后由调度器调用，幂等：以注册表里的默认参数自动启用本租户的模板。只启用本租户还没有定义（起过草稿也算有）、
 * 且 entities 里每个实体都有已发布未停用映射的模板：建定义与已发布的第 1 版（作者与发布者为 platform，不经双人发布，ADR-0021），
 * 以当天（UTC）为 asOf 入队一次模板任务（来源 publish）并记审计。依赖不全、租户已停用或还有合并在排队或运行时跳过，之后的合并会再检查。
 * 返回这次启用的模板
 */
export async function enableDefaultTemplates(tenantId: string): Promise<TemplateId[]> {
  return getDb().transaction(async tx => {
    // 锁住租户行：同时结束的两次合并不会重复启用；定义的唯一键兜底
    const [tenant] = await tx.select({ suspendedAt: tenants.suspendedAt }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
    if (!tenant || tenant.suspendedAt || await pendingMerge(tx, tenantId)) return [];
    const existing = new Set((await tx.select({ template: templateDefinitions.template }).from(templateDefinitions)
      .where(eq(templateDefinitions.tenantId, tenantId))).map(d => d.template));
    const mapped = new Set((await tx.selectDistinct({ entity: mappings.entity }).from(mappings)
      .innerJoin(mappingVersions, and(eq(mappingVersions.mappingId, mappings.id), eq(mappingVersions.status, 'published')))
      .where(and(eq(mappings.tenantId, tenantId), isNull(mappings.disabledAt)))).map(m => m.entity));
    const enabled: TemplateId[] = [];
    for (const template of Object.keys(TEMPLATES) as TemplateId[]) {
      if (existing.has(template) || !TEMPLATES[template].entities.every(e => mapped.has(e))) continue;
      const [definition] = await tx.insert(templateDefinitions).values({ tenantId, template }).onConflictDoNothing().returning({ id: templateDefinitions.id });
      if (!definition) continue;
      const latest = latestTemplate(template);
      const params = checked(latest, latest.defaults as Record<string, unknown>);
      await tx.insert(templateVersions).values({
        definitionId: definition.id, version: 1, status: 'published', params, templateVersion: latest.version, authors: [PLATFORM], lastEditor: PLATFORM,
        publishedByEmail: PLATFORM, publishedAt: sql`now()`,
      });
      await recordAudit(tx, {
        tenantId, system: true, action: 'template.auto_enabled', targetType: 'template', targetId: definition.id,
        detail: { template, version: 1 },
      });
      await enqueueTemplate(tx, tenantId, template, params, 1, todayUtc(), 'publish');
      enabled.push(template);
    }
    return enabled;
  });
}
