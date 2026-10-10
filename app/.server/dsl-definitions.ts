// app/.server/dsl-definitions.ts —— 指标与标签定义（ADR-0025）：成员用 YAML 写定义，按种类（pipeline/dsl 的注册表）校验通过才能保存为草稿。
// 键在租户与种类内唯一；每个定义同时只有一份草稿，再次保存改的是同一份，记下作者与最后保存的人，之后按映射同样的规则双人发布（ADR-0015）。
// 校验对照本租户已发布的自定义实体登记与已发布映射的扩展字段（标签另对照各指标最新的已发布版本）；定义页展示编译出的 SQL，并可在只读挂载的数据湖上预览前 50 行。
// 发布后版本锁定，并以当天为 asOf 入队一次 gold.dsl（编译在入队时完成，SQL 进任务参数），成功后登记为一张快照（template 为 <种类>:<键>）。
// 有修改与删除权限的成员可以删除定义；被已发布标签引用的指标不能删（依赖由已发布版本按需解析，dsl-dependencies.ts）。
// 一律限定在操作者所属租户内
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { publishedCustomEntities } from './custom-entities';
import { getDb, isUniqueViolation } from './db/client';
import { publishedTagsOf } from './dsl-dependencies';
import { dslDefinitions, dslVersions } from './db/schema';
import { lakeReady, lakeRow, lakeSpecOf } from './lake';
import { lockTenant, publishedPlans } from './mappings';
import { DSL_KINDS, isDslKind, type DslKind } from './pipeline/dsl';
import { checkMetric, type DslCheck, type DslContext, type DslIssue, type MetricSpec } from './pipeline/dsl/metric-spec';
import { IDENTITIES } from './pipeline/identity-engine';
import { openTenantLake, redactLakeSecrets } from './pipeline/lake-engine';
import { lit, rows } from './pipeline/merge-engine';
import { isStale, publishBlocker, publisherCount, withAuthor } from './publish-rules';
import { registerTaskSnapshot } from './snapshots';
import { insertTask } from './tasks';
import { todayUtc } from './templates';

/** 定义的键：小写字母开头，只用小写字母、数字与下划线 */
export const DSL_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/** 可以展示给成员的业务错误；定义校验不通过时带上按行列的问题 */
export class DslError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400, readonly issues: DslIssue[] = []) { super(message); }
}

function requireKind(kind: string): asserts kind is DslKind {
  if (!isDslKind(kind)) throw new DslError(`没有 ${kind} 这种定义`, 404);
}

/**
 * 校验与编译定义要用的本租户上下文：已发布的自定义实体登记、已发布映射的合并计划，
 * 以及各指标最新的已发布版本（对照前两者校验，供标签引用；指标草稿不算）
 */
