// app/.server/custom-entities.ts —— 自定义实体登记（ADR-0019）：成员在标准模型之外登记的实体，名称 custom_ 开头、租户内唯一（建实体时定下，之后不能改），
// 每一版登记中文名、类型（维度 / 事实，只用于引导）、字段（名称、类型、说明、是否敏感）、主键与关系（本实体或标准实体的字段 → 另一个实体的单列主键，
// 至少一端是本实体，ADR-0019「关系」）。保存草稿时校验登记本身、关系的两端与成环，发布时再校验一次。
// 草稿按映射同样的规则双人发布：由最后保存它的人以外的另一位有发布权限的成员在页面上发布，也可以丢弃（回到最近的已发布版本，
// 从没发布过时整个删除）；发布后版本锁定。没有任何自动发布的路径。发布过的实体只能新增字段与关系（规则同 ADR-0018），
// 没被已发布映射、也没被别的实体的已发布关系指向的实体可以由有发布权限的成员删除。已发布映射在用、但没登记的实体由平台推断一份登记草稿（ADR-0019「已有自定义实体怎么迁」），
// 先由一位成员确认（保存），再由另一位成员发布；登记发布前映射页提示实体待补登，映射页的实体链接到实体页。一律限定在操作者所属租户内
import { and, desc, eq, exists, getTableColumns, inArray, notExists, sql } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb, isUniqueViolation } from './db/client';
import { customEntities, customEntityVersions, mappings, mappingVersions, sources } from './db/schema';
import { publishedPlans } from './mappings';
import { isStale, publishBlocker, publisherCount, withAuthor } from './publish-rules';
import {
  CANONICAL_ENTITIES, CUSTOM_ENTITY_KINDS, CUSTOM_ENTITY_PATTERN, CUSTOM_FIELD_PATTERN, type CustomEntityField, type CustomEntityKind, type EntityRelation, entityOf,
  EXTENSION_PATTERN, FIELD_TYPE_NAMES, FIELD_TYPES, type FieldType, isCustomEntity,
} from '../lib/canonical-model';

/** 可以展示给成员的业务错误 */
export class CustomEntityError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) { super(message); }
}

/** 一个自定义实体的一版登记；没有关系时 relations 可以不填 */
export interface RegisteredEntity { name: string; label: string; kind: CustomEntityKind; fields: CustomEntityField[]; primaryKey: string[]; relations?: EntityRelation[] }

/** 校验整理过的一版登记：关系一定有 */
type CheckedRegistration = Omit<RegisteredEntity, 'name'> & { relations: EntityRelation[] };

/** 新建与保存草稿的输入；名称只在新建时接收 */
export type CustomEntityInput = Omit<RegisteredEntity, 'name'> & { name?: string };

/**
 * 页面表单（components/custom-entity-form.tsx）提交的登记：字段按行提交 fieldName / fieldType / fieldDescription，
 * 敏感勾选框提交行号 fieldSensitive；字段名留空的行忽略。主键按逗号（或顿号）分隔。
 * 关系按行提交 relFrom / relField / relEntity / relTarget（起点实体、起点字段、终点实体、终点字段），起点字段留空的行忽略；起点实体或终点实体留空，即本实体
 */
export function customEntityInputOf(form: FormData): CustomEntityInput {
  const all = (key: string) => form.getAll(key).map(String);
  const [names, types, descriptions] = [all('fieldName'), all('fieldType'), all('fieldDescription')];
  const sensitive = new Set(all('fieldSensitive').map(Number));
  const [relFroms, relFields, relEntities, relTargets] = [all('relFrom'), all('relField'), all('relEntity'), all('relTarget')];
  return {
    name: form.has('name') ? String(form.get('name')) : undefined,
    label: String(form.get('label') ?? ''),
    kind: String(form.get('kind') ?? '') as CustomEntityKind,
    fields: names.flatMap((name, i) => (name.trim()
      ? [{ name, type: (types[i] ?? '') as FieldType, description: descriptions[i] ?? '', sensitive: sensitive.has(i) }]
      : [])),
    primaryKey: String(form.get('primaryKey') ?? '').split(/[,，、\s]+/),
    relations: relFields.flatMap((field, i) => (field.trim()
      ? [{ from: { entity: relFroms[i] ?? '', field }, ref: { entity: relEntities[i] ?? '', field: relTargets[i] ?? '' } }]
      : [])),
  };
}

