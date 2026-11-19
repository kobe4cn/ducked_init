// app/routes/api.v1.consumers.$id.tsx —— 外部系统接口：按消费者 ID 点查标签、指标与 RFM（Bearer API Key，不读 cookie）。
// 默认读本租户当前的服务库；?snapshot=<快照 ID> 时只读查湖里那一张快照表（ADR-0033）。
// 响应按 Key 的数据范围裁剪（ADR-0061「数据范围」，#975）：范围外的标签、指标与 RFM 不出现，范围外的快照 404。
// 不带 snapshot 的成功返回按天记一次 API Key 调用（ADR-0059）
import type { Route } from './+types/api.v1.consumers.$id';
import { requireApiKey } from '~/.server/api-auth';
import { recordApiKeyUsage } from '~/.server/api-usage';
import { assertSnapshotInScope, filterProfile } from '~/.server/api-data-scope';
import { lookupConsumer, lookupSnapshot, ServingError } from '~/.server/serving-reader';

export async function loader({ request, params }: Route.LoaderArgs) {
  const { tenantId, keyId, dataScope } = await requireApiKey(request);
  const snapshot = new URL(request.url).searchParams.get('snapshot');
  try {
    // 范围判定在 lookupSnapshot 之前：范围外的快照先报「快照不存在或已过期」，不会因为人不在表里报出别的 404
    if (snapshot !== null) {
      await assertSnapshotInScope(tenantId, snapshot, dataScope);
      return Response.json(filterProfile(await lookupSnapshot(tenantId, snapshot, params.consumerId), dataScope)); // 指定快照不记计数（ADR-0059）
    }
    const body = filterProfile(await lookupConsumer(tenantId, params.consumerId), dataScope);
    await recordApiKeyUsage({ tenantId, keyId }, 'consumers.byId'); // 成功返回前记一笔；写不进去时接口照常返回
    return Response.json(body);
  } catch (e) {
    if (e instanceof ServingError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
