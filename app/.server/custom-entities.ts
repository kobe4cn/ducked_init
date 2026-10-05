// app/.server/custom-entities.ts —— 自定义实体登记（ADR-0019）：成员在标准模型之外登记的实体，名称 custom_ 开头、租户内唯一（建实体时定下，之后不能改），
// 每一版登记中文名、类型（维度 / 事实，只用于引导）、字段（名称、类型、说明、是否敏感）与主键。保存草稿时校验登记本身。
// 草稿按映射同样的规则双人发布：由最后保存它的人以外的另一位有发布权限的成员在页面上发布，也可以丢弃（回到最近的已发布版本，
// 从没发布过时整个删除）；发布后版本锁定。没有任何自动发布的路径。发布过的实体只能新增字段（规则同 ADR-0018），
// 没被已发布映射引用的实体可以由有发布权限的成员删除。一律限定在操作者所属租户内
import { and, desc, eq, exists, getTableColumns, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb, isUniqueViolation } from './db/client';
import { customEntities, customEntityVersions, mappings, mappingVersions, sources } from './db/schema';
import { isStale, publishBlocker, publisherCount, withAuthor } from './publish-rules';
import { CUSTOM_ENTITY_KINDS, CUSTOM_ENTITY_PATTERN, CUSTOM_FIELD_PATTERN, type CustomEntityField, type CustomEntityKind, FIELD_TYPE_NAMES, FIELD_TYPES, type FieldType } from '../lib/canonical-model';

/** 可以展示给成员的业务错误 */
export class CustomEntityError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) { super(message); }
}

/** 一个自定义实体的一版登记 */
export interface RegisteredEntity { name: string; label: string; kind: CustomEntityKind; fields: CustomEntityField[]; primaryKey: string[] }

/** 新建与保存草稿的输入；名称只在新建时接收 */
export type CustomEntityInput = Omit<RegisteredEntity, 'name'> & { name?: string };

/**
 * 页面表单（components/custom-entity-form.tsx）提交的登记：字段按行提交 fieldName / fieldType / fieldDescription，
 * 敏感勾选框提交行号 fieldSensitive；字段名留空的行忽略。主键按逗号（或顿号）分隔
 */
export function customEntityInputOf(form: FormData): CustomEntityInput {
  const all = (key: string) => form.getAll(key).map(String);
  const [names, types, descriptions] = [all('fieldName'), all('fieldType'), all('fieldDescription')];
  const sensitive = new Set(all('fieldSensitive').map(Number));
  return {
    name: form.has('name') ? String(form.get('name')) : undefined,
    label: String(form.get('label') ?? ''),
    kind: String(form.get('kind') ?? '') as CustomEntityKind,
    fields: names.flatMap((name, i) => (name.trim()
      ? [{ name, type: (types[i] ?? '') as FieldType, description: descriptions[i] ?? '', sensitive: sensitive.has(i) }]
      : [])),
    primaryKey: String(form.get('primaryKey') ?? '').split(/[,，、\s]+/),
  };
}

const ENTITY_NAME = new RegExp(CUSTOM_ENTITY_PATTERN);
const FIELD_NAME = new RegExp(CUSTOM_FIELD_PATTERN);

/** 校验并整理一版登记（去掉首尾空白、主键去重）；不合格时抛出 CustomEntityError，说明原因 */
function checkRegistration(input: CustomEntityInput): Omit<RegisteredEntity, 'name'> {
  const label = input.label.trim();
  if (!label) throw new CustomEntityError('请填写中文名');
  if (!Object.hasOwn(CUSTOM_ENTITY_KINDS, input.kind)) throw new CustomEntityError('类型只能是维度或事实');
  const fields = input.fields.map(f => ({ name: f.name.trim(), type: f.type, description: f.description.trim(), sensitive: f.sensitive }));
  if (!fields.length) throw new CustomEntityError('请至少登记一个字段');
  const seen = new Set<string>();
  for (const f of fields) {
    if (!FIELD_NAME.test(f.name)) throw new CustomEntityError(`字段名 ${f.name || '（空）'} 只能用小写字母、数字与下划线，以字母开头`);
    if (seen.has(f.name)) throw new CustomEntityError(`字段名 ${f.name} 重复`);
    seen.add(f.name);
    if (!FIELD_TYPE_NAMES.includes(f.type)) {
      throw new CustomEntityError(`字段 ${f.name} 的类型只能是 ${FIELD_TYPE_NAMES.map(t => `${t}（${FIELD_TYPES[t].label}）`).join('、')}`);
    }
    if (f.sensitive && f.type !== 'string') throw new CustomEntityError(`字段 ${f.name} 是敏感字段：敏感字段在标准层只存哈希，类型只能是 string（文本）`);
  }
  const primaryKey = [...new Set(input.primaryKey.map(k => k.trim()).filter(Boolean))];
  if (!primaryKey.length) throw new CustomEntityError('请填写主键：一个或几个已登记的字段');
  for (const k of primaryKey) if (!seen.has(k)) throw new CustomEntityError(`主键 ${k} 不是已登记的字段`);
  return { label, kind: input.kind, fields, primaryKey };
}