/** 关系的展示：起点实体.起点字段 → 终点实体.终点字段 */
const relationText = (r: EntityRelation) => `${r.from.entity}.${r.from.field} → ${r.ref.entity}.${r.ref.field}`;

/** 标准模型字段上内置的 ref，写成与登记上的关系同形的边 */
const BUILTIN_RELATIONS: EntityRelation[] = CANONICAL_ENTITIES.flatMap(e => e.fields.flatMap(f => (f.ref ? [{ from: { entity: e.name, field: f.name }, ref: f.ref }] : [])));

/** 租户的全部关系：标准模型内置的 ref 与已发布登记上的关系 */
const allRelations = (published: Map<string, RegisteredEntity>) => [...BUILTIN_RELATIONS, ...[...published.values()].flatMap(e => e.relations ?? [])];

/** 以 entity 为起点的全部关系：标准模型内置的 ref 与已发布登记上的关系（ADR-0019） */
export function relationsFrom(entity: string, published: Map<string, RegisteredEntity>): EntityRelation[] {
  return allRelations(published).filter(r => r.from.entity === entity);
}

/**
 * 被关系指向的实体与各自的主键：内置 ref 与已发布登记上关系的终点，customer 除外。
 * 合并时这些实体的主键在整个实体内跨映射唯一（ADR-0019「终点主键在整个实体内唯一」）
 */
export function referencedKeys(published: Map<string, RegisteredEntity>): Map<string, string[]> {
  const targets = new Set(allRelations(published).map(r => r.ref.entity));
  targets.delete('customer');
  return new Map([...targets].flatMap(name => {
    const key = entityOf(name)?.key.slice() ?? published.get(name)?.primaryKey;
    return key ? [[name, key] as const] : [];
  }));
}

/** 自定义实体名称的规则（CUSTOM_ENTITY_PATTERN） */
export const ENTITY_NAME = new RegExp(CUSTOM_ENTITY_PATTERN);
const FIELD_NAME = new RegExp(CUSTOM_FIELD_PATTERN);
const EXTENSION_NAME = new RegExp(EXTENSION_PATTERN);

/**
 * 校验并整理一版登记（去掉首尾空白、主键去重）；不合格时抛出 CustomEntityError，说明原因。name 是本实体的名称：
 * 关系的起点要是本实体已登记的字段（起点、终点实体留空时补上 name），或标准实体的字段或 x_ 扩展字段，这时终点要是本实体（关系挂在另一端的登记上）。
 * x_ 字段的类型、关系的终点与成环在 checkRelations 里对照已发布的映射与实体校验
 */
export function checkRegistration(input: CustomEntityInput, name = input.name?.trim() ?? ''): CheckedRegistration {
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
  const relations = (input.relations ?? []).map(r => ({
    from: { entity: r.from.entity.trim() || name, field: r.from.field.trim() },
    ref: { entity: r.ref.entity.trim() || name, field: r.ref.field.trim() },
  }));
  const declared = new Set<string>();
  for (const r of relations) {
    const canonical = entityOf(r.from.entity);
    if (r.from.entity !== name && !canonical) throw new CustomEntityError(`关系 ${relationText(r)} 的起点要是本实体 ${name} 或标准实体的字段`);
    if (!canonical && !seen.has(r.from.field)) throw new CustomEntityError(`关系的起点 ${r.from.field} 不是已登记的字段`);
    if (canonical && !canonical.fields.some(f => f.name === r.from.field) && !EXTENSION_NAME.test(r.from.field)) {
      throw new CustomEntityError(`关系的起点 ${r.from.field} 不是 ${r.from.entity} 的字段，也不是 x_ 开头的扩展字段`);
    }
    if (!r.ref.field) throw new CustomEntityError(`请填写关系 ${relationText(r)} 的终点字段`);
    if (canonical && r.ref.entity !== name) throw new CustomEntityError(`关系 ${relationText(r)}：起点是标准实体时，终点要是本实体 ${name}`);
    if (r.ref.entity === r.from.entity) throw new CustomEntityError(`关系 ${relationText(r)} 指向本实体自己：自指算成环，不能声明`);
    if (declared.has(relationText(r))) throw new CustomEntityError(`关系 ${relationText(r)} 重复`);
    declared.add(relationText(r));
  }
  return { label, kind: input.kind, fields, primaryKey, relations };
}

