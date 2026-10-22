// app/routes/api.v1.consumers.by-source.tsx —— 外部系统接口：按数据源登记名 + 源端消费者 ID 点查（Bearer API Key，不读 cookie）。
// 读本租户当前的服务库，响应与按统一消费者 ID 点查相同；不支持 ?snapshot=（旧快照记的是当时的 ID，ADR-0033）
import type { Route } from './+types/api.v1.consumers.by-source';
import { requireApiKey } from '~/.server/api-auth';
import { lookupConsumerBySource, ServingError } from '~/.server/serving-reader';

export async function loader({ request, params }: Route.LoaderArgs) {
  const { tenantId } = await requireApiKey(request);
  if (new URL(request.url).searchParams.get('snapshot') !== null) {
    return Response.json({ error: '按数据源查询不支持 snapshot：请先查出 consumer_id，再带 snapshot 调 /api/v1/consumers/:consumerId' }, { status: 400 });
  }
  try {
    return Response.json(await lookupConsumerBySource(tenantId, params.source, params.customerId));
  } catch (e) {
    if (e instanceof ServingError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
