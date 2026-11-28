// app/.server/catalog/index.ts —— 语义目录（ADR-0041）：按本租户的元数据（数据源、同步范围内的源表与已发布源视图、已发布映射、
// 自定义实体与合并组、已发布的指标与标签、已发布的模板及其快照、业务说明）与平台能力说明（capabilities.ts）确定性地生成条目，
// 给出总览、按稳定标识展开与关键词搜索，结果可渲染成 Markdown 与 JSON。
// 纯函数，不连库（加载见 load.ts）。敏感字段、哈希列与系统列不进目录（ADR-0005）；同步范围外的源表不收（ADR-0013）。
// 源表、实体与字段展开时带统计与截至时间（行数、空值率、日期 / 时间列的范围与 ADR-0016 的常见取值），统计不进总览。
// 定义条目只给键、说明、度量 / 取值、依赖与系统生成的口径文字（knowledge/derive.ts，读目录时现算），不给结果数据；模板条目给产出列与最近一次快照的表名、行数与时间。
// 字段带实体字段的业务说明，各映射血缘带映射字段的业务说明（当前内容，清空的不给），都参与搜索、不进总览。
// 实体、字段、指标、标签与各映射血缘可带业务知识（knowledge，见 knowledge/catalog.ts），同样参与搜索、不进总览；映射字段的知识挂在血缘项上，
// 没有 sources:read 时随血缘一起去掉。
// 另有一份分层总览（#854）：groupOverview 只给第一层分组（主题组、实体组各一行，数据源、关系、模板各一行汇总；放不下时去掉说明、把实体组
// 连续分桶为合并组），groupItems 按分组标识（group:…，分页在标识后加 @页）给出组内条目（第二层，超出分页不截断）；助手与 MCP 的目录工具用它，
// 起草用下面的 layeredContext()（#855：第一层分组 + 相关分组的组内列表）
import { parse } from 'yaml';
import { CANONICAL_ENTITIES, CUSTOM_ENTITY_KINDS, type CustomEntityField, type EntityRelation, type FieldType } from '../../lib/canonical-model';
import { noteKey } from '../../lib/business-note-key';
import { cmp, deriveLineage } from '../../lib/lineage';
import { entityFields } from '../../lib/lineage-fields';
import { ruleText } from '../../lib/merge-groups';
import { looksSensitive, SENSITIVE_NAME } from '../../lib/sensitive';
import type { RegisteredEntity } from '../custom-entities';
import type { PublishedMergeGroup } from '../merge-groups';
import { DSL_KINDS, type DslKind } from '../pipeline/dsl';
import type { MetricSpec } from '../pipeline/dsl/metric-spec';
import type { TagSpec } from '../pipeline/dsl/tag-spec';
import { TEMPLATES, type TemplateId } from '../pipeline/templates';
import { isSensitiveField, type PublishedPlan } from '../pipeline/mapping-spec';
import { SILVER_SYSTEM_COLUMNS } from '../pipeline/merge-engine';
import type { ColumnProfile } from '../pipeline/source-engine';
import { PLATFORM_COLUMNS } from '../pipeline/sync-engine';
import { claimPhrase, knowledgeKey, knowledgeMarkdown, knowledgeText, presentKnowledge, type Knowledge, type KnowledgeInput } from '../knowledge/catalog';
import { metricClaims, metricText, tagClaims, tagText, type SystemFacts } from '../knowledge/derive';
import { CAPABILITIES, TEMPLATE_OUTPUTS } from './capabilities';

/** 生成目录的元数据；各部分都可以不给 */
export interface CatalogInput {
  sources?: { id: string; name: string; kind: string }[];
  /** 同步范围内（源端仍在且可读）的源表与已发布的源视图；columns 是最近一次采集到的列（源视图是输出列） */
  tables?: { sourceId: string; name: string; view: boolean; columns: { name: string; type: string; formats?: { format: string }[] }[] }[];
  /** 已发布映射（publishedPlans，已去掉停用的） */
  plans?: PublishedPlan[];
  /** 已发布的自定义实体 */
  customEntities?: RegisteredEntity[];
  /** 已发布的合并组：members 是映射 ID，按优先级排 */
  mergeGroups?: (PublishedMergeGroup & { entity: string })[];
  /** 各源表最近一次成功采集的统计（基于样本，top 已按 ADR-0016 过滤）；profiledAt 是采集时间 */
  tableStats?: {
    sourceId: string; name: string; rows: number; sampleRows: number; profiledAt: string;
    columns: Pick<ColumnProfile, 'name' | 'type' | 'nullRate' | 'min' | 'max' | 'top'>[];
  }[];
  /** 各实体在标准层的行数（最近一次合并成功的各映射之和）与最近一次合并时间 */
  entityStats?: { entity: string; rows: number; at: string }[];
  /** 已发布的指标与标签：每个键最新的已发布版本的 YAML（发布时已校验过） */
  definitions?: { kind: DslKind; key: string; version: number; yaml: string; spaceId: string; snapshot?: TemplateSnapshot }[];
  /** 已发布的模板定义（最新的已发布版本的参数）与最近一次没过期的快照 */
  templates?: { template: TemplateId; version: number; params: Record<string, unknown>; snapshot: TemplateSnapshot | null; spaceId: string }[];
  /** 业务说明的当前内容（currentNotes）：键是 noteKey，空串是已清空 */
  notes?: ReadonlyMap<string, string>;
  /** 业务知识（loadKnowledge）：按 knowledgeKey 挂到条目或映射血缘上，挂不上的（目标已不在目录里）丢掉 */
  knowledge?: KnowledgeInput;
}

/** 模板最近一次没过期的快照：表名、行数与登记时间 */
export interface TemplateSnapshot { table: string; rows: number; at: string }

/** 一列在源端样本里的统计：时间范围只有日期 / 时间列有，常见取值只有低基数、不像敏感信息的文本列有 */
export interface ColumnStats { name: string; nullRate: number; range?: { min: string; max: string }; top?: { value: string; rows: number }[] }

/** 源表统计：rows 是表的行数，列统计基于 sampleRows 行样本；at 是采集时间 */
export interface TableStats { rows: number; sampleRows: number; at: string; columns: ColumnStats[] }

interface Base { id: string; name: string; description: string }

export interface SourceEntry extends Base { kind: 'source'; sourceKind: string; tables: string[] }

export interface TableEntry extends Base {
  kind: 'table'; source: string; table: string; view: boolean;
  /** 有已发布映射读它；entities 是它写入的实体 */
  mapped: boolean; entities: string[];
  /** 不含敏感列（像敏感信息的、被敏感字段引用的）与系统列 */
  columns: { name: string; type: string }[];
  /** 只有 columns 里的列；源视图与从没采集过的源表为 null */
  stats: TableStats | null;
}

export interface FieldSummary { name: string; label: string; type: FieldType; description: string }