/**
 * 校验本实体 name 这一版登记的关系：终点是标准实体、本租户已发布的自定义实体（只有草稿的、包括推断出的登记草稿都不算）或本实体，
 * ref.field 是它唯一的一列主键，且与起点字段类型相同。起点是标准实体的 x_ 字段时，类型取自用了它的已发布映射（映射草稿不算），
 * 没有映射用过或各映射给的类型不同时报错。敏感字段可以作为关系的键（两端都是哈希）。
 * 再把本版的关系放进租户的关系图（别的实体已发布的关系、标准模型内置的 ref）检查成环。不合格时抛出 CustomEntityError
 */
export async function checkRelations(
  db: Tx | ReturnType<typeof getDb>, tenantId: string, name: string, registration: Pick<CheckedRegistration, 'fields' | 'primaryKey' | 'relations'>,
) {
  if (!registration.relations.length) return;
  const published = await publishedCustomEntities(db, tenantId);
  let plans: Awaited<ReturnType<typeof publishedPlans>> | undefined;
  const typeOf = async (r: EntityRelation): Promise<FieldType> => {
    const origin = entityOf(r.from.entity);
    if (!origin) return registration.fields.find(f => f.name === r.from.field)!.type;
    const field = origin.fields.find(f => f.name === r.from.field);
    if (field) return field.type;
    plans ??= await publishedPlans(db, tenantId);
    const types = [...new Set(plans.filter(p => p.entity === r.from.entity)
      .flatMap(p => p.entityColumns.filter(c => c.name === r.from.field).map(c => c.type)))];
    if (!types.length) throw new CustomEntityError(`关系 ${relationText(r)}：${r.from.field} 没有被已发布的 ${r.from.entity} 映射用过，类型无从确定`);
    if (types.length > 1) throw new CustomEntityError(`关系 ${relationText(r)}：各已发布的 ${r.from.entity} 映射给 ${r.from.field} 的类型不一致（${types.join('、')}）`);
    return types[0];
  };
  for (const r of registration.relations) {
    const canonicalTarget = entityOf(r.ref.entity);
    const custom = r.ref.entity === name ? registration : published.get(r.ref.entity);
    const target = canonicalTarget
      ? { key: canonicalTarget.key, fields: canonicalTarget.fields as readonly { name: string; type: FieldType }[] }
      : custom && { key: custom.primaryKey, fields: custom.fields };
    if (!target) throw new CustomEntityError(`关系 ${relationText(r)} 的终点 ${r.ref.entity} 不存在或没发布：终点要是标准实体或已发布的自定义实体`);
    if (target.key.length !== 1) throw new CustomEntityError(`关系 ${relationText(r)}：${r.ref.entity} 的主键有多列（${target.key.join(', ')}），终点只能是单列主键`);
    if (r.ref.field !== target.key[0]) throw new CustomEntityError(`关系 ${relationText(r)}：${r.ref.field} 不是 ${r.ref.entity} 的主键（${target.key[0]}）`);
    const fromType = await typeOf(r);
    const refType = target.fields.find(f => f.name === r.ref.field)!.type;
    if (fromType !== refType) throw new CustomEntityError(`关系 ${relationText(r)} 两端类型不一致（${fromType} → ${refType}）`);
  }
  const edges = [
    ...[...published.values()].filter(e => e.name !== name).flatMap(e => e.relations ?? []),
    ...registration.relations,
    ...BUILTIN_RELATIONS,
  ];
  const cycle = findCycle(edges, name);
  if (cycle) throw new CustomEntityError(`关系成环：${cycle.join(' → ')}；维度路径要能沿关系一直走到头，不能绕回来`);
}

