// app/routes/ops.audit.tsx —— 运营者审计日志：运营者对各租户的操作，以及运营者登录、绑定 TOTP、新增运营者等平台级事件
import type { Route } from './+types/ops.audit';
import { AUDIT_PAGE_SIZE, listOperatorAuditLogs } from '~/.server/audit';
import { requireOperator } from '~/.server/ops-auth';
import { OpsShell } from '~/components/ops-shell';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '审计日志 · 运营后台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const operator = await requireOperator(request);
  const logs = await listOperatorAuditLogs();
  return {
    email: operator.email,
    pageSize: AUDIT_PAGE_SIZE,
    logs: logs.map(l => ({ ...l, at: l.at.toISOString() })),
  };
}

export default function OpsAudit({ loaderData }: Route.ComponentProps) {
  const { email, pageSize, logs } = loaderData;
  return (
    <OpsShell email={email}>
      <Card>
        <CardHeader>
          <CardTitle>审计日志</CardTitle>
          <CardDescription>最近 {pageSize} 条运营者操作与平台级事件，按时间倒序。成员在租户内的操作不在此显示。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>操作者</TableHead>
                <TableHead>操作</TableHead>
                <TableHead>租户</TableHead>
                <TableHead>内容</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map(l => (
                <TableRow key={l.id} data-audit-action={l.action}>
                  <TableCell className="text-muted-foreground">{new Date(l.at).toLocaleString('zh-CN')}</TableCell>
                  <TableCell>{l.actor}</TableCell>
                  <TableCell>{l.action}</TableCell>
                  <TableCell>{l.tenant ?? <span className="text-muted-foreground">平台</span>}</TableCell>
                  <TableCell>{l.summary}</TableCell>
                </TableRow>
              ))}
              {!logs.length && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">暂无记录</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </OpsShell>
  );
}
