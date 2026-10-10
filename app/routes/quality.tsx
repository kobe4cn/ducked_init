// app/routes/quality.tsx —— 数据质量（有 sources:read 的成员）：本租户最近的内置断言结果（来自 silver._assertion_runs）与隔离区里不合格行的样本（silver._quarantine）。
// 每次请求只读挂载本租户的数据湖读取；样本只来自标准层，敏感字段只有哈希。失败的 error 断言标红，warn 标琥珀色
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { Route } from './+types/quality';
import { requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { ASSERTION_LABELS, SAMPLE_LIMIT, type AssertionLevel } from '~/.server/pipeline/assertions';
import { QUALITY_QUARANTINE, QUALITY_RUNS, readQuality } from '~/.server/quality';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { StatTile } from '~/components/stat-tile';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '数据质量 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  const { runs, quarantine } = await readQuality(member.tenant.id);
  const latest = runs.filter(r => r.taskId === runs[0]?.taskId).flatMap(r => r.assertions);
  return {
    email: member.email,
    nav: navFor(member),
    runs,
    quarantine,
    labels: ASSERTION_LABELS,
    limits: { runs: QUALITY_RUNS, quarantine: QUALITY_QUARANTINE, sample: SAMPLE_LIMIT },
    latest: {
      taskId: runs[0]?.taskId,
      errors: latest.filter(a => a.level === 'error' && a.failed > 0).length,
      warns: latest.filter(a => a.level === 'warn' && a.failed > 0).length,
    },
  };
}

const time = (iso: string) => new Date(iso).toLocaleString('zh-CN');

/** 级别的文字与失败时的状态色 */
const LEVELS: Record<AssertionLevel, { text: string; tone: string }> = {
  error: { text: '阻断', tone: 'text-red-600' },
  warn: { text: '告警', tone: 'text-amber-600' },
};

function Failed({ level, children }: { level: AssertionLevel; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1 ${LEVELS[level].tone}`}><AlertTriangle className="size-4" />{children}</span>;
}

function Outcome({ level, failed }: { level: AssertionLevel; failed: number }) {
  if (!failed) return <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="size-4" />通过</span>;
  return <Failed level={level}>{failed} 行不合格</Failed>;
}

export default function Quality({ loaderData }: Route.ComponentProps) {
  const { email, nav, runs, quarantine, labels, limits, latest } = loaderData;
  const label = (name: string) => labels[name] ?? name;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="数据质量" description="结果层任务计算前对标准层做的内置检查。阻断级失败时任务不产出新快照，告警级只记录；不合格行的样本放在隔离区，敏感字段只有哈希。" />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="最近一次阻断失败" value={latest.errors} tone={latest.errors ? 'text-red-600' : undefined} hint={latest.taskId ? `任务 ${latest.taskId}` : '还没有运行记录'} />
        <StatTile label="最近一次告警" value={latest.warns} tone={latest.warns ? 'text-amber-600' : undefined} hint="告警不阻断任务" />
        <StatTile label="隔离区样本" value={quarantine.length} hint={`最近 ${limits.quarantine} 行`} />
      </div>

      {runs.length ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold">最近 {limits.runs} 次检查</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>任务</TableHead>
                <TableHead>实体</TableHead>
                <TableHead>行数</TableHead>
                <TableHead>断言</TableHead>
                <TableHead>级别</TableHead>
                <TableHead>结果</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.flatMap(run => run.assertions.map(a => (
                <TableRow key={`${run.taskId}-${run.entity}-${a.name}`} data-assertion={a.name} data-failed={a.failed > 0 ? 'true' : 'false'}>
                  <TableCell className="text-slate-500">{time(run.at)}</TableCell>
                  <TableCell className="font-mono text-xs text-slate-500">{run.taskId}</TableCell>
                  <TableCell>silver.{run.entity}</TableCell>
                  <TableCell>{run.rows.toLocaleString('zh-CN')}</TableCell>
                  <TableCell>{label(a.name)}{a.detail && <span className="ml-1 text-slate-400">（{a.detail}）</span>}</TableCell>
                  <TableCell>{LEVELS[a.level].text}</TableCell>
                  <TableCell><Outcome level={a.level} failed={a.failed} /></TableCell>
                </TableRow>
              )))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">还没有检查记录。RFM 等结果层任务运行时会先检查标准层，结果记在这里。</div>
      )}

      {quarantine.length ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold">隔离区</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>断言</TableHead>
                <TableHead>实体</TableHead>
                <TableHead>键</TableHead>
                <TableHead>行</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quarantine.map((q, i) => (
                <TableRow key={i} data-quarantine-key={q.key}>
                  <TableCell className="text-slate-500">{time(q.at)}</TableCell>
                  <TableCell><Failed level={q.level}>{label(q.assertion)}</Failed></TableCell>
                  <TableCell>silver.{q.entity}</TableCell>
                  <TableCell className="font-mono text-xs">{q.key}</TableCell>
                  <TableCell className="max-w-xl whitespace-normal break-all font-mono text-xs text-slate-500">{q.row}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">隔离区是空的。断言失败时，每条断言最多 {limits.sample} 行不合格行的样本会放在这里。</div>
      )}
    </AppShell>
  );
}