/**
 * 关系图（实体 → 实体）里经过 start 的一个环，按路径列出实体、从 start 写起、首尾相同；没有时为 null。
 * 本版新增的边都挂在本实体上，新出现的环一定经过它；只从它找，租户里已有的无关的环不拦这次保存
 */
function findCycle(relations: EntityRelation[], start: string): string[] | null {
  const next = new Map<string, Set<string>>();
  for (const r of relations) next.set(r.from.entity, (next.get(r.from.entity) ?? new Set()).add(r.ref.entity));
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (node: string): string[] | null => {
    if (node === start && path.length) return [...path, node];
    if (path.includes(node) || done.has(node)) return null;
    path.push(node);
    for (const to of next.get(node) ?? []) {
      const found = visit(to);
      if (found) return found;
    }
    path.pop();
    done.add(node);
    return null;
  };
  return visit(start);
}

/** 关系可选的终点：标准实体与本租户已发布的自定义实体，各自的名称、中文名与主键（实体页的关系下拉） */
export async function relationTargets(actor: CurrentMember) {
  assertCan(actor, 'sources:read');
  const custom = [...(await publishedCustomEntities(getDb(), actor.tenant.id)).values()];
  return [
    ...CANONICAL_ENTITIES.map(e => ({ name: e.name, label: e.label, primaryKey: [...e.key] })),
    ...custom.map(e => ({ name: e.name, label: e.label, primaryKey: e.primaryKey })),
  ];
}

/**
 * 发布后只能新增字段与关系：新的一版与最近的已发布版本相比，已有字段不能少、类型与敏感标记不能变，主键必须完全相同，已发布的关系原样都在。
 * 中文名、类型（维度 / 事实）、字段说明与字段顺序可以改。不兼容时抛出 CustomEntityError
 */
function checkAdditive(published: CheckedRegistration, next: CheckedRegistration) {
  const reject = (reason: string) => {
    throw new CustomEntityError(`${reason}：发布后只能新增字段与关系；改主键、改类型、改名要新建实体`);
  };
  const nextByName = new Map(next.fields.map(f => [f.name, f]));
  for (const f of published.fields) {
    const nextField = nextByName.get(f.name);
    if (!nextField) reject(`不能删除字段 ${f.name}`);
    else if (nextField.type !== f.type) reject(`不能改字段 ${f.name} 的类型（${f.type} → ${nextField.type}）`);
    else if (nextField.sensitive !== f.sensitive) reject(`不能改字段 ${f.name} 的敏感标记`);
  }
  if (next.primaryKey.join() !== published.primaryKey.join()) reject(`不能改主键（${published.primaryKey.join(', ')}）`);
  // 按值比较：jsonb 存进去后对象键的顺序会变
  const keyOf = (r: EntityRelation) => [r.from.entity, r.from.field, r.ref.entity, r.ref.field].join('\n');
  const nextRelations = new Set(next.relations.map(keyOf));
  for (const r of published.relations) {
    if (!nextRelations.has(keyOf(r))) reject(`不能删除或修改关系 ${relationText(r)}`);
  }
}

/** 本租户的自定义实体；不存在（含属于别的租户）时 404 */
export async function requireEntity(tenantId: string, entityId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(entityId)) throw new CustomEntityError('自定义实体不存在', 404);
  const [row] = await getDb().select({ id: customEntities.id, name: customEntities.name }).from(customEntities)
    .where(and(eq(customEntities.id, entityId), eq(customEntities.tenantId, tenantId)));
  if (!row) throw new CustomEntityError('自定义实体不存在', 404);
  return row;
}