export interface EntityEntry extends Base {
  kind: 'entity'; entity: string; custom: boolean; key: string[];
  fields: FieldSummary[];
  /** 映射到它的源表与源视图；unscoped 是其中已不在同步范围（目录里没有这一条）的 */
  tables: string[];
  unscoped: string[];
  relations: string[];
  /** 作用在它上面的已发布合并组：组员是源表或源视图 */
  mergeGroups: { rule: string; members: string[] }[];
  /** 从没合并成功过时为 null */
  stats: { rows: number; at: string } | null;
  /** 业务知识；没有时没有 */
  knowledge?: Knowledge;
}

/** 字段在一个映射里的来源 */
export interface FieldLineageItem {
  source: string; table: string; expr: string; sourceColumns: string[]; dictionary: boolean;
  /** 所映射源列的源端样本统计（标准层字段没有自己的统计）；源表没采集过、读源视图或列不进目录时没有 */
  sample: ColumnStats[];
  /** 映射字段的业务说明：这个数据源在这个字段上的特殊之处；没有或已清空时没有 */
  note?: string;
  /** 映射字段的业务说明需复核（依据的映射计划变了，ADR-0046）；不需复核或没有说明时没有 */
  noteNeedsReview?: true;
  /** 映射字段的业务知识；没有时没有 */
  knowledge?: Knowledge;
}

export interface FieldEntry extends Base {
  kind: 'field'; entity: string; field: string; type: FieldType; enum?: string[]; lineage: FieldLineageItem[];
  /** 实体字段的业务说明（本租户的口径）；没有或已清空时没有 */
  note?: string;
  /** 业务知识；没有时没有 */
  knowledge?: Knowledge;
}

export interface RelationEntry extends Base { kind: 'relation'; from: string; to: string }

/** 定义的依赖：引用的指标、用到的实体与字段（都是目录标识） */
export interface DefinitionDependencies { metrics: string[]; entities: string[]; fields: string[] }

export interface MetricEntry extends Base {
  kind: 'metric'; key: string; version: number; base: string;
  /** 定义所属空间，只作记录，不按它过滤（ADR-0048） */
  spaceId: string;
  /** 度量，如 sum(amount)、ratio(count / count) */
  measure: string;
  dimensions: string[];
  /** 时间窗口（DSL 原样，field 可以是 a.b -> c.d 的路径）；没有窗口时没有。歧义判定比较用（ambiguity.ts），不进检索文字 */
  window?: { field: string; days: number };
  /** 基础实体字段上的过滤（DSL 原样）；没有过滤时没有。歧义判定比较用（ambiguity.ts），不进检索文字 */
  filter?: MetricSpec['filter'];
  dependencies: DefinitionDependencies;
  /** 系统事实：从 DSL 确定性生成的口径文字（knowledge/derive.ts） */
  system: SystemFacts;
  /** 最新一张未过期的结果快照；没有时没有 */
  snapshot?: TemplateSnapshot;
  /** 业务知识；没有时没有 */
  knowledge?: Knowledge;
}

export interface TagEntry extends Base {
  kind: 'tag'; key: string; version: number;
  /** 定义所属空间，只作记录，不按它过滤（ADR-0048） */
  spaceId: string;
  /** 规则与 default 给出的取值，按出现顺序去重 */
  values: (string | number)[];
  dependencies: DefinitionDependencies;
  /** 系统事实：从 DSL 确定性生成的口径文字（knowledge/derive.ts） */
  system: SystemFacts;
  /** 最新一张未过期的结果快照；没有时没有 */
  snapshot?: TemplateSnapshot;
  /** 业务知识；没有时没有 */
  knowledge?: Knowledge;
}

export interface TemplateEntry extends Base {
  kind: 'template'; template: string; version: number; params: Record<string, unknown>; entities: string[];
  /** 定义所属空间，只作记录，不按它过滤（ADR-0048） */
  spaceId: string;
  columns: OutputColumn[];
  /** 还没有没过期的快照时为 null */
  snapshot: TemplateSnapshot | null;
}

/** 模板产出的一列 */
export interface OutputColumn { name: string; type: string; description: string }

export interface CapabilityItem { name: string; type?: string; description: string }

export interface CapabilityEntry extends Base {
  kind: 'capability';
  sections: { title: string; items: CapabilityItem[] }[];
  examples: { key: string; yaml: string; note: string }[];
}

export type CatalogEntry =
  | SourceEntry | TableEntry | EntityEntry | FieldEntry | RelationEntry | MetricEntry | TagEntry | TemplateEntry | CapabilityEntry;

/** 按标识排好序的全部条目；version 是当前目录版本号（tenantCatalog 读出，不进快照、不参与比较），还没有版本时为 null */
export interface Catalog { entries: CatalogEntry[]; version?: number | null }

/** 第一层分组与起草分层上下文的 token 上限（按 estimateTokens 估算 Markdown） */
export const OVERVIEW_TOKENS = 4000;
/** 分组展开（第二层）的 token 上限：超出按条目分页，不截断 */
export const GROUP_TOKENS = 4000;
/** 总览里的说明截到多少字 */
const SUMMARY_CHARS = 40;

/** 分层总览（第一层）的一项：实体组 / 主题组一行（名称、说明与数量），合并组一行（首尾实体名与总数），数据源、关系、模板各一行汇总 */
export interface GroupLine {
  id: string;
  name: string;
  /** 说明（截 40 字）；主题组、合并组与汇总行没有 */
  description: string;
  /** 组内指标 / 标签 / 字段数量，为 0 的不显示；实体组自身不算 */
  metrics: number;
  tags: number;
  fields: number;
  /** 合并组：桶里实体组数与首尾实体名 */
  merged?: { entities: number; first: string; last: string };
  /** 汇总行的正文（数据源 / 关系 / 模板），给了就不渲染名称、说明与数量 */
  summary?: string;
}

/** 分层总览（第一层）：只给分组，每组一行；大目录去掉说明、把实体组连续分桶，不截掉条目（条目经分组展开找） */
export interface GroupOverview { kind: 'groups'; groups: GroupLine[]; /** 目录版本号，还没有版本时为 null */ version: number | null }

/** 分组展开（第二层）：条目组每行一个条目，合并组给其中实体组的第一层行；超出 GROUP_TOKENS 分页 */
export interface GroupItems {
  kind: 'group';
  /** 组标识，不带页码 */
  id: string;
  page: number;
  /** 每项一行（以「- 」开头） */
  lines: string[];
  /** 本页里的条目 id（合并组没有），供调用方记进本轮检索上下文 */
  entries: string[];
  /** 还有下一页时给下一页的标识（组标识后加 @页码） */
  nextPage?: string;
}

