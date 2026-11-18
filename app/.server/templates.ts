// app/.server/templates.ts —— 分析模板定义：成员调整分析模板（如 RFM）的参数，校验通过才能保存为草稿；草稿按映射同样的规则双人发布——
// 由最后保存它的人以外的另一位有发布权限的成员发布，也可以丢弃（回到最近的已发布版本，从没发布过时回到注册表里的默认参数）。
// 发布后版本锁定，并以新参数（加上当天的 asOf）入队一次模板任务，快照登记时记下定义版本（ADR-0004、0015）。
// 保存草稿、发布与丢弃的流程（双人发布、版本与审计）经 publishing.ts（ADR-0051），本文件给适配器、校验与各入口。
// 也可以按当前生效的版本重新计算（可指定参考日期），不产生新版本；依赖的实体有新合并后调度器按当天以生效版本重算（refresh.ts，ADR-0028）。
// 任务参数与快照记下来源（发布、手动重新计算、定时刷新、平台自动启用时的发布）。映射合并成功后，平台以注册表里的默认参数自动启用
// 本租户还没有定义、依赖的实体都已有已发布映射的模板（enableDefaultTemplates，不经双人发布，ADR-0021）。
// 注册表有了比生效版本锁定的更新的模板版本时，成员可以预览升级后的差异（只读、计数与统计量，ADR-0025），有结果层查看权限的成员可以再点格子或输出列
// 查看最多 10 个样例消费者在两版下的全部输出列（#830，每次写审计），预览还列出下游影响：这个模板进服务库的表与读取它的对外接口。确认后起草一版锁定新模板版本的草稿，照常双人发布。
// 一律限定在操作者所属租户内
import type { DuckDBConnection } from '@duckdb/node-api';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { catalogTx } from './catalog/tx';
import { getDb, type Db } from './db/client';
import { DslError, onReadOnlyLake, type DiffCounts, type TagTransition } from './dsl-definitions';
import { mappings, mappingVersions, spaces, tasks, templateDefinitions, templateVersions, tenants, type SnapshotTrigger } from './db/schema';
import { pendingMerge } from './merges';
import { apiKeyUsageLast30Days, type ApiUsageEndpoint } from './api-usage';
import { discard, type DraftRow, publish, publishBlocker, PublishError, publisherCount, saveDraft as savePublishable, type PublishableAdapter, withAuthor } from './publishing';
import { compileMetricDiff, compileTagDiff } from './pipeline/dsl/impact';
import { cmp } from '../lib/compare';
import { ident, lit } from '../lib/mapping-expr';
import { rows } from './pipeline/duck-sql';
import { currentServingStore } from './serving-store';
import { latestTemplate, missingTableHint, TASK_KINDS, templateAt, TEMPLATES, type Template, type TemplateId } from './pipeline/templates';
import { summarizeColumnUpgrade, summarizeSegmentUpgrade, type ColumnStat, type ColumnType, type NumberStat } from './pipeline/templates/upgrade-summary';
import { insertTask } from './tasks';

export { TASK_KINDS, templateOfKind, type TemplateId } from './pipeline/templates';

/** 可以展示给成员的业务错误：发布流程的错误继承 PublishError（ADR-0051） */
export class TemplateError extends PublishError {}

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
 * 与这一版锁定的模板版本 templateVersion（任务按它编译）。这里的对象按契约的入参类型（InputOf）做编译期检查；
 * 模板参数在 insertTask 里由契约 parse 运行时检查（定义参数来自 jsonb，静态类型只能是 Record）
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
  const upgradeAvailable = published !== null && published.templateVersion < latestTemplateVersion;
  return {
    template,
    label: TEMPLATES[template].label,
    /** 注册表里模板的当前版本 */
    latestTemplateVersion,
    /** 生效的已发布版本锁定的模板版本比当前版本旧：可以预览升级差异、起草升级 */
    upgradeAvailable,
    /** 有可升级版本时：锁定版本 +1 到当前版本之间每一版的改动说明（提示条与预览结果头部列出）；没有时为空 */
    upgradeChanges: upgradeAvailable
      ? Array.from({ length: latestTemplateVersion - published.templateVersion }, (_, i) => {
          const version = published.templateVersion + i + 1;
          return { version, changes: templateAt(template, version).changes };
        })
      : [],
    versions: versions.map(v => ({ ...v, publishBlocker: publishBlocker(actor, v) })),
    draft,
    published,
    // 没有已发布版本时为草稿锁定的模板版本（没有草稿时为当前版本）的默认参数
    params: published?.params ?? (lockedTemplate(template, draft?.templateVersion ?? latestTemplate(template).version).defaults as Record<string, unknown>),
    publishers: await publisherCount(actor.tenant.id),
  };
}

