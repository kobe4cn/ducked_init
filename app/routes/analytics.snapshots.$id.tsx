// app/routes/analytics.snapshots.$id.tsx —— RFM 快照结果（有结果层查看权限的成员）：各人群的人数与金额（?tab=segments），
// 按 consumer_id 分页的消费者明细（?tab=consumers&page=N）。每次请求只读挂载本租户的数据湖读取；页面上只有 consumer_id 与分值，没有明文。
// 其他租户的快照、已过期的快照返回 404
import { data, Link } from 'react-router';
import type { Route } from './+types/analytics.snapshots.$id';
import { requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { TEMPLATES } from '~/.server/pipeline/templates';
import { CONSUMER_PAGE_SIZE, getSnapshot, readRfmSnapshot, SnapshotError } from '~/.server/snapshots';
import { AppShell } from '~/components/app-shell';
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
    const result = await readRfmSnapshot(snapshot, { page });
    return {
      email: member.email,
      nav: navFor(member),
      tab,
      page,
      pages,
      pageSize: CONSUMER_PAGE_SIZE,
      snapshot: {
        id: snapshot.id,
        templateLabel: TEMPLATES.rfm.label,
        asOf: String(snapshot.params.asOf),
        lookbackDays: Number(snapshot.params.lookbackDays),
        rowCount: snapshot.rowCount,
        createdAt: snapshot.createdAt.toISOString(),
        expiresAt: snapshot.expiresAt.toISOString(),
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

export default function SnapshotResult({ loaderData }: Route.ComponentProps) {
  const { email, nav, tab, page, pages, pageSize, snapshot, segments, consumers } = loaderData;
  const base = `/analytics/snapshots/${snapshot.id}`;
  const total = segments.reduce((sum, s) => sum + Number(s.monetary), 0);
  const pageHref = (p: number) => `${base}?tab=consumers&page=${p}`;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={`${snapshot.templateLabel} · ${snapshot.asOf}`}
        description={<><Link to="/analytics" className="hover:underline">← 全部快照</Link>{`　回看 ${snapshot.lookbackDays} 天，创建于 ${date(snapshot.createdAt)}，${date(snapshot.expiresAt)} 过期`}</>}
      />

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
          <div className="flex items-center justify-between text-sm text-slate-500">
            <span data-page={page}>{`第 ${page} / ${pages} 页，每页 ${pageSize} 位`}</span>
            <div className="flex gap-3">
              {page > 1 && <Link to={pageHref(page - 1)} className="hover:underline">← 上一页</Link>}
              {page < pages && <Link to={pageHref(page + 1)} className="hover:underline">下一页 →</Link>}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