/**
 * 引用这个实体的已发布映射（有已发布版本、映射的实体是它；映射的实体建映射时定下），按「数据源」表名列出；
 * 再列出别的实体已发布的登记上指向它的关系（挂在它自己登记上的关系随它一起删，不算引用）。指标与标签还不能引用自定义实体
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
  const relations = [...(await publishedCustomEntities(db, tenantId)).values()]
    .flatMap(e => (e.name === name ? [] : (e.relations ?? []).filter(r => r.ref.entity === name)));
  return [...rows.map(r => `「${r.source}」${r.viewId ? '源视图 ' : ''}${r.table}`), ...relations.map(r => `关系 ${relationText(r)}`)];
}

/** 目标是这个实体、从没发布过的映射（如一键直通配套的映射草稿）：丢弃从没发布过的登记时一并丢弃 */
export async function unpublishedMappingsOf(tenantId: string, name: string, db: Tx | ReturnType<typeof getDb> = getDb()) {
  return db.select({ id: mappings.id, source: sources.name, table: mappings.tableName })
    .from(mappings).innerJoin(sources, eq(sources.id, mappings.sourceId))
    .where(and(
      eq(mappings.tenantId, tenantId), eq(mappings.entity, name),
      notExists(db.select({ id: mappingVersions.id }).from(mappingVersions)
        .where(and(eq(mappingVersions.mappingId, mappings.id), eq(mappingVersions.status, 'published')))),
    ))
    .orderBy(sources.name, mappings.tableName);
}

/** 列表里的一个自定义实体：最新一版的中文名与类型，最近的已发布版本号与草稿的版本号（没有时为 null），草稿是否为待确认的推断登记 */
export interface CustomEntitySummary {
  id: string; name: string; label: string; kind: CustomEntityKind; published: number | null; draft: number | null; inferred: boolean;
}

