// app/routes/api.v1.exports.$id.tsx —— 外部系统接口：查一次人群导出的状态与所用快照（Bearer API Key，不读 cookie，ADR-0040）。
// 别的租户的任务、不是导出的任务一律 404
import type { Route } from './+types/api.v1.exports.$id';
import { requireApiKey } from '~/.server/api-auth';
import { getExport } from '~/.server/exports';

export async function loader({ request, params }: Route.LoaderArgs) {
  const { tenantId } = await requireApiKey(request);
  const found = await getExport(tenantId, params.id);
  return found ? Response.json(found) : Response.json({ error: '导出不存在' }, { status: 404 });
}