/** templateAdapter 的上下文：租户、空间与模板；保存时另带这一版草稿锁定的模板版本（checkSave 与 saveInside 要用，发布 / 丢弃用不到） */
interface TemplateCtx { tenantId: string; spaceId: string; template: TemplateId; templateVersion?: number }

/** 保存时的上下文：入口读出最新一版锁定的模板版本后带上（publishing.ts 的 saveInside 收不到保存的输入，见 #497） */
type TemplateSaveCtx = TemplateCtx & { templateVersion: number };

/** 模板版本的内容列：发布流程里 checkOutside、afterPublish 与审计收到的草稿带上它们 */
type TemplateDraft = DraftRow & { params: Record<string, unknown>; templateVersion: number };

/** enqueueTemplate 入队的模板任务（publishTemplate 返回它） */
type QueuedTemplate = Awaited<ReturnType<typeof enqueueTemplate>>;

/**
 * 模板定义接入 publishing.ts 的适配器（ADR-0051）：第一次保存时懒建定义父行，保存要用的值（草稿锁定的模板版本、
 * 第一次保存记下的空间，ADR-0048）放在 ctx 里传。发布不锁租户行、不查排队中的任务：发布总要按新参数算一次（ADR-0021）。
 * 发布后以这一版的参数加上当天的 asOf 入队一次模板任务（来源 publish）
 */
export const templateAdapter: PublishableAdapter<TemplateCtx, Record<string, unknown>, undefined, QueuedTemplate> = {
  parent: templateDefinitions,
  versions: templateVersions,
  versionsFk: templateVersions.definitionId,
  lockTenant: false,
  // 丢弃从没发布过的定义会删除它：拿不到锁住的行说明没有草稿可丢
  lockParent: async (tx, ctx) => {
    const [locked] = await tx.select({ id: templateDefinitions.id }).from(templateDefinitions)
      .where(ofDefinition(ctx.tenantId, ctx.template)).for('update');
    if (!locked) throw new TemplateError('这个模板没有草稿');
    return locked.id;
  },
  checkSave: async (ctx, params) => {
    const { template, templateVersion } = ctx as TemplateSaveCtx;
    // templateVersion 一定要放进返回的列：publishing.ts 插入新版本时只写这些列，漏了它就会取列默认值 1
    return { params: checked(lockedTemplate(template, templateVersion), params), templateVersion };
  },
  saveInside: async (tx, ctx) => {
    const { templateVersion } = ctx as TemplateSaveCtx;
    await tx.insert(templateDefinitions).values({ tenantId: ctx.tenantId, spaceId: ctx.spaceId, template: ctx.template }).onConflictDoNothing();
    // 锁住定义行：与发布、丢弃互斥；插入与加锁之间定义可能因丢弃草稿被删除
    const [locked] = await tx.select({ id: templateDefinitions.id }).from(templateDefinitions)
      .where(ofDefinition(ctx.tenantId, ctx.template)).for('update');
    if (!locked) throw new TemplateError('模板定义刚被修改，请刷新后重试');
    // checkSave 在事务外按当时最新一版锁定的模板版本校验，这里再读一次：防止校验之后 upgradeTemplateDraft 改了草稿锁定的版本。
    // 随后 lockParent 会对同一行再加一次锁，没有影响
    const [latest] = await tx.select({ templateVersion: templateVersions.templateVersion }).from(templateVersions)
      .where(eq(templateVersions.definitionId, locked.id)).orderBy(desc(templateVersions.version)).limit(1);
    if ((latest?.templateVersion ?? latestTemplate(ctx.template).version) !== templateVersion) {
      throw new TemplateError('模板定义刚被修改，请刷新后重试');
    }
  },
  // 发布前再校验一次参数（对应发布入口原来的再次校验）；publishing.ts 改状态时不写 params，存的就是校验后的参数
  checkOutside: async (draft, ctx) => {
    const { params, templateVersion } = draft as TemplateDraft;
    checked(lockedTemplate(ctx.template, templateVersion), params);
  },
  afterPublish: async (tx, draft, ctx) => {
    const { params, templateVersion } = draft as TemplateDraft;
    return enqueueTemplate(tx, ctx.tenantId, ctx.template, checked(lockedTemplate(ctx.template, templateVersion), params), draft.version, todayUtc(), 'publish');
  },
  audit: {
    drafted: { action: 'template.drafted', detail: (ctx, _columns, version) => ({ template: ctx.template, version }) },
    published: {
      action: 'template.published',
      detail: (ctx, draft) => ({ template: ctx.template, version: draft.version, authors: draft.authors, lastEditor: draft.lastEditor }),
    },
    // audit.ts 的文案读 detail 里的 published，这个字段名不能改
    discarded: { action: 'template.draft_discarded', detail: (ctx, version, published) => ({ template: ctx.template, version, published }) },
    targetType: 'template',
  },
  missingVersion: version => `没有第 ${version} 版`,
  noDraft: () => '这个模板没有草稿',
};