const CJK = /[\u3000-\u303f\uff00-\uffef぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/u;
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+/gu;

/** 估算 token：中日韩字符（含全角标点，宁可多估）每字算 1，其余字符每 4 个算 1 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) CJK.test(ch) ? cjk++ : other++;
  return cjk + Math.ceil(other / 4);
}

const SYSTEM_COLUMNS = new Set<string>(['_hash', '_customer_source', ...Object.keys(SILVER_SYSTEM_COLUMNS), ...PLATFORM_COLUMNS]);

/** 哈希列与系统列：整行哈希、标准层系统列、原始层平台列与引用列旁的数据源列（_<字段>_source） */
export const isSystemColumn = (name: string) => SYSTEM_COLUMNS.has(name) || /^_.+_source$/.test(name);

const sourceId = (name: string) => `source:${name}`;
const tableId = (source: string, table: string) => `table:${source}/${table}`;
const entityId = (entity: string) => `entity:${entity}`;
const fieldId = (entity: string, field: string) => `field:${entity}.${field}`;
const relationId = (entity: string, field: string) => `relation:${entity}.${field}`;
const metricId = (key: string) => `metric:${key}`;
const tagId = (key: string) => `tag:${key}`;
const templateEntryId = (id: string) => `template:${id}`;

const byId = <T extends { id: string }>(a: T, b: T) => cmp(a.id, b.id);

/** 给时间范围的列类型（文本列的 min / max 可能是手机号等，不给） */
const isTimeType = (type: string) => /^(DATE|TIMESTAMP)/i.test(type);

const toColumnStats = (c: NonNullable<CatalogInput['tableStats']>[number]['columns'][number]): ColumnStats => ({
  name: c.name, nullRate: c.nullRate,
  // 像生日的日期列也不给时间范围（#1317）；上游 visibleColumns 已滤掉敏感列，这里再拦一次兜住旧的采集结果
  ...(isTimeType(c.type) && !SENSITIVE_NAME.test(c.name) && c.min !== null && c.max !== null && { range: { min: c.min, max: c.max } }),
  ...(c.top?.length && { top: c.top.map(t => ({ value: t.value, rows: t.rows })) }),
});

/** 按元数据生成目录 */
export function buildCatalog(input: CatalogInput): Catalog {
  const sourceList = [...(input.sources ?? [])].sort((a, b) => cmp(a.name, b.name));
  const plans = [...(input.plans ?? [])].sort((a, b) => cmp(a.mapping, b.mapping));
  const custom = [...(input.customEntities ?? [])].sort((a, b) => cmp(a.name, b.name));
  const sourceName = new Map(sourceList.map(s => [s.id, s.name]));
  const lineage = deriveLineage({ plans, sources: sourceList });

  // 敏感字段（ADR-0005）
  const registered = new Map(custom.map(e => [e.name, e.fields]));
  const sensitive = (entity: string, field: string) => isSensitiveField({ entity, field }, e => registered.get(e), plans);
  const hidden = (entity: string, field: string) => sensitive(entity, field) || isSystemColumn(field);

  const entries: CatalogEntry[] = [];
  // 目录里有的源表与源视图（同步范围内的、已发布的）
  const listed = new Set((input.tables ?? []).flatMap(t => (sourceName.has(t.sourceId) ? [tableId(sourceName.get(t.sourceId)!, t.name)] : [])));
  const planTable = (p: PublishedPlan) => tableId(sourceName.get(p.sourceId) ?? p.sourceId, p.table);

  // 源表与源视图能列出的列：被敏感字段引用的源列、像敏感信息的源列与系统列不列；统计只给这些列，只有源表有
  const visibleColumns = (t: NonNullable<CatalogInput['tables']>[number]) => {
    const secret = new Set(lineage.fields
      .filter(f => f.sourceId === t.sourceId && f.table === t.name && sensitive(f.entity, f.field))
      .flatMap(f => f.sourceColumns));
    return t.columns.filter(c => !isSystemColumn(c.name) && !looksSensitive(c) && !secret.has(c.name)).map(c => ({ name: c.name, type: c.type }));
  };
  const tableKey = (source: string, table: string) => `${source}\n${table}`;
  const profiled = new Map((input.tableStats ?? []).map(s => [tableKey(s.sourceId, s.name), s]));
  const statsByTable = new Map<string, TableStats>();
  for (const t of input.tables ?? []) {
    const s = profiled.get(tableKey(t.sourceId, t.name));
    if (t.view || !s) continue;
    const visible = new Set(visibleColumns(t).map(c => c.name));
    statsByTable.set(tableKey(t.sourceId, t.name), {
      rows: s.rows, sampleRows: s.sampleRows, at: s.profiledAt, columns: s.columns.filter(c => visible.has(c.name)).map(toColumnStats),
    });
  }
  const statsByEntity = new Map((input.entityStats ?? []).map(s => [s.entity, { rows: s.rows, at: s.at }]));

  // 实体与字段：标准实体与已发布的自定义实体；字段按登记顺序，映射里的扩展字段按名字排在后面
  const entities = [
    ...CANONICAL_ENTITIES.map(e => ({
      name: e.name, label: e.label, description: e.description, custom: false, key: [...e.key],
      declared: e.fields.map(f => ({ name: f.name, label: f.label, type: f.type, description: f.description, enum: f.enum && [...f.enum] })),
    })),
    ...custom.map(e => ({
      name: e.name, label: e.label, description: `自定义${CUSTOM_ENTITY_KINDS[e.kind]}实体`, custom: true, key: [...e.primaryKey],
      declared: e.fields.map((f: CustomEntityField) => ({ name: f.name, label: f.name, type: f.type, description: f.description, enum: undefined })),
    })),
  ];
  const relations: EntityRelation[] = [
    ...CANONICAL_ENTITIES.flatMap(e => e.fields.flatMap(f => (f.ref ? [{ from: { entity: e.name, field: f.name }, ref: f.ref }] : []))),
    ...custom.flatMap(e => e.relations ?? []),
  ].filter(r => !hidden(r.from.entity, r.from.field) && !hidden(r.ref.entity, r.ref.field));
  const groups = new Map((input.mergeGroups ?? []).map(g => [g.entity, g]));
  // 业务说明的当前内容；空串（已清空）当作没有。敏感字段整个不进目录，说明也就不进
  const note = (entity: string, field: string, mapping: string | null = null) => input.notes?.get(noteKey(entity, field, mapping)) || undefined;
  // 业务知识：只挂在目录里有的条目与血缘上，目标不在了（映射停用、定义删除）就不出现
  const knowledgeOf = (targetId: string, mapping: string | null = null) => {
    const k = presentKnowledge(input.knowledge?.byTarget.get(knowledgeKey(targetId, mapping)));
    return k && { knowledge: k };
  };

  for (const e of entities) {
    const mapped = entityFields(lineage, e.name, e.declared, {});
    const extensions = mapped.filter(f => !e.declared.some(d => d.name === f.name)).map(f => {
      const column = plans.find(p => p.entity === e.name && p.columns.some(c => c.name === f.name))!.columns.find(c => c.name === f.name)!;
      return { name: f.name, label: f.name, type: column.type, description: '', enum: column.enum && [...column.enum] };
    });
    const fields = [...e.declared, ...extensions].filter(f => !hidden(e.name, f.name));
    for (const f of fields) {
      const origins = mapped.find(m => m.name === f.name)?.sources ?? [];
      const fieldNote = note(e.name, f.name);
      entries.push({
        kind: 'field', id: fieldId(e.name, f.name), name: f.label, description: f.description,
        entity: entityId(e.name), field: f.name, type: f.type, ...(f.enum && { enum: f.enum }), ...(fieldNote && { note: fieldNote }),
        ...knowledgeOf(fieldId(e.name, f.name)),
        lineage: origins.map(s => {
          const p = plans.find(x => x.mapping === s.mapping);
          const stats = p && !p.sourceView ? statsByTable.get(tableKey(p.sourceId, p.table)) : undefined;
          const mappingNote = note(e.name, f.name, s.mapping);
          return {
            source: s.sourceName, table: s.table, expr: s.expr, sourceColumns: s.sourceColumns, dictionary: s.dictionary,
            sample: s.sourceColumns.flatMap(name => stats?.columns.filter(c => c.name === name) ?? []),
            ...(mappingNote && { note: mappingNote }),
            ...(mappingNote && input.knowledge?.staleNotes?.has(noteKey(e.name, f.name, s.mapping)) && { noteNeedsReview: true as const }),
            ...knowledgeOf(fieldId(e.name, f.name), s.mapping),
          };
        }),
      });
    }
    const ofEntity = [...new Set(plans.filter(p => p.entity === e.name).map(planTable))].sort(cmp);
    const group = groups.get(e.name);
    const members = group?.members.flatMap(m => plans.filter(p => p.mapping === m && p.entity === e.name).map(planTable)) ?? [];
    entries.push({
      kind: 'entity', id: entityId(e.name), name: e.label, description: e.description, entity: e.name, custom: e.custom, key: e.key,
      fields: fields.map(f => ({ name: f.name, label: f.label, type: f.type, description: f.description })),
      tables: ofEntity, unscoped: ofEntity.filter(id => !listed.has(id)),
      relations: relations.filter(r => r.from.entity === e.name).map(r => relationId(r.from.entity, r.from.field)).sort(cmp),
      mergeGroups: group && members.length ? [{ rule: ruleText(group.rule), members: [...new Set(members)] }] : [],
      stats: statsByEntity.get(e.name) ?? null,
      ...knowledgeOf(entityId(e.name)),
    });
  }

  const known = new Set(entities.map(e => e.name));
  for (const r of relations) {
    if (!known.has(r.from.entity) || !known.has(r.ref.entity)) continue;
    const field = entities.find(e => e.name === r.from.entity)!.declared.find(f => f.name === r.from.field);
    entries.push({
      kind: 'relation', id: relationId(r.from.entity, r.from.field), name: `${r.from.entity}.${r.from.field} → ${r.ref.entity}.${r.ref.field}`,
      description: field?.description ?? '', from: fieldId(r.from.entity, r.from.field), to: fieldId(r.ref.entity, r.ref.field),
    });
  }

  // 源表与源视图：同名的源表与源视图只留源表
  const tables = new Map<string, TableEntry>();
  for (const t of [...(input.tables ?? [])].sort((a, b) => Number(a.view) - Number(b.view))) {
    const source = sourceName.get(t.sourceId);
    if (source === undefined || tables.has(tableId(source, t.name))) continue;
    const id = tableId(source, t.name);
    const reading = plans.filter(p => p.sourceId === t.sourceId && p.table === t.name && !!p.sourceView === t.view);
    const written = [...new Set(reading.map(p => p.entity))].sort(cmp);
    tables.set(id, {
      kind: 'table', id, name: t.name, source: sourceId(source), table: t.name, view: t.view,
      description: `${t.view ? '源视图' : '源表'}，${written.length ? `映射到 ${written.join('、')}` : '未映射'}`,
      mapped: reading.length > 0, entities: written.map(entityId),
      columns: visibleColumns(t),
      stats: statsByTable.get(tableKey(t.sourceId, t.name)) ?? null,
    });
  }
  entries.push(...tables.values());

  for (const s of sourceList) {
    const own = [...tables.values()].filter(t => t.source === sourceId(s.name));
    const unmapped = own.filter(t => !t.mapped).length;
    entries.push({
      kind: 'source', id: sourceId(s.name), name: s.name, sourceKind: s.kind,
      description: `${s.kind} 数据源，${own.length} 张表${unmapped ? `（${unmapped} 张未映射）` : ''}`,
      tables: own.map(t => t.id).sort(cmp),
    });
  }

  // 已发布的指标与标签：YAML 发布时已校验过，可选的部分（说明、维度）没写时按缺省取
  const dependencyIds = (d: ReturnType<(typeof DSL_KINDS)[DslKind]['dependencies']>): DefinitionDependencies => ({
    metrics: d.metrics.map(metricId),
    entities: d.entities.map(entityId),
    fields: d.fields.filter(f => !hidden(f.entity, f.field)).map(f => fieldId(f.entity, f.field)),
  });
  const descriptionOf = (spec: { description?: unknown } | null) => (typeof spec?.description === 'string' ? spec.description : '');
  // 标签的派生声明要看被引用指标的 spec：先把本批全部指标解析出来（循环里不保证指标排在标签前）
  const metricSpecs = new Map((input.definitions ?? []).filter(d => d.kind === 'metric').map(d => [d.key, parse(d.yaml) as MetricSpec]));
  for (const d of input.definitions ?? []) {
    if (d.kind === 'metric') {
      const spec = parse(d.yaml) as MetricSpec;
      entries.push({
        kind: 'metric', id: metricId(d.key), name: d.key, description: descriptionOf(spec), key: d.key, version: d.version, spaceId: d.spaceId,
        base: entityId(spec.base), measure: measureText(spec.measure), dimensions: (spec.dimensions ?? []).map(x => x.name),
        ...(spec.window && { window: { field: spec.window.field, days: spec.window.days } }), ...(spec.filter?.length && { filter: spec.filter }),
        dependencies: dependencyIds(DSL_KINDS.metric.dependencies(spec)), system: { text: metricText(spec), claims: metricClaims(spec) }, ...(d.snapshot && { snapshot: d.snapshot }), ...knowledgeOf(metricId(d.key)),
      });
    } else {
      const spec = parse(d.yaml) as TagSpec;
      const values = [...(Array.isArray(spec.rules) ? spec.rules.map(r => r?.value) : []), spec.default].filter(v => typeof v === 'string' || typeof v === 'number');
      entries.push({
        kind: 'tag', id: tagId(d.key), name: d.key, description: descriptionOf(spec), key: d.key, version: d.version, spaceId: d.spaceId,
        values: [...new Set(values)], dependencies: dependencyIds(DSL_KINDS.tag.dependencies(spec)), system: { text: tagText(spec), claims: tagClaims(spec, metricSpecs) },
        ...(d.snapshot && { snapshot: d.snapshot }), ...knowledgeOf(tagId(d.key)),
      });
    }
  }

  for (const t of input.templates ?? []) {
    if (!Object.hasOwn(TEMPLATES, t.template)) continue;
    entries.push({
      kind: 'template', id: templateEntryId(t.template), name: TEMPLATES[t.template].label, description: TEMPLATE_OUTPUTS[t.template].description,
      template: t.template, version: t.version, spaceId: t.spaceId, params: t.params, entities: TEMPLATES[t.template].entities.map(entityId),
      columns: TEMPLATE_OUTPUTS[t.template].columns, snapshot: t.snapshot,
    });
  }

  entries.push(...CAPABILITIES);
  return { entries: entries.sort(byId) };
}

/** 度量的简写：agg(field)，ratio 写成 ratio(分子 / 分母)，latest / earliest 带 by */
function measureText(m: MetricSpec['measure'] | undefined): string {
  if (!m) return '';
  const part = (p: { agg: string; field?: string } | undefined) => (p ? `${p.agg}${p.field ? `(${p.field})` : ''}` : '?');
  if (m.agg === 'ratio') return `ratio(${part(m.numerator)} / ${part(m.denominator)})`;
  return `${m.agg}(${[m.field, ...(m.by ? [`by ${m.by}`] : [])].filter(Boolean).join(', ')})`;
}

const truncate = (text: string, chars = SUMMARY_CHARS) => {
  const all = [...text];
  return all.length > chars ? `${all.slice(0, chars).join('')}…` : text;
};

/** 按标识展开一个条目；标识不存在时为 null */
export const expand = (c: Catalog, id: string): CatalogEntry | null => c.entries.find(e => e.id === id) ?? null;

/** 归组：字段归它的实体组，指标按 base，标签按依赖里按标识排序的第一个实体（没有时第一个指标的 base）；指标、标签、字段另按
 * knowledge.subjects 进主题组；能力条目不进任何组；归不进实体组的兜底进 group:other，保证每个条目都能经分组找到 */
interface Groups {
  /** 实体组：键是实体条目标识（entity:order），组里含实体条目自身 */
  entity: Map<string, CatalogEntry[]>;
  /** 主题组：键是主题名；只有挂了条目的主题才出现 */
  subject: Map<string, CatalogEntry[]>;
  /** 推不出实体组的条目 */
  other: CatalogEntry[];
  /** 数据源与源表（含源视图） */
  sources: CatalogEntry[];
  relations: CatalogEntry[];
  templates: CatalogEntry[];
}

function groupsOf(c: Catalog): Groups {
  const g: Groups = { entity: new Map(), subject: new Map(), other: [], sources: [], relations: [], templates: [] };
  const entryById = new Map(c.entries.map(e => [e.id, e]));
  for (const e of c.entries) {
    let group: CatalogEntry[] | undefined;
    switch (e.kind) {
      case 'entity':
        g.entity.set(e.id, [e]);
        break;
      case 'field':
      case 'metric':
        group = g.entity.get(e.kind === 'field' ? e.entity : e.base);
        break;
      case 'tag': {
        const firstEntity = [...e.dependencies.entities].sort(cmp)[0];
        group = firstEntity !== undefined ? g.entity.get(firstEntity) : undefined;
        if (!group) {
          const firstMetric = [...e.dependencies.metrics].sort(cmp)[0];
          const base = firstMetric !== undefined ? entryById.get(firstMetric) : undefined;
          if (base?.kind === 'metric') group = g.entity.get(base.base);
        }
        break;
      }
      case 'source':
      case 'table':
        g.sources.push(e);
        break;
      case 'relation':
        g.relations.push(e);
        break;
      case 'template':
        g.templates.push(e);
        break;
      case 'capability':
        break;
    }
    if (e.kind === 'field' || e.kind === 'metric' || e.kind === 'tag') {
      for (const s of e.knowledge?.subjects ?? []) {
        const list = g.subject.get(s);
        if (list) list.push(e);
        else g.subject.set(s, [e]);
      }
      (group ?? g.other).push(e);
    }
  }
  for (const list of [...g.entity.values(), ...g.subject.values()]) list.sort(byId);
  return g;
}

/** 第一层一行：`- group:entity:order 订单 — 说明 · 指标 12 · 标签 3 · 字段 40`；合并组带实体数，汇总行给 summary 正文 */
function groupLineMarkdown(l: GroupLine): string {
  if (l.summary !== undefined) return `- ${l.id} ${l.summary}`;
  const counts = ([['指标', l.metrics], ['标签', l.tags], ['字段', l.fields]] as const)
    .filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(' · ');
  const rest = [l.merged ? `共 ${l.merged.entities} 个实体` : '', counts].filter(Boolean).join(' · ');
  return `- ${l.id} ${l.name}${l.description ? ` — ${l.description}` : ''}${rest ? ` · ${rest}` : ''}`;
}

/** 实体组的第一层行（按实体标识排序；withDescription 为 false 时去掉说明） */
function entityGroupLines(g: Groups, withDescription: boolean): GroupLine[] {
  return [...g.entity.entries()].sort(([a], [b]) => cmp(a, b)).map(([, entries]) => {
    const entity = entries.find(e => e.kind === 'entity')!;
    const count = (kind: 'metric' | 'tag' | 'field') => entries.filter(e => e.kind === kind).length;
    return {
      id: `group:entity:${entity.entity}`, name: entity.name, description: withDescription ? truncate(entity.description) : '',
      metrics: count('metric'), tags: count('tag'), fields: count('field'),
    };
  });
}

/** 一个合并组的行：写首尾实体名与总计数（成员是桶里的实体组行） */
function bucketLine(bucket: GroupLine[], index: number): GroupLine {
  const first = bucket[0]!;
  const last = bucket.at(-1)!;
  const count = (k: 'metrics' | 'tags' | 'fields') => bucket.reduce((n, l) => n + l[k], 0);
  return {
    id: `group:entities@${index}`, name: `${first.name} ~ ${last.name}`, description: '',
    metrics: count('metrics'), tags: count('tags'), fields: count('fields'),
    merged: { entities: bucket.length, first: first.name, last: last.name },
  };
}

/** 第一层的全部内容：主题组行、要显示的实体组行（分桶后是合并组行）、分桶（成员是实体组行，展开合并组用）与汇总行。
 * 估算超过 OVERVIEW_TOKENS 时先去掉说明，还放不下时把实体组行按标识排序连续分桶：每桶的第一层行放得下 GROUP_TOKENS、桶数取最少；
 * 第一层还放不下时桶数减半到放得下为止（桶内超出由第二层分页兜住）。groupOverview 与 groupItems（解析 group:entities@k）共用，保证两边一致 */
function firstLevel(c: Catalog): { g: Groups; subjects: GroupLine[]; entityLines: GroupLine[]; buckets: GroupLine[][]; summaries: GroupLine[] } {
  const g = groupsOf(c);
  const subjects = [...g.subject.entries()].sort(([a], [b]) => cmp(`group:subject:${a}`, `group:subject:${b}`)).map(([name, list]) => {
    const count = (kind: 'metric' | 'tag' | 'field') => list.filter(e => e.kind === kind).length;
    return { id: `group:subject:${name}`, name, description: '', metrics: count('metric'), tags: count('tag'), fields: count('field') };
  });
  const summary = (id: string, name: string, text: string): GroupLine => ({ id, name, description: '', metrics: 0, tags: 0, fields: 0, summary: text });
  // restricted 目录里没有 source 条目时这行不出，也不泄露源表数
  const sourceCount = c.entries.filter(e => e.kind === 'source').length;
  const summaries = [
    ...(g.other.length ? [summary('group:other', '其他', `条目 ${g.other.length} 个`)] : []),
    ...(sourceCount ? [summary('group:sources', '数据源', `数据源 ${sourceCount} 个、源表 ${c.entries.filter(e => e.kind === 'table').length} 张`)] : []),
    ...(g.relations.length ? [summary('group:relationships', '关系', `关系 ${g.relations.length} 条`)] : []),
    ...(g.templates.length ? [summary('group:templates', '模板', `模板 ${g.templates.length} 个`)] : []),
  ];
  const of = (entityLines: GroupLine[]): GroupOverview => ({ kind: 'groups', groups: [...subjects, ...entityLines, ...summaries], version: c.version ?? null });
  const fits = (o: GroupOverview) => estimateTokens(toMarkdown(o)) <= OVERVIEW_TOKENS;

  const described = entityGroupLines(g, true);
  if (fits(of(described))) return { g, subjects, entityLines: described, buckets: [], summaries };
  const bare = entityGroupLines(g, false);
  if (fits(of(bare))) return { g, subjects, entityLines: bare, buckets: [], summaries };
  // 连续分桶：每桶的第一层行放得下 GROUP_TOKENS（至少一组一桶），桶数最少
  const buckets: GroupLine[][] = [];
  let current: GroupLine[] = [];
  let used = 0;
  for (const line of bare) {
    const t = estimateTokens(groupLineMarkdown(line));
    if (current.length && used + t > GROUP_TOKENS) {
      buckets.push(current);
      current = [];
      used = 0;
    }
    current.push(line);
    used += t;
  }
  if (current.length) buckets.push(current);
  let merged = buckets;
  while (merged.length > 1 && !fits(of(merged.map((b, i) => bucketLine(b, i + 1))))) {
    merged = merged.reduce<GroupLine[][]>((out, b, i) => {
      if (i % 2) out[out.length - 1] = [...out[out.length - 1]!, ...b];
      else out.push(b);
      return out;
    }, []);
  }
  return { g, subjects, entityLines: merged.map((b, i) => bucketLine(b, i + 1)), buckets: merged, summaries };
}

/**
 * 分层总览（第一层）：主题组、实体组各一行（名称、说明与指标 / 标签 / 字段数量），数据源、关系、模板各一行汇总；
 * 超过 OVERVIEW_TOKENS 时去掉说明、把实体组连续分桶（每桶一行，首尾实体名与总计数），不截掉条目（条目经分组展开找）
 */
export function groupOverview(c: Catalog): GroupOverview {
  const { subjects, entityLines, summaries } = firstLevel(c);
  return { kind: 'groups', groups: [...subjects, ...entityLines, ...summaries], version: c.version ?? null };
}

/**
 * 按分组标识展开第二层：group:entity:<实体名> / group:subject:<主题名> / group:sources / group:relationships / group:templates / group:other
 * 给组内条目（每行一个，带调用方传入的 semanticHash（可不给，如起草的上下文）；指标、标签、模板带 version），合并组 group:entities@<k> 给其中实体组的第一层行；
 * 标识后加 @<页> 翻页（超出 GROUP_TOKENS 分页，不截断）。没有这个分组或页码时为 null
 */
export function groupItems(c: Catalog, groupId: string, hash?: (e: CatalogEntry) => string): GroupItems | null {
  const { g, buckets } = firstLevel(c);
  type Resolved = { entries: CatalogEntry[] } | { bucket: GroupLine[] };
  const resolve = (id: string): Resolved | null => {
    if (id === 'group:sources') return g.sources.length ? { entries: g.sources } : null;
    if (id === 'group:relationships') return g.relations.length ? { entries: g.relations } : null;
    if (id === 'group:templates') return g.templates.length ? { entries: g.templates } : null;
    if (id === 'group:other') return g.other.length ? { entries: g.other } : null;
    if (id.startsWith('group:entity:')) {
      const entries = g.entity.get(`entity:${id.slice('group:entity:'.length)}`);
      return entries ? { entries } : null;
    }
    if (id.startsWith('group:subject:')) {
      const entries = g.subject.get(id.slice('group:subject:'.length));
      return entries ? { entries } : null;
    }
    const bucketNo = id.match(/^group:entities@(\d+)$/);
    if (bucketNo) return buckets[Number(bucketNo[1]) - 1] ? { bucket: buckets[Number(bucketNo[1]) - 1]! } : null;
    return null;
  };
  // 页码：标识后缀 @<页>（如 group:entity:order@2）；整个标识先按原样解析（group:entities@1 是桶 1，不是 group:entities 的第 1 页）
  const paged = groupId.match(/^(.*)@(\d+)$/);
  let resolved: Resolved | null = resolve(groupId);
  let id = groupId;
  let page = 1;
  if (!resolved && paged) {
    resolved = resolve(paged[1]!);
    id = paged[1]!;
    page = Number(paged[2]);
  }
  if (!resolved) return null;

  const versionOf = (e: CatalogEntry) => (e.kind === 'metric' || e.kind === 'tag' || e.kind === 'template') ? ` · version: ${e.version}` : '';
  const itemLine = (e: CatalogEntry) => `- ${e.id} ${e.name}${e.description ? ` — ${truncate(e.description)}` : ''}${hash ? ` · semanticHash: ${hash(e)}` : ''}${versionOf(e)}`;
  const all = 'entries' in resolved ? resolved.entries.map(itemLine) : resolved.bucket.map(groupLineMarkdown);
  const entryIds = 'entries' in resolved ? resolved.entries.map(e => e.id) : [];
  // 分页：每页至少一行，放得下 GROUP_TOKENS 就继续放
  const pages: { lines: string[]; entries: string[] }[] = [];
  let lines: string[] = [];
  let ids: string[] = [];
  let used = 0;
  const flush = () => {
    if (lines.length) {
      pages.push({ lines, entries: ids });
      lines = [];
      ids = [];
      used = 0;
    }
  };
  for (const [i, line] of all.entries()) {
    const t = estimateTokens(line);
    if (lines.length && used + t > GROUP_TOKENS) flush();
    lines.push(line);
    if (entryIds.length) ids.push(entryIds[i]!);
    used += t;
  }
  flush();
  const current = pages[page - 1];
  if (!current) return null;
  return { kind: 'group', id, page, lines: current.lines, entries: current.entries, ...(pages[page] && { nextPage: `${id}@${page + 1}` }) };
}

/** 反查条目属于哪些分组（groupItems 认的分组标识）：字段、指标、标签同时属于实体组（或 other）与各主题组，
 * 数据源与源表进 group:sources，关系进 group:relationships，模板进 group:templates；能力条目不属于任何组 */
function entryGroups(g: Groups): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (groupId: string, entries: CatalogEntry[]) => {
    for (const e of entries) out.set(e.id, [...(out.get(e.id) ?? []), groupId]);
  };
  for (const [id, entries] of g.entity) add(`group:${id}`, entries);
  for (const [name, entries] of g.subject) add(`group:subject:${name}`, entries);
  add('group:other', g.other);
  add('group:sources', g.sources);
  add('group:relationships', g.relations);
  add('group:templates', g.templates);
  return out;
}

