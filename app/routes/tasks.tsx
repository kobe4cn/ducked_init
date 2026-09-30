// app/routes/tasks.tsx —— 任务（需登录，任何角色）：本租户最近的任务及其状态、成功任务的结果
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

// 工作进程回传的结果（pipeline/worker.ts）：各类任务都带本租户数据湖的表与行数，以及运行时生效的配额
interface TaskResult {
  tables?: { name: string; rows: number }[];
  engine?: { memoryLimit: string; threads: number };
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
      result: t.status === 'succeeded' ? (t.result as TaskResult | null) : null,
      createdAt: t.createdAt.toISOString(),
      startedAt: t.startedAt?.toISOString() ?? null,
      finishedAt: t.finishedAt?.toISOString() ?? null,
    })),
  };
}

const STATUS_VARIANTS = { queued: 'outline', running: 'secondary', succeeded: 'default', failed: 'destructive' } as const;
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

function ResultDetails({ result: { tables = [], engine } }: { result: TaskResult }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">查看结果</summary>
      <div className="mt-1 space-y-1 pl-3">
        {tables.length ? (
          <ul>
            {tables.map(t => (
              <li key={t.name} data-result-table={t.name}>
                {`${t.name}：`}<span className="text-foreground">{`${t.rows.toLocaleString('zh-CN')} 行`}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div>数据湖里还没有表</div>
        )}
        {engine && <div>{`运行配额：内存 ${engine.memoryLimit} · ${engine.threads} 线程`}</div>}
      </div>
    </details>
  );
}

export default function Tasks({ loaderData }: Route.ComponentProps) {
  const { email, nav, pageSize, tasks } = loaderData;
  return (
    <AppShell email={email} nav={nav}>
      <Card>
        <CardHeader>
          <CardTitle>任务</CardTitle>
          <CardDescription>本租户最近 {pageSize} 个任务，按提交时间倒序。超出并发上限的任务排队等待；成功的任务可展开查看结果。</CardDescription>
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
                    {t.result && <ResultDetails result={t.result} />}
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
