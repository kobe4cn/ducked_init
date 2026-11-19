// app/routes/api.v1.consumers.by-source.tsx —— 外部系统接口：按数据源登记名 + 源端消费者 ID 点查（Bearer API Key，不读 cookie）。
// 读本租户当前的服务库，响应与按统一消费者 ID 点查相同（含按 Key 数据范围的裁剪，ADR-0061「数据范围」，#975）；
// 不支持 ?snapshot=（旧快照记的是当时的 ID，ADR-0033）。
// 成功返回按天记一次 API Key 调用（ADR-0059）
import type { Route } from './+types/api.v1.consumers.by-source';
import { requireApiKey } from '~/.server/api-auth';
import { recordApiKeyUsage } from '~/.server/api-usage';
import { filterProfile } from '~/.server/api-data-scope';
import { lookupConsumerBySource, ServingError } from '~/.server/serving-reader';

export async function loader({ request, params }: Route.LoaderArgs) {
  const { tenantId, keyId, dataScope } = await requireApiKey(request);
  if (new URL(request.url).searchParams.get('snapshot') !== null) {
    return Response.json({ error: '按数据源查询不支持 snapshot：请先查出 consumer_id，再带 snapshot 调 /api/v1/consumers/:consumerId' }, { status: 400 });
  }
  try {
    const body = filterProfile(await lookupConsumerBySource(tenantId, params.source, params.customerId), dataScope);
    await recordApiKeyUsage({ tenantId, keyId }, 'consumers.bySource'); // 成功返回前记一笔；写不进去时接口照常返回
    return Response.json(body);
  } catch (e) {
    if (e instanceof ServingError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
