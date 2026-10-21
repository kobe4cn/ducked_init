// app/routes/quality.tsx —— 数据质量（有 sources:read 的成员）：本租户最近的内置断言结果（来自 silver._assertion_runs）与隔离区里不合格行的样本（silver._quarantine），
// 以及最近一次成功打通里连了太多源记录的匹配值（只有加盐哈希、记录数与数据源名，见 ADR-0039）。有 sources:write 的成员可以把其中的值标为不参与匹配、
// 或撤销：写平台表、记审计，并在同一个事务里入队一次强制重算打通的合并；页面列出已标记的值（哈希、标记人、时间）。
// 合并时映射的自定义断言也记在 silver._assertion_runs，显示为「自定义：<字段> <检查>」。每次请求只读挂载本租户的数据湖读取；样本只来自标准层，敏感字段只有哈希。失败的 error 断言标红，warn 标琥珀色
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { data, Form, useNavigation } from 'react-router';
import type { Route } from './+types/quality';
import { can, requirePermission } from '~/.server/access';
import type { Tx } from '~/.server/audit';
import { getDb } from '~/.server/db/client';
import { excludeValue, includeValue, listExcludedValues } from '~/.server/identity-exclusions';
import { enqueueMerge, latestIdentitySummary } from '~/.server/mappings';
import { navFor } from '~/.server/nav';
import { HOT_VALUE_THRESHOLD } from '~/.server/pipeline/identity-engine';
import { ASSERTION_LABELS, describeCustom, SAMPLE_LIMIT, type AssertionLevel } from '~/.server/pipeline/assertions';
import { latestResultCheck, QUALITY_QUARANTINE, QUALITY_RUNS, readQuality } from '~/.server/quality';
import { listSources } from '~/.server/sources';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { StatTile } from '~/components/stat-tile';
import { Alert, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '数据质量 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  const { runs, quarantine } = await readQuality(member.tenant.id);
  // 「最近一次」只看结果层任务：合并任务的自定义断言也写运行记录，error 失败时还会回滚、不留记录
  const check = await latestResultCheck(member.tenant.id);
  const latest = check?.assertions ?? [];
  // 结果里的 sources 是数据源 ID（工作进程不读平台库），在这里换成名字；删掉的数据源照旧显示 ID
  const [identity, sources, excluded] = await Promise.all([latestIdentitySummary(member.tenant.id), listSources(member), listExcludedValues(member.tenant.id)]);
  const names = new Map(sources.map(s => [s.id, s.name]));
  const hot = (identity?.hot ?? []).map(h => ({ rule: h.rule, hash: h.hash, records: h.records, sources: h.sources.map(id => names.get(id) ?? id) }));
  return {
    email: member.email,
    nav: navFor(member),
    canWrite: can(member.role, 'sources:write'),
    runs,
    quarantine,
    labels: labelsFor(runs.flatMap(r => r.assertions).map(a => a.name)),
    /** 最近一次成功打通的热值；还没成功打通过时为 null */
    hot: identity ? hot : null,
    hotThreshold: HOT_VALUE_THRESHOLD,
    /** 不参与匹配的值；标记人已被移除时 createdBy 为 null */
    excluded: excluded.map(e => ({ ...e, createdAt: e.createdAt.toISOString() })),
    limits: { runs: QUALITY_RUNS, quarantine: QUALITY_QUARANTINE, sample: SAMPLE_LIMIT },
    latest: {
      taskId: check?.taskId,
      errors: latest.filter(a => a.level === 'error' && a.failed > 0).length,
      warns: latest.filter(a => a.level === 'warn' && a.failed > 0).length,
    },
  };
}

/** 标记或撤销没有做成：回滚事务，把原因与状态码交给页面 */
class ExclusionError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * 标记（exclude）或撤销（include）一个不参与匹配的值。标记只收最近一次成功打通的 hot 里有的哈希（记录数也取自那里），不收任意输入；
 * 登记或撤销后在同一个事务里入队合并（带上新的排除列表，与上次打通的参数不同，强制重算打通）。合并正在运行时入不了队，
 * 定时检查也不会因排除列表变了补一次合并，所以整个回滚、请成员稍后再试（同恢复映射）
 */
export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'sources:write');
  const form = await request.formData();
  const hash = String(form.get('hash') ?? '');
  const tenantId = member.tenant.id;
  const change = async (apply: (tx: Tx) => Promise<boolean>, missing: ExclusionError) => getDb().transaction(async tx => {
    if (!await apply(tx)) throw missing;
    if (!await enqueueMerge(tx, tenantId)) throw new ExclusionError('已有一次合并在运行，等它结束后再试。', 409);
  });
  try {
    switch (form.get('intent')) {
      case 'exclude': {
        const hot = (await latestIdentitySummary(tenantId))?.hot.find(h => h.hash === hash);
        if (!hot) throw new ExclusionError('这个值不在最近一次打通的告警里，不能标记。', 400);
        await change(tx => excludeValue(tx, tenantId, member, hash, hot.records), new ExclusionError('这个值已经标为不参与匹配。', 409));
        return { error: null, notice: '已标为不参与匹配，已排队一次合并，打通完成后这些记录各自成组。' };
      }
      case 'include':
        await change(tx => includeValue(tx, tenantId, member, hash), new ExclusionError('这个值不在不参与匹配的列表里。', 404));
        return { error: null, notice: '已撤销，已排队一次合并重新打通。' };
      default:
        return data({ error: '未知操作', notice: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof ExclusionError) return data({ error: e.message, notice: null }, { status: e.status });
    throw e;
  }
}

/** 内置断言的中文名，加上运行记录里映射自定义断言（custom:<字段>:<检查>）现转的中文名 */
const labelsFor = (names: string[]): Record<string, string> => ({
  ...ASSERTION_LABELS,
  ...Object.fromEntries(names.filter(n => n.startsWith('custom:')).map(n => [n, describeCustom(n)])),
});

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

/** 提交一个哈希的标记或撤销 */
function HashAction({ intent, hash, children }: { intent: 'exclude' | 'include'; hash: string; children: React.ReactNode }) {
  const submitting = useNavigation().state === 'submitting';
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="hash" value={hash} />
      <Button type="submit" variant="outline" size="sm" disabled={submitting} data-intent={intent}>{children}</Button>
    </Form>
  );
}

