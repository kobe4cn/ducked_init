// app/routes/llm-usage.tsx —— 「模型调用」页（仅管理员，#303）：按用途看近 7/30 天的调用次数、token、平均与 P95 耗时、
// Schema 通过率与错误率，并列出最近的调用明细（分页）；失败的调用标红、错误摘要截到 120 字（全文在 title）
import type { Route } from './+types/llm-usage';
import { Link } from 'react-router';
import { requirePermission } from '~/.server/access';
import { LLM_CALL_PAGE_SIZE, listCalls, parseDays, usageByPurpose, type PurposeUsage } from '~/.server/llm-usage';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { SectionHeader } from '~/components/section-header';
import { StatTile } from '~/components/stat-tile';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { cn } from '~/lib/utils';

export function meta({}: Route.MetaArgs) {
  return [{ title: '模型调用 · CRM 数据分析平台' }];
}

const n = (v: number) => v.toLocaleString('zh-CN');
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : '—');
const brief = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'model_provider:manage');
  const url = new URL(request.url);
  const days = parseDays(url.searchParams.get('days'));
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const [usage, calls] = await Promise.all([
    usageByPurpose(member.tenant.id, days),
    listCalls(member.tenant.id, days, page),
  ]);
  return {
    email: member.email,
    nav: navFor(member),
    days,
    pageSize: LLM_CALL_PAGE_SIZE,
    usage,
    calls: { ...calls, rows: calls.rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })) },
  };
}

/** 统计表的一行（用途行与总计行共用） */
function UsageRow({ row, isTotal = false }: { row: PurposeUsage; isTotal?: boolean }) {
  const checked = row.schemaChecked;
  return (
    <TableRow data-purpose={row.purpose} className={isTotal ? 'font-medium' : undefined}>
      <TableCell>{isTotal ? '总计' : row.purpose}</TableCell>
      <TableCell data-col="calls">{n(row.calls)}</TableCell>
      <TableCell data-col="tokens" className="text-slate-500">{`${n(row.promptTokens)} / ${n(row.completionTokens)}`}</TableCell>
      <TableCell data-col="avg">{`${n(row.avgMs)} ms`}</TableCell>
      <TableCell data-col="p95">{`${n(row.p95Ms)} ms`}</TableCell>
      <TableCell data-col="schema">{checked ? `${row.schemaValid}/${checked}（${pct(row.schemaValid, checked)}）` : '—'}</TableCell>
      <TableCell data-col="errors" className={row.errors ? 'text-red-600' : 'text-slate-500'}>{`${n(row.errors)}（${pct(row.errors, row.calls)}）`}</TableCell>
    </TableRow>
  );
}

/** 明细里一次调用的 Schema 校验结果：没校验（null）显示「—」 */
function SchemaResult({ valid }: { valid: boolean | null }) {
  if (valid === null) return <>—</>;
  return valid ? <span className="text-emerald-600">通过</span> : <span className="text-red-600">未通过</span>;
}

/** 上一页 / 下一页 */
function Pager({ page, pages, pageSize, href }: { page: number; pages: number; pageSize: number; href: (p: number) => string }) {
  return (
    <div className="flex items-center justify-between text-sm text-slate-500">
      <span data-page={page}>{`第 ${page} / ${pages} 页，每页 ${pageSize} 条`}</span>
      <div className="flex gap-3">
        {page > 1 && <Link to={href(page - 1)} className="hover:underline">← 上一页</Link>}
        {page < pages && <Link to={href(page + 1)} className="hover:underline">下一页 →</Link>}
      </div>
    </div>
  );
}

export default function LlmUsage({ loaderData }: Route.ComponentProps) {
  const { email, nav, days, pageSize, usage, calls } = loaderData;
  const href = (p: number) => `/llm-usage?days=${days}&page=${p}`;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="模型调用" description={`近 ${days} 天本租户的模型调用：次数、token、耗时与质量（Schema 通过率、错误率），不含草稿采纳率。`} />

      <PillTabs
        tabs={[
          { key: '7', label: '近 7 天', href: '/llm-usage?days=7' },
          { key: '30', label: '近 30 天', href: '/llm-usage?days=30' },
        ]}
        current={String(days)}
      />

      {usage.total.calls === 0 ? (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">
          暂无模型调用。测试连通性、生成映射草稿、AI 解读等每次调用（成功与失败）都会记在这里，可以先到
          <Link to="/model-provider" className="mx-1 underline">模型服务</Link>
          测试一次连通性。
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatTile label="总调用" value={n(usage.total.calls)} hint={`近 ${days} 天，全部用途`} />
            <StatTile label="总 token" value={n(usage.total.promptTokens + usage.total.completionTokens)}
              hint={`输入 ${n(usage.total.promptTokens)} · 输出 ${n(usage.total.completionTokens)}`} />
            <StatTile label="P95 耗时" value={`${n(usage.total.p95Ms)} ms`} hint="全部用途合计" />
            <StatTile label="错误率" value={pct(usage.total.errors, usage.total.calls)} tone={usage.total.errors ? 'text-red-600' : undefined}
              hint={`${n(usage.total.errors)} 次失败`} />
          </div>

          <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
            <SectionHeader title="按用途统计">Schema 通过率的分母只算做了校验的调用（工具对话与向量检索没有 Schema）；P95 按每次调用的原始耗时算，不是各用途的平均。</SectionHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用途</TableHead>
                  <TableHead>调用</TableHead>
                  <TableHead>token（输入 / 输出）</TableHead>
                  <TableHead>平均耗时</TableHead>
                  <TableHead>P95 耗时</TableHead>
                  <TableHead>Schema 通过率</TableHead>
                  <TableHead>错误</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.rows.map(r => <UsageRow key={r.purpose} row={r} />)}
                <UsageRow row={usage.total} isTotal />
              </TableBody>
            </Table>
          </div>

          <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
            <SectionHeader title="最近调用">按时间倒序，失败的红字标出；错误摘要截到 120 字，悬停可看全文。</SectionHeader>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>用途</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>输入 token</TableHead>
                  <TableHead>输出 token</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead>Schema</TableHead>
                  <TableHead>错误</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {calls.rows.map(r => (
                  <TableRow key={r.id} data-call-id={r.id}>
                    <TableCell className="text-slate-500">{new Date(r.createdAt).toLocaleString('zh-CN')}</TableCell>
                    <TableCell>{r.purpose}</TableCell>
                    <TableCell className="text-slate-500">{r.model}</TableCell>
                    <TableCell>{r.promptTokens === null ? '—' : n(r.promptTokens)}</TableCell>
                    <TableCell>{r.completionTokens === null ? '—' : n(r.completionTokens)}</TableCell>
                    <TableCell>{`${n(r.durationMs)} ms`}</TableCell>
                    <TableCell><SchemaResult valid={r.schemaValid} /></TableCell>
                    <TableCell className={cn('max-w-2xl truncate', r.error ? 'text-red-600' : 'text-slate-400')} title={r.error ?? undefined}>
                      {r.error ? brief(r.error) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pager page={calls.page} pages={calls.pages} pageSize={pageSize} href={href} />
          </div>
        </>
      )}
    </AppShell>
  );
}
