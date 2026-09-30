// app/components/tenant-status-badge.tsx —— 运营后台里租户的状态：正常 / 已停用
import { Badge } from '~/components/ui/badge';

export function TenantStatusBadge({ suspended }: { suspended: boolean }) {
  return suspended ? <Badge variant="destructive">已停用</Badge> : <Badge variant="secondary">正常</Badge>;
}
