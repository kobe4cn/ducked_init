// app/routes/workbench.tsx —— 数据查询工作台（有沙箱权限的分析师、数据工程师，ADR-0036）：写一条只读 SQL，在本租户只读挂载的数据湖上执行，
// 只能读标准层 silver、结果层 gold、自己的沙箱与分享给自己的沙箱表，结果最多 1 万行、不导出；执行中可以取消（中止请求即中断查询），每次查询都记进审计日志。
// 填上表名可以把 SELECT 的结果保存为个人沙箱表（SANDBOX_TTL_DAYS 天后过期），「我的沙箱表」列出表名、行数、过期时间与分享给了谁，
// 可以按邮箱分享给本租户有沙箱权限的成员或撤销；「分享给我的」列出别人分享来的表（只读，在查询里按 sandbox_<主人>.<表名> 读）。
// 左侧目录树按 标准层 / 结果层 / 我的沙箱 / 分享给我的 列出能读的表、字段类型、行数与湖中位置，点表名把带引号的引用插进 SQL 框
import { useRef } from 'react';
import { data, Form, Link, useNavigation } from 'react-router';
import { AlertTriangle, CheckCircle2, ChevronRight, CircleAlert, Table2 } from 'lucide-react';
import type { Route } from './+types/workbench';
import { requirePermission } from '~/.server/access';
import type { CurrentMember } from '~/.server/auth';
import { navFor } from '~/.server/nav';
import {
  listCatalog, listSandboxTables, listSharedWithMe, runQuery, SANDBOX_TTL_DAYS, sandboxSchema, saveAsSandbox, shareSandboxTable, unshareSandboxTable,
  WORKBENCH_ROWS, WORKBENCH_TIMEOUT_MS, WorkbenchError, type CatalogEntry, type WorkbenchCatalog,
} from '~/.server/workbench';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '查询 · CRM 数据分析平台' }];
}

// 响应里有查询结果：浏览器与中间代理都不留副本
export const headers = () => ({ 'Cache-Control': 'no-store' });