/**
 * 起草用的分层上下文（#855）：第一层分组（groupOverview，总是完整给出）+「相关分组」的组内列表（每个组只取第 1 页，不出哈希列）。
 * 相关分组 = pin 在前（映射起草的目标实体组），然后按 ranked 的排名先后收条目所在的分组（一个条目属于多个组时都算）；
 * 第一层 + 全部组内列表放得下 budget 时全部给出（不再分相关 / 不相关）。剩余预算（budget − 第一层）≤ 0 时不给组内列表；
 * 否则按顺序逐组加入，下一组放不下就停（不跳过去试更小的组）。纯函数
 */
export function layeredContext(c: Catalog, ranked: CatalogEntry[], budget: number, pin: string[] = []): string {
  const first = groupsMarkdown(groupOverview(c));
  if (budget - estimateTokens(first) <= 0) return first;
  const g = groupsOf(c);
  const belongs = entryGroups(g);
  // 全部分组，按第一层顺序（主题组、实体组，然后各汇总组）；大目录里实体组被合并成合并组行，相关分组仍用 group:entity:x（groupItems 能解析）
  const all = [
    ...[...g.subject.keys()].sort((a, b) => cmp(`group:subject:${a}`, `group:subject:${b}`)).map(name => `group:subject:${name}`),
    ...[...g.entity.keys()].sort(cmp).map(id => `group:${id}`),
    ...(g.other.length ? ['group:other'] : []),
    ...(c.entries.some(e => e.kind === 'source') ? ['group:sources'] : []),
    ...(g.relations.length ? ['group:relationships'] : []),
    ...(g.templates.length ? ['group:templates'] : []),
  ];
  const relevant: string[] = [];
  const push = (id: string) => { if (!relevant.includes(id)) relevant.push(id); };
  for (const id of pin) push(id);
  for (const e of ranked) for (const id of belongs.get(e.id) ?? []) push(id);

  const memo = new Map<string, string>();
  const items = (id: string): string | null => {
    if (!memo.has(id)) {
      const gi = groupItems(c, id);
      memo.set(id, gi ? groupItemsMarkdown(gi) : '');
    }
    return memo.get(id) || null;
  };
  // 全部放得下时全部给出（pin 与相关组在前，其余按第一层顺序）；逐项累计超过预算就提前认定放不下。+3 是「# 相关分组」标题与分隔的余量
  let allFits = true;
  let used = estimateTokens(first);
  for (const id of all) {
    const md = items(id);
    if (!md) continue;
    used += estimateTokens(md);
    if (used + 3 > budget) { allFits = false; break; }
  }
  const withSections = (list: string[]) => (list.length ? [first, '# 相关分组', ...list].join('\n\n') : first);
  const sections: string[] = [];
  for (const id of (allFits ? [...relevant, ...all.filter(id => !relevant.includes(id))] : relevant)) {
    const md = items(id);
    if (!md) continue;
    if (estimateTokens(withSections([...sections, md])) > budget) break;
    sections.push(md);
  }
  return withSections(sections);
}