/**
 * 发布后只能新增字段：新的一版与最近的已发布版本相比，已有字段不能少、类型与敏感标记不能变，主键必须完全相同。
 * 中文名、类型（维度 / 事实）、字段说明与字段顺序可以改。不兼容时抛出 CustomEntityError
 */
function checkAdditive(published: Omit<RegisteredEntity, 'name'>, next: Omit<RegisteredEntity, 'name'>) {
  const reject = (reason: string) => {
    throw new CustomEntityError(`${reason}：发布后只能新增字段；改主键、改类型、改名要新建实体`);
  };
  const nextByName = new Map(next.fields.map(f => [f.name, f]));
  for (const f of published.fields) {
    const nextField = nextByName.get(f.name);
    if (!nextField) reject(`不能删除字段 ${f.name}`);
    else if (nextField.type !== f.type) reject(`不能改字段 ${f.name} 的类型（${f.type} → ${nextField.type}）`);
    else if (nextField.sensitive !== f.sensitive) reject(`不能改字段 ${f.name} 的敏感标记`);
  }
  if (next.primaryKey.join() !== published.primaryKey.join()) reject(`不能改主键（${published.primaryKey.join(', ')}）`);
}

/** 本租户的自定义实体；不存在（含属于别的租户）时 404 */
async function requireEntity(tenantId: string, entityId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(entityId)) throw new CustomEntityError('自定义实体不存在', 404);
  const [row] = await getDb().select({ id: customEntities.id, name: customEntities.name }).from(customEntities)
    .where(and(eq(customEntities.id, entityId), eq(customEntities.tenantId, tenantId)));
  if (!row) throw new CustomEntityError('自定义实体不存在', 404);
  return row;
}

/**
 * 引用这个实体的已发布映射（有已发布版本、映射的实体是它；映射的实体建映射时定下），按「数据源」表名列出。
 * 指标与标签还不能引用自定义实体，只查映射
 */
async function publishedReferrers(db: Tx | ReturnType<typeof getDb>, tenantId: string, name: string) {
  const rows = await db.select({ source: sources.name, table: mappings.tableName, viewId: mappings.sourceViewId })
    .from(mappings).innerJoin(sources, eq(sources.id, mappings.sourceId))
    .where(and(
      eq(mappings.tenantId, tenantId), eq(mappings.entity, name),
      exists(db.select({ id: mappingVersions.id }).from(mappingVersions)
        .where(and(eq(mappingVersions.mappingId, mappings.id), eq(mappingVersions.status, 'published')))),
    ))
    .orderBy(sources.name, mappings.tableName);
  return rows.map(r => `「${r.source}」${r.viewId ? '源视图 ' : ''}${r.table}`);
}

/** 列表里的一个自定义实体：最新一版的中文名与类型，最近的已发布版本号与草稿的版本号（没有时为 null） */
export interface CustomEntitySummary { id: string; name: string; label: string; kind: CustomEntityKind; published: number | null; draft: number | null }

/** 本租户的自定义实体，按名称排序 */
export async function listCustomEntities(actor: CurrentMember) {
  assertCan(actor, 'sources:read');
  const versions = await getDb().select({
    id: customEntities.id, name: customEntities.name, version: customEntityVersions.version, status: customEntityVersions.status,
    label: customEntityVersions.label, kind: customEntityVersions.kind,
  })
    .from(customEntities).innerJoin(customEntityVersions, eq(customEntityVersions.entityId, customEntities.id))
    .where(eq(customEntities.tenantId, actor.tenant.id))
    .orderBy(customEntities.name, desc(customEntityVersions.version));
  const entities = new Map<string, CustomEntitySummary>();
  for (const v of versions) {
    const entity = entities.get(v.id) ?? { id: v.id, name: v.name, label: v.label, kind: v.kind, published: null, draft: null };
    if (v.status === 'draft') entity.draft = v.version;
    else entity.published ??= v.version;
    entities.set(v.id, entity);
  }
  return [...entities.values()];
}

