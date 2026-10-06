// app/.server/passthrough.ts —— 一键直通（ADR-0019）：成员选一个数据源和一张已采集的源表，平台一次生成两份草稿：
// 自定义实体的登记（名称默认 custom_<表名>，成员可以另填，如别的数据源已有同名表时）（每个源列一个字段，类型与敏感标记取自源列，像敏感信息的列按 ADR-0016 标为敏感；主键取源表主键，没有时取声明的业务主键）
// 与覆盖全部列、以主键去重的恒等映射。两份草稿的作者都是点按钮的成员，之后照常由另一位成员发布。
// 先整体预检，有一项不过就两份都不写；登记与映射各自一个事务，映射仍然写不进时删掉刚建的登记（记审计）。
// 同名实体的预检不加锁：并发生成同一张表时由 custom_entities 的租户内名称唯一约束兜底，后到的那次照常报「已有名为…」；撞名时建议 custom_<数据源名>_<表名>
// 第二步在实体详情页：从没发布过的登记草稿与配套的映射草稿由另一位成员一次双人发布（一个事务里先发布登记再发布映射，入队合并），任一份不满足发布条件时都不发布
import { and, asc, eq, getTableColumns, gt, notExists } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { assertCan } from './access';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import {
  checkRegistration, createCustomEntity, CustomEntityError, type CustomEntityInput, ENTITY_NAME, isInferredDraft, publishedCustomEntities,
  publishEntityDraft, type RegisteredEntity, requireEntity, UNCONFIRMED,
} from './custom-entities';
import { getDb } from './db/client';
import { customEntities, customEntityVersions, mappings, mappingVersions, sources, tenants } from './db/schema';
import { checkMappingDraft, createMapping, MappingError, profiledTables, publishMappingDraft, requireMapping } from './mappings';
import { draftCustomMapping, DraftError, fieldNameFor } from './pipeline/mapping-draft';
import type { TableProfile } from './pipeline/source-engine';
import { publishBlocker } from './publish-rules';
import { requireSource } from './source-config';
import { extensionSpec } from '../lib/mapping-expr';

/**
 * 源表对应的登记（带名称）：名称是 entityName，留空时取 custom_<表名>；每个源列一个字段（列名规范化成字段名），主键是 primaryKey（源列名）对应的字段。
 * 名称不合规则（留空时是表名做不成实体名）、有列名规范化后不合字段名规则或重名时抛出 CustomEntityError
 */
export function passthroughRegistration(table: TableProfile, primaryKey: string[], entityName = ''): CustomEntityInput & { name: string } {
  const name = entityName || `custom_${fieldNameFor(table.name) ?? ''}`;
  if (!ENTITY_NAME.test(name)) {
    throw new CustomEntityError(entityName
      ? '实体名要以 custom_ 开头，之后只含小写字母、数字和下划线（如 custom_store）'
      : `表名 ${table.name} 做不成实体名（custom_ 之后只含小写字母、数字和下划线，以字母开头）：请填实体名`);
  }
  const columnToField = new Map<string, string>();
  const fieldToColumn = new Map<string, string>();
  for (const col of table.columns) {
    const field = fieldNameFor(col.name);
    if (!field) throw new CustomEntityError(`列 ${col.name} 做不成字段名（只能用小写字母、数字与下划线，以字母开头）`);
    const taken = fieldToColumn.get(field);
    if (taken) throw new CustomEntityError(`列 ${taken} 与 ${col.name} 都会成为字段 ${field}`);
    fieldToColumn.set(field, col.name);
    columnToField.set(col.name, field);
  }
  return {
    name,
    label: table.name,
    kind: 'dimension',
    fields: table.columns.map(col => {
      const { type, sensitive } = extensionSpec(col);
      return { name: columnToField.get(col.name)!, type, description: '', sensitive: sensitive ?? false };
    }),
    primaryKey: primaryKey.map(k => columnToField.get(k) ?? k),
  };
}

/** 从源表一键生成登记草稿与恒等映射草稿（实体名 entityName 留空时取 custom_<表名>），返回两者的 ID。不合格时抛出 CustomEntityError，两份草稿都不写 */
export async function createPassthrough(
  actor: CurrentMember, sourceId: string, tableName: string, entityName = '',
): Promise<{ entityId: string; mappingId: string }> {
  assertCan(actor, 'sources:write');
  const tenantId = actor.tenant.id;
  const source = await requireSource(tenantId, sourceId).catch(() => { throw new CustomEntityError('请选择数据源'); });
  if (!tableName) throw new CustomEntityError('请选择表');
  const profiled = (await profiledTables(tenantId, sourceId))(tableName);
  if (typeof profiled === 'string') throw new CustomEntityError(profiled);
  const { table, key } = profiled;
  const primaryKey = table.primaryKey?.length ? table.primaryKey : (key ?? []);
  if (!primaryKey.length) throw new CustomEntityError(`表 ${table.name} 没有主键，也没有声明业务主键：请先在数据源页声明业务主键`);

  // 预检：登记、同名实体、映射，一项不过就都不写
  const input = passthroughRegistration(table, primaryKey, entityName);
  const entity: RegisteredEntity = { name: input.name, ...checkRegistration(input) };
  const [existing] = await getDb().select({ id: customEntities.id }).from(customEntities)
    .where(and(eq(customEntities.tenantId, tenantId), eq(customEntities.name, input.name)));
  if (existing) {
    // 多半是别的数据源有同名表：建议带上数据源名
    const suggested = `custom_${fieldNameFor(source.name) ?? ''}_${fieldNameFor(table.name) ?? ''}`;
    const hint = ENTITY_NAME.test(suggested) && suggested !== input.name ? `，如 ${suggested}` : '';
    throw new CustomEntityError(`已有名为 ${input.name} 的自定义实体：请换一个实体名${hint}`);
  }
  let yaml: string;
  try {
    yaml = draftCustomMapping(table, entity);
  } catch (e) {
    throw e instanceof DraftError ? new CustomEntityError(e.message) : e;
  }
  // 对照已发布登记加上这份新登记：新登记还只是草稿，平常的映射校验不认它
  const registrations = new Map(await publishedCustomEntities(getDb(), tenantId)).set(entity.name, entity);
  await checkMappingDraft(tenantId, sourceId, yaml, registrations).catch(rethrow);

  const entityId = await createCustomEntity(actor, input);
  try {
    const mapping = await createMapping(actor, sourceId, yaml, { registrations });
    return { entityId, mappingId: mapping.id };
  } catch (e) {
    // 预检之后（如并发）映射仍然写不进：删掉刚建的登记，两份都不留
    await getDb().transaction(async tx => {
      await tx.delete(customEntities).where(eq(customEntities.id, entityId));
      await recordAudit(tx, {
        tenantId, actor, action: 'custom_entity.deleted', targetType: 'custom_entity', targetId: entityId, detail: { name: entity.name },
      });
    });
    return rethrow(e);
  }
}

