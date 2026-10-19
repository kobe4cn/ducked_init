// app/routes/workbench.tsx —— 数据查询工作台（有沙箱权限的分析师、数据工程师，ADR-0036）：写一条只读 SQL，在本租户只读挂载的数据湖上执行，
// 只能读标准层 silver 与结果层 gold，结果最多 1 万行、不导出；执行中可以取消（中止请求即中断查询），每次查询都记进审计日志
import { data, Form, Link, useNavigation } from 'react-router';
import { AlertTriangle, CircleAlert } from 'lucide-react';
import type { Route } from './+types/workbench';
import { requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { runQuery, WORKBENCH_ROWS, WORKBENCH_TIMEOUT_MS, WorkbenchError } from '~/.server/workbench';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '查询 · CRM 数据分析平台' }];
}

// 响应里有查询结果：浏览器与中间代理都不留副本
export const headers = () => ({ 'Cache-Control': 'no-store' });

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sandbox');
  return { email: member.email, nav: navFor(member), maxRows: WORKBENCH_ROWS, timeoutSeconds: WORKBENCH_TIMEOUT_MS / 1000 };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'sandbox');
  const sql = String((await request.formData()).get('sql') ?? '');
  try {
    return { sql, result: await runQuery(member, sql, request.signal) };
  } catch (e) {
    if (e instanceof WorkbenchError) return data({ sql, error: e.message }, { status: e.status });
    throw e;
  }
}

const cell = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export default function Workbench({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, maxRows, timeoutSeconds } = loaderData;
  const running = useNavigation().state === 'submitting';
  const result = actionData && 'result' in actionData ? actionData.result : null;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title="查询"
        description={`对本租户的标准层 silver 与结果层 gold 执行只读 SQL（SELECT / WITH、DESCRIBE、SHOW、SUMMARIZE、EXPLAIN），最多显示 ${maxRows.toLocaleString('zh-CN')} 行，超过 ${timeoutSeconds} 秒自动中断。每次查询都记入审计日志。`}
      />

      <Form method="post" className="space-y-3 rounded-2xl border bg-white p-6 shadow-sm">
        <label htmlFor="sql" className="text-sm font-medium">SQL</label>
        <textarea
          id="sql" name="sql" rows={8} required defaultValue={actionData?.sql ?? ''} spellCheck={false}
          placeholder={'SELECT * FROM silver.customer LIMIT 100\n-- 结果层的表名带横线，要加引号：gold."rfm__<任务 ID>"'}
          className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={running}>{running ? '执行中…' : '执行'}</Button>
          {/* 发起新的导航会中止进行中的提交，服务端随之中断查询 */}
          {running && <Button asChild variant="outline"><Link to="/workbench" replace>取消</Link></Button>}
          <span className="text-sm text-slate-400">同一租户同时只能运行一个查询。</span>
        </div>
      </Form>

      {actionData && 'error' in actionData && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>查询没有完成</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {result && (
        <div className="space-y-3 rounded-2xl border bg-white p-6 shadow-sm" data-workbench-result>
          <p className="text-sm text-slate-500">
            {`${result.rows.length.toLocaleString('zh-CN')} 行，耗时 ${result.durationMs} 毫秒`}
            {result.truncated && (
              <span className="ml-2 inline-flex items-center gap-1 text-amber-600" data-truncated>
                <AlertTriangle className="size-4" />{`结果超过 ${maxRows.toLocaleString('zh-CN')} 行，只显示前 ${maxRows.toLocaleString('zh-CN')} 行`}
              </span>
            )}
          </p>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {result.columns.map((c, i) => <TableHead key={i} title={c.type}>{c.name}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row, i) => (
                  <TableRow key={i}>
                    {row.map((v, j) => <TableCell key={j} className="font-mono">{cell(v)}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </AppShell>
  );
}
