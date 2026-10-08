// app/.server/relation-suggest.ts —— 实体页的关系推荐（ADR-0019）：按列名相似与取值包含推荐登记在本实体上的关系，成员在实体页一键采纳到登记草稿（adoptRelation），
// 不自动登记。候选有两种：本实体的字段 → 标准实体或别的已发布自定义实体的单列主键；标准实体的字段（含已发布映射用过的 x_ 字段）→ 本实体的单列主键。
// 取值包含：起点字段由已发布映射原样取自一列源列时，拿这列的常见取值（ADR-0016，带键空间时补上前缀，ADR-0024）到只读挂载的标准层里找终点主键，
// 全部找到的标「取值已核对」，有找不到的不推荐，核对不了的（没有常见取值、表不存在、查询出错）标「未核对取值」
import { desc, eq } from 'drizzle-orm';
import { assertCan } from './access';
import type { CurrentMember } from './auth';
import { allRelations, publishedCustomEntities, requireEntity } from './custom-entities';
import { getDb } from './db/client';
import { customEntityVersions } from './db/schema';
import { lakeReady, lakeRow, lakeSpecOf } from './lake';
import { publishedPlans } from './mappings';
import { openTenantLake } from './pipeline/lake-engine';
import { SILVER } from './pipeline/merge-engine';
import { confirmedTables } from './sources';
import {
  CANONICAL_ENTITIES, type EntityRelation, entityOf, EXTENSION_PATTERN, type FieldType, isCustomEntity, type RelationSuggestion, relationText,
} from '../lib/canonical-model';
import { parseExpression, referencedColumns } from '../lib/mapping-expr';

export interface SuggestInput {
  /** 本实体：推荐的关系都登记在它上面 */
  entity: string;
  /** 候选起点字段：本实体登记的字段，标准实体的字段与已发布映射用过的 x_ 字段 */
  origins: { entity: string; field: string; type: FieldType }[];
  /** 候选终点：主键只有一列的实体（含本实体）与主键的类型 */
  targets: { entity: string; key: string; type: FieldType }[];
  /** 已有的关系：标准模型内置的 ref、已发布登记与本实体草稿上的关系 */
  existing: EntityRelation[];
  /** 取值核对的结果，按关系的展示文字（relationText）：true 是全部找到，false 是有找不到的；没有的算没核对 */
  checks?: ReadonlyMap<string, boolean>;
}

/** 列名相似：起点字段名（x_ 字段去掉前缀）等于终点主键，或等于「终点实体名去掉 custom_ 前缀」_主键 */
const similar = (field: string, target: { entity: string; key: string }) => {
  const name = field.replace(/^x_/, '');
  return name === target.key || name === `${target.entity.replace(/^custom_/, '')}_${target.key}`;
};

/**
 * 推荐登记在本实体上的关系：本实体的字段指向别的实体，标准实体的字段指向本实体；列名相似、两端类型相同、还没登记过。
 * 取值核对出有找不到的不推荐。按候选起点的顺序
 */
export function suggestRelations({ entity, origins, targets, existing, checks }: SuggestInput): RelationSuggestion[] {
  const known = new Set(existing.map(relationText));
  return origins.flatMap(origin => targets
    .filter(t => (origin.entity === entity ? t.entity !== entity : t.entity === entity) && t.type === origin.type && similar(origin.field, t))
    .flatMap((t): RelationSuggestion[] => {
      const relation = { from: { entity: origin.entity, field: origin.field }, ref: { entity: t.entity, field: t.key } };
      const check = checks?.get(relationText(relation));
      if (known.has(relationText(relation)) || check === false) return [];
      return [{ relation, checked: check ? 'values' : 'name-only' }];
    }));
}

const EXTENSION_NAME = new RegExp(EXTENSION_PATTERN);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const CHECK_LIMITS = { memoryLimitMb: 256, threads: 1 };

/**
 * 实体页的「推荐关系」：本实体最新一版登记（有草稿时是草稿）上还没有的关系，按上面的规则推荐并核对取值。需要 sources:write
 */
