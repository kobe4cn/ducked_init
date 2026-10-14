// app/routes/api.v1.consumers.$id.tsx —— 外部系统接口：按消费者 ID 点查标签、指标与 RFM（Bearer API Key，不读 cookie）。
// 默认读本租户当前的服务库；?snapshot=<快照 ID> 时只读查湖里那一张快照表（ADR-0033）
import type { Route } from './+types/api.v1.consumers.$id';
import { requireApiKey } from '~/.server/api-auth';
import { lookupConsumer, lookupSnapshot, ServingError } from '~/.server/serving-reader';

export async function loader({ request, params }: Route.LoaderArgs) {
  const { tenantId } = await requireApiKey(request);
  const snapshot = new URL(request.url).searchParams.get('snapshot');
  try {
    return Response.json(snapshot === null
      ? await lookupConsumer(tenantId, params.consumerId)
      : await lookupSnapshot(tenantId, snapshot, params.consumerId));
  } catch (e) {
    if (e instanceof ServingError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
