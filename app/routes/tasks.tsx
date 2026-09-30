// app/routes/tasks.tsx —— 任务（需登录，任何角色）：本租户最近的任务及其状态
import type { Route } from './+types/tasks';
import { requireMember } from '~/.server/auth';
import { navFor } from '~/.server/nav';
import { listTasks, TASK_PAGE_SIZE, TASK_STATUS_LABELS } from '~/.server/tasks';
import { AppShell } from '~/components/app-shell';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '任务 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  const tasks = await listTasks(member.tenant.id);
  return {
    email: member.email,
    nav: navFor(member),
    pageSize: TASK_PAGE_SIZE,
    tasks: tasks.map(t => ({
      id: t.id,
      kind: t.kind,
      kindLabel: t.kindLabel,
      status: t.status,
      statusLabel: TASK_STATUS_LABELS[t.status],
      error: t.error,
      createdAt: t.createdAt.toISOString(),
      startedAt: t.startedAt?.toISOString() ?? null,
      finishedAt: t.finishedAt?.toISOString() ?? null,
    })),
  };
}

const STATUS_VARIANTS = { queued: 'outline', running: 'secondary', succeeded: 'default', failed: 'destructive' } as const;
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

export default function Tasks({ loaderData }: Route.ComponentProps) {
  const { email, nav, pageSize, tasks } = loaderData;
  return (
    <AppShell email={email} nav={nav}>
      <Card>
        <CardHeader>
          <CardTitle>任务</CardTitle>
          <CardDescription>本租户最近 {pageSize} 个任务，按提交时间倒序。超出并发上限的任务排队等待。</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>任务</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>提交时间</TableHead>
                <TableHead>开始时间</TableHead>
                <TableHead>结束时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map(t => (
                <TableRow key={t.id} data-task-kind={t.kind} data-task-status={t.status}>
                  <TableCell>
                    {t.kindLabel}
                    {t.error && <div className="text-xs whitespace-normal text-destructive">{t.error}</div>}
                  </TableCell>
                  <TableCell><Badge variant={STATUS_VARIANTS[t.status]}>{t.statusLabel}</Badge></TableCell>
                  <TableCell className="text-muted-foreground">{time(t.createdAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{time(t.startedAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{time(t.finishedAt)}</TableCell>
                </TableRow>
              ))}
              {!tasks.length && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">暂无任务</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </AppShell>
  );
}