/** 本租户的自定义实体，按名称排序。先为已发布映射在用、但没登记的实体推断登记草稿 */
export async function listCustomEntities(actor: CurrentMember) {
  assertCan(actor, 'sources:read');
  await getDb().transaction(tx => inferCustomEntityDrafts(tx, actor.tenant.id));
  const versions = await getDb().select({
    id: customEntities.id, name: customEntities.name, version: customEntityVersions.version, status: customEntityVersions.status,
    label: customEntityVersions.label, kind: customEntityVersions.kind, lastEditor: customEntityVersions.lastEditor,
  })
    .from(customEntities).innerJoin(customEntityVersions, eq(customEntityVersions.entityId, customEntities.id))
    .where(eq(customEntities.tenantId, actor.tenant.id))
    .orderBy(customEntities.name, desc(customEntityVersions.version));
  const entities = new Map<string, CustomEntitySummary>();
  for (const v of versions) {
    const entity = entities.get(v.id) ?? { id: v.id, name: v.name, label: v.label, kind: v.kind, published: null, draft: null, inferred: false };
    if (v.status === 'draft') Object.assign(entity, { draft: v.version, inferred: isInferredDraft(v) });
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
    relations: customEntityVersions.relations, authors: customEntityVersions.authors, lastEditor: customEntityVersions.lastEditor,
    publishedByEmail: customEntityVersions.publishedByEmail, publishedAt: customEntityVersions.publishedAt, updatedAt: customEntityVersions.updatedAt,
  }).from(customEntityVersions).where(eq(customEntityVersions.entityId, entityId)).orderBy(desc(customEntityVersions.version));
  return {
    entity,
    versions: versions.map(v => ({ ...v, publishBlocker: isInferredDraft(v) ? UNCONFIRMED : publishBlocker(actor, v) })),
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
  const registration = checkRegistration(input, name);
  try {
    return await getDb().transaction(async tx => {
      await checkRelations(tx, actor.tenant.id, name, registration);
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
 * 保存草稿：登记与关系的终点校验通过、且发布过时只新增了字段与关系（checkAdditive）后，已有草稿时改它（记下又一位作者与最后保存的人），否则在最新版本之上新建一版草稿（已发布的版本不变）。
 * 名称不能改，input.name 被忽略。返回草稿的版本号
 */
export async function saveCustomEntityDraft(actor: CurrentMember, entityId: string, input: CustomEntityInput) {
  assertCan(actor, 'sources:write');
  const entity = await requireEntity(actor.tenant.id, entityId);
  const registration = checkRegistration(input, entity.name);
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
    await checkRelations(tx, actor.tenant.id, entity.name, registration);
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

/**
 * 发布草稿：需要发布权限，且发布者不能是最后保存这一版草稿的人（双人发布）。只由成员在页面上调用，没有自动发布。发布后版本锁定。
 * 关系在发布时再校验一次（publishEntityDraft），因为终点可能在保存后被删，别的实体发布的关系也可能与它成环
 */
export async function publishCustomEntity(actor: CurrentMember, entityId: string, version: number) {
  assertCan(actor, 'publish');
  const entity = await requireEntity(actor.tenant.id, entityId);
  const [draft] = await getDb().select(getTableColumns(customEntityVersions)).from(customEntityVersions)
    .where(and(eq(customEntityVersions.entityId, entityId), eq(customEntityVersions.version, version)));
  if (!draft) throw new CustomEntityError(`没有第 ${version} 版`, 404);
  if (isInferredDraft(draft)) throw new CustomEntityError(UNCONFIRMED);
  const blocker = publishBlocker(actor, draft);
  if (blocker) throw new CustomEntityError(blocker, draft.status === 'draft' ? 403 : 400);
  await getDb().transaction(async tx => {
    // 锁住实体行：与保存草稿、丢弃互斥，发布的正是检查过的那份草稿
    await tx.select({ id: customEntities.id }).from(customEntities).where(eq(customEntities.id, entityId)).for('update');
    await publishEntityDraft(tx, actor, entity, draft);
  });
}

/**
 * 在调用方的事务里再校验关系，发布检查过的这份草稿并记审计；调用方须已锁住实体行。等锁期间草稿被修改、发布或丢弃，或关系不再合格时抛出 CustomEntityError。
 * 发布权限与双人发布由调用方检查（publishCustomEntity，以及一键直通里登记与映射一起发布）
 */
export async function publishEntityDraft(
  tx: Tx, actor: CurrentMember, entity: { id: string; name: string }, draft: typeof customEntityVersions.$inferSelect,
) {
  const [current] = await tx.select().from(customEntityVersions).where(eq(customEntityVersions.id, draft.id));
  if (isStale(current, draft)) throw new CustomEntityError('草稿在你发布前被修改、发布或丢弃，请刷新后重新检查');
  await checkRelations(tx, actor.tenant.id, entity.name, current);
  await tx.update(customEntityVersions)
    .set({ status: 'published', publishedByEmail: actor.email, publishedAt: sql`now()` })
    .where(eq(customEntityVersions.id, draft.id));
  await recordAudit(tx, {
    tenantId: actor.tenant.id,
    actor,
    action: 'custom_entity.published',
    targetType: 'custom_entity',
    targetId: entity.id,
    detail: { name: entity.name, version: draft.version, authors: draft.authors, lastEditor: draft.lastEditor },
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
    // 从没发布过时删除实体，各版本随之级联删除；目标是它、从没发布过的映射一并丢弃，免得留下指向不存在实体的映射
    if (published) await tx.delete(customEntityVersions).where(eq(customEntityVersions.id, draft.id));
    else {
      await tx.delete(customEntities).where(eq(customEntities.id, entityId));
      const orphans = await unpublishedMappingsOf(actor.tenant.id, entity.name, tx);
      if (orphans.length) {
        // 实体行之后锁映射行，与一起发布的加锁顺序一致；锁住后再确认仍没有已发布版本
        await tx.select({ id: mappings.id }).from(mappings).where(inArray(mappings.id, orphans.map(m => m.id))).for('update');
        for (const m of await unpublishedMappingsOf(actor.tenant.id, entity.name, tx)) {
          const [{ version }] = await tx.select({ version: mappingVersions.version }).from(mappingVersions)
            .where(eq(mappingVersions.mappingId, m.id)).orderBy(desc(mappingVersions.version)).limit(1);
          await tx.delete(mappings).where(eq(mappings.id, m.id));
          await recordAudit(tx, {
            tenantId: actor.tenant.id, actor, action: 'mapping.draft_discarded', targetType: 'mapping', targetId: m.id,
            detail: { source: m.source, table: m.table, entity: entity.name, version, published: null },
          });
        }
      }
    }
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
 * 删除自定义实体（硬删除，各版本随之级联删除）：需要发布权限；被已发布的映射或别的实体已发布的关系引用时拒绝并列出它们。
 * 引用检查与删除在同一事务里，并锁住实体行（发布映射目前不锁实体行，要等映射发布对照登记校验时才完全互斥）
 */
export async function deleteCustomEntity(actor: CurrentMember, entityId: string) {
  assertCan(actor, 'publish');
  const entity = await requireEntity(actor.tenant.id, entityId);
  await getDb().transaction(async tx => {
    const [locked] = await tx.select({ id: customEntities.id }).from(customEntities).where(eq(customEntities.id, entityId)).for('update');
    if (!locked) throw new CustomEntityError('自定义实体已被删除', 404);
    const referrers = await publishedReferrers(tx, actor.tenant.id, entity.name);
    if (referrers.length) throw new CustomEntityError(`${entity.name} 被已发布的映射或关系引用，不能删除：${referrers.join('、')}`);
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

/** 推断登记草稿的作者与最后保存的人：平台本身，不是哪位成员 */
export const INFERRED_BY = 'platform';

/** 这一版是平台推断、还没有成员确认（保存）过的登记草稿 */
export const isInferredDraft = (v: { status: string; lastEditor: string }) => v.status === 'draft' && v.lastEditor === INFERRED_BY;

export const UNCONFIRMED = '推断出的登记要先由一位成员确认（保存）后，再由另一位成员发布';

/**
 * 为已发布映射在用、但没有登记的自定义实体推断一份登记草稿（ADR-0019「已有自定义实体怎么迁」），幂等：已有登记（含只有草稿）的实体不动。
 * 字段取各映射扩展字段的并集，类型与敏感标记照映射（映射发布时已保证同名字段类型一致；敏感只要有一份为真就是真）；
 * 主键取去重键，各映射不一致时取映射 ID 排第一的那份，并在主键第一个字段的说明里列出分歧。推断不出合格登记的实体跳过。不记审计
 */
export async function inferCustomEntityDrafts(tx: Tx, tenantId: string) {
  const registeredNames = new Set((await tx.select({ name: customEntities.name }).from(customEntities)
    .where(eq(customEntities.tenantId, tenantId))).map(r => r.name));
  // publishedPlans 按映射 ID 排序
  const byEntity = new Map<string, Awaited<ReturnType<typeof publishedPlans>>>();
  for (const plan of await publishedPlans(tx, tenantId)) {
    if (isCustomEntity(plan.entity) && !registeredNames.has(plan.entity)) byEntity.set(plan.entity, [...byEntity.get(plan.entity) ?? [], plan]);
  }
  for (const [name, plans] of byEntity) {
    const fields = new Map<string, CustomEntityField>();
    for (const c of plans.flatMap(p => p.columns)) {
      const field = fields.get(c.name);
      if (field) field.sensitive ||= !!c.sensitive;
      else fields.set(c.name, { name: c.name, type: c.type, description: '', sensitive: !!c.sensitive });
    }
    const primaryKey = plans[0].key;
    const keys = [...new Set(plans.map(p => p.key.join(', ')))];
    const keyField = fields.get(primaryKey[0]);
    if (keys.length > 1 && keyField) {
      keyField.description = `各映射的去重键不一致：${plans.map(p => `${p.table}（${p.key.join(', ')}）`).join('；')}。推断取了第一份，请确认主键`;
    }
    let checked;
    try {
      checked = checkRegistration({ label: name.replace(/^custom_/, ''), kind: 'dimension', fields: [...fields.values()], primaryKey }, name);
    } catch (e) {
      if (e instanceof CustomEntityError) continue;
      throw e;
    }
    const [entity] = await tx.insert(customEntities).values({ tenantId, name }).onConflictDoNothing().returning({ id: customEntities.id });
    if (!entity) continue;
    await tx.insert(customEntityVersions).values({ entityId: entity.id, version: 1, ...checked, authors: [INFERRED_BY], lastEditor: INFERRED_BY });
  }
}

/** 本租户每个自定义实体最新的已发布登记，按名称索引（映射校验与合并用）；从没发布过的实体不在其中 */
export async function publishedCustomEntities(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<Map<string, RegisteredEntity>> {
  const rows = await db
    .selectDistinctOn([customEntityVersions.entityId], {
      name: customEntities.name, label: customEntityVersions.label, kind: customEntityVersions.kind,
      fields: customEntityVersions.fields, primaryKey: customEntityVersions.primaryKey, relations: customEntityVersions.relations,
    })
    .from(customEntityVersions)
    .innerJoin(customEntities, eq(customEntities.id, customEntityVersions.entityId))
    .where(and(eq(customEntities.tenantId, tenantId), eq(customEntityVersions.status, 'published')))
    .orderBy(customEntityVersions.entityId, desc(customEntityVersions.version));
  return new Map(rows.map(r => [r.name, r]));
}

/** 本租户已发布的自定义实体登记，按名称索引成普通对象（loader 传给映射页的对照面板） */
export async function customEntityRegistrations(actor: CurrentMember): Promise<Record<string, RegisteredEntity>> {
  assertCan(actor, 'sources:read');
  return Object.fromEntries(await publishedCustomEntities(getDb(), actor.tenant.id));
}

/** 映射页上一个自定义实体的去处：实体页（推断不出合格登记、也没人登记过时是实体列表）、中文名（取最新的已发布版本，没发布过时取最新一版，
 * 都没有时是实体名），以及是否待补登（还没有已发布的登记：只有草稿的也算，映射校验不把草稿当作登记） */
export interface CustomEntityPage { href: string; label: string; pending: boolean }

/** 这些实体里的自定义实体按名称索引到它们的 CustomEntityPage。先推断登记草稿，让已发布映射在用的实体有实体页可去 */
export async function customEntityPages(actor: CurrentMember, entities: string[]): Promise<Record<string, CustomEntityPage>> {
  assertCan(actor, 'sources:read');
  const custom = [...new Set(entities.filter(isCustomEntity))];
  if (!custom.length) return {};
  return getDb().transaction(async tx => {
    await inferCustomEntityDrafts(tx, actor.tenant.id);
    const published = await publishedCustomEntities(tx, actor.tenant.id);
    const latest = new Map((await tx
      .selectDistinctOn([customEntityVersions.entityId], { id: customEntities.id, name: customEntities.name, label: customEntityVersions.label })
      .from(customEntityVersions)
      .innerJoin(customEntities, eq(customEntities.id, customEntityVersions.entityId))
      .where(and(eq(customEntities.tenantId, actor.tenant.id), inArray(customEntities.name, custom)))
      .orderBy(customEntityVersions.entityId, desc(customEntityVersions.version))).map(r => [r.name, r]));
    return Object.fromEntries(custom.map(name => {
      const entity = latest.get(name);
      return [name, {
        href: entity ? `/entities/${entity.id}` : '/entities',
        label: published.get(name)?.label ?? entity?.label ?? name,
        pending: !published.has(name),
      }];
    }));
  });
}