/** 查询分词：ASCII 单词转小写、至少 2 个字符；连续的中日韩字符切成二元组（只有一个字时取这个字） */
export function terms(query: string): string[] {
  const out = new Set<string>();
  for (const w of query.match(/[A-Za-z0-9]+/g) ?? []) if (w.length >= 2) out.add(w.toLowerCase());
  for (const run of query.match(CJK_RUN) ?? []) {
    const chars = [...run];
    if (chars.length === 1) out.add(run);
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  }
  return [...out];
}

/** 条目参与搜索的文字：标识、名称、说明、枚举与标签取值、业务知识、指标与标签的口径文字与取值不是未知的系统口径声明（「币种：未知」之类不带信息，进检索会让「退款」等词命中所有指标），字段再加业务说明与各映射字段的说明与知识，能力说明再加各项说明 */
export const haystack = (e: CatalogEntry) => [
  e.id, e.name, e.description,
  ...('knowledge' in e ? [knowledgeText(e.knowledge)] : []),
  ...(e.kind === 'metric' || e.kind === 'tag' ? [e.system.text, ...e.system.claims.filter(c => c.value !== 'unknown').map(claimPhrase)] : []),
  ...(e.kind === 'field' ? [...(e.enum ?? []), e.note ?? '', ...e.lineage.flatMap(l => [l.note ?? '', knowledgeText(l.knowledge)])] : []),
  ...(e.kind === 'tag' ? e.values.map(String) : []),
  ...(e.kind === 'capability' ? e.sections.flatMap(s => [s.title, ...s.items.flatMap(i => [i.name, i.description])]) : []),
].join('\n').toLowerCase();