export async function dslContext(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<DslContext> {
  const base = { published: await publishedCustomEntities(db, tenantId), plans: await publishedPlans(db, tenantId), metrics: new Map() };
  const published = await db.select({ key: dslDefinitions.key, yaml: dslVersions.yaml }).from(dslVersions)
    .innerJoin(dslDefinitions, eq(dslDefinitions.id, dslVersions.definitionId))
    .where(and(eq(dslDefinitions.tenantId, tenantId), eq(dslDefinitions.kind, 'metric'), eq(dslVersions.status, 'published')))
    .orderBy(desc(dslVersions.version));
  const metrics = new Map<string, DslCheck<MetricSpec>>();
  for (const { key, yaml } of published) if (!metrics.has(key)) metrics.set(key, checkMetric(yaml, base));
  return { ...base, metrics };
}

/** 校验定义，不通过时抛出带问题的 DslError */
async function assertValid(kind: DslKind, tenantId: string, yaml: string) {
  const result = DSL_KINDS[kind].check(yaml, await dslContext(getDb(), tenantId));
  if (!result.ok) throw new DslError(`${DSL_KINDS[kind].label}定义有 ${result.issues.length} 个问题，没有保存`, 400, result.issues);
  return result.spec;
}

const ofDefinition = (tenantId: string, kind: DslKind, key: string) =>
  and(eq(dslDefinitions.tenantId, tenantId), eq(dslDefinitions.kind, kind), eq(dslDefinitions.key, key));

/** 新建定义：键要合规且在本租户这一种类里没用过，YAML 校验通过后保存为第 1 版草稿 */
export async function createDefinition(actor: CurrentMember, kind: string, key: string, yaml: string) {
  assertCan(actor, 'definitions:draft');
  requireKind(kind);
  if (!DSL_KEY_PATTERN.test(key)) throw new DslError('键要以小写字母开头，只用小写字母、数字与下划线，最长 63 个字符');
  await assertValid(kind, actor.tenant.id, yaml);
  try {
    return await getDb().transaction(async tx => {
      const [definition] = await tx.insert(dslDefinitions).values({ tenantId: actor.tenant.id, kind, key }).returning({ id: dslDefinitions.id });
      await tx.insert(dslVersions).values({ definitionId: definition!.id, version: 1, yaml, authors: [actor.email], lastEditor: actor.email });
      await recordAudit(tx, {
        tenantId: actor.tenant.id, actor, action: 'definition.drafted', targetType: 'definition', targetId: definition!.id, detail: { kind, key, version: 1 },
      });
      return { kind, key, version: 1 };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new DslError(`已经有键为 ${key} 的${DSL_KINDS[kind].label}`);
    throw e;
  }
}

/**
 * 保存草稿：已有草稿时改它（记下又一位作者与最后保存的人），否则在最新版本之上新建一版草稿（已发布的版本不变）。
 * 定义要已经存在（新建走 createDefinition）。返回草稿的版本号
 */
export async function saveDslDraft(actor: CurrentMember, kind: string, key: string, yaml: string) {
  assertCan(actor, 'definitions:draft');
  requireKind(kind);
  await assertValid(kind, actor.tenant.id, yaml);
  return getDb().transaction(async tx => {
    // 锁住定义行：与发布、丢弃互斥
    const [locked] = await tx.select({ id: dslDefinitions.id }).from(dslDefinitions).where(ofDefinition(actor.tenant.id, kind, key)).for('update');
    if (!locked) throw new DslError(`没有键为 ${key} 的${DSL_KINDS[kind].label}`, 404);
    const [latest] = await tx.select().from(dslVersions)
      .where(eq(dslVersions.definitionId, locked.id)).orderBy(desc(dslVersions.version)).limit(1);
    if (latest?.status === 'draft') {
      await tx.update(dslVersions).set({ yaml, authors: withAuthor(latest.authors, actor.email), lastEditor: actor.email, updatedAt: new Date() })
        .where(eq(dslVersions.id, latest.id));
      return latest.version;
    }
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(dslVersions).values({ definitionId: locked.id, version, yaml, authors: [actor.email], lastEditor: actor.email });
    await recordAudit(tx, {
      tenantId: actor.tenant.id, actor, action: 'definition.drafted', targetType: 'definition', targetId: locked.id, detail: { kind, key, version },
    });
    return version;
  });
}

/**
 * 本租户的一个定义：各版本（最新的在前，带当前成员发布不了的原因）、草稿与最近的已发布版本、本租户有发布权限的成员人数、引用它的已发布标签，
 * 以及最新一版（有草稿时是草稿）按今天（UTC）编译出的 SQL；它对照当前的登记与映射不再通过校验时给出问题
 */
export async function getDefinition(actor: CurrentMember, kind: string, key: string) {
  assertCan(actor, 'definitions:read');
  requireKind(kind);
  const versions = await getDb().select({
    version: dslVersions.version, status: dslVersions.status, yaml: dslVersions.yaml,
    authors: dslVersions.authors, lastEditor: dslVersions.lastEditor,
    publishedByEmail: dslVersions.publishedByEmail, publishedAt: dslVersions.publishedAt, updatedAt: dslVersions.updatedAt,
  }).from(dslVersions)
    .innerJoin(dslDefinitions, eq(dslDefinitions.id, dslVersions.definitionId))
    .where(ofDefinition(actor.tenant.id, kind, key))
    .orderBy(desc(dslVersions.version));
  if (!versions.length) throw new DslError(`没有键为 ${key} 的${DSL_KINDS[kind].label}`, 404);
  const draft = versions.find(v => v.status === 'draft') ?? null;
  const published = versions.find(v => v.status === 'published') ?? null;
  const ctx = await dslContext(getDb(), actor.tenant.id);
  const result = DSL_KINDS[kind].check(versions[0]!.yaml, ctx);
  return {
    kind,
    key,
    label: DSL_KINDS[kind].label,
    versions: versions.map(v => ({ ...v, publishBlocker: publishBlocker(actor, v) })),
    draft,
    published,
    publishers: await publisherCount(actor.tenant.id),
    /** 引用这个指标的已发布标签的键；有引用时不能删除 */
    dependents: kind === 'metric' ? await publishedTagsOf(getDb(), actor.tenant.id, key) : [],
    compiled: result.ok
      ? { version: versions[0]!.version, sql: DSL_KINDS[kind].compile(result.spec, ctx, todayUtc(), key), issues: [] as DslIssue[] }
      : { version: versions[0]!.version, sql: null, issues: result.issues },
  };
}

/**
 * 发布草稿：需要发布权限，且发布者不能是最后保存这一版草稿的人（双人发布）。发布前对照当前的登记与映射再校验一次，并按当天（UTC）编译。
 * 发布后版本锁定，同一事务里入队一次 gold.dsl，任务参数带上编译出的 SQL 与用到的实体（任务不再访问平台库）。返回入队的任务
 */
export async function publishDefinition(actor: CurrentMember, kind: string, key: string, version: number) {
  assertCan(actor, 'publish');
  requireKind(kind);
  const [draft] = await getDb().select(getTableColumns(dslVersions)).from(dslVersions)
    .innerJoin(dslDefinitions, eq(dslDefinitions.id, dslVersions.definitionId))
    .where(and(ofDefinition(actor.tenant.id, kind, key), eq(dslVersions.version, version)));
  if (!draft) throw new DslError(`没有第 ${version} 版`, 404);
  const blocker = publishBlocker(actor, draft);
  if (blocker) throw new DslError(blocker, draft.status === 'draft' ? 403 : 400);
  return getDb().transaction(async tx => {
    // 先锁住租户行：与映射发布、删除定义与自定义实体互斥，它们按已发布定义的依赖做检查
    await lockTenant(tx, actor.tenant.id);
    // 锁住定义行：与保存草稿、丢弃互斥，发布的正是检查过的那份草稿
    await tx.select({ id: dslDefinitions.id }).from(dslDefinitions).where(eq(dslDefinitions.id, draft.definitionId)).for('update');
    const [current] = await tx.select().from(dslVersions).where(eq(dslVersions.id, draft.id));
    if (isStale(current, draft)) throw new DslError('草稿在你发布前被修改、发布或丢弃，请刷新后重新检查');
    const ctx = await dslContext(tx, actor.tenant.id);
    const checked = DSL_KINDS[kind].check(draft.yaml, ctx);
    if (!checked.ok) throw new DslError('对照当前已发布的登记与映射，这一版不再通过校验，不能发布', 400, checked.issues);
    const asOf = todayUtc();
    await tx.update(dslVersions).set({ status: 'published', publishedByEmail: actor.email, publishedAt: sql`now()` }).where(eq(dslVersions.id, draft.id));
    await recordAudit(tx, {
      tenantId: actor.tenant.id, actor, action: 'definition.published', targetType: 'definition', targetId: draft.definitionId,
      detail: { kind, key, version, authors: draft.authors, lastEditor: draft.lastEditor },
    });
    return insertTask(tx, actor.tenant.id, 'gold.dsl', {
      kind, key, definitionId: draft.definitionId, definitionVersion: version, asOf,
      sql: DSL_KINDS[kind].compile(checked.spec, ctx, asOf, key), entities: DSL_KINDS[kind].entities(checked.spec, ctx),
    });
  });
}

/**
 * 丢弃草稿：回到最近的已发布版本；从没发布过的定义整个删除。用于草稿卡住（如最后保存的人离职）的情况。
 * 返回回到的已发布版本号（没有时为 null）
 */
export async function discardDslDraft(actor: CurrentMember, kind: string, key: string) {
  assertCan(actor, 'definitions:draft');
  requireKind(kind);
  return getDb().transaction(async tx => {
    // 锁住定义行：与保存、发布互斥
    const [definition] = await tx.select({ id: dslDefinitions.id }).from(dslDefinitions).where(ofDefinition(actor.tenant.id, kind, key)).for('update');
    if (!definition) throw new DslError(`没有键为 ${key} 的${DSL_KINDS[kind].label}`, 404);
    const versions = await tx.select({ id: dslVersions.id, version: dslVersions.version, status: dslVersions.status })
      .from(dslVersions).where(eq(dslVersions.definitionId, definition.id)).orderBy(desc(dslVersions.version));
    const draft = versions.find(v => v.status === 'draft');
    if (!draft) throw new DslError(`这个${DSL_KINDS[kind].label}没有草稿`, 404);
    const published = versions.find(v => v.status === 'published')?.version ?? null;
    // 从没发布过时删除定义，各版本随之级联删除
    if (published) await tx.delete(dslVersions).where(eq(dslVersions.id, draft.id));
    else await tx.delete(dslDefinitions).where(eq(dslDefinitions.id, definition.id));
    await recordAudit(tx, {
      tenantId: actor.tenant.id, actor, action: 'definition.draft_discarded', targetType: 'definition', targetId: definition.id,
      detail: { kind, key, version: draft.version, published },
    });
    return { published };
  });
}

/**
 * 删除定义（硬删除，各版本随之级联删除；已登记的快照留到正常过期）：需要修改与删除权限。
 * 指标被已发布的标签引用（各标签最新的已发布版本，草稿不算）时拒绝并列出这些标签的键
 */
export async function deleteDefinition(actor: CurrentMember, kind: string, key: string) {
  assertCan(actor, 'definitions:write');
  requireKind(kind);
  await getDb().transaction(async tx => {
    // 先锁租户行（与发布定义、映射互斥，同时发布的标签要么已提交、要么看不到这个指标），再锁定义行后查依赖
    await lockTenant(tx, actor.tenant.id);
    const [definition] = await tx.select({ id: dslDefinitions.id }).from(dslDefinitions).where(ofDefinition(actor.tenant.id, kind, key)).for('update');
    if (!definition) throw new DslError(`没有键为 ${key} 的${DSL_KINDS[kind].label}`, 404);
    const tags = kind === 'metric' ? await publishedTagsOf(tx, actor.tenant.id, key) : [];
    if (tags.length) throw new DslError(`指标 ${key} 被已发布的标签引用，不能删除：${tags.join('、')}`);
    await tx.delete(dslDefinitions).where(eq(dslDefinitions.id, definition.id));
    await recordAudit(tx, {
      tenantId: actor.tenant.id, actor, action: 'definition.deleted', targetType: 'definition', targetId: definition.id, detail: { kind, key },
    });
  });
}

/**
 * gold.dsl 成功后登记它的快照：template 为 <种类>:<键>，读到的实体取任务参数 entities（入队时由定义得出）；
 * 其余（定义版本、行数、90 天过期、不完整的映射）同分析模板的快照
 */
export const registerDslSnapshot = (tenantId: string, taskId: string) =>
  registerTaskSnapshot(tenantId, taskId, params => ({ template: `${params.kind}:${params.key}`, entities: params.entities as string[] }));

const PREVIEW_ROWS = 50;
const PREVIEW_LIMITS = { memoryLimitMb: 512, threads: 1 };

/**
 * 样本预览：在只读挂载的数据湖上按今天（UTC）运行定义第 version 版（默认最新一版）编译出的 SQL，返回列名、前 50 行与总行数。
 * 只执行一条 SELECT：不建表、不入队任务、不登记快照。标准层还没有定义用到的实体或身份打通结果时抛出说明；
 * 结果只有 consumer_id、维度与值，或标签的键与取值（敏感字段在校验时已被拒），查询出错时报错里抹掉湖的凭据
 */
export async function previewDefinition(actor: CurrentMember, kind: string, key: string, version?: number) {
  assertCan(actor, 'definitions:read');
  requireKind(kind);
  const [row] = await getDb().select({ version: dslVersions.version, yaml: dslVersions.yaml }).from(dslVersions)
    .innerJoin(dslDefinitions, eq(dslDefinitions.id, dslVersions.definitionId))
    .where(and(ofDefinition(actor.tenant.id, kind, key), version === undefined ? undefined : eq(dslVersions.version, version)))
    .orderBy(desc(dslVersions.version)).limit(1);
  if (!row) throw new DslError(version === undefined ? `没有键为 ${key} 的${DSL_KINDS[kind].label}` : `没有第 ${version} 版`, 404);
  const ctx = await dslContext(getDb(), actor.tenant.id);
  const checked = DSL_KINDS[kind].check(row.yaml, ctx);
  if (!checked.ok) throw new DslError('对照当前已发布的登记与映射，这一版不再通过校验，不能预览', 400, checked.issues);
  const lake = await lakeRow(actor.tenant.id);
  if (!lake || !lakeReady(lake)) throw new DslError('本租户的数据湖还没有初始化');
  const asOf = todayUtc();
  const sql = DSL_KINDS[kind].compile(checked.spec, ctx, asOf, key);
  const spec = lakeSpecOf(lake);
  const session = await openTenantLake(spec, PREVIEW_LIMITS, undefined, { readOnly: true });
  try {
    const entities = DSL_KINDS[kind].entities(checked.spec, ctx);
    const present = new Set((await rows<{ name: string }>(session.con, `
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_catalog = 'lake' AND table_schema = 'silver' AND table_name IN (${[...entities, '_identities'].map(lit).join(', ')})`)).map(t => t.name));
    const missing = entities.filter(entity => !present.has(entity));
    if (missing.length) {
      throw new DslError(`标准层还没有 ${missing.map(entity => `silver.${entity}`).join('、')}：先发布 ${missing.join('、')} 的映射并合并，再预览`);
    }
    if (!present.has('_identities')) throw new DslError(`标准层还没有身份打通结果（${IDENTITIES}）：先发布 customer 映射并合并，再预览`);
    const reader = await session.con.runAndReadAll(
      `SELECT *, count(*) OVER () AS _preview_total FROM (${sql}) ORDER BY ALL LIMIT ${PREVIEW_ROWS}`);
    const columns = reader.columnNames().filter(c => c !== '_preview_total');
    const result = reader.getRowObjectsJson() as Record<string, string | number | boolean | null>[];
    return {
      version: row.version,
      asOf,
      columns,
      total: Number(result[0]?._preview_total ?? 0),
      rows: result.map(({ _preview_total: _, ...r }) => r),
    };
  } catch (e) {
    if (e instanceof DslError) throw e;
    throw new DslError(`预览失败：${redactLakeSecrets((e as Error).message, spec)}`);
  } finally {
    session.close();
  }
}
