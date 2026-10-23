// app/routes/api.v1.exports.$id.download.tsx —— 外部系统接口：凭限时下载链接里的令牌下载人群导出文件（ADR-0040）。
// 只认 ?token=，不读 cookie 也不要 Bearer；令牌不存在或不是这个导出的 404，已到期或文件已清理 410
import type { Route } from './+types/api.v1.exports.$id.download';
import { openExportDownload } from '~/.server/exports';

export async function loader({ request, params }: Route.LoaderArgs) {
  return openExportDownload(params.id, new URL(request.url).searchParams.get('token'));
}
