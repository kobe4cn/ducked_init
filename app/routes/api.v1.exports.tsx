// app/routes/api.v1.exports.tsx —— 外部系统接口：按标签条件发起人群导出（Bearer API Key，不读 cookie，ADR-0040）。
// 请求体是 JSON { conditions: [{ tag, value }], snapshots?: { <标签>: <快照 ID> }, format?: 'parquet' | 'csv' }，合法时 202 返回任务 ID 与所用快照
import type { Route } from './+types/api.v1.exports';
import { requireApiKey } from '~/.server/api-auth';
import { createExport, ExportError } from '~/.server/exports';

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') return Response.json({ error: '只支持 POST' }, { status: 405 });
  const caller = await requireApiKey(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: '请求体必须是 JSON' }, { status: 400 });
  }
  try {
    return Response.json(await createExport(caller, body), { status: 202 });
  } catch (e) {
    if (e instanceof ExportError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