/** 按关键词搜索：得分是命中的词数，同分按标识排；返回展开后的条目 */
export function search(c: Catalog, query: string, limit = 20): CatalogEntry[] {
  const words = terms(query);
  if (!words.length) return [];
  return c.entries
    .map(e => {
      const text = haystack(e);
      return { e, score: words.filter(w => text.includes(w)).length };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || byId(a.e, b.e))
    .slice(0, limit)
    .map(x => x.e);
}

const code = (s: string) => `\`${s}\``;

const NO_STATS = '暂无统计';

const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`;

/** 一列的统计：空值率、时间范围、常见取值 */
const columnStatsText = (c: ColumnStats) => [
  `空值率 ${percent(c.nullRate)}`,
  ...(c.range ? [`时间范围 ${c.range.min} ~ ${c.range.max}`] : []),
  ...(c.top ? [`常见取值 ${c.top.map(t => `${t.value}（${t.rows}）`).join('、')}`] : []),
].join('，');

function tableStatsMarkdown(s: TableStats | null): string[] {
  if (!s) return [`- 统计：${NO_STATS}`];
  return [`- 统计：${s.rows} 行，列统计基于 ${s.sampleRows} 行样本，统计截至 ${s.at}（采集时间）`,
    ...s.columns.map(c => `  - ${code(c.name)}：${columnStatsText(c)}`)];
}

function groupsMarkdown(o: GroupOverview): string {
  return ['# 语义目录', '', ...(o.version != null ? [`目录版本 ${o.version}`, ''] : []), ...o.groups.map(groupLineMarkdown)].join('\n');
}

function groupItemsMarkdown(gi: GroupItems): string {
  return ['# 分组 ' + (gi.page > 1 ? `${gi.id}@${gi.page}` : gi.id), '', ...gi.lines, ...(gi.nextPage ? ['', `- 下一页：${gi.nextPage}`] : [])].join('\n');
}

/** 渲染选项：restricted 是按角色清掉了来源的目录（ADR-0047），空来源写中性文字而不是「未映射」 */
export type RenderOptions = { restricted?: boolean };

/** 查看者目录里被清掉的来源（实体的映射来源、字段的来源）渲染成这句，免得模型当成「没映射」 */
const SOURCES_HIDDEN = '按你的角色不显示';

function entryMarkdown(e: CatalogEntry, opts: RenderOptions = {}): string {
  const head = [`## ${e.id} ${e.name}`, ...(e.description ? ['', e.description] : []), '', ...('knowledge' in e ? knowledgeMarkdown(e.knowledge) : [])];
  switch (e.kind) {
    case 'source':
      return [...head, `- 类型：${e.sourceKind}`, `- 源表：${e.tables.join(', ') || '无'}`].join('\n');
    case 'table':
      return [...head, `- 数据源：${e.source}`, ...(e.mapped ? [`- 写入：${e.entities.join(', ')}`] : []),
        `- 列：${e.columns.map(c => `${code(c.name)} ${c.type}`).join(', ') || '无'}`, ...(e.view ? [] : tableStatsMarkdown(e.stats))].join('\n');
    case 'entity':
      return [...head, `- ${e.custom ? '自定义实体' : '标准实体'} ${code(e.entity)}，主键 ${e.key.map(code).join(', ')}`,
        `- 映射来源：${e.tables.map(id => (e.unscoped.includes(id) ? `${id}（不在同步范围）` : id)).join(', ') || (opts.restricted ? SOURCES_HIDDEN : '未映射')}`,
        ...(e.relations.length ? [`- 关系：${e.relations.join(', ')}`] : []),
        ...e.mergeGroups.map(g => `- 合并组（${g.rule}）：${g.members.join(' > ')}`),
        `- 统计：${e.stats ? `${e.stats.rows} 行，统计截至 ${e.stats.at}（最近一次合并）` : NO_STATS}`,
        '', '| 字段 | 名称 | 类型 | 说明 |', '|---|---|---|---|',
        ...e.fields.map(f => `| ${code(f.name)} | ${f.label} | ${f.type} | ${f.description} |`)].join('\n');
    case 'field':
      return [...head, `- 实体：${e.entity}，字段 ${code(e.field)}，类型 ${e.type}`,
        ...(e.enum ? [`- 取值：${e.enum.map(code).join(', ')}`] : []),
        ...(e.note ? [`- 业务说明：${e.note}`] : []),
        ...(e.lineage.length
          ? ['- 来源：', ...e.lineage.flatMap(l => [`  - ${l.source}/${l.table}：${code(l.expr)}${l.dictionary ? '（经值字典）' : ''}`,
            ...(l.note ? [`    - 映射说明${l.noteNeedsReview ? '（待复核）' : ''}：${l.note}`] : []),
            ...knowledgeMarkdown(l.knowledge, '    '),
            ...l.sample.map(c => `    - 源端样本 ${code(c.name)}：${columnStatsText(c)}`)])]
          : [`- 来源：${opts.restricted ? SOURCES_HIDDEN : '未映射'}`])].join('\n');
    case 'relation':
      return [...head, `- ${e.from} → ${e.to}`].join('\n');
    case 'metric':
      return [...head, `- 指标 ${code(e.key)}（第 ${e.version} 版），基础实体 ${e.base}，度量 ${code(e.measure)}`, `- 口径（系统生成）：${e.system.text}`, `- 口径声明（系统生成）：${e.system.claims.map(claimPhrase).join('、')}`,
        snapshotLine(e.snapshot, e.dimensions.length ? '每个消费者×维度取值一行' : '每个消费者一行'),
        ...(e.dimensions.length ? [`- 维度：${e.dimensions.map(code).join(', ')}`] : []), ...dependenciesMarkdown(e.dependencies)].join('\n');
    case 'tag':
      return [...head, `- 标签 ${code(e.key)}（第 ${e.version} 版），取值 ${e.values.map(v => code(String(v))).join(', ')}`, `- 口径（系统生成）：${e.system.text}`, `- 口径声明（系统生成）：${e.system.claims.map(claimPhrase).join('、')}`,
        snapshotLine(e.snapshot, '每个统一消费者一行'), ...dependenciesMarkdown(e.dependencies)].join('\n');
    case 'template':
      return [...head, `- 模板 ${code(e.template)}（定义第 ${e.version} 版），读 ${e.entities.join(', ')}`, `- 参数：${code(JSON.stringify(e.params))}`,
        snapshotLine(e.snapshot ?? undefined),
        '', '| 产出列 | 类型 | 说明 |', '|---|---|---|', ...e.columns.map(c => `| ${code(c.name)} | ${c.type} | ${c.description} |`)].join('\n');
    case 'capability':
      return [...head,
        ...e.sections.flatMap(s => [`### ${s.title}`, '', ...s.items.map(i => `- ${code(i.name)}${i.type ? ` ${i.type}` : ''}：${i.description}`), '']),
        ...e.examples.flatMap(x => [`### 示例 ${x.key}：${x.note}`, '', '```yaml', x.yaml.trimEnd(), '```', ''])].join('\n').trimEnd();
  }
}