/**
 * 保存草稿：已有草稿时改它（记下又一位作者与最后保存的人），否则在最新版本之上新建一版草稿（已发布的版本不变）。
 * 第一次保存时建立本租户这个模板的定义。草稿锁定的模板版本：已有草稿时不变，否则沿用最近的已发布版本锁定的，
 * 从没发布过时为注册表的当前版本（不随注册表升级，ADR-0021）；参数按这个版本校验。返回草稿的版本号
 */
export async function saveDraft(actor: CurrentMember, id: string, params: Record<string, unknown>) {
  assertCan(actor, 'definitions:draft');
  const template = requireTemplate(id);
  // 最新一版是草稿时沿用草稿的（草稿新建时已沿用最近的已发布版本），否则它就是最近的已发布版本；
  // 事务外的这次读取只定校验用的版本，并发下的一致性由 saveInside 里的比对保证
  const [latest] = await getDb().select({ templateVersion: templateVersions.templateVersion }).from(templateVersions)
    .innerJoin(templateDefinitions, eq(templateDefinitions.id, templateVersions.definitionId))
    .where(ofDefinition(actor.tenant.id, template))
    .orderBy(desc(templateVersions.version)).limit(1);
  const templateVersion = latest?.templateVersion ?? latestTemplate(template).version;
  return savePublishable(templateAdapter, actor, { tenantId: actor.tenant.id, spaceId: actor.space.id, template, templateVersion }, params);
}

/**
 * 发布草稿：需要发布权限，且发布者不能是最后保存这一版草稿的人（双人发布）。发布前再校验一次参数。
 * 发布后版本锁定，并以这一版的参数加上当天（UTC）的 asOf 入队一次模板任务（来源 publish）。返回入队的任务
 */
export async function publishTemplate(actor: CurrentMember, id: string, version: number) {
  assertCan(actor, 'publish');
  const template = requireTemplate(id);
  const [definition] = await getDb().select({ id: templateDefinitions.id }).from(templateDefinitions)
    .where(ofDefinition(actor.tenant.id, template));
  if (!definition) throw new TemplateError(`没有第 ${version} 版`, 404);
  return publish(templateAdapter, actor, { tenantId: actor.tenant.id, spaceId: actor.space.id, template, parentId: definition.id }, version);
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
  const [published] = await db.select({
    definitionId: templateVersions.definitionId, version: templateVersions.version, params: templateVersions.params, templateVersion: templateVersions.templateVersion,
  })
    .from(templateVersions)
    .innerJoin(templateDefinitions, eq(templateDefinitions.id, templateVersions.definitionId))
    .where(and(ofDefinition(tenantId, template), eq(templateVersions.status, 'published')))
    .orderBy(desc(templateVersions.version)).limit(1);
  const latest = latestTemplate(template);
  if (!published || published.templateVersion >= latest.version) throw new TemplateError('已是最新模板版本');
  return { published, latest };
}

