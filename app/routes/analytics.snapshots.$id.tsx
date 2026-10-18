// app/routes/analytics.snapshots.$id.tsx —— 分析模板快照结果（有结果层查看权限的成员）。RFM：各人群的人数与金额（?tab=segments），
// 按 consumer_id 分页的消费者明细（?tab=consumers&page=N）；其他模板：按 consumer_id 分页的通用明细（?page=N），列取快照表的全部列。
// 登记时有映射最近一次合并失败的快照标「数据不完整」，列出失败的映射。每次请求只读挂载本租户的数据湖读取；页面上只有 consumer_id 与汇总值（分值、订单汇总、各渠道同意等），没有明文。
// 其他租户的快照、已过期的快照返回 404
import { AlertTriangle } from 'lucide-react';
import { data, Link } from 'react-router';
import type { Route } from './+types/analytics.snapshots.$id';
import { requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { TEMPLATES } from '~/.server/pipeline/templates';
import { CONSUMER_PAGE_SIZE, getSnapshot, readRfmSnapshot, readTemplateSnapshot, SnapshotError, type SnapshotTemplate } from '~/.server/snapshots';
import { AppShell } from '~/components/app-shell';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { StatTile } from '~/components/stat-tile';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData ? `${loaderData.snapshot.templateLabel} · ${loaderData.snapshot.asOf}` : '分析'} · CRM 数据分析平台` }];
}

type Tab = 'segments' | 'consumers';

export async function loader({ request, params }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'results:read');
  const snapshot = await getSnapshot(member.tenant.id, params.snapshotId);
  if (!snapshot) throw data({ message: '快照不存在' }, { status: 404 });
  const url = new URL(request.url);
  const tab: Tab = url.searchParams.get('tab') === 'consumers' ? 'consumers' : 'segments';
  const pages = Math.max(1, Math.ceil(snapshot.rowCount / CONSUMER_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.floor(Number(url.searchParams.get('page'))) || 1));
  try {
    const result = snapshot.template === 'rfm'
      ? { kind: 'rfm' as const, ...(await readRfmSnapshot(snapshot, { page })) }
      : { kind: 'generic' as const, ...(await readTemplateSnapshot(snapshot, { page })) };
    const lookbackDays = snapshot.params.lookbackDays;
    return {
      email: member.email,
      nav: navFor(member),
      tab,
      page,
      pages,
      pageSize: CONSUMER_PAGE_SIZE,
      snapshot: {
        id: snapshot.id,
        // readTemplateSnapshot 已确认是登记过的模板
        templateLabel: TEMPLATES[snapshot.template as SnapshotTemplate].label,
        asOf: String(snapshot.params.asOf),
        lookbackDays: typeof lookbackDays === 'number' ? lookbackDays : null,
        rowCount: snapshot.rowCount,
        createdAt: snapshot.createdAt.toISOString(),
        expiresAt: snapshot.expiresAt.toISOString(),
        incomplete: snapshot.incomplete,
      },
      ...result,
    };
  } catch (e) {
    if (e instanceof SnapshotError) throw data({ message: e.message }, { status: e.status });
    throw e;
  }
}

const money = (s: string) => `¥${Number(s).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (iso: string) => new Date(iso).toLocaleDateString('zh-CN');

/** 通用明细里的一格：BOOLEAN 显示为是 / 否，列表用顿号连接，空值显示为 —，其余原样 */
function cell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (Array.isArray(v)) return v.map(cell).join('、');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 上一页 / 下一页 */
function Pager({ page, pages, pageSize, href }: { page: number; pages: number; pageSize: number; href: (p: number) => string }) {
  return (
    <div className="flex items-center justify-between text-sm text-slate-500">
      <span data-page={page}>{`第 ${page} / ${pages} 页，每页 ${pageSize} 位`}</span>
      <div className="flex gap-3">
        {page > 1 && <Link to={href(page - 1)} className="hover:underline">← 上一页</Link>}
        {page < pages && <Link to={href(page + 1)} className="hover:underline">下一页 →</Link>}
      </div>
    </div>
  );
}

export default function SnapshotResult({ loaderData }: Route.ComponentProps) {
  const { email, nav, snapshot } = loaderData;
  const lookback = snapshot.lookbackDays === null ? '' : `回看 ${snapshot.lookbackDays} 天，`;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={`${snapshot.templateLabel} · ${snapshot.asOf}`}
        description={<><Link to="/analytics" className="hover:underline">← 全部快照</Link>{`　${lookback}创建于 ${date(snapshot.createdAt)}，${date(snapshot.expiresAt)} 过期`}</>}
      />

      {snapshot.incomplete && (
        <Alert role="status" data-snapshot-incomplete className="border-amber-200 bg-amber-50 text-amber-900">
          <AlertTriangle className="text-amber-600" />
          <AlertTitle>数据不完整</AlertTitle>
          <AlertDescription>
            <p>计算时以下映射最近一次合并失败，结果没有包含它们最新的数据：</p>
            <ul className="list-disc pl-5">
              {snapshot.incomplete.map(m => (
                <li key={m.mapping} data-incomplete-mapping={m.mapping}>
                  {`源表 ${m.table} → ${m.entity}：${m.error}，${m.lastSuccessAt ? `数据停在 ${new Date(m.lastSuccessAt).toLocaleString('zh-CN')}` : '从未成功合并'}`}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {loaderData.kind === 'rfm' ? <RfmResult {...loaderData} /> : <GenericResult {...loaderData} />}
    </AppShell>
  );
}

function GenericResult({ page, pages, pageSize, snapshot, columns, rows }: Extract<Route.ComponentProps['loaderData'], { kind: 'generic' }>) {
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="消费者" value={snapshot.rowCount.toLocaleString('zh-CN')} hint="打通后的统一消费者" />
        <StatTile label="参考日期" value={snapshot.asOf} hint="计算的基准日" />
      </div>
      <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map(c => <TableHead key={c}>{c}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(r => (
              <TableRow key={String(r.consumer_id)} data-consumer={String(r.consumer_id)}>
                {columns.map(c => <TableCell key={c} className={c === 'consumer_id' ? 'font-mono text-xs' : undefined}>{cell(r[c])}</TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Pager page={page} pages={pages} pageSize={pageSize} href={p => `/analytics/snapshots/${snapshot.id}?page=${p}`} />
      </div>
    </>
  );
}

function RfmResult({ tab, page, pages, pageSize, snapshot, segments, consumers }: Extract<Route.ComponentProps['loaderData'], { kind: 'rfm' }>) {
  const base = `/analytics/snapshots/${snapshot.id}`;
  const total = segments.reduce((sum, s) => sum + Number(s.monetary), 0);
  const pageHref = (p: number) => `${base}?tab=consumers&page=${p}`;
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="消费者" value={snapshot.rowCount.toLocaleString('zh-CN')} hint="打通后的统一消费者" />
        <StatTile label="消费金额" value={money(String(total))} hint="回看窗口内计入的订单" />
        <StatTile label="人群" value={segments.filter(s => s.consumers > 0).length} hint={`共 ${segments.length} 个分群规则`} />
        <StatTile label="参考日期" value={snapshot.asOf} hint="计算最近一次消费的基准" />
      </div>

      <PillTabs
        current={tab}
        tabs={[
          { key: 'segments', label: '人群', href: base },
          { key: 'consumers', label: '消费者明细', href: `${base}?tab=consumers` },
        ]}
      />

      {tab === 'segments' ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>人群</TableHead>
                <TableHead>人数</TableHead>
                <TableHead>占比</TableHead>
                <TableHead>消费金额</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments.map(s => (
                <TableRow key={s.name} data-segment={s.name} className={s.consumers ? undefined : 'text-slate-400'}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell data-segment-consumers>{s.consumers.toLocaleString('zh-CN')}</TableCell>
                  <TableCell>{snapshot.rowCount ? `${((s.consumers / snapshot.rowCount) * 100).toFixed(1)}%` : '—'}</TableCell>
                  <TableCell data-segment-monetary>{money(s.monetary)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>consumer_id</TableHead>
                <TableHead>人群</TableHead>
                <TableHead>R</TableHead>
                <TableHead>F</TableHead>
                <TableHead>M</TableHead>
                <TableHead>距最近消费（天）</TableHead>
                <TableHead>消费次数</TableHead>
                <TableHead>消费金额</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {consumers.map(c => (
                <TableRow key={c.consumer_id} data-consumer={c.consumer_id}>
                  <TableCell className="font-mono text-xs">{c.consumer_id}</TableCell>
                  <TableCell>{c.segment}</TableCell>
                  <TableCell>{c.r}</TableCell>
                  <TableCell>{c.f}</TableCell>
                  <TableCell>{c.m}</TableCell>
                  <TableCell>{c.recency_days}</TableCell>
                  <TableCell>{c.frequency}</TableCell>
                  <TableCell>{money(c.monetary)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager page={page} pages={pages} pageSize={pageSize} href={pageHref} />
        </div>
      )}
    </>
  );
}
