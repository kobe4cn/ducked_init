// app/routes/audit.tsx —— 审计日志（仅管理员）：本租户成员与角色变更等关键操作
import { Form } from 'react-router';
import type { Route } from './+types/audit';
import { requirePermission } from '~/.server/access';
import { AUDIT_PAGE_SIZE, auditActionOptions, listAuditLogs, normalizeAuditAction } from '~/.server/audit';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { useT } from '~/lib/i18n';

export function meta({}: Route.MetaArgs) {
  return [{ title: '审计日志 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'audit:read');
  // 不认识的值按「全部」处理：规范化后传给查询与下拉框回显
  const action = normalizeAuditAction(new URL(request.url).searchParams.get('action'));
  const logs = await listAuditLogs(member.tenant.id, action ?? undefined);
  return {
    email: member.email,
    nav: navFor(member),
    pageSize: AUDIT_PAGE_SIZE,
    action,
    actionOptions: auditActionOptions(),
    logs: logs.map(l => ({ ...l, at: l.at.toISOString() })),
  };
}

export default function Audit({ loaderData }: Route.ComponentProps) {
  const { email, nav, pageSize, action, actionOptions, logs } = loaderData;
  const t = useT();
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="审计日志" description={`本租户最近 ${pageSize} 条关键操作记录，按时间倒序。`} />

      <Form method="get" preventScrollReset className="mb-4 flex max-w-2xl items-center gap-2">
        <label htmlFor="audit-action" className="text-sm text-slate-500">{t('按动作筛选')}</label>
        <select
          key={action ?? ''}
          id="audit-action"
          name="action"
          defaultValue={action ?? ''}
          className="rounded-lg border bg-white px-2 py-1.5"
          data-audit-action-select
        >
          <option value="">{t('全部')}</option>
          {actionOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <Button type="submit" variant="outline" size="sm">{t('筛选')}</Button>
      </Form>

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
