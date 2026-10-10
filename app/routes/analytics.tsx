// app/routes/analytics.tsx —— 分析（有结果层查看权限的成员）：本租户分析模板任务产出的结果快照（带所用的模板定义版本），最新的在前；已过期的标灰、不能打开，登记时数据不完整的标「数据不完整」（详情在快照页）。
// 有定义查看权限的成员从这里进入 RFM 模板参数页，有起草权限的成员从这里新建指标；指标与标签（template 为 metric:<键>、tag:<键>）的快照链接到它们的定义页（ADR-0025）
import { Plus, SlidersHorizontal } from 'lucide-react';
import { Link } from 'react-router';
import type { Route } from './+types/analytics';
import { can, requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { TEMPLATES } from '~/.server/pipeline/templates';
import { listSnapshots, SNAPSHOT_RETENTION_DAYS, type SnapshotTemplate } from '~/.server/snapshots';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { StatusText } from '~/components/status-text';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { cn } from '~/lib/utils';

/** 指标与标签快照的 template：<种类>:<键> */
const DSL_TEMPLATE = /^(metric|tag):(.+)$/;

export function meta({}: Route.MetaArgs) {
  return [{ title: '分析 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'results:read');
  const snapshots = await listSnapshots(member.tenant.id);
  return {
    email: member.email,
    nav: navFor(member),
    canReadDefinitions: can(member.role, 'definitions:read'),
    canDraftDefinitions: can(member.role, 'definitions:draft'),
    retentionDays: SNAPSHOT_RETENTION_DAYS,
    snapshots: snapshots.map(s => {
      const dsl = DSL_TEMPLATE.exec(s.template);
      return {
        id: s.id,
        templateLabel: dsl ? dsl[2]! : TEMPLATES[s.template as SnapshotTemplate]?.label ?? s.template,
        /** 指标与标签的快照链接到定义页，其余链接到快照页 */
        href: dsl ? `/analytics/definitions/${dsl[1]}/${dsl[2]}` : `/analytics/snapshots/${s.id}`,
        asOf: typeof s.params.asOf === 'string' ? s.params.asOf : null,
        definitionVersion: s.definitionVersion,
        rowCount: s.rowCount,
        expired: !!s.expiredAt,
        incomplete: !!s.incomplete,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
      };
    }),
  };
}

const time = (iso: string) => new Date(iso).toLocaleString('zh-CN');

export default function Analytics({ loaderData }: Route.ComponentProps) {
  const { email, nav, canReadDefinitions, canDraftDefinitions, retentionDays, snapshots } = loaderData;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="分析" description={`分析模板每次运行在结果层写下一份快照，只含 consumer_id 与分值，保留 ${retentionDays} 天。点开快照查看各人群与消费者明细。`}
        actions={(canReadDefinitions || canDraftDefinitions) && (
          <>
            {canReadDefinitions && <Button asChild variant="outline"><Link to="/analytics/templates/rfm"><SlidersHorizontal />RFM 模板参数</Link></Button>}
            {canDraftDefinitions && <Button asChild><Link to="/analytics/definitions/new"><Plus />新建指标</Link></Button>}
          </>
        )}
      />

      {snapshots.length ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模板</TableHead>
                <TableHead>参考日期</TableHead>
                <TableHead>参数</TableHead>
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
                    {s.expired ? s.templateLabel : <Link to={s.href} className="font-medium hover:underline">{s.templateLabel}</Link>}
                  </TableCell>
                  <TableCell>{s.asOf ?? '—'}</TableCell>
                  <TableCell data-definition-version>{s.definitionVersion ? `定义第 ${s.definitionVersion} 版` : '任务参数'}</TableCell>
                  <TableCell>{s.rowCount.toLocaleString('zh-CN')}</TableCell>
                  <TableCell className={cn(!s.expired && 'text-slate-500')}>{time(s.createdAt)}</TableCell>
                  <TableCell className={cn(!s.expired && 'text-slate-500')}>{time(s.expiresAt)}</TableCell>
                  <TableCell>
                    {s.expired
                      ? <StatusText tone="none" data-snapshot-status="expired">已过期</StatusText>
                      : s.incomplete
                        ? <StatusText tone="pending" data-snapshot-status="incomplete">数据不完整</StatusText>
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
