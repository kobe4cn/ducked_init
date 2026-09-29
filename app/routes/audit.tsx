// app/routes/audit.tsx —— 审计日志（仅管理员）：本租户成员与角色变更等关键操作
import type { Route } from './+types/audit';
import { requirePermission } from '~/.server/access';
import { AUDIT_PAGE_SIZE, listAuditLogs } from '~/.server/audit';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
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
      <Card>
        <CardHeader>
          <CardTitle>审计日志</CardTitle>
          <CardDescription>本租户最近 {pageSize} 条关键操作记录，按时间倒序。</CardDescription>
        </CardHeader>
        <CardContent>
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
                  <TableCell className="text-muted-foreground">{new Date(l.at).toLocaleString('zh-CN')}</TableCell>
                  <TableCell>{l.actor}</TableCell>
                  <TableCell>{l.action}</TableCell>
                  <TableCell>{l.summary}</TableCell>
                </TableRow>
              ))}
              {!logs.length && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">暂无记录</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </AppShell>
  );
}
