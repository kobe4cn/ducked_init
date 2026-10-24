// app/.server/catalog/index.ts —— 语义目录（ADR-0041）：按本租户的元数据（数据源、同步范围内的源表与已发布源视图、已发布映射、
// 自定义实体与合并组）确定性地生成条目，给出总览、按稳定标识展开与关键词搜索，结果可渲染成 Markdown 与 JSON。
// 纯函数，不连库（加载见 load.ts）。敏感字段、哈希列与系统列不进目录（ADR-0005）；同步范围外的源表不收（ADR-0013）
import { CANONICAL_ENTITIES, CUSTOM_ENTITY_KINDS, type CustomEntityField, type EntityRelation, type FieldType } from '../../lib/canonical-model';
import { cmp, deriveLineage } from '../../lib/lineage';
import { entityFields } from '../../lib/lineage-fields';
import { ruleText } from '../../lib/merge-groups';
import { looksSensitive } from '../../lib/sensitive';
import type { RegisteredEntity } from '../custom-entities';
import type { PublishedMergeGroup } from '../merge-groups';
import { isSensitiveField } from '../mappings';
import { SILVER_SYSTEM_COLUMNS, type MergeMappingParam } from '../pipeline/merge-engine';
import { PLATFORM_COLUMNS } from '../pipeline/sync-engine';

/** 生成目录的元数据；后续会加统计、定义与业务说明，所以各部分都可以不给 */
export interface CatalogInput {
  sources?: { id: string; name: string; kind: string }[];
  /** 同步范围内（源端仍在且可读）的源表与已发布的源视图；columns 是最近一次采集到的列（源视图是输出列） */
  tables?: { sourceId: string; name: string; view: boolean; columns: { name: string; type: string; formats?: { format: string }[] }[] }[];
  /** 已发布映射（publishedPlans，已去掉停用的） */
  plans?: MergeMappingParam[];
  /** 已发布的自定义实体 */
  customEntities?: RegisteredEntity[];
  /** 已发布的合并组：members 是映射 ID，按优先级排 */
  mergeGroups?: (PublishedMergeGroup & { entity: string })[];
}

interface Base { id: string; name: string; description: string }

export interface SourceEntry extends Base { kind: 'source'; sourceKind: string; tables: string[] }

export interface TableEntry extends Base {
  kind: 'table'; source: string; table: string; view: boolean;
  /** 有已发布映射读它；entities 是它写入的实体 */
  mapped: boolean; entities: string[];
  /** 不含敏感列（像敏感信息的、被敏感字段引用的）与系统列 */
  columns: { name: string; type: string }[];
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
}

/** 字段在一个映射里的来源 */
export interface FieldLineageItem { source: string; table: string; expr: string; sourceColumns: string[]; dictionary: boolean }

export interface FieldEntry extends Base {
  kind: 'field'; entity: string; field: string; type: FieldType; enum?: string[]; lineage: FieldLineageItem[];
}

export interface RelationEntry extends Base { kind: 'relation'; from: string; to: string }

export type CatalogEntry = SourceEntry | TableEntry | EntityEntry | FieldEntry | RelationEntry;

/** 按标识排好序的全部条目 */
export interface Catalog { entries: CatalogEntry[] }

/** 总览的一项；实体带字段名，放不下时只带字段数 */
export interface OverviewItem { id: string; name: string; description: string; fields?: string[]; fieldCount?: number }

export interface Overview { kind: 'overview'; items: OverviewItem[]; /** 放不下、没列出的项数（用搜索找） */ omitted: number }

/** 总览的 token 上限（按 estimateTokens 估算 Markdown） */
export const OVERVIEW_TOKENS = 4000;
/** 总览里的说明截到多少字 */
const SUMMARY_CHARS = 40;

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
const isSystemColumn = (name: string) => SYSTEM_COLUMNS.has(name) || /^_.+_source$/.test(name);

const sourceId = (name: string) => `source:${name}`;
const tableId = (source: string, table: string) => `table:${source}/${table}`;
const entityId = (entity: string) => `entity:${entity}`;
const fieldId = (entity: string, field: string) => `field:${entity}.${field}`;
const relationId = (entity: string, field: string) => `relation:${entity}.${field}`;