/** DESCRIBE 报的列类型可能带参数（DECIMAL(18,2)、INTEGER[] 等），按前缀归类 */
const NUMBER_TYPE_PREFIXES = ['TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT', 'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL'];

const columnKind = (t: string): ColumnType => {
  const upper = t.toUpperCase();
  if (upper === 'BOOLEAN') return 'bool';
  if (upper === 'VARCHAR') return 'text';
  // 带 [] 的列表（如 INTEGER[]）不算数值列，归 other
  return NUMBER_TYPE_PREFIXES.some(p => upper.startsWith(p)) && !upper.endsWith('[]') ? 'number' : 'other';
};

/** 升级预览 / 样例共用的准备结果（withUpgradedSqls 交给 run 的上下文）：生效与最新版本、两版编译出的 SQL 与统计日 */
type UpgradeCtx = Awaited<ReturnType<typeof requireUpgradable>> & {
  con: DuckDBConnection;
  /** 统计日（asOf，不给时为当天，UTC） */
  day: string;
  oldSql: string;
  newSql: string;
};

/**
 * 升级预览与样例（#830）共用的准备：以生效版本的参数加上参考日期 asOf（不给时为当天，UTC；不能晚于今天），分别按它锁定的模板版本与当前版本编译，
 * 在只读挂载的数据湖上运行 run（what 是操作名，报错时用）。不建表、不入队任务、不登记快照。已是当前版本时报「已是最新模板版本」，当前版本不接受生效的参数时说明原因
 */
async function withUpgradedSqls<T>(tenantId: string, template: TemplateId, asOf: string | undefined, what: string, run: (ctx: UpgradeCtx) => Promise<T>) {
  const { published, latest } = await requireUpgradable(getDb(), tenantId, template);
  const locked = lockedTemplate(template, published.templateVersion);
  const day = asOf || todayUtc();
  const before = validated(() => locked.parse({ ...published.params, asOf: day }));
  // 校验过格式后两边都是 YYYY-MM-DD，可以直接比较字符串
  if (day > todayUtc()) throw new TemplateError(`参考日期 ${day} 晚于今天（UTC ${todayUtc()}）`);
  const after = validated(() => latest.parse({ ...published.params, asOf: day }), `模板第 ${latest.version} 版不接受生效的参数：`);
  const tables = [...new Set([...locked.requires, ...locked.optional ?? [], ...latest.requires, ...latest.optional ?? []])];
  const entities = [...new Set([...locked.entities, ...latest.entities])];
  try {
    return await onReadOnlyLake(tenantId, entities, [], what, async con => {
      const present = new Set((await rows<{ name: string }>(con, `
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_catalog = 'lake' AND table_schema = 'silver' AND table_name IN (${tables.map(lit).join(', ')})`)).map(t => t.name));
      const missing = [...locked.requires, ...latest.requires].find(t => !present.has(t));
      if (missing) throw new DslError(`${missingTableHint(missing)}，再${what}`);
      const has = (t: string) => present.has(t);
      return run({ published, latest, con, day, oldSql: locked.compile(before, has), newSql: latest.compile(after, has) });
    });
  } catch (e) {
    if (e instanceof DslError) throw new TemplateError(e.message);
    throw e;
  }
}

/**
 * 预览升级差异：需要定义查看权限。计数与统计量（ADR-0025）：RFM 是分群迁移（原分群 → 新分群的人数）加 v1 / v2 各分群人数、完整迁移矩阵
 * （含没变的人）与一句话结论（upgrade-summary.ts，不调模型），其他模板是换了取值、新增、移出的人数加每个输出列（不含 consumer_id）的 v1 / v2 统计量
 * （布尔列是的人数、数值列是均值 / 中位数 / P90、文本列是人数最多的前 10 个取值、其余只给非空人数）与一句话结论，不输出单个消费者的取值。
 * 不出 consumer_id，不建表、不入队任务、不登记快照；单个消费者的样例由 sampleTemplateUpgrade 另行按需给出（要结果层查看权限）。
 * 已是当前版本时报「已是最新模板版本」，当前版本不接受生效的参数时说明原因
 */