/** 目录树；读不出来时给出原因，页面其余部分照常 */
async function loadCatalog(member: CurrentMember): Promise<{ catalog: WorkbenchCatalog | null; catalogError?: string }> {
  try {
    return { catalog: await listCatalog(member) };
  } catch (e) {
    if (e instanceof WorkbenchError) return { catalog: null, catalogError: e.message };
    throw e;
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sandbox');
  return {
    ...await loadCatalog(member),
    email: member.email, nav: navFor(member), maxRows: WORKBENCH_ROWS, timeoutSeconds: WORKBENCH_TIMEOUT_MS / 1000,
    sandbox: sandboxSchema(member.memberId), sandboxTables: await listSandboxTables(member), sharedWithMe: await listSharedWithMe(member),
    ttlDays: SANDBOX_TTL_DAYS,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'sandbox');
  const form = await request.formData();
  const sql = String(form.get('sql') ?? '');
  const name = String(form.get('name') ?? '').trim();
  const intent = String(form.get('intent') ?? 'query');
  const email = String(form.get('email') ?? '');
  try {
    if (intent === 'save') return { sql, name, saved: await saveAsSandbox(member, name, sql, request.signal) };
    if (intent === 'share') {
      return { sql: '', name: '', notice: `已把 ${name} 分享给 ${await shareSandboxTable(member, name, email)}` };
    }
    if (intent === 'unshare') {
      return { sql: '', name: '', notice: `已撤销 ${name} 对 ${await unshareSandboxTable(member, name, email)} 的分享` };
    }
    return { sql, name, result: await runQuery(member, sql, request.signal) };
  } catch (e) {
    if (e instanceof WorkbenchError) return data({ sql, name, intent, error: e.message }, { status: e.status });
    throw e;
  }
}

const dateTime = (d: Date | string) => new Date(d).toLocaleString('zh-CN', { hour12: false });

const ERROR_TITLES: Record<string, string> = { save: '沙箱表没有保存', share: '没有分享', unshare: '没有撤销分享' };

/** 目录树的四节：标题与说明 */
const CATALOG_SECTIONS: { key: keyof WorkbenchCatalog; title: string; empty: string }[] = [
  { key: 'silver', title: '标准层 silver', empty: '还没有标准层表' },
  { key: 'gold', title: '结果层 gold', empty: '还没有结果层表' },
  { key: 'mine', title: '我的沙箱', empty: '还没有沙箱表' },
  { key: 'shared', title: '分享给我的', empty: '没有人分享表给你' },
];

/** 左侧目录树：schema → 表（行数、位置）→ 字段（类型）；点表名调用 onInsert 插入引用 */
function CatalogTree({ catalog, error, onInsert }: { catalog: WorkbenchCatalog | null; error?: string; onInsert: (ref: string) => void }) {
  return (
    <aside className="space-y-3 self-start rounded-2xl border bg-white p-4 text-sm shadow-sm" data-catalog-tree>
      <h2 className="text-base font-semibold">目录</h2>
      {!catalog ? <p className="flex items-start gap-1 text-red-600"><CircleAlert className="size-4 shrink-0" />{error}</p> : CATALOG_SECTIONS.map(({ key, title, empty }) => (
        <details key={key} open className="group/section" data-section={key}>
          <summary className="flex cursor-pointer list-none items-center gap-1 font-medium">
            <ChevronRight className="size-4 transition-transform group-open/section:rotate-90" />
            {title}<span className="text-slate-400">{catalog[key].length}</span>
          </summary>
          {catalog[key].length === 0 ? <p className="py-1 pl-5 text-slate-400">{empty}</p> : (
            <ul className="space-y-1 py-1 pl-3">
              {catalog[key].map(t => <CatalogTableItem key={t.ref} table={t} onInsert={onInsert} />)}
            </ul>
          )}
        </details>
      ))}
      <span hidden data-catalog-end />
    </aside>
  );
}

function CatalogTableItem({ table, onInsert }: { table: CatalogEntry; onInsert: (ref: string) => void }) {
  return (
    <li>
      <details className="group/table">
        <summary className="flex cursor-pointer list-none items-center gap-1">
          <ChevronRight className="size-3.5 shrink-0 text-slate-400 transition-transform group-open/table:rotate-90" />
          <Table2 className="size-3.5 shrink-0 text-slate-500" />
          {/* 只插入引用，不展开 */}
          <button
            type="button" title={`插入 ${table.ref}`} data-ref={table.ref} data-rows={table.rows}
            onClick={e => { e.preventDefault(); onInsert(table.ref); }}
            className="truncate font-mono text-left hover:text-primary hover:underline"
          >{table.name}</button>
          <span className="ml-auto shrink-0 text-xs text-slate-400">{`${table.rows.toLocaleString('zh-CN')} 行`}</span>
        </summary>
        <div className="space-y-1 py-1 pl-8 text-xs">
          <p className="break-all font-mono text-slate-500">{table.ref}</p>
          <p className="break-all font-mono text-slate-400" title="数据文件所在目录">{table.location}</p>
          <ul>
            {table.columns.map(c => (
              <li key={c.name} className="flex gap-2 font-mono"><span className="truncate">{c.name}</span><span className="ml-auto shrink-0 text-slate-400">{c.type}</span></li>
            ))}
          </ul>
        </div>
      </details>
    </li>
  );
}

const cell = (v: unknown) => (v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export default function Workbench({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, maxRows, timeoutSeconds, sandbox, sandboxTables, sharedWithMe, ttlDays, catalog, catalogError } = loaderData;
  const sqlBox = useRef<HTMLTextAreaElement>(null);
  /** 在光标处插入表的引用（替换选中的文字） */
  const insertRef = (ref: string) => {
    const box = sqlBox.current;
    if (!box) return;
    box.setRangeText(ref, box.selectionStart, box.selectionEnd, 'end');
    box.focus();
  };
  const running = useNavigation().state === 'submitting';
  const result = actionData && 'result' in actionData ? actionData.result : null;
  const saved = actionData && 'saved' in actionData ? actionData.saved : null;
  const notice = actionData && 'notice' in actionData ? actionData.notice : null;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title="查询"
        description={`对本租户的标准层 silver、结果层 gold 与自己的沙箱 ${sandbox} 执行只读 SQL（SELECT / WITH、DESCRIBE、SHOW、SUMMARIZE、EXPLAIN），最多显示 ${maxRows.toLocaleString('zh-CN')} 行，超过 ${timeoutSeconds} 秒自动中断。每次查询都记入审计日志。`}
      />

      <div className="grid items-start gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <CatalogTree catalog={catalog} error={catalogError} onInsert={insertRef} />
        <div className="min-w-0 space-y-6">
          <Form method="post" className="space-y-3 rounded-2xl border bg-white p-6 shadow-sm">
            <label htmlFor="sql" className="text-sm font-medium">SQL</label>
            <textarea
              id="sql" name="sql" ref={sqlBox} rows={8} required defaultValue={actionData?.sql ?? ''} spellCheck={false}
              placeholder={'SELECT * FROM silver.customer LIMIT 100\n-- 结果层的表名带横线，要加引号：gold."rfm__<任务 ID>"'}
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={running}>{running ? '执行中…' : '执行'}</Button>
              {/* 发起新的导航会中止进行中的提交，服务端随之中断查询 */}
              {running && <Button asChild variant="outline"><Link to="/workbench" replace>取消</Link></Button>}
              <span className="text-sm text-slate-400">同一租户同时只能运行一个查询。</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t pt-3">
              <Label htmlFor="name">保存为沙箱表</Label>
              <Input
                id="name" name="name" defaultValue={actionData?.name ?? ''} placeholder="表名，如 top_customers" spellCheck={false}
                className="w-64 font-mono"
              />
              <Button type="submit" name="intent" value="save" variant="outline" disabled={running}>保存</Button>
              <span className="text-sm text-slate-400">{`把 SELECT 的结果存为 ${sandbox}.<表名>，同名表覆盖，${ttlDays} 天后过期。`}</span>
            </div>
          </Form>

          {saved && (
            <Alert role="status" data-sandbox-saved>
              <CheckCircle2 className="text-emerald-600" />
              <AlertTitle>{`已保存沙箱表 ${saved.name}`}</AlertTitle>
              <AlertDescription>{`${saved.rowCount.toLocaleString('zh-CN')} 行，${dateTime(saved.expiresAt)} 过期。`}</AlertDescription>
            </Alert>
          )}

          {notice && (
            <Alert role="status" data-sandbox-shared>
              <CheckCircle2 className="text-emerald-600" />
              <AlertTitle>{notice}</AlertTitle>
            </Alert>
          )}

          {actionData && 'error' in actionData && (
            <Alert variant="destructive" role="alert">
              <CircleAlert />
              <AlertTitle>{ERROR_TITLES[actionData.intent] ?? '查询没有完成'}</AlertTitle>
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

          <div className="space-y-3 rounded-2xl border bg-white p-6 shadow-sm" data-sandbox-tables>
            <h2 className="text-base font-semibold">我的沙箱表</h2>
            {sandboxTables.length === 0 ? (
              <p className="text-sm text-slate-500">{`还没有沙箱表。执行 SELECT 前填上表名并点「保存」，结果会存进 ${sandbox}，可以在查询里读。`}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>表名</TableHead>
                    <TableHead>行数</TableHead>
                    <TableHead>保存时间</TableHead>
                    <TableHead>过期时间</TableHead>
                    <TableHead>分享给</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sandboxTables.map(t => (
                    <TableRow key={t.name}>
                      <TableCell className="font-mono">{`${sandbox}.${t.name}`}</TableCell>
                      <TableCell>{t.rowCount.toLocaleString('zh-CN')}</TableCell>
                      <TableCell>{dateTime(t.createdAt)}</TableCell>
                      <TableCell>{dateTime(t.expiresAt)}</TableCell>
                      <TableCell className="space-y-2">
                        {t.sharedWith.map(member => (
                          <Form method="post" key={member} className="flex items-center gap-2">
                            <input type="hidden" name="name" value={t.name} />
                            <input type="hidden" name="email" value={member} />
                            <span>{member}</span>
                            <Button type="submit" name="intent" value="unshare" variant="outline" size="sm">撤销</Button>
                          </Form>
                        ))}
                        <Form method="post" className="flex items-center gap-2">
                          <input type="hidden" name="name" value={t.name} />
                          <Input name="email" type="email" required placeholder="成员邮箱" aria-label={`把 ${t.name} 分享给`} className="h-8 w-48" />
                          <Button type="submit" name="intent" value="share" variant="outline" size="sm">分享</Button>
                        </Form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="text-sm text-slate-400">只能分享给本租户有沙箱权限的成员（查看者除外）。对方只能读，不能改，表过期后分享随之失效。</p>
          </div>

          <div className="space-y-3 rounded-2xl border bg-white p-6 shadow-sm" data-shared-with-me>
            <h2 className="text-base font-semibold">分享给我的</h2>
            {sharedWithMe.length === 0 ? (
              <p className="text-sm text-slate-500">还没有人分享沙箱表给你。别人分享后，表会列在这里，可以在查询里只读。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>主人</TableHead>
                    <TableHead>表名</TableHead>
                    <TableHead>过期时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sharedWithMe.map(t => (
                    <TableRow key={`${t.schema}.${t.name}`}>
                      <TableCell>{t.owner}</TableCell>
                      <TableCell className="font-mono">{`${t.schema}.${t.name}`}</TableCell>
                      <TableCell>{dateTime(t.expiresAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
