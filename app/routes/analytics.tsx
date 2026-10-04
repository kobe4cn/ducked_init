// app/routes/analytics.tsx —— 分析（有结果层查看权限的成员）：本租户分析模板任务产出的结果快照，最新的在前；已过期的标灰、不能打开
import { Link } from 'react-router';
import type { Route } from './+types/analytics';
import { requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { TEMPLATES } from '~/.server/pipeline/templates';
import { listSnapshots, SNAPSHOT_RETENTION_DAYS, type SnapshotTemplate } from '~/.server/snapshots';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { StatusText } from '~/components/status-text';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { cn } from '~/lib/utils';

export function meta({}: Route.MetaArgs) {
  return [{ title: '分析 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'results:read');
  const snapshots = await listSnapshots(member.tenant.id);
  return {
    email: member.email,
    nav: navFor(member),
    retentionDays: SNAPSHOT_RETENTION_DAYS,
    snapshots: snapshots.map(s => ({
      id: s.id,
      templateLabel: TEMPLATES[s.template as SnapshotTemplate]?.label ?? s.template,
      asOf: typeof s.params.asOf === 'string' ? s.params.asOf : null,
      rowCount: s.rowCount,
      expired: !!s.expiredAt,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    })),
  };
}

const time = (iso: string) => new Date(iso).toLocaleString('zh-CN');

export default function Analytics({ loaderData }: Route.ComponentProps) {
  const { email, nav, retentionDays, snapshots } = loaderData;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="分析" description={`分析模板每次运行在结果层写下一份快照，只含 consumer_id 与分值，保留 ${retentionDays} 天。点开快照查看各人群与消费者明细。`} />

      {snapshots.length ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模板</TableHead>
                <TableHead>参考日期</TableHead>
                <TableHead>消费者</TableHead>
                <TableHead>创建时间</TableHead>
                <TableHead>过期时间</TableHead>
                <TableHead>状态</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshots.map(s => (
                <TableRow key={s.id} data-snapshot={s.id} className={cn(s.expired && 'text-slate-400')}>
                  <TableCell>
                    {s.expired ? s.templateLabel : <Link to={`/analytics/snapshots/${s.id}`} className="font-medium hover:underline">{s.templateLabel}</Link>}
                  </TableCell>
                  <TableCell>{s.asOf ?? '—'}</TableCell>
                  <TableCell>{s.rowCount.toLocaleString('zh-CN')}</TableCell>
                  <TableCell className={cn(!s.expired && 'text-slate-500')}>{time(s.createdAt)}</TableCell>
                  <TableCell className={cn(!s.expired && 'text-slate-500')}>{time(s.expiresAt)}</TableCell>
                  <TableCell>
                    {s.expired
                      ? <StatusText tone="none" data-snapshot-status="expired">已过期</StatusText>
                      : <StatusText tone="ok" data-snapshot-status="available">可查看</StatusText>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">还没有结果快照。RFM 分层等分析模板运行成功后，快照会出现在这里。</div>
      )}
    </AppShell>
  );
}
