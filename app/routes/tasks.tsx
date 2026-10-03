// app/routes/tasks.tsx —— 任务（需登录，任何角色）：本租户最近的任务及其状态、成功任务的结果
import type { Route } from './+types/tasks';
import { requireMember } from '~/.server/auth';
import { navFor } from '~/.server/nav';
import { listTasks, TASK_PAGE_SIZE, TASK_STATUS_LABELS } from '~/.server/tasks';
import { entityLabel } from '~/lib/canonical-model';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { StatusText, TASK_TONES } from '~/components/status-text';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '任务 · CRM 数据分析平台' }];
}

// 工作进程回传的结果（pipeline/worker.ts）：各类任务都带按表的结果与运行时生效的配额。各类任务的表结构不同：
// 盘点与采集是 { name, rows }，同步是 { table, rows }（失败或源端已删除的表没有 rows），核对是 { table, sourceRows }；
// 合并到标准层按映射给出 { entity, table, rows }（失败或跳过的映射没有 rows）
type RawTable = { name?: string; table?: string; rows?: unknown; sourceRows?: unknown };
type RawMapping = { entity?: string; table?: string; rows?: unknown };
interface RawResult {
  tables?: RawTable[];
  mappings?: RawMapping[];
  engine?: { memoryLimit: string; threads: number };
}
interface TaskResult {
  /** rows 为 null：这张表没有行数（同步失败、源端已删除、核对时读不了） */
  tables: { name: string; rows: number | null }[];
  engine?: RawResult['engine'];
}

function taskResult(raw: RawResult | null): TaskResult | null {
  if (!raw) return null;
  const tables = (Array.isArray(raw.tables) ? raw.tables : []).map(t => {
    const rows = t.rows ?? t.sourceRows;
    return { name: String(t.name ?? t.table ?? ''), rows: typeof rows === 'number' ? rows : null };
  });
  for (const m of Array.isArray(raw.mappings) ? raw.mappings : []) {
    tables.push({ name: `${entityLabel(String(m.entity ?? ''))} ← ${String(m.table ?? '')}`, rows: typeof m.rows === 'number' ? m.rows : null });
  }
  return { tables, engine: raw.engine };
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
      result: t.status === 'succeeded' ? taskResult(t.result as RawResult | null) : null,
      createdAt: t.createdAt.toISOString(),
      startedAt: t.startedAt?.toISOString() ?? null,
      finishedAt: t.finishedAt?.toISOString() ?? null,
    })),
  };
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

function ResultDetails({ result: { tables, engine } }: { result: TaskResult }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">查看结果</summary>
      <div className="mt-1 space-y-1 pl-3">
        {tables.length ? (
          <ul>
            {tables.map(t => (
              <li key={t.name} data-result-table={t.name}>
                {`${t.name}：`}<span className="text-foreground">{t.rows === null ? '—' : `${t.rows.toLocaleString('zh-CN')} 行`}</span>
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
      <PageHeader title="任务" description={`本租户最近 ${pageSize} 个任务，按提交时间倒序。超出并发上限的任务排队等待；成功的任务可展开查看结果。`} />

      {tasks.length ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
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
                    {t.error && <div className="text-xs whitespace-normal text-red-600">{t.error}</div>}
                    {t.result && <ResultDetails result={t.result} />}
                  </TableCell>
                  <TableCell><StatusText tone={TASK_TONES[t.status]}>{t.statusLabel}</StatusText></TableCell>
                  <TableCell className="text-slate-500">{time(t.createdAt)}</TableCell>
                  <TableCell className="text-slate-500">{time(t.startedAt)}</TableCell>
                  <TableCell className="text-slate-500">{time(t.finishedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">暂无任务。采集、同步、核对、合并等后台任务提交后会出现在这里。</div>
      )}
    </AppShell>
  );
}
