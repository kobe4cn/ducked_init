// app/routes/api.v1.catalog.tsx —— 外部系统接口：本租户已发布的指标与标签目录（Bearer API Key，不读 cookie），
// 只列这把 Key 数据范围内的定义（#976）：「全部」时与收窄前相同
import type { Route } from './+types/api.v1.catalog';
import { apiCatalog } from '~/.server/api-catalog';
import { requireApiKey } from '~/.server/api-auth';
import { templateInScope } from '~/lib/api-data-scope';

export async function loader({ request }: Route.LoaderArgs) {
  const { tenantId, dataScope } = await requireApiKey(request);
  const { definitions } = await apiCatalog(tenantId);
  return Response.json({ definitions: definitions.filter(d => templateInScope(`${d.kind}:${d.key}`, dataScope)) });
}
