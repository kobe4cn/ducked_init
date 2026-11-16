// app/.server/pending-publish.ts —— 首页「待你发布」的聚合查询：本租户所有处于草稿状态、且当前成员可以发布的可发布项（ADR-0051 的六种），按最后保存时间倒序。
// 不放进 publishing.ts：它被 mappings.ts 等领域模块导入，反过来 import 它们会循环依赖（见 publishing.ts 头注）；
// 本文件只 import db/schema、db/client、publishing.ts 的 publishBlocker、模板注册表（纯注册表）与 custom-entities 的 isInferredDraft，不 import 领域模块的其余部分
import { and, eq, isNull } from 'drizzle-orm';
import type { CurrentMember } from './auth';
import { isInferredDraft } from './custom-entities';
import { getDb } from './db/client';
import {
  customEntities, customEntityVersions, dslDefinitions, dslVersions, mappingVersions, mappings,
  mergeGroupVersions, mergeGroups, sourceViewVersions, sourceViews, sources, templateDefinitions, templateVersions,
} from './db/schema';
import { TEMPLATES } from './pipeline/templates';
import { publishBlocker } from './publishing';

/** 首页「待你发布」的一项：草稿的名称、版本、最后保存的人与时间，链接到能发布它的页面 */
export interface PendingItem {
  kind: 'mapping' | 'source_view' | 'metric' | 'tag' | 'template' | 'custom_entity' | 'merge_group';
  kindLabel: string;
  name: string;
  version: number;
  lastEditor: string;
  updatedAt: Date;
  href: string;
}

/** 六张版本表（各可发布项形状相同、名字相同，ADR-0051）：每条查询都要选出的公共列 */
type AnyVersions = typeof mappingVersions | typeof sourceViewVersions | typeof dslVersions |
  typeof templateVersions | typeof customEntityVersions | typeof mergeGroupVersions;

/** 版本表自己的公共列（不能用一张表的列对象给别的表用：drizzle 会照列表名出错误的 SQL） */
const draftColumns = (v: AnyVersions) => ({ version: v.version, status: v.status, lastEditor: v.lastEditor, updatedAt: v.updatedAt });

/** 最后保存的人是当前成员自己的草稿被 publishBlocker 拦下（ADR-0015 双人发布），不列给他；平台最后保存的（映射修复草稿）任何有发布权限的成员都能发布，照常列出 */
const publishableBy = <T extends { status: string; lastEditor: string }>(member: CurrentMember, rows: T[]): T[] =>
  rows.filter(r => publishBlocker(member, r) === null);

/**
 * 当前成员要发布的草稿（首页「待你发布」）：每种可发布项一条查询（Promise.all 并行），最后保存时间倒序。
 * 已停用的映射（disabledAt 不为 null）与推断出的自定义实体草稿（isInferredDraft，要先有成员确认）不列；
 * 调用方先查 can(role, 'publish')：没有发布权限的角色不显示这个区块，也不查
 */
export async function listPendingPublish(member: CurrentMember): Promise<PendingItem[]> {
  const tenantId = member.tenant.id;
  const [mappingRows, viewRows, dslRows, templateRows, entityRows, mergeRows] = await Promise.all([
    getDb().select({
      ...draftColumns(mappingVersions),
      mappingId: mappings.id, sourceName: sources.name, tableName: mappings.tableName, entity: mappings.entity,
    }).from(mappingVersions)
      .innerJoin(mappings, eq(mappings.id, mappingVersions.mappingId))
      .innerJoin(sources, eq(sources.id, mappings.sourceId))
      .where(and(eq(mappings.tenantId, tenantId), eq(mappingVersions.status, 'draft'), isNull(mappings.disabledAt))),
    getDb().select({
      ...draftColumns(sourceViewVersions),
      viewId: sourceViews.id, sourceId: sourceViews.sourceId, name: sourceViews.name,
    }).from(sourceViewVersions)
      .innerJoin(sourceViews, eq(sourceViews.id, sourceViewVersions.viewId))
      .where(and(eq(sourceViews.tenantId, tenantId), eq(sourceViewVersions.status, 'draft'))),
    getDb().select({
      ...draftColumns(dslVersions),
      kind: dslDefinitions.kind, key: dslDefinitions.key,
    }).from(dslVersions)
      .innerJoin(dslDefinitions, eq(dslDefinitions.id, dslVersions.definitionId))
      .where(and(eq(dslDefinitions.tenantId, tenantId), eq(dslVersions.status, 'draft'))),
    getDb().select({
      ...draftColumns(templateVersions),
      template: templateDefinitions.template,
    }).from(templateVersions)
      .innerJoin(templateDefinitions, eq(templateDefinitions.id, templateVersions.definitionId))
      .where(and(eq(templateDefinitions.tenantId, tenantId), eq(templateVersions.status, 'draft'))),
    getDb().select({
      ...draftColumns(customEntityVersions),
      entityId: customEntities.id, name: customEntities.name,
    }).from(customEntityVersions)
      .innerJoin(customEntities, eq(customEntities.id, customEntityVersions.entityId))
      .where(and(eq(customEntities.tenantId, tenantId), eq(customEntityVersions.status, 'draft'))),
    getDb().select({
      ...draftColumns(mergeGroupVersions),
      entity: mergeGroups.entity,
    }).from(mergeGroupVersions)
      .innerJoin(mergeGroups, eq(mergeGroups.id, mergeGroupVersions.groupId))
      .where(and(eq(mergeGroups.tenantId, tenantId), eq(mergeGroupVersions.status, 'draft'))),
  ]);

  const pending: PendingItem[] = [
    ...publishableBy(member, mappingRows).map(r => ({
      ...r,
      kind: 'mapping' as const, kindLabel: '映射', name: `${r.sourceName} · ${r.tableName} → ${r.entity}`,
      href: `/mappings/${r.mappingId}`,
    })),
    ...publishableBy(member, viewRows).map(r => ({
      ...r,
      kind: 'source_view' as const, kindLabel: '源视图',
      href: `/sources/${r.sourceId}/views/${r.viewId}`,
    })),
    ...publishableBy(member, dslRows).map(r => ({
      ...r,
      kindLabel: r.kind === 'metric' ? '指标' : '标签', name: r.key,
      href: `/analytics/definitions/${r.kind}/${r.key}`,
    })),
    ...publishableBy(member, templateRows).map(r => ({
      ...r,
      kind: 'template' as const, kindLabel: '模板', name: TEMPLATES[r.template as keyof typeof TEMPLATES]?.label ?? r.template,
      href: `/analytics/templates/${r.template}`,
    })),
    // 推断出的登记草稿（lastEditor 是 platform）任何人都发布不了，等成员确认后才进这个列表
    ...publishableBy(member, entityRows.filter(r => !isInferredDraft(r))).map(r => ({
      ...r,
      kind: 'custom_entity' as const, kindLabel: '自定义实体',
      href: `/entities/${r.entityId}`,
    })),
    ...publishableBy(member, mergeRows).map(r => ({
      ...r,
      kind: 'merge_group' as const, kindLabel: '合并组', name: r.entity,
      href: `/merge-groups?entity=${encodeURIComponent(r.entity)}`,
    })),
  ];
  return pending.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