/** 自定义实体详情：各版本（最新的在前，带当前成员发布不了的原因）、草稿与最近的已发布版本、本租户有发布权限的成员人数，以及引用它的已发布映射 */
export async function getCustomEntity(actor: CurrentMember, entityId: string) {
  assertCan(actor, 'sources:read');
  const entity = await requireEntity(actor.tenant.id, entityId);
  const versions = await getDb().select({
    version: customEntityVersions.version, status: customEntityVersions.status,
    label: customEntityVersions.label, kind: customEntityVersions.kind, fields: customEntityVersions.fields, primaryKey: customEntityVersions.primaryKey,
    authors: customEntityVersions.authors, lastEditor: customEntityVersions.lastEditor,
    publishedByEmail: customEntityVersions.publishedByEmail, publishedAt: customEntityVersions.publishedAt, updatedAt: customEntityVersions.updatedAt,
  }).from(customEntityVersions).where(eq(customEntityVersions.entityId, entityId)).orderBy(desc(customEntityVersions.version));
  return {
    entity,
    versions: versions.map(v => ({ ...v, publishBlocker: publishBlocker(actor, v) })),
    draft: versions.find(v => v.status === 'draft') ?? null,
    published: versions.find(v => v.status === 'published') ?? null,
    publishers: await publisherCount(actor.tenant.id),
    referrers: await publishedReferrers(getDb(), actor.tenant.id, entity.name),
  };
}

/** 新建自定义实体：名称与登记校验通过后保存为第一版草稿。名称在租户内唯一。返回新建的实体 ID */
export async function createCustomEntity(actor: CurrentMember, input: CustomEntityInput) {
  assertCan(actor, 'sources:write');
  const name = (input.name ?? '').trim();
  if (!ENTITY_NAME.test(name)) throw new CustomEntityError('名称要以 custom_ 开头，之后只含小写字母、数字和下划线（如 custom_store）');
  const registration = checkRegistration(input);
  try {
    return await getDb().transaction(async tx => {
      const [entity] = await tx.insert(customEntities).values({ tenantId: actor.tenant.id, name }).returning({ id: customEntities.id });
      await tx.insert(customEntityVersions).values({ entityId: entity.id, version: 1, ...registration, authors: [actor.email], lastEditor: actor.email });
      await recordAudit(tx, {
        tenantId: actor.tenant.id,
        actor,
        action: 'custom_entity.drafted',
        targetType: 'custom_entity',
        targetId: entity.id,
        detail: { name, version: 1 },
      });
      return entity.id;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new CustomEntityError(`已有名为 ${name} 的自定义实体，请在那个实体上修改`);
    throw e;
  }
}

/**
 * 保存草稿：登记校验通过、且发布过时只新增了字段（checkAdditive）后，已有草稿时改它（记下又一位作者与最后保存的人），否则在最新版本之上新建一版草稿（已发布的版本不变）。
 * 名称不能改，input.name 被忽略。返回草稿的版本号
 */
export async function saveCustomEntityDraft(actor: CurrentMember, entityId: string, input: CustomEntityInput) {
  assertCan(actor, 'sources:write');
  const entity = await requireEntity(actor.tenant.id, entityId);
  const registration = checkRegistration(input);
  return getDb().transaction(async tx => {
    // 锁住实体行：与发布、丢弃互斥；丢弃从没发布过的实体会删除它
    const [locked] = await tx.select({ id: customEntities.id }).from(customEntities).where(eq(customEntities.id, entityId)).for('update');
    if (!locked) throw new CustomEntityError('自定义实体已被删除', 404);
    const [latest] = await tx.select().from(customEntityVersions)
      .where(eq(customEntityVersions.entityId, entityId)).orderBy(desc(customEntityVersions.version)).limit(1);
    const [published] = await tx.select().from(customEntityVersions)
      .where(and(eq(customEntityVersions.entityId, entityId), eq(customEntityVersions.status, 'published')))
      .orderBy(desc(customEntityVersions.version)).limit(1);
    if (published) checkAdditive(published, registration);
    if (latest?.status === 'draft') {
      await tx.update(customEntityVersions)
        .set({ ...registration, authors: withAuthor(latest.authors, actor.email), lastEditor: actor.email, updatedAt: new Date() })
        .where(eq(customEntityVersions.id, latest.id));
      return latest.version;
    }
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(customEntityVersions).values({ entityId, version, ...registration, authors: [actor.email], lastEditor: actor.email });
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'custom_entity.drafted',
      targetType: 'custom_entity',
      targetId: entityId,
      detail: { name: entity.name, version },
    });
    return version;
  });
}