export async function previewTemplateUpgrade(actor: CurrentMember, id: string, asOf?: string) {
  assertCan(actor, 'definitions:read');
  const template = requireTemplate(id);
  return withUpgradedSqls(actor.tenant.id, template, asOf, '预览升级差异', async ({ con, published, latest, day, oldSql, newSql }) => {
    const segment = (sql: string) => `SELECT consumer_id, segment AS tag_value FROM (${sql})`;
    if (template !== 'rfm') {
      const metric = (await rows<DiffCounts>(con, compileMetricDiff(oldSql, newSql)))[0]!;
      // 按列对比（#858）：列名从两边的 DESCRIBE 取并集（不含 consumer_id），按码点排序（ADR-0045：列名是内部键）；两边类型不一致以 v2 为准
      const described = async (sql: string) => new Map((await rows<{ column_name: string; column_type: string }>(con, `DESCRIBE (${sql})`)).map(c => [c.column_name, c.column_type]));
      const oldTypes = await described(oldSql), newTypes = await described(newSql);
      const names = [...new Set([...oldTypes.keys(), ...newTypes.keys()])].filter(n => n !== 'consumer_id').sort(cmp);
      // 换了取值的人数：两边都有的列才比（IS DISTINCT FROM 连 null 与 null 也算没变）；只有一边有的列 changed 为 null
      const shared = names.filter(n => oldTypes.has(n) && newTypes.has(n));
      const changedCounts = shared.length > 0
        ? (await rows<Record<string, number>>(con, `
          WITH o AS (${oldSql}),
          n AS (${newSql})
          SELECT ${shared.map(n => `count(*) FILTER (WHERE o.${ident(n)} IS DISTINCT FROM n.${ident(n)})::INTEGER AS ${ident(n)}`).join(', ')}
          FROM o JOIN n ON n.${ident('consumer_id')} = o.${ident('consumer_id')}`))[0]!
        : {};
      // 每列在 v1、v2 各算一份统计（计数转 ::INTEGER、统计量转 ::DOUBLE：getRowObjectsJson 里 BIGINT / DECIMAL 是字符串）；
      // DECIMAL 先 CAST 成 DOUBLE 再聚合；文本列只给人数最多的前 10 个取值，超过不另标注
      const boolStat = async (sql: string, c: string) => (await rows<{ yes: number }>(con, `SELECT count(*) FILTER (WHERE ${c})::INTEGER AS yes FROM (${sql})`))[0]!;
      const numberStat = async (sql: string, c: string): Promise<NumberStat> => (await rows<NumberStat>(con, `
        SELECT avg(CAST(${c} AS DOUBLE))::DOUBLE AS mean, median(CAST(${c} AS DOUBLE))::DOUBLE AS median,
          quantile_cont(CAST(${c} AS DOUBLE), 0.9)::DOUBLE AS p90 FROM (${sql})`))[0]!;
      const textStat = async (sql: string, c: string) => ({ values: await rows<{ value: string | null; consumers: number }>(con, `
        SELECT ${c} AS value, count(*)::INTEGER AS consumers FROM (${sql}) GROUP BY ${c} ORDER BY count(*) DESC, ${c} LIMIT 10`) });
      const otherStat = async (sql: string, c: string) => (await rows<{ nonNull: number }>(con, `SELECT count(${c})::INTEGER AS nonNull FROM (${sql})`))[0]!;
      // 同一列两边的统计形状一样（type 以 v2 为准），pair 在这一列两边都在时各算一份，只有一边有时缺的一边为 null
      const pair = async <S>(stat: (sql: string) => Promise<S>, name: string) => ({
        before: oldTypes.has(name) ? await stat(oldSql) : null,
        after: newTypes.has(name) ? await stat(newSql) : null,
      });
      const columns: ColumnStat[] = [];
      for (const name of names) {
        const c = ident(name), type = columnKind(newTypes.get(name) ?? oldTypes.get(name)!), changed = shared.includes(name) ? changedCounts[name]! : null;
        if (type === 'bool') columns.push({ name, type, ...await pair(sql => boolStat(sql, c), name), changed });
        else if (type === 'number') columns.push({ name, type, ...await pair(sql => numberStat(sql, c), name), changed });
        else if (type === 'text') columns.push({ name, type, ...await pair(sql => textStat(sql, c), name), changed });
        else columns.push({ name, type, ...await pair(sql => otherStat(sql, c), name), changed });
      }
      const totalOf = async (sql: string) => (await rows<{ n: number }>(con, `SELECT count(*)::INTEGER AS n FROM (${sql})`))[0]!.n;
      const total = { before: await totalOf(oldSql), after: await totalOf(newSql) };
      return {
        template,
        from: published.templateVersion,
        to: latest.version,
        asOf: day,
        segments: null,
        metric,
        /** 每个输出列（不含 consumer_id）的 v1 / v2 统计量与换了取值的人数（只有计数与统计量，ADR-0025） */
        distribution: { kind: 'columns' as const, total, columns },
        /** 一句话结论：由代码从计数与统计量生成，不调用模型 */
        summary: summarizeColumnUpgrade(metric, columns, total),
      };
    }
    // RFM 在同一个只读连接上多跑各分群人数与完整迁移（compileTagDiff 去掉 WHERE：含没变的人）。
    // 迁移 SQL 内联在这里：dsl-definitions 的标签影响预览还在用 impact.ts 的版本，不改它
    const segmentCounts = (sql: string) => rows<{ segment: string; consumers: number }>(con, `
      SELECT tag_value AS segment, count(*)::INTEGER AS consumers FROM (${segment(sql)}) GROUP BY tag_value ORDER BY tag_value`);
    const matrix = await rows<TagTransition>(con, `
      WITH o AS (${segment(oldSql)}),
      n AS (${segment(newSql)})
      SELECT o.tag_value AS before, n.tag_value AS after, count(*)::INTEGER AS consumers
      FROM o FULL JOIN n ON n.consumer_id = o.consumer_id
      GROUP BY ALL
      ORDER BY ALL NULLS FIRST`);
    return {
      template,
      from: published.templateVersion,
      to: latest.version,
      asOf: day,
      /** 分群迁移，取值没变的人不出现 */
      segments: await rows<TagTransition>(con, compileTagDiff(segment(oldSql), segment(newSql))),
      metric: null,
      /** v1 / v2 各分群人数与「原分群 × 新分群」迁移矩阵（含没变的人；新增、移出的一边为 null） */
      distribution: { kind: 'segments' as const, before: await segmentCounts(oldSql), after: await segmentCounts(newSql), matrix },
      /** 一句话结论：由代码从矩阵计数生成，不调用模型 */
      summary: summarizeSegmentUpgrade(matrix),
    };
  });
}

