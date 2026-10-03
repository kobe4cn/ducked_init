// app/routes/audit.tsx —— 审计日志（仅管理员）：本租户成员与角色变更等关键操作
import type { Route } from './+types/audit';
import { requirePermission } from '~/.server/access';
import { AUDIT_PAGE_SIZE, listAuditLogs } from '~/.server/audit';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '审计日志 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'audit:read');
  const logs = await listAuditLogs(member.tenant.id);
  return {
    email: member.email,
    nav: navFor(member),
    pageSize: AUDIT_PAGE_SIZE,
    logs: logs.map(l => ({ ...l, at: l.at.toISOString() })),
  };
}

export default function Audit({ loaderData }: Route.ComponentProps) {
  const { email, nav, pageSize, logs } = loaderData;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="审计日志" description={`本租户最近 ${pageSize} 条关键操作记录，按时间倒序。`} />

      {logs.length ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>操作者</TableHead>
                <TableHead>操作</TableHead>
                <TableHead>内容</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map(l => (
                <TableRow key={l.id} data-audit-action={l.action}>
                  <TableCell className="text-slate-500">{new Date(l.at).toLocaleString('zh-CN')}</TableCell>
                  <TableCell>{l.actor}</TableCell>
                  <TableCell>{l.action}</TableCell>
                  <TableCell>{l.summary}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">暂无记录。邀请成员、修改角色、发布映射等关键操作会记录在这里。</div>
      )}
    </AppShell>
  );
}
