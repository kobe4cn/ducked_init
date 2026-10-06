// app/.server/passthrough.ts —— 一键直通（ADR-0019）：成员选一个数据源和一张已采集的源表，平台一次生成两份草稿：
// 自定义实体 custom_<表名> 的登记（每个源列一个字段，类型与敏感标记取自源列，像敏感信息的列按 ADR-0016 标为敏感；主键取源表主键，没有时取声明的业务主键）
// 与覆盖全部列、以主键去重的恒等映射。两份草稿的作者都是点按钮的成员，之后照常由另一位成员发布。
// 先整体预检，有一项不过就两份都不写；登记与映射各自一个事务，映射仍然写不进时删掉刚建的登记（记审计）。
// 同名实体的预检不加锁：并发生成同一张表时由 custom_entities 的租户内名称唯一约束兜底，后到的那次照常报「已有名为…」
import { and, eq } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import {
  checkRegistration, createCustomEntity, CustomEntityError, type CustomEntityInput, ENTITY_NAME, publishedCustomEntities, type RegisteredEntity,
} from './custom-entities';
import { getDb } from './db/client';
import { customEntities } from './db/schema';
import { checkMappingDraft, createMapping, MappingError, profiledTables } from './mappings';
import { draftCustomMapping, DraftError, fieldNameFor } from './pipeline/mapping-draft';
import type { TableProfile } from './pipeline/source-engine';
import { requireSource } from './source-config';
import { extensionSpec } from '../lib/mapping-expr';

/**
 * 源表对应的登记（带名称）：每个源列一个字段（列名规范化成字段名），主键是 primaryKey（源列名）对应的字段。
 * 表名做不成实体名、有列名规范化后不合字段名规则或重名时抛出 CustomEntityError
 */
export function passthroughRegistration(table: TableProfile, primaryKey: string[]): CustomEntityInput & { name: string } {
  const name = `custom_${fieldNameFor(table.name) ?? ''}`;
  if (!ENTITY_NAME.test(name)) throw new CustomEntityError(`表名 ${table.name} 做不成实体名（custom_ 之后只含小写字母、数字和下划线，以字母开头）`);
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

/** 从源表一键生成登记草稿与恒等映射草稿，返回两者的 ID。不合格时抛出 CustomEntityError，两份草稿都不写 */
export async function createPassthrough(actor: CurrentMember, sourceId: string, tableName: string): Promise<{ entityId: string; mappingId: string }> {
  assertCan(actor, 'sources:write');
  const tenantId = actor.tenant.id;
  await requireSource(tenantId, sourceId).catch(() => { throw new CustomEntityError('请选择数据源'); });
  if (!tableName) throw new CustomEntityError('请选择表');
  const profiled = (await profiledTables(tenantId, sourceId))(tableName);
  if (typeof profiled === 'string') throw new CustomEntityError(profiled);
  const { table, key } = profiled;
  const primaryKey = table.primaryKey?.length ? table.primaryKey : (key ?? []);
  if (!primaryKey.length) throw new CustomEntityError(`表 ${table.name} 没有主键，也没有声明业务主键：请先在数据源页声明业务主键`);

  // 预检：登记、同名实体、映射，一项不过就都不写
  const input = passthroughRegistration(table, primaryKey);
  const entity: RegisteredEntity = { name: input.name, ...checkRegistration(input) };
  const [existing] = await getDb().select({ id: customEntities.id }).from(customEntities)
    .where(and(eq(customEntities.tenantId, tenantId), eq(customEntities.name, input.name)));
  if (existing) throw new CustomEntityError(`已有名为 ${input.name} 的自定义实体，请在那个实体上修改`);
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

/** 映射的问题转成实体页能回显的 CustomEntityError */
function rethrow(e: unknown): never {
  if (e instanceof MappingError) throw new CustomEntityError([e.message, ...e.issues.map(i => `${i.path}：${i.message}`)].join('；'), e.status);
  throw e;
}