/** 样例消费者的一行：这个人在 v1、v2 下的全部输出列（不含 consumer_id；只有一边有的列那一边为 null） */
export interface UpgradeSampleRow { consumerId: string; before: Record<string, unknown>; after: Record<string, unknown> }

/** 查看升级样例的结果：点的格子（RFM）或输出列（其他模板）、两版输出列的并集（按码点排序）与样例行（最多 10 个，按 consumer_id 排序） */
export interface UpgradeSample {
  template: TemplateId;
  from: number;
  to: number;
  asOf: string;
  pick: { kind: 'cell'; before: string | null; after: string | null } | { kind: 'column'; column: string };
  /** 两版输出列的并集（不含 consumer_id，按码点排序），样例行两边都按它给值 */
  columns: string[];
  rows: UpgradeSampleRow[];
}

/** 一次查看的样例上限（ADR-0025 补充：按需取样例，只读湖上现算、不缓存） */
const SAMPLE_LIMIT = 10;

/**
 * 查看升级样例（#830）：需要结果层查看权限（没有这个权限的成员仍然只能看计数）。pick 指定看哪些人：RFM 是迁移矩阵的一格
 * （before / after 是原、新分群，null 是「（无）」，与矩阵的口径一致）；其他模板是某个输出列的「换了取值」（只取两边都在且这一列换了取值的人）。
 * 在只读湖上对两版做 FULL JOIN 按 consumer_id 现算（每点一次都重算，不缓存），最多 10 条、按 consumer_id 排序，给出两版的全部输出列。
 * 不建表、不入队任务；每次查看写审计 template.preview_sampled（detail 只有模板、版本、格子 / 列与条数，不出 consumer_id）
 */