/**
 * 实体的配套映射：目标是这个实体、只有一版草稿（从没发布过）的映射，有多个时取最早建的；没有时为 null。
 * lastEditor 是最后保存这版映射草稿的人，用来判断当前成员能不能一起发布
 */
export async function passthroughPair(tenantId: string, entityName: string) {
  const later = alias(mappingVersions, 'later');
  const [pair] = await getDb().select({
    mappingId: mappings.id, version: mappingVersions.version, sourceName: sources.name, table: mappings.tableName, lastEditor: mappingVersions.lastEditor,
  })
    .from(mappings).innerJoin(sources, eq(sources.id, mappings.sourceId))
    .innerJoin(mappingVersions, and(eq(mappingVersions.mappingId, mappings.id), eq(mappingVersions.version, 1), eq(mappingVersions.status, 'draft')))
    .where(and(
      eq(mappings.tenantId, tenantId), eq(mappings.entity, entityName),
      notExists(getDb().select({ id: later.id }).from(later).where(and(eq(later.mappingId, mappings.id), gt(later.version, 1)))),
    ))
    .orderBy(asc(mappings.createdAt)).limit(1);
  return pair ?? null;
}

/**
 * 登记与配套映射一起发布：需要发布权限，两份草稿都要满足发布条件（双人发布、都是从没发布过的第一版），否则都不发布。
 * 映射对照这份登记草稿预检；一个事务里先发布登记、再发布映射（映射的校验在事务里才看得到刚发布的登记）并入队合并。
 * 等锁期间任一份草稿被改或被丢弃时整个事务回滚，报「请刷新后重新检查」
 */
export async function publishPassthrough(actor: CurrentMember, entityId: string, entityVersion: number, mappingId: string, mappingVersion: number) {
  assertCan(actor, 'publish');
  const tenantId = actor.tenant.id;
  const entity = await requireEntity(tenantId, entityId);
  const mapping = await requireMapping(tenantId, mappingId).catch(rethrow);
  if (mapping.entity !== entity.name) throw new CustomEntityError(`映射的目标是 ${mapping.entity}，不是 ${entity.name}`);
  const [entityDraft] = await getDb().select(getTableColumns(customEntityVersions)).from(customEntityVersions)
    .where(and(eq(customEntityVersions.entityId, entityId), eq(customEntityVersions.version, entityVersion)));
  if (!entityDraft) throw new CustomEntityError(`没有第 ${entityVersion} 版`, 404);
  const [mappingDraft] = await getDb().select().from(mappingVersions)
    .where(and(eq(mappingVersions.mappingId, mappingId), eq(mappingVersions.version, mappingVersion)));
  if (!mappingDraft) throw new CustomEntityError(`映射没有第 ${mappingVersion} 版`, 404);
  if (isInferredDraft(entityDraft)) throw new CustomEntityError(UNCONFIRMED);
  for (const draft of [entityDraft, mappingDraft]) {
    const blocker = publishBlocker(actor, draft);
    if (blocker) throw new CustomEntityError(blocker, draft.status === 'draft' ? 403 : 400);
  }
  if (entityVersion !== 1 || mappingVersion !== 1) throw new CustomEntityError('登记或映射发布过，请分开发布');

  // 对照已发布登记加上这份登记草稿预检映射；事务里的 stale 检查保证发布的正是这两份
  const draftRegistration: RegisteredEntity = {
    name: entity.name, label: entityDraft.label, kind: entityDraft.kind, fields: entityDraft.fields, primaryKey: entityDraft.primaryKey,
  };
  const registry = new Map(await publishedCustomEntities(getDb(), tenantId)).set(entity.name, draftRegistration);
  const { plan } = await checkMappingDraft(tenantId, mapping.sourceId, mappingDraft.yaml, registry).catch(rethrow);
  return getDb().transaction(async tx => {
    // 锁的顺序同单独发布：租户行（入队合并也锁它）、实体行、映射行（publishMappingDraft 里）
    await tx.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).for('update');
    await tx.select({ id: customEntities.id }).from(customEntities).where(eq(customEntities.id, entityId)).for('update');
    await publishEntityDraft(tx, actor, entity, entityDraft);
    return publishMappingDraft(tx, actor, mapping, mappingDraft, plan).catch(rethrow);
  });
}

/** 映射的问题转成实体页能回显的 CustomEntityError */
function rethrow(e: unknown): never {
  if (e instanceof MappingError) throw new CustomEntityError([e.message, ...e.issues.map(i => `${i.path}：${i.message}`)].join('；'), e.status);
  throw e;
}