const byId = <T extends { id: string }>(a: T, b: T) => cmp(a.id, b.id);

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
  const planTable = (p: MergeMappingParam) => tableId(sourceName.get(p.sourceId) ?? p.sourceId, p.table);

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

  for (const e of entities) {
    const mapped = entityFields(lineage, e.name, e.declared, {});
    const extensions = mapped.filter(f => !e.declared.some(d => d.name === f.name)).map(f => {
      const column = plans.find(p => p.entity === e.name && p.columns.some(c => c.name === f.name))!.columns.find(c => c.name === f.name)!;
      return { name: f.name, label: f.name, type: column.type, description: '', enum: column.enum && [...column.enum] };
    });
    const fields = [...e.declared, ...extensions].filter(f => !hidden(e.name, f.name));
    for (const f of fields) {
      const origins = mapped.find(m => m.name === f.name)?.sources ?? [];
      entries.push({
        kind: 'field', id: fieldId(e.name, f.name), name: f.label, description: f.description,
        entity: entityId(e.name), field: f.name, type: f.type, ...(f.enum && { enum: f.enum }),
        lineage: origins.map(s => ({ source: s.sourceName, table: s.table, expr: s.expr, sourceColumns: s.sourceColumns, dictionary: s.dictionary })),
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

  // 源表与源视图：被敏感字段引用的源列、像敏感信息的源列与系统列不列；同名的源表与源视图只留源表
  const tables = new Map<string, TableEntry>();
  for (const t of [...(input.tables ?? [])].sort((a, b) => Number(a.view) - Number(b.view))) {
    const source = sourceName.get(t.sourceId);
    if (source === undefined || tables.has(tableId(source, t.name))) continue;
    const id = tableId(source, t.name);
    const reading = plans.filter(p => p.sourceId === t.sourceId && p.table === t.name && !!p.sourceView === t.view);
    const secret = new Set(lineage.fields
      .filter(f => f.sourceId === t.sourceId && f.table === t.name && sensitive(f.entity, f.field))
      .flatMap(f => f.sourceColumns));
    const written = [...new Set(reading.map(p => p.entity))].sort(cmp);
    tables.set(id, {
      kind: 'table', id, name: t.name, source: sourceId(source), table: t.name, view: t.view,
      description: `${t.view ? '源视图' : '源表'}，${written.length ? `映射到 ${written.join('、')}` : '未映射'}`,
      mapped: reading.length > 0, entities: written.map(entityId),
      columns: t.columns.filter(c => !isSystemColumn(c.name) && !looksSensitive(c) && !secret.has(c.name)).map(c => ({ name: c.name, type: c.type })),
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

  return { entries: entries.sort(byId) };
}

const truncate = (text: string, chars = SUMMARY_CHARS) => {
  const all = [...text];
  return all.length > chars ? `${all.slice(0, chars).join('')}…` : text;
};

/**
 * 总览：数据源、源表、实体与关系各一行（字段在实体那一行），说明截到 40 字；估算超过 4000 token 时实体只给字段数，
 * 还放不下时截掉后面的项，记下没列出的项数
 */
export function overview(c: Catalog): Overview {
  const top = c.entries.filter(e => e.kind !== 'field');
  const item = (e: CatalogEntry, names: boolean): OverviewItem => ({
    id: e.id, name: e.name, description: truncate(e.description),
    ...(e.kind === 'entity' && (names ? { fields: e.fields.map(f => f.name) } : { fieldCount: e.fields.length })),
  });
  const fits = (o: Overview) => estimateTokens(toMarkdown(o)) <= OVERVIEW_TOKENS;
  const full: Overview = { kind: 'overview', items: top.map(e => item(e, true)), omitted: 0 };
  if (fits(full)) return full;
  const counts = top.map(e => item(e, false));
  const first = (n: number): Overview => ({ kind: 'overview', items: counts.slice(0, n), omitted: counts.length - n });
  // 放得下的最多项数（项数越多越长，二分）
  let [lo, hi] = [0, counts.length];
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(first(mid))) lo = mid; else hi = mid - 1;
  }
  return first(lo);
}

/** 按标识展开一个条目；标识不存在时为 null */
export const expand = (c: Catalog, id: string): CatalogEntry | null => c.entries.find(e => e.id === id) ?? null;

/** 查询分词：ASCII 单词转小写、至少 2 个字符；连续的中日韩字符切成二元组（只有一个字时取这个字） */
function terms(query: string): string[] {
  const out = new Set<string>();
  for (const w of query.match(/[A-Za-z0-9]+/g) ?? []) if (w.length >= 2) out.add(w.toLowerCase());
  for (const run of query.match(CJK_RUN) ?? []) {
    const chars = [...run];
    if (chars.length === 1) out.add(run);
    for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
  }
  return [...out];
}

/** 条目参与搜索的文字：标识、名称、说明与枚举取值 */
const haystack = (e: CatalogEntry) => [e.id, e.name, e.description, ...(e.kind === 'field' ? (e.enum ?? []) : [])].join('\n').toLowerCase();

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

function overviewMarkdown(o: Overview): string {
  const lines = o.items.map(i => {
    const fields = i.fields ? `；字段：${i.fields.join(', ')}` : i.fieldCount !== undefined ? `；${i.fieldCount} 个字段` : '';
    return `- ${i.id} ${i.name}${i.description ? ` — ${i.description}` : ''}${fields}`;
  });
  if (o.omitted) lines.push(`- 另有 ${o.omitted} 项没有列出，请用搜索查找`);
  return ['# 语义目录', '', ...lines].join('\n');
}

function entryMarkdown(e: CatalogEntry): string {
  const head = [`## ${e.id} ${e.name}`, ...(e.description ? ['', e.description] : []), ''];
  switch (e.kind) {
    case 'source':
      return [...head, `- 类型：${e.sourceKind}`, `- 源表：${e.tables.join(', ') || '无'}`].join('\n');
    case 'table':
      return [...head, `- 数据源：${e.source}`, ...(e.mapped ? [`- 写入：${e.entities.join(', ')}`] : []),
        `- 列：${e.columns.map(c => `${code(c.name)} ${c.type}`).join(', ') || '无'}`].join('\n');
    case 'entity':
      return [...head, `- ${e.custom ? '自定义实体' : '标准实体'} ${code(e.entity)}，主键 ${e.key.map(code).join(', ')}`,
        `- 映射来源：${e.tables.map(id => (e.unscoped.includes(id) ? `${id}（不在同步范围）` : id)).join(', ') || '未映射'}`,
        ...(e.relations.length ? [`- 关系：${e.relations.join(', ')}`] : []),
        ...e.mergeGroups.map(g => `- 合并组（${g.rule}）：${g.members.join(' > ')}`),
        '', '| 字段 | 名称 | 类型 | 说明 |', '|---|---|---|---|',
        ...e.fields.map(f => `| ${code(f.name)} | ${f.label} | ${f.type} | ${f.description} |`)].join('\n');
    case 'field':
      return [...head, `- 实体：${e.entity}，字段 ${code(e.field)}，类型 ${e.type}`,
        ...(e.enum ? [`- 取值：${e.enum.map(code).join(', ')}`] : []),
        ...(e.lineage.length
          ? ['- 来源：', ...e.lineage.map(l => `  - ${l.source}/${l.table}：${code(l.expr)}${l.dictionary ? '（经值字典）' : ''}`)]
          : ['- 来源：未映射'])].join('\n');
    case 'relation':
      return [...head, `- ${e.from} → ${e.to}`].join('\n');
  }
}

/** 可渲染的结果：总览、单个条目或搜索结果 */
export type Renderable = Overview | CatalogEntry | CatalogEntry[];

/** 渲染成 Markdown */
export function toMarkdown(x: Renderable): string {
  if (Array.isArray(x)) return x.length ? x.map(entryMarkdown).join('\n\n') : '没有找到相关条目';
  return x.kind === 'overview' ? overviewMarkdown(x) : entryMarkdown(x);
}

/** 渲染成 JSON */
export const toJson = (x: Renderable): string => JSON.stringify(x, null, 2);