export async function sampleTemplateUpgrade(
  actor: CurrentMember, id: string, pick: { before: string | null; after: string | null } | { column: string }, asOf?: string,
): Promise<UpgradeSample> {
  assertCan(actor, 'results:read');
  const template = requireTemplate(id);
  return withUpgradedSqls(actor.tenant.id, template, asOf, '查看升级样例', async ({ con, published, latest, day, oldSql, newSql }) => {
    // 两版输出列的并集（不含 consumer_id，按码点排序，与按列对比同一口径）；只有一边有的列那一栏给 null
    const namesOf = async (sql: string) => new Set((await rows<{ column_name: string }>(con, `DESCRIBE (${sql})`)).map(c => c.column_name));
    const oldNames = await namesOf(oldSql), newNames = await namesOf(newSql);
    const columns = [...new Set([...oldNames, ...newNames])].filter(n => n !== 'consumer_id').sort(cmp);
    // 取样例的 WHERE：列名先验证再拼进 SQL（不拼接用户输入以外的内容，且只在两版都有这一列时才比）
    let where: string;
    if (template === 'rfm') {
      if (!('before' in pick) || !('after' in pick)) throw new TemplateError(`${TEMPLATES[template].label}的样例按迁移矩阵的格子取：要给原分群 before 与新分群 after`);
      // NULL 表示新增 / 移出，与迁移矩阵的口径一致
      where = `o.${ident('segment')} IS NOT DISTINCT FROM ${pick.before === null ? 'NULL' : lit(pick.before)}`
        + ` AND n.${ident('segment')} IS NOT DISTINCT FROM ${pick.after === null ? 'NULL' : lit(pick.after)}`;
    } else {
      if (!('column' in pick)) throw new TemplateError(`${TEMPLATES[template].label}的样例按输出列取：要给列名 column`);
      if (!columns.includes(pick.column)) throw new TemplateError(`模板没有输出列 ${pick.column}`);
      if (!oldNames.has(pick.column) || !newNames.has(pick.column)) throw new TemplateError(`输出列 ${pick.column} 只在其中一版里有，不能取样例`);
      // 只取两边都在的人（与按列对比的换了取值人数同一口径）
      where = `o.${ident('consumer_id')} IS NOT NULL AND n.${ident('consumer_id')} IS NOT NULL AND o.${ident(pick.column)} IS DISTINCT FROM n.${ident(pick.column)}`;
    }
    const selected = await rows<Record<string, unknown>>(con, `
      WITH o AS (${oldSql}),
      n AS (${newSql})
      SELECT coalesce(o.${ident('consumer_id')}, n.${ident('consumer_id')}) AS consumer_id,
        ${columns.flatMap(c => [
          `${oldNames.has(c) ? `o.${ident(c)}` : 'NULL'} AS ${ident(`v1_${c}`)}`,
          `${newNames.has(c) ? `n.${ident(c)}` : 'NULL'} AS ${ident(`v2_${c}`)}`,
        ]).join(', ')}
      FROM o FULL JOIN n ON n.${ident('consumer_id')} = o.${ident('consumer_id')}
      WHERE ${where}
      ORDER BY consumer_id
      LIMIT ${SAMPLE_LIMIT}`);
    const samples: UpgradeSampleRow[] = selected.map(r => ({
      consumerId: String(r.consumer_id),
      before: Object.fromEntries(columns.map(c => [c, r[`v1_${c}`]])),
      after: Object.fromEntries(columns.map(c => [c, r[`v2_${c}`]])),
    }));
    const picked = 'column' in pick ? { kind: 'column' as const, column: pick.column } : { kind: 'cell' as const, before: pick.before, after: pick.after };
    await recordAudit(getDb(), {
      tenantId: actor.tenant.id,
      actor,
      action: 'template.preview_sampled',
      targetType: 'template',
      targetId: published.definitionId,
      detail: { template, from: published.templateVersion, to: latest.version, ...('column' in picked ? { column: picked.column } : { cell: { before: picked.before, after: picked.after } }), count: samples.length },
    });
    return { template, from: published.templateVersion, to: latest.version, asOf: day, pick: picked, columns, rows: samples };
  });
}

