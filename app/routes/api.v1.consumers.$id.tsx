// app/routes/api.v1.consumers.$id.tsx —— 外部系统接口：按消费者 ID 点查标签、指标与 RFM（Bearer API Key，不读 cookie）。
// 默认读本租户当前的服务库；?snapshot=<快照 ID> 时只读查湖里那一张快照表（ADR-0033）。
// 不带 snapshot 的成功返回按天记一次 API Key 调用（ADR-0059）
import type { Route } from './+types/api.v1.consumers.$id';
import { requireApiKey } from '~/.server/api-auth';
import { recordApiKeyUsage } from '~/.server/api-usage';
import { lookupConsumer, lookupSnapshot, ServingError } from '~/.server/serving-reader';

export async function loader({ request, params }: Route.LoaderArgs) {
  const { tenantId, keyId } = await requireApiKey(request);
  const snapshot = new URL(request.url).searchParams.get('snapshot');
  try {
    if (snapshot !== null) return Response.json(await lookupSnapshot(tenantId, snapshot, params.consumerId)); // 指定快照不记计数（ADR-0059）
    const body = await lookupConsumer(tenantId, params.consumerId);
    await recordApiKeyUsage({ tenantId, keyId }, 'consumers.byId'); // 成功返回前记一笔；写不进去时接口照常返回
    return Response.json(body);
  } catch (e) {
    if (e instanceof ServingError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
