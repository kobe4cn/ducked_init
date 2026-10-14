// app/routes/api.v1.catalog.tsx —— 外部系统接口：本租户已发布的指标与标签目录（Bearer API Key，不读 cookie）
import type { Route } from './+types/api.v1.catalog';
import { apiCatalog } from '~/.server/api-catalog';
import { requireApiKey } from '~/.server/api-auth';

export async function loader({ request }: Route.LoaderArgs) {
  const { tenantId } = await requireApiKey(request);
  return Response.json(await apiCatalog(tenantId));
}
