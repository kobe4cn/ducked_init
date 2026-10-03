// app/components/tenant-status.tsx —— 运营后台里租户的状态：正常 / 已停用
import { StatusText } from '~/components/status-text';

export function TenantStatus({ suspended }: { suspended: boolean }) {
  return suspended ? <StatusText tone="bad">已停用</StatusText> : <StatusText tone="ok">正常</StatusText>;
}
