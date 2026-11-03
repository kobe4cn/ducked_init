// app/.server/knowledge/hub.ts —— 业务知识集中页（ADR-0046 第 18 行）的读模型：按分析主题分组列出有待确认提案或缺失项的目录条目。
// 条目只取成员可见目录（catalogFor）里的实体、字段、指标、标签；提案的目标不在目录里（已删除、敏感字段）或带 mappingId（本期面板不处理映射字段）的不列。
// 缺失项只看生效声明：成员声明（knowledge.claims）优先，没有时取系统声明（指标的 system.claims）。没有声明是「未声明」，取值为 unknown 是「未知」，
// 需复核的按未知（ADR-0046 第 16 行）另记为 needsReview；not_applicable 与具体取值不算缺失。检查范围：
// - 金额字段：type 为 decimal、所属实体已接入（tables 非空）的字段，检查单位与币种。没有 sources:read 的成员目录里实体的 tables 已清空，所以他们看不到金额字段的缺失项
// - 指标：只检查单位（sum / avg / min / max / latest / earliest 的系统单位是 unknown，没有成员声明时列为缺失）
// 分组按 knowledge.subjects（主题名，cmpName 排序）：属于多个主题的每组各出现一次，不属于任何主题的进最后的「未归入主题」组（subject 为 null）；
// 总数按条目去重
import type { CurrentMember } from '../auth';
import { catalogFor } from '../assistant/tools';
import type { Catalog, CatalogEntry, EntityEntry, FieldEntry, MetricEntry, TagEntry } from '../catalog';
import { getDb } from '../db/client';
import { cmpName } from '../../lib/compare';
import type { Claim } from './catalog';
import { listProposals, type Proposal } from './proposals';

type HubEntry = EntityEntry | FieldEntry | MetricEntry | TagEntry;
type MissingType = 'unit' | 'currency';

export interface HubItem {
  targetId: string;
  kind: HubEntry['kind'];
  name: string;
  /** 待确认的提案数 */
  proposals: number;
  missing: { type: MissingType; state: 'undeclared' | 'unknown' | 'needsReview' }[];
}

export interface HubGroup { subject: string | null; proposals: number; missing: number; items: HubItem[] }

export interface KnowledgeHub { totals: { proposals: number; missing: number; subjects: number }; groups: HubGroup[] }

const isHubEntry = (e: CatalogEntry): e is HubEntry => e.kind === 'entity' || e.kind === 'field' || e.kind === 'metric' || e.kind === 'tag';

/** 这个条目要检查的声明类型；connected 是已接入实体的目录标识（字段的 entity 也是实体的目录标识） */
function checkedTypes(e: HubEntry, connected: ReadonlySet<string>): MissingType[] {
  if (e.kind === 'metric') return ['unit'];
  if (e.kind === 'field' && e.type === 'decimal' && connected.has(e.entity)) return ['unit', 'currency'];
  return [];
}

function missingOf(e: HubEntry, connected: ReadonlySet<string>): HubItem['missing'] {
  const own = e.knowledge?.claims ?? [];
  const system: Claim[] = e.kind === 'metric' ? e.system.claims : [];
  return checkedTypes(e, connected).flatMap((type): HubItem['missing'] => {
    const claim = own.find(c => c.type === type) ?? system.find(c => c.type === type);
    if (!claim) return [{ type, state: 'undeclared' }];
    if (claim.value !== 'unknown') return [];
    return [{ type, state: claim.needsReview ? 'needsReview' : 'unknown' }];
  });
}

/** 由目录条目与待确认提案算出集中页；proposals 应只含 status 为 proposed 的 */
export function buildKnowledgeHub(entries: CatalogEntry[], proposals: Proposal[]): KnowledgeHub {
  const counts = new Map<string, number>();
  for (const p of proposals) if (p.mappingId === null) counts.set(p.targetId, (counts.get(p.targetId) ?? 0) + 1);
  const connected = new Set(entries.flatMap(e => (e.kind === 'entity' && e.tables.length > 0 ? [e.id] : [])));

  const bySubject = new Map<string | null, HubItem[]>();
  let totalProposals = 0;
  let totalMissing = 0;
  for (const e of entries) {
    if (!isHubEntry(e)) continue;
    const item: HubItem = { targetId: e.id, kind: e.kind, name: e.name, proposals: counts.get(e.id) ?? 0, missing: missingOf(e, connected) };
    if (!item.proposals && !item.missing.length) continue;
    totalProposals += item.proposals;
    totalMissing += item.missing.length;
    const subjects = e.knowledge?.subjects?.length ? e.knowledge.subjects : [null];
    for (const s of subjects) bySubject.set(s, [...(bySubject.get(s) ?? []), item]);
  }

  const named = [...bySubject.keys()].filter((s): s is string => s !== null).sort(cmpName);
  const groups = [...named, ...(bySubject.has(null) ? [null] : [])].map(subject => {
    const items = bySubject.get(subject)!.sort((a, b) => cmpName(a.name, b.name));
    return {
      subject,
      proposals: items.reduce((n, i) => n + i.proposals, 0),
      missing: items.reduce((n, i) => n + i.missing.length, 0),
      items,
    };
  });
  return { totals: { proposals: totalProposals, missing: totalMissing, subjects: named.length }, groups };
}

/** 成员看到的集中页；catalog 已取好时传进来，免得再读一次目录 */
export async function knowledgeHub(member: CurrentMember, catalog?: Catalog): Promise<KnowledgeHub> {
  const c = catalog ?? await catalogFor(member);
  return buildKnowledgeHub(c.entries, await listProposals(getDb(), member.tenant.id, { status: 'proposed' }));
}