/** 发布草稿：需要发布权限，且发布者不能是最后保存这一版草稿的人（双人发布）。只由成员在页面上调用，没有自动发布。发布后版本锁定 */
export async function publishCustomEntity(actor: CurrentMember, entityId: string, version: number) {
  assertCan(actor, 'publish');
  const entity = await requireEntity(actor.tenant.id, entityId);
  const [draft] = await getDb().select(getTableColumns(customEntityVersions)).from(customEntityVersions)
    .where(and(eq(customEntityVersions.entityId, entityId), eq(customEntityVersions.version, version)));
  if (!draft) throw new CustomEntityError(`没有第 ${version} 版`, 404);
  const blocker = publishBlocker(actor, draft);
  if (blocker) throw new CustomEntityError(blocker, draft.status === 'draft' ? 403 : 400);
  await getDb().transaction(async tx => {
    // 锁住实体行：与保存草稿、丢弃互斥，发布的正是检查过的那份草稿
    await tx.select({ id: customEntities.id }).from(customEntities).where(eq(customEntities.id, entityId)).for('update');
    const [current] = await tx.select().from(customEntityVersions).where(eq(customEntityVersions.id, draft.id));
    if (isStale(current, draft)) throw new CustomEntityError('草稿在你发布前被修改、发布或丢弃，请刷新后重新检查');
    await tx.update(customEntityVersions)
      .set({ status: 'published', publishedByEmail: actor.email, publishedAt: sql`now()` })
      .where(eq(customEntityVersions.id, draft.id));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'custom_entity.published',
      targetType: 'custom_entity',
      targetId: entityId,
      detail: { name: entity.name, version, authors: draft.authors, lastEditor: draft.lastEditor },
    });
  });
}

/**
 * 丢弃草稿：回到最近的已发布版本；从没发布过的实体整个删除。用于草稿卡住（如最后保存的人离职）的情况。
 * 返回实体是否还在
 */
export async function discardCustomEntityDraft(actor: CurrentMember, entityId: string) {
  assertCan(actor, 'sources:write');
  const entity = await requireEntity(actor.tenant.id, entityId);
  return getDb().transaction(async tx => {
    // 锁住实体行：与保存、发布互斥
    const [locked] = await tx.select({ id: customEntities.id }).from(customEntities).where(eq(customEntities.id, entityId)).for('update');
    if (!locked) throw new CustomEntityError('自定义实体已被删除', 404);
    const versions = await tx.select({ id: customEntityVersions.id, version: customEntityVersions.version, status: customEntityVersions.status })
      .from(customEntityVersions).where(eq(customEntityVersions.entityId, entityId)).orderBy(desc(customEntityVersions.version));
    const draft = versions.find(v => v.status === 'draft');
    if (!draft) throw new CustomEntityError('这个自定义实体没有草稿');
    const published = versions.find(v => v.status === 'published')?.version ?? null;
    // 从没发布过时删除实体，各版本随之级联删除
    if (published) await tx.delete(customEntityVersions).where(eq(customEntityVersions.id, draft.id));
    else await tx.delete(customEntities).where(eq(customEntities.id, entityId));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'custom_entity.draft_discarded',
      targetType: 'custom_entity',
      targetId: entityId,
      detail: { name: entity.name, version: draft.version, published },
    });
    return { kept: published !== null };
  });
}

/**
 * 删除自定义实体（硬删除，各版本随之级联删除）：需要发布权限；被已发布的映射引用时拒绝并列出这些映射。
 * 引用检查与删除在同一事务里，并锁住实体行（发布映射目前不锁实体行，要等映射发布对照登记校验时才完全互斥）
 */
export async function deleteCustomEntity(actor: CurrentMember, entityId: string) {
  assertCan(actor, 'publish');
  const entity = await requireEntity(actor.tenant.id, entityId);
  await getDb().transaction(async tx => {
    const [locked] = await tx.select({ id: customEntities.id }).from(customEntities).where(eq(customEntities.id, entityId)).for('update');
    if (!locked) throw new CustomEntityError('自定义实体已被删除', 404);
    const referrers = await publishedReferrers(tx, actor.tenant.id, entity.name);
    if (referrers.length) throw new CustomEntityError(`${entity.name} 被已发布的映射引用，不能删除：${referrers.join('、')}`);
    await tx.delete(customEntities).where(eq(customEntities.id, entityId));
    await recordAudit(tx, {
      tenantId: actor.tenant.id,
      actor,
      action: 'custom_entity.deleted',
      targetType: 'custom_entity',
      targetId: entityId,
      detail: { name: entity.name },
    });
  });
}

/** 本租户每个自定义实体最新的已发布登记，按名称索引（映射校验与合并用）；从没发布过的实体不在其中 */
export async function publishedCustomEntities(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<Map<string, RegisteredEntity>> {
  const rows = await db
    .selectDistinctOn([customEntityVersions.entityId], {
      name: customEntities.name, label: customEntityVersions.label, kind: customEntityVersions.kind,
      fields: customEntityVersions.fields, primaryKey: customEntityVersions.primaryKey,
    })
    .from(customEntityVersions)
    .innerJoin(customEntities, eq(customEntities.id, customEntityVersions.entityId))
    .where(and(eq(customEntities.tenantId, tenantId), eq(customEntityVersions.status, 'published')))
    .orderBy(customEntityVersions.entityId, desc(customEntityVersions.version));
  return new Map(rows.map(r => [r.name, r]));
}