/** 模板 → 它进服务库的表与读取这张表的对外接口（ADR-0004、0033：分析模板里目前只有 RFM 进服务库）；有新模板进服务库时在这里登记 */
const SERVING_DOWNSTREAM: Partial<Record<TemplateId, { table: string; paths: string[]; endpoints: ApiUsageEndpoint[] }>> = {
  rfm: {
    table: 'serving.rfm',
    paths: ['GET /api/v1/consumers/:consumerId', 'GET /api/v1/consumers/by-source/:source/:customerId'],
    endpoints: ['consumers.byId', 'consumers.bySource'],
  },
};

/** 模板升级预览的「下游影响」（#830）：这个模板进服务库的表与读取它的对外接口路径 */
export interface TemplateDownstream {
  template: TemplateId;
  /** 服务库里由这个模板生成的表；模板不进服务库、租户还没有服务库或没有这个模板的快照时为 null（「没有下游使用」） */
  table: string | null;
  /** 读取这张表的对外接口路径；没有下游时为空 */
  paths: string[];
  /** 最近 30 个 UTC 日读过的 API Key（名字、两个点查合计次数、是否吊销）；没有下游时为空 */
  keys: { name: string; calls: number; revoked: boolean }[];
}

/**
 * 模板的下游影响（#830）：需要定义查看权限。只读服务库指针，不改服务库代码：列出服务库里由这个模板生成的表与读取它的对外接口路径。
 * 升级确认发布后以下一次计算产出的新快照为准，serving.build 成功后服务库切到新版——没有可查的切换时间，界面用固定文案说明。
 * 模板不进服务库、租户还没有服务库或没有这个模板的快照时 table 为 null（「没有下游使用」）；进服务库的模板另列最近 30 个
 * UTC 日有调用的 API Key 与合计次数（ADR-0059：只显示名字与次数，已吊销的照样列出）
 */
export async function templateDownstream(actor: CurrentMember, id: string): Promise<TemplateDownstream> {
  assertCan(actor, 'definitions:read');
  const template = requireTemplate(id);
  const downstream = SERVING_DOWNSTREAM[template];
  if (!downstream) return { template, table: null, paths: [], keys: [] };
  const store = await currentServingStore(actor.tenant.id);
  const inStore = (store?.snapshots ?? []).some(s => s.template === template);
  // 不展开 downstream：endpoints 是登记数据，不进返回值
  return inStore
    ? { template, table: downstream.table, paths: downstream.paths, keys: await apiKeyUsageLast30Days(actor.tenant.id, downstream.endpoints) }
    : { template, table: null, paths: [], keys: [] };
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
 * 用于草稿卡住（如最后保存的人离职）的情况。返回定义是否还在
 */
export async function discardDraft(actor: CurrentMember, id: string) {
  assertCan(actor, 'definitions:draft');
  const template = requireTemplate(id);
  return discard(templateAdapter, actor, { tenantId: actor.tenant.id, spaceId: actor.space.id, template });
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
  return catalogTx(tenantId, async tx => {
    // 锁住租户行：同时结束的两次合并不会重复启用；定义的唯一键兜底
    const [tenant] = await tx.select({ suspendedAt: tenants.suspendedAt }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
    if (!tenant || tenant.suspendedAt || await pendingMerge(tx, tenantId)) return [];
    const existing = new Set((await tx.select({ template: templateDefinitions.template }).from(templateDefinitions)
      .where(eq(templateDefinitions.tenantId, tenantId))).map(d => d.template));
    const mapped = new Set((await tx.selectDistinct({ entity: mappings.entity }).from(mappings)
      .innerJoin(mappingVersions, and(eq(mappingVersions.mappingId, mappings.id), eq(mappingVersions.status, 'published')))
      .where(and(eq(mappings.tenantId, tenantId), isNull(mappings.disabledAt)))).map(m => m.entity));
    // 自动启用的模板没有操作成员，记在本租户的默认空间（ADR-0048）
    const [defaultSpace] = await tx.select({ id: spaces.id }).from(spaces).where(and(eq(spaces.tenantId, tenantId), eq(spaces.isDefault, true)));
    const enabled: TemplateId[] = [];
    for (const template of Object.keys(TEMPLATES) as TemplateId[]) {
      if (existing.has(template) || !TEMPLATES[template].entities.every(e => mapped.has(e))) continue;
      const [definition] = await tx.insert(templateDefinitions).values({ tenantId, spaceId: defaultSpace!.id, template }).onConflictDoNothing().returning({ id: templateDefinitions.id });
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
