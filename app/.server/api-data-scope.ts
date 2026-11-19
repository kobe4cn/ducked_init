// app/.server/api-data-scope.ts —— 按数据范围裁剪点查结果（ADR-0061「数据范围」，#975）：范围外的标签、指标与 RFM 不出现、不报错，
// 快照只列范围内的，?snapshot= 指向范围外时 404 且文案与真不存在相同。过滤放在点查的路由这一层，serving-reader 与服务库不感知 Key 的数据范围
import { templateInScope, type ApiDataScope } from '../lib/api-data-scope';
import { msg } from '../lib/i18n';
import { getSnapshot } from './snapshots';
import { ServingError, type ConsumerProfile } from './serving-reader';
import { formatServer } from './i18n';

/** 把点查结果裁到数据范围内：all 全开时原样返回同一个对象；否则 tags / metrics 只留范围内 key（保持原字段顺序）、
 *  rfm 不在范围时为 null、snapshots 只留范围内模板的项（rfm: false 时 RFM 快照也去掉） */
export function filterProfile(p: ConsumerProfile, scope: ApiDataScope): ConsumerProfile {
  if (scope.all === true) return p;
  const tags: ConsumerProfile['tags'] = {};
  for (const [key, value] of Object.entries(p.tags)) if (templateInScope(`tag:${key}`, scope)) tags[key] = value;
  const metrics: ConsumerProfile['metrics'] = {};
  for (const [key, value] of Object.entries(p.metrics)) if (templateInScope(`metric:${key}`, scope)) metrics[key] = value;
  return {
    ...p,
    tags,
    metrics,
    rfm: scope.rfm === true ? p.rfm : null,
    snapshots: p.snapshots.filter(s => templateInScope(s.template, scope)),
  };
}

/** ?snapshot= 指向范围外定义的快照时抛与真不存在相同的 404；快照不存在（或属于别的租户）时什么都不做，
 *  交给 lookupSnapshot 报同样的 404。必须先于 lookupSnapshot 调用：范围外的快照不会因为人不在表里先报出「没有这个消费者」 */
export async function assertSnapshotInScope(tenantId: string, snapshotId: string, scope: ApiDataScope): Promise<void> {
  if (scope.all === true) return;
  const snapshot = await getSnapshot(tenantId, snapshotId);
  // 文案与 lookupSnapshot 的「快照不存在或已过期」相同，分不出范围外与不存在；msg() 出中文（ADR-0060：/api/v1 默认中文）
  if (snapshot && !templateInScope(snapshot.template, scope)) {
    throw new ServingError(formatServer('zh-CN', msg('快照不存在或已过期')), 404);
  }
}