export async function relationSuggestions(actor: CurrentMember, entityId: string): Promise<RelationSuggestion[]> {
  assertCan(actor, 'sources:write');
  const tenantId = actor.tenant.id;
  const { name } = await requireEntity(tenantId, entityId);
  const [latest] = await getDb().select().from(customEntityVersions)
    .where(eq(customEntityVersions.entityId, entityId)).orderBy(desc(customEntityVersions.version)).limit(1);
  if (!latest) return [];
  const published = await publishedCustomEntities(getDb(), tenantId);
  const plans = await publishedPlans(getDb(), tenantId);

  // 标准实体的 x_ 字段：已发布映射用过、各映射给的类型一致的（否则 checkRelations 会拦下）
  const extensions = new Map<string, Set<FieldType>>();
  for (const p of plans.filter(p => entityOf(p.entity))) {
    for (const c of p.entityColumns.filter(c => EXTENSION_NAME.test(c.name))) {
      const key = `${p.entity}.${c.name}`;
      extensions.set(key, (extensions.get(key) ?? new Set()).add(c.type));
    }
  }
  const origins = [
    ...latest.fields.map(f => ({ entity: name, field: f.name, type: f.type })),
    ...CANONICAL_ENTITIES.flatMap(e => e.fields.map(f => ({ entity: e.name, field: f.name, type: f.type }))),
    ...[...extensions].flatMap(([key, types]) => {
      const [entity, field] = key.split('.');
      return types.size === 1 ? [{ entity, field, type: [...types][0] }] : [];
    }),
  ];
  const keyed = (entity: string, key: readonly string[], fields: readonly { name: string; type: FieldType }[]) =>
    (key.length === 1 ? [{ entity, key: key[0], type: fields.find(f => f.name === key[0])!.type }] : []);
  const targets = [
    ...CANONICAL_ENTITIES.flatMap(e => keyed(e.name, e.key, e.fields)),
    ...[...published.values()].filter(e => e.name !== name).flatMap(e => keyed(e.name, e.primaryKey, e.fields)),
    ...keyed(name, latest.primaryKey, latest.fields),
  ];
  const input: SuggestInput = { entity: name, origins, targets, existing: [...allRelations(published), ...latest.relations] };
  const candidates = suggestRelations(input);
  if (!candidates.length) return [];

  // 起点字段的常见取值：给它的已发布映射都原样取自一列源列（不是源视图、不敏感）、这列有常见取值时才有，带键空间时补上前缀；有一个映射核对不了就不核对
  const profiles = new Map<string, Awaited<ReturnType<typeof confirmedTables>>['tables']>();
  const tablesOf = async (sourceId: string) => {
    if (!profiles.has(sourceId)) profiles.set(sourceId, (await confirmedTables(tenantId, sourceId)).tables);
    return profiles.get(sourceId)!;
  };
  const valuesOf = async (r: EntityRelation) => {
    const values = new Set<string>();
    for (const p of plans.filter(p => p.entity === r.from.entity)) {
      const c = p.columns.find(c => c.name === r.from.field);
      if (!c) continue;
      const column = p.sourceView || c.sensitive ? undefined : sourceColumnOf(c.expr);
      if (!column) return [];
      const table = (await tablesOf(p.sourceId)).find(t => t.table.name === p.table)?.table;
      const top = table?.columns.find(col => col.name === column)?.top;
      if (!top?.length) return [];
      for (const { value } of top) values.add(c.keySpace ? `${c.keySpace}:${value}` : value);
    }
    return [...values];
  };
  // 终点主键是敏感字段时标准层只存哈希，取值没法对照
  const sensitiveKey = (ref: EntityRelation['ref']) => (isCustomEntity(ref.entity)
    ? !!(ref.entity === name ? latest.fields : published.get(ref.entity)?.fields)?.find(f => f.name === ref.field)?.sensitive
    : !!entityOf(ref.entity)?.fields.find(f => f.name === ref.field)?.pii);
  const pending = (await Promise.all(candidates.map(async ({ relation }) => ({ relation, values: await valuesOf(relation) }))))
    .filter(c => c.values.length && !sensitiveKey(c.relation.ref));
  const checks = pending.length ? await lookupKeys(tenantId, pending) : new Map<string, boolean>();
  return suggestRelations({ ...input, checks });
}

/** 映射列的表达式原样是一列源列时，这列的名字 */
function sourceColumnOf(expr: string) {
  try {
    const parsed = parseExpression(expr);
    return parsed.kind === 'column' ? referencedColumns(parsed)[0].name : undefined;
  } catch {
    return undefined; // 已发布的表达式都能解析；万一不能就不核对
  }
}

/**
 * 在只读挂载的标准层里查终点主键，按关系给出起点的常见取值是否全部找到。数据湖没初始化、挂载失败或终点还没有标准层表时，
 * 相应的关系不在结果里（只按列名推荐）
 */
async function lookupKeys(tenantId: string, pending: { relation: EntityRelation; values: string[] }[]) {
  const checks = new Map<string, boolean>();
  const lake = await lakeRow(tenantId);
  if (!lake || !lakeReady(lake)) return checks;
  let session: Awaited<ReturnType<typeof openTenantLake>>;
  try {
    session = await openTenantLake(lakeSpecOf(lake), CHECK_LIMITS, undefined, { readOnly: true });
  } catch {
    return checks;
  }
  try {
    for (const { relation: r, values } of pending) {
      const key = ident(r.ref.field);
      try {
        const found = (await session.con.runAndReadAll(
          `SELECT DISTINCT CAST(${key} AS VARCHAR) AS v FROM ${SILVER}.${ident(r.ref.entity)} WHERE CAST(${key} AS VARCHAR) IN (${values.map(lit).join(', ')})`,
        )).getRowObjectsJson().map(row => String(row.v));
        checks.set(relationText(r), values.every(v => found.includes(v)));
      } catch { /* 终点还没合并出标准层表等：只按列名推荐 */ }
    }
  } finally {
    session.close();
  }
  return checks;
}