/** 「快照：…」一行：表名、行数、截至时间，指标与标签再写结果粒度；没有快照时写「还没有快照」 */
const snapshotLine = (s: TemplateSnapshot | undefined, grain?: string) =>
  `- 快照：${s ? `${code(s.table)}，${s.rows} 行，截至 ${s.at}${grain ? `（${grain}）` : ''}` : '还没有快照'}`;

const dependenciesMarkdown = (d: DefinitionDependencies) => [
  ...(d.metrics.length ? [`- 引用指标：${d.metrics.join(', ')}`] : []),
  ...(d.entities.length ? [`- 用到实体：${d.entities.join(', ')}`] : []),
  ...(d.fields.length ? [`- 用到字段：${d.fields.join(', ')}`] : []),
];

/** 可渲染的结果：分层总览、分组展开、单个条目或搜索结果 */
export type Renderable = GroupOverview | GroupItems | CatalogEntry | CatalogEntry[];

/** 渲染成 Markdown；opts 只影响单个条目与条目列表 */
export function toMarkdown(x: Renderable, opts?: RenderOptions): string {
  if (Array.isArray(x)) return x.length ? x.map(e => entryMarkdown(e, opts)).join('\n\n') : '没有找到相关条目';
  if (x.kind === 'groups') return groupsMarkdown(x);
  if (x.kind === 'group') return groupItemsMarkdown(x);
  return entryMarkdown(x, opts);
}

/** 渲染成 JSON */
export const toJson = (x: Renderable): string => JSON.stringify(x, null, 2);