export default function Quality({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canWrite, runs, quarantine, hot, hotThreshold, excluded, labels, limits, latest } = loaderData;
  const label = (name: string) => labels[name] ?? name;
  const isExcluded = (hash: string) => excluded.some(e => e.hash === hash);
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="数据质量" description="结果层任务计算前对标准层做的内置检查，以及合并时映射里写的自定义断言。阻断级失败时任务不产出新快照（自定义断言则是这个映射合并失败），告警级只记录；不合格行的样本放在隔离区，敏感字段只有哈希。" />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="最近一次阻断失败" value={latest.errors} tone={latest.errors ? 'text-red-600' : undefined} hint={latest.taskId ? `结果层任务 ${latest.taskId}` : '还没有运行记录'} />
        <StatTile label="最近一次告警" value={latest.warns} tone={latest.warns ? 'text-amber-600' : undefined} hint="告警不阻断任务" />
        <StatTile label="隔离区样本" value={quarantine.length} hint={`最近 ${limits.quarantine} 行`} />
      </div>

      {actionData?.error && <Alert variant="destructive" role="alert"><AlertTitle>{actionData.error}</AlertTitle></Alert>}
      {actionData?.notice && <Alert role="status"><CheckCircle2 /><AlertTitle>{actionData.notice}</AlertTitle></Alert>}

      {hot?.length ? (
        <div className="rounded-2xl border border-amber-200 bg-white p-6 shadow-sm" data-hot-values>
          <h2 className="mb-1 inline-flex items-center gap-2 text-lg font-semibold text-amber-700"><AlertTriangle className="size-5" />身份打通：一个值连了太多记录</h2>
          <p className="mb-4 text-sm text-slate-500">最近一次打通里，下面的匹配值各连了 {hotThreshold} 条以上源记录，可能是占位号或代填号，会把不相干的人合成一个统一消费者。{canWrite ? '确认是这类值时可以标为不参与匹配：之后的打通里只靠它相连的记录各自成组，标错了可以撤销。' : '有修改数据源权限的成员可以把它标为不参与匹配。'}</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>匹配字段</TableHead>
                <TableHead>哈希</TableHead>
                <TableHead>记录数</TableHead>
                <TableHead>数据源</TableHead>
                {canWrite && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {hot.map(h => (
                <TableRow key={`${h.rule}-${h.hash}`} data-hot-hash={h.hash}>
                  <TableCell>{h.rule}</TableCell>
                  <TableCell className="font-mono text-xs" title={h.hash}>{h.hash.slice(0, 16)}…</TableCell>
                  <TableCell>{h.records.toLocaleString('zh-CN')}</TableCell>
                  <TableCell>{h.sources.join('、')}</TableCell>
                  {canWrite && (
                    <TableCell className="text-right">
                      {isExcluded(h.hash) ? <span className="text-slate-500">已标为不参与匹配</span> : <HashAction intent="exclude" hash={h.hash}>不参与匹配</HashAction>}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <h2 className="mb-1 text-lg font-semibold">身份打通：一个值连了太多记录</h2>
          <p className="text-slate-500">{hot ? `没有发现一个值连了 ${hotThreshold} 条以上记录。` : '还没有成功打通过。合并 customer 映射时打通，连了太多源记录的匹配值会列在这里。'}</p>
        </div>
      )}

      {excluded.length ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm" data-excluded-values>
          <h2 className="mb-1 text-lg font-semibold">不参与匹配的值</h2>
          <p className="mb-4 text-sm text-slate-500">每次合并的身份打通都把这些值当作没有值；只靠它们相连的记录各自成组，其他字段仍能连起来的照样合并。</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>哈希</TableHead>
                <TableHead>标记时的记录数</TableHead>
                <TableHead>标记人</TableHead>
                <TableHead>时间</TableHead>
                {canWrite && <TableHead />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {excluded.map(e => (
                <TableRow key={e.hash} data-excluded-hash={e.hash}>
                  <TableCell className="font-mono text-xs" title={e.hash}>{e.hash.slice(0, 16)}…</TableCell>
                  <TableCell>{e.records.toLocaleString('zh-CN')}</TableCell>
                  <TableCell>{e.createdBy ?? <span className="text-slate-400">已移除的成员</span>}</TableCell>
                  <TableCell className="text-slate-500">{time(e.createdAt)}</TableCell>
                  {canWrite && <TableCell className="text-right"><HashAction intent="include" hash={e.hash}>撤销</HashAction></TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 shadow-sm" data-excluded-values>
          <h2 className="mb-1 text-lg font-semibold">不参与匹配的值</h2>
          <p className="text-slate-500">还没有。在上面的告警里把占位号、代填号这类值标为不参与匹配后，会列在这里，可以撤销。</p>
        </div>
      )}

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
