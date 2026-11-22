// app/routes/analytics.snapshots.$id.tsx —— 分析模板快照结果（有结果层查看权限的成员）。loader 按模板分派：
// RFM：各人群的人数与金额（?tab=segments），按 consumer_id 分页的消费者明细（?tab=consumers&page=N）；
// 流失预警（#834）：顶部汇总卡片（有风险人数、占比、总人数），明细默认只列有风险（at_risk）的人、按沉默比从高到低（?tab=all 看全部）；
// 复购（#835）：顶部卡片写复购率（X / Y 人）与到第二单天数中位数（没人有第二单时为「—」），下方通用分页明细；
// CLV（#835）：顶部卡片写前 10% 的人贡献的 clv 占比（总 clv 为 0 时为「—」）与合计，下方十档分布表（每档人数与 clv 合计，只列有人的档），再下方通用分页明细；
// 同期群（#836）：主视图是留存矩阵（行是 cohort_start 升序、列是第 0…periods-1 期，格子是人数与留存率，卡片写同期群数、总人数、粒度，?tab=matrix），
// 逐人明细挪到 ?tab=consumers&page=N（仍按 consumer_id 分页、active_periods 顿号连接）；
// 用户 360（#837）：默认「汇总」标签（?tab=summary）——卡片写总人数、有订单人数与各渠道同意人数，可按 consumer_id 查单人一行（?consumer=），
// 逐人明细挪到 ?tab=consumers&page=N（仍按 consumer_id 分页）；
// 其他模板（含指标 / 标签 DSL 快照，#816）：按 consumer_id（DSL 按全部列）分页的通用明细（?page=N），列取快照表的全部列，
// DSL 快照页头写定义（类型与键）、定义版本、统计日与来源，标签在明细上方带各取值人数的汇总（回刷前后对照），
// 带维度的指标每个消费者有多行，按行分页、统计卡片标「行数」。
// 登记时有映射最近一次合并失败的快照标「数据不完整」，列出失败的映射。每次请求只读挂载本租户的数据湖读取；页面上只有 consumer_id 与汇总值（分值、订单汇总、各渠道同意等），没有明文。
// 其他租户的快照、已过期的快照返回 404
import { AlertTriangle } from 'lucide-react';
import { data, Form, Link } from 'react-router';
import type { Route } from './+types/analytics.snapshots.$id';
import { requirePermission } from '~/.server/access';
import { errorTextFor } from '~/.server/i18n';
import { navFor } from '~/.server/nav';
import { TEMPLATES } from '~/.server/pipeline/templates';
import { RFM_DEFAULTS } from '~/.server/pipeline/templates/rfm';
import { CONSUMER_PAGE_SIZE, dslKindOf, getSnapshot, readChurnSnapshot, readClvSnapshot, readCohortSnapshot, readRepurchaseSnapshot, readRfmSnapshot, readTemplateSnapshot, readUser360Snapshot, SnapshotError, triggerLabel, type SnapshotTemplate } from '~/.server/snapshots';
import { AppShell } from '~/components/app-shell';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Input } from '~/components/ui/input';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { StatTile } from '~/components/stat-tile';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { builtinName } from '~/lib/builtin-names';
import { makeT, useT, type T } from '~/lib/i18n';

/** DSL 类型名（指标 / 标签）按界面语言翻译：写成字面量 t('…') 的对照表（照 api-keys 的 scopeLabel）才能与词典对账 */
const dslKindLabel = (t: T, kind: 'metric' | 'tag') => ({ metric: t('指标'), tag: t('标签') })[kind];

export function meta({ loaderData, matches }: Route.MetaArgs) {
  // RR8 的 MetaMatch 把 loader 数据放在 loaderData 字段；root 出错时为空，回退中文
  const root = matches[0]?.loaderData;
  const t = makeT(root?.locale ?? 'zh-CN', root?.messages ?? null);
  const s = loaderData?.snapshot;
  if (!s) return [{ title: `分析 · ${t('CRM 数据分析平台')}` }];
  // 模板名与类型名是平台内置名称，按界面语言翻译；定义键不翻
  const name = 'definition' in s
    ? `${dslKindLabel(t, s.definition.kind)} ${s.definition.key}`
    : builtinName(t, s.templateLabel);
  return [{ title: `${name} · ${s.asOf} · ${t('CRM 数据分析平台')}` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'results:read');
  const snapshot = await getSnapshot(member.tenant.id, params.snapshotId);
  if (!snapshot) throw data({ message: '快照不存在' }, { status: 404 });
  const url = new URL(request.url);
  // 页码先清洗成 ≥ 1 的整数，夹到最后一页由各模板分支自己算（流失预警要先知道筛选后的行数）
  const requestedPage = Math.max(1, Math.floor(Number(url.searchParams.get('page'))) || 1);
  const tabOf = <T extends string>(allowed: readonly T[], fallback: T): T => {
    const t = url.searchParams.get('tab');
    return (allowed as readonly string[]).includes(t!) ? t as T : fallback;
  };
  try {
    const lookbackDays = snapshot.params.lookbackDays;
    // 页头：DSL（指标 / 标签）快照写定义（类型与键）、版本与来源；模板快照写注册表里的名字。
    // 名称是原名（中文），渲染处按界面语言翻译（ADR-0060）
    const dsl = dslKindOf(snapshot.template);
    const head = {
      email: member.email,
      nav: navFor(member),
      pageSize: CONSUMER_PAGE_SIZE,
      snapshot: {
        id: snapshot.id,
        ...(dsl
          ? {
            definition: { kind: dsl, key: snapshot.template.slice(dsl.length + 1) },
            definitionVersion: snapshot.definitionVersion,
            trigger: triggerLabel(snapshot.trigger),
          }
          : { templateLabel: TEMPLATES[snapshot.template as SnapshotTemplate].label }),
        asOf: String(snapshot.params.asOf),
        lookbackDays: typeof lookbackDays === 'number' ? lookbackDays : null,
        rowCount: snapshot.rowCount,
        createdAt: snapshot.createdAt.toISOString(),
        expiresAt: snapshot.expiresAt.toISOString(),
        incomplete: snapshot.incomplete,
      },
    };
    // 每个模板自己的快照视图：解析 ?tab=、算分页并读数（后面的票在这里加分支）
    switch (snapshot.template) {
      case 'rfm': {
        const tab = tabOf(['segments', 'consumers'] as const, 'segments');
        const pages = Math.max(1, Math.ceil(snapshot.rowCount / CONSUMER_PAGE_SIZE));
        const page = Math.min(pages, requestedPage);
        // RFM 默认人群名：展示时判断「是不是默认名」的名单（默认名翻译、租户改名原样），值本身不进这里
        return { ...head, tab, page, pages, kind: 'rfm' as const, defaultSegmentNames: RFM_DEFAULTS.segments.map(s => s.name), ...(await readRfmSnapshot(snapshot, { page })) };
      }
      case 'churn': {
        // 分页总数按筛选后的行数算，页码由 readChurnSnapshot 夹（它开了湖才知道行数，避免开两次）
        const tab = tabOf(['at-risk', 'all'] as const, 'at-risk');
        return { ...head, tab, kind: 'churn' as const, ...(await readChurnSnapshot(snapshot, { page: requestedPage, filter: tab })) };
      }
      // 复购与 CLV（#835）：明细不筛选，页数按快照行数算（同 default 分支），只是多读一份顶部汇总
      case 'repurchase': {
        const pages = Math.max(1, Math.ceil(snapshot.rowCount / CONSUMER_PAGE_SIZE));
        const page = Math.min(pages, requestedPage);
        return { ...head, page, pages, kind: 'repurchase' as const, ...(await readRepurchaseSnapshot(snapshot, { page })) };
      }
      case 'clv': {
        const pages = Math.max(1, Math.ceil(snapshot.rowCount / CONSUMER_PAGE_SIZE));
        const page = Math.min(pages, requestedPage);
        return { ...head, page, pages, kind: 'clv' as const, ...(await readClvSnapshot(snapshot, { page })) };
      }
      // 同期群（#836）：主视图是留存矩阵（?tab=matrix），逐人明细在 ?tab=consumers；两个标签都读矩阵（卡片要用）
      case 'cohort': {
        const tab = tabOf(['matrix', 'consumers'] as const, 'matrix');
        const pages = Math.max(1, Math.ceil(snapshot.rowCount / CONSUMER_PAGE_SIZE));
        const page = Math.min(pages, requestedPage);
        return { ...head, tab, page, pages, kind: 'cohort' as const, ...(await readCohortSnapshot(snapshot, { page })) };
      }
      // 用户 360（#837）：默认汇总（?tab=summary，可带 ?consumer= 查单人），逐人明细在 ?tab=consumers；两个标签都读汇总（卡片要用）
      case 'user360': {
        const tab = tabOf(['summary', 'consumers'] as const, 'summary');
        const pages = Math.max(1, Math.ceil(snapshot.rowCount / CONSUMER_PAGE_SIZE));
        const page = Math.min(pages, requestedPage);
        const consumer = url.searchParams.get('consumer');
        return { ...head, tab, page, pages, kind: 'user360' as const, consumer, ...(await readUser360Snapshot(snapshot, { page, consumerId: consumer })) };
      }
      default: {
        const pages = Math.max(1, Math.ceil(snapshot.rowCount / CONSUMER_PAGE_SIZE));
        const page = Math.min(pages, requestedPage);
        return { ...head, page, pages, kind: 'generic' as const, ...(await readTemplateSnapshot(snapshot, { page })) };
      }
    }
  } catch (e) {
    if (e instanceof SnapshotError) throw data({ message: await errorTextFor(request, e) }, { status: e.status });
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

/** 上一页 / 下一页；unit 是每页计数的单位（模板快照按消费者「位」，DSL 快照按「行」） */
function Pager({ page, pages, pageSize, unit = '位', href }: { page: number; pages: number; pageSize: number; unit?: string; href: (p: number) => string }) {
  return (
    <div className="flex items-center justify-between text-sm text-slate-500">
      <span data-page={page}>{`第 ${page} / ${pages} 页，每页 ${pageSize} ${unit}`}</span>
      <div className="flex gap-3">
        {page > 1 && <Link to={href(page - 1)} className="hover:underline">← 上一页</Link>}
        {page < pages && <Link to={href(page + 1)} className="hover:underline">下一页 →</Link>}
      </div>
    </div>
  );
}

/**
 * 通用分页明细：列取快照表的全部列（空值 —、BOOLEAN 是 / 否、列表顿号连接），第 page 页按 consumer_id（DSL 按全部列）排好序。
 * 通用视图、复购 / CLV（#835）与同期群逐人明细（#836）都用它；翻页链接默认是 ?page=N，带标签的页面
 * （同期群的 ?tab=consumers）传 href 保住自己的查询参数
 */
function DetailTable({ columns, rows, page, pages, pageSize, unit, snapshot, href }: {
  columns: string[];
  rows: Record<string, unknown>[];
  page: number;
  pages: number;
  pageSize: number;
  unit?: string;
  snapshot: { id: string };
  href?: (p: number) => string;
}) {
  return (
    <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map(c => <TableHead key={c}>{c}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            // 带维度的指标每个消费者有多行，行键不能只用 consumer_id
            <TableRow key={i} data-consumer={String(r.consumer_id)}>
              {columns.map(c => <TableCell key={c} className={c === 'consumer_id' ? 'font-mono text-xs' : undefined}>{cell(r[c])}</TableCell>)}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Pager page={page} pages={pages} pageSize={pageSize} unit={unit} href={href ?? (p => `/analytics/snapshots/${snapshot.id}?page=${p}`)} />
    </div>
  );
}

export default function SnapshotResult({ loaderData }: Route.ComponentProps) {
  const { email, nav, snapshot } = loaderData;
  const t = useT();
  const lookback = snapshot.lookbackDays === null ? '' : `回看 ${snapshot.lookbackDays} 天，`;
  // DSL（指标 / 标签）快照：页头改写定义（类型与键）与版本、统计日、来源；类型名与模板名按界面语言翻译，定义键不翻
  const header = 'definition' in snapshot
    ? {
      title: `${dslKindLabel(t, snapshot.definition.kind)} · ${snapshot.definition.key}`,
      note: `　${snapshot.definitionVersion ? `第 ${snapshot.definitionVersion} 版` : '—'}，统计日 ${snapshot.asOf}，来源 ${snapshot.trigger}，创建于 ${date(snapshot.createdAt)}，${date(snapshot.expiresAt)} 过期`,
    }
    : {
      title: `${builtinName(t, snapshot.templateLabel)} · ${snapshot.asOf}`,
      note: `　${lookback}创建于 ${date(snapshot.createdAt)}，${date(snapshot.expiresAt)} 过期`,
    };
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={header.title}
        description={<><Link to="/analytics" className="hover:underline">← 全部快照</Link>{header.note}</>}
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

      {loaderData.kind === 'rfm' && <RfmResult {...loaderData} />}
      {loaderData.kind === 'churn' && <ChurnResult {...loaderData} />}
      {loaderData.kind === 'repurchase' && <RepurchaseResult {...loaderData} />}
      {loaderData.kind === 'clv' && <ClvResult {...loaderData} />}
      {loaderData.kind === 'cohort' && <CohortResult {...loaderData} />}
      {loaderData.kind === 'user360' && <User360Result {...loaderData} />}
      {loaderData.kind === 'generic' && <GenericResult {...loaderData} />}
    </AppShell>
  );
}

function GenericResult({ page, pages, pageSize, snapshot, columns, rows, tagSummary }: Extract<Route.ComponentProps['loaderData'], { kind: 'generic' }>) {
  // DSL 快照的 rowCount 是快照表的行数（带维度的指标每个消费者有多行），不是消费者数
  const dsl = 'definition' in snapshot ? snapshot : null;
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label={dsl ? '行数' : '消费者'} value={snapshot.rowCount.toLocaleString('zh-CN')} hint={dsl ? '快照表的行数' : '打通后的统一消费者'} />
        <StatTile label="参考日期" value={snapshot.asOf} hint="计算的基准日" />
      </div>
      {tagSummary && (
        <div className="rounded-2xl border bg-white p-6 shadow-sm" data-tag-summary>
          <h2 className="mb-4 font-medium">各取值人数</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>取值</TableHead>
                <TableHead>人数</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tagSummary.map(t => (
                <TableRow key={t.value ?? ''} data-tag-value={t.value ?? ''}>
                  <TableCell className="font-medium">{t.value ?? '—'}</TableCell>
                  <TableCell>{t.consumers.toLocaleString('zh-CN')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <DetailTable columns={columns} rows={rows} page={page} pages={pages} pageSize={pageSize} unit={dsl ? '行' : '位'} snapshot={snapshot} />
    </>
  );
}

/** 流失预警快照：顶部汇总卡片（有风险人数、占比、总人数），明细默认只列有风险的人、沉默比从高到低，可切到全部 */
function ChurnResult({ tab, page, pages, pageSize, snapshot, total, atRisk, rows }: Extract<Route.ComponentProps['loaderData'], { kind: 'churn' }>) {
  const base = `/analytics/snapshots/${snapshot.id}`;
  const pageHref = (p: number) => `${base}?tab=${tab}&page=${p}`;
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="有风险人数" value={atRisk.toLocaleString('zh-CN')} tone={atRisk ? 'text-amber-600' : undefined} hint="沉默比超过风险阈值的消费者" />
        <StatTile label="风险占比" value={total ? `${((atRisk / total) * 100).toFixed(1)}%` : '—'} hint="有风险人数 ÷ 总人数" />
        <StatTile label="总人数" value={total.toLocaleString('zh-CN')} hint="回看窗口内有购买节奏的消费者" />
        <StatTile label="参考日期" value={snapshot.asOf} hint="计算沉默天数的基准" />
      </div>

      <PillTabs
        current={tab}
        tabs={[
          { key: 'at-risk', label: '有风险', href: base },
          { key: 'all', label: '全部', href: `${base}?tab=all` },
        ]}
      />

      <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        {rows.length === 0 && <p className="text-sm text-slate-500">{tab === 'at-risk' ? '没有有风险的消费者' : '这份快照没有数据'}</p>}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>consumer_id</TableHead>
              <TableHead>订单数</TableHead>
              <TableHead>平均间隔（天）</TableHead>
              <TableHead>沉默天数</TableHead>
              <TableHead>沉默比</TableHead>
              <TableHead>有风险</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(c => (
              <TableRow key={c.consumer_id} data-consumer={c.consumer_id}>
                <TableCell className="font-mono text-xs">{c.consumer_id}</TableCell>
                <TableCell>{c.orders}</TableCell>
                <TableCell>{c.avg_gap_days}</TableCell>
                <TableCell>{c.recency_days}</TableCell>
                <TableCell>{c.silence_ratio}</TableCell>
                <TableCell>{c.at_risk ? '是' : '否'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Pager page={page} pages={pages} pageSize={pageSize} href={pageHref} />
      </div>
    </>
  );
}

/** 复购快照（#835）：顶部卡片写复购率（X / Y 人）与到第二单天数中位数，下方按 consumer_id 的通用分页明细 */
function RepurchaseResult({ page, pages, pageSize, snapshot, total, repurchased, medianDaysToSecond, columns, rows }: Extract<Route.ComponentProps['loaderData'], { kind: 'repurchase' }>) {
  const rate = total ? `${((repurchased / total) * 100).toFixed(1)}%` : '—';
  const median = medianDaysToSecond === null ? '—' : `${medianDaysToSecond} 天`;
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div data-repurchase-rate={rate}>
          <StatTile label="复购率" value={rate} hint={`${repurchased} / ${total} 人`} />
        </div>
        <div data-median-days={median}>
          <StatTile label="到第二单天数中位数" value={median} hint="只算有第二单的人" />
        </div>
        <div data-repurchase-count={repurchased}>
          <StatTile label="复购人数" value={repurchased.toLocaleString('zh-CN')} hint="第二单落在复购窗口内" />
        </div>
        <div data-total-count={total}>
          <StatTile label="总人数" value={total.toLocaleString('zh-CN')} hint="回看窗口内下过单的消费者" />
        </div>
      </div>

      <DetailTable columns={columns} rows={rows} page={page} pages={pages} pageSize={pageSize} snapshot={snapshot} />
    </>
  );
}

/**
 * CLV 快照（#835）：顶部卡片写前 10% 的人（clv 最高的第 1 档）贡献的占比与合计，下方按 clv 从高到低分十档
 * （每档人数与 clv 合计，只列有人的档），再下方按 consumer_id 的通用分页明细
 */
function ClvResult({ page, pages, pageSize, snapshot, totalClv, topShare, deciles, columns, rows }: Extract<Route.ComponentProps['loaderData'], { kind: 'clv' }>) {
  const share = topShare === null ? '—' : `${(topShare * 100).toFixed(1)}%`;
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div data-clv-top-share={share}>
          <StatTile label="前 10% 的人贡献的 clv 占比" value={share} hint="clv 最高的第 1 档合计 ÷ 总额" />
        </div>
        <StatTile label="CLV 合计" value={money(totalClv)} hint="回看窗口内全部消费者的 clv" />
        <StatTile label="消费者" value={snapshot.rowCount.toLocaleString('zh-CN')} hint="打通后的统一消费者" />
        <StatTile label="参考日期" value={snapshot.asOf} hint="计算 clv 的基准日" />
      </div>

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        <h2 className="mb-4 font-medium">CLV 十档分布</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>档位</TableHead>
              <TableHead>人数</TableHead>
              <TableHead>clv 合计</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deciles.map(d => (
              <TableRow key={d.decile} data-clv-decile={d.decile}>
                <TableCell className="font-medium">{`第 ${d.decile} 档${d.decile === 1 ? '（最高）' : ''}`}</TableCell>
                <TableCell data-clv-decile-consumers={d.consumers}>{d.consumers.toLocaleString('zh-CN')}</TableCell>
                <TableCell>{money(d.clv)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <DetailTable columns={columns} rows={rows} page={page} pages={pages} pageSize={pageSize} snapshot={snapshot} />
    </>
  );
}

/**
 * 同期群快照（#836）：顶部卡片写同期群数、总人数与粒度，主视图是留存矩阵——行是 cohort_start（升序）、列是第 0…periods-1 期，
 * 格子是这一期有下单的人数与留存率（÷ 该群第 0 期人数；首单周期是 0，第 0 期都是 100.0%，没人下单的期补 0）；
 * 逐人明细在 ?tab=consumers（按 consumer_id 分页，active_periods 用顿号连接）
 */
function CohortResult({ tab, page, pages, pageSize, snapshot, matrix, granularity, columns, rows }: Extract<Route.ComponentProps['loaderData'], { kind: 'cohort' }>) {
  const base = `/analytics/snapshots/${snapshot.id}`;
  const pageHref = (p: number) => `${base}?tab=consumers&page=${p}`;
  const cohorts = matrix.length;
  const total = matrix.reduce((sum, r) => sum + r.counts[0]!, 0);
  const periods = matrix[0]?.counts.length ?? 0;
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div data-cohort-count={cohorts}>
          <StatTile label="同期群数" value={cohorts.toLocaleString('zh-CN')} hint="按首单所在周期分群" />
        </div>
        <div data-cohort-total={total}>
          <StatTile label="总人数" value={total.toLocaleString('zh-CN')} hint="首单落在最近周期窗口内的消费者" />
        </div>
        <div data-cohort-granularity={granularity}>
          <StatTile label="粒度" value={granularity === 'week' ? '按周' : '按月'} hint="同期与周期的划分粒度" />
        </div>
      </div>

      <PillTabs
        current={tab}
        tabs={[
          { key: 'matrix', label: '留存矩阵', href: base },
          { key: 'consumers', label: '逐人明细', href: `${base}?tab=consumers` },
        ]}
      />

      {tab === 'matrix' ? (
        <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
          {matrix.length === 0 && <p className="text-sm text-slate-500">这份快照没有数据</p>}
          {/* periods 最多 60 列，矩阵面板里横向滚动 */}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>cohort_start</TableHead>
                  {Array.from({ length: periods }, (_, k) => <TableHead key={k}>{`第 ${k} 期`}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {matrix.map(r => (
                  <TableRow key={r.cohortStart}>
                    <TableCell className="font-mono text-xs">{r.cohortStart}</TableCell>
                    {r.counts.map((n, k) => (
                      <TableCell key={k} data-cohort={r.cohortStart} data-period={k} data-consumers={n}>
                        {`${n} / ${((n / r.counts[0]!) * 100).toFixed(1)}%`}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : (
        <DetailTable columns={columns} rows={rows} page={page} pages={pages} pageSize={pageSize} snapshot={snapshot} href={pageHref} />
      )}
    </>
  );
}

/**
 * 用户 360 快照（#837）：默认「汇总」标签——顶部卡片写总人数、有订单人数与各渠道同意人数（按 CHANNELS 顺序），
 * 下方按 consumer_id 查单人一行（GET 表单 ?consumer=，查不到或格式不对时给提示、页面仍 200）；
 * 「逐人明细」标签是原来的通用分页明细（按 consumer_id 分页、全部列）
 */
function User360Result({ tab, page, pages, pageSize, snapshot, total, withOrders, consents, lookup, lookupError, columns, rows, consumer }: Extract<Route.ComponentProps['loaderData'], { kind: 'user360' }>) {
  const base = `/analytics/snapshots/${snapshot.id}`;
  const pageHref = (p: number) => `${base}?tab=consumers&page=${p}`;
  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div data-user360-total={total}>
          <StatTile label="总人数" value={total.toLocaleString('zh-CN')} hint="打通后的统一消费者" />
        </div>
        <div data-user360-with-orders={withOrders}>
          <StatTile label="有订单人数" value={withOrders.toLocaleString('zh-CN')} hint="回看窗口内 orders > 0" />
        </div>
        <StatTile label="参考日期" value={snapshot.asOf} hint="统计订单与同意的基准" />
      </div>

      <PillTabs
        current={tab}
        tabs={[
          { key: 'summary', label: '汇总', href: base },
          { key: 'consumers', label: '逐人明细', href: `${base}?tab=consumers` },
        ]}
      />

      {tab === 'summary' ? (
        <>
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h2 className="mb-4 font-medium">各渠道同意人数</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {consents.map(c => (
                <div key={c.channel} data-consent-channel={c.channel} className="rounded-xl border bg-slate-50 px-4 py-3">
                  <div className="text-sm text-slate-500">{c.channel}</div>
                  <div className="mt-1 text-xl font-semibold" data-consent-consumers={c.consumers}>{c.consumers.toLocaleString('zh-CN')}</div>
                </div>
              ))}
            </div>
          </div>

          <Form method="get" action={base} preventScrollReset className="flex max-w-2xl items-center gap-2">
            <input type="hidden" name="tab" value="summary" />
            <div className="flex-1">
              <Input key={consumer ?? ''} type="search" name="consumer" defaultValue={consumer ?? ''} placeholder="按 consumer_id 查单人" aria-label="按 consumer_id 查单人" data-consumer-input />
            </div>
            <button type="submit" className="h-8 shrink-0 rounded-lg border px-3 text-sm hover:bg-slate-50">查询</button>
          </Form>

          {lookupError === 'invalid' && <p data-lookup-error="invalid" className="text-sm text-amber-700">consumer_id 格式不对：只允许字母、数字、下划线与连字符，最长 80 字符</p>}
          {lookupError === 'missing' && <p data-lookup-error="missing" className="text-sm text-slate-500">这张快照里没有这个 consumer_id</p>}
          {lookup && (
            <div className="rounded-2xl border bg-white p-6 shadow-sm">
              <Table>
                <TableHeader>
                  <TableRow>
                    {columns.map(c => <TableHead key={c}>{c}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow data-user360-lookup={String(lookup.consumer_id)}>
                    {columns.map(c => <TableCell key={c} className={c === 'consumer_id' ? 'font-mono text-xs' : undefined}>{cell(lookup[c])}</TableCell>)}
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
        </>
      ) : (
        <DetailTable columns={columns} rows={rows} page={page} pages={pages} pageSize={pageSize} snapshot={snapshot} href={pageHref} />
      )}
    </>
  );
}

function RfmResult({ tab, page, pages, pageSize, snapshot, segments, consumers, defaultSegmentNames }: Extract<Route.ComponentProps['loaderData'], { kind: 'rfm' }>) {
  const t = useT();
  /** 默认人群名按界面语言翻译，租户改过的人群名原样；行键、data-segment 与写回的值仍是存储的原值 */
  const defaults = new Set(defaultSegmentNames);
  const segmentName = (name: string) => builtinName(t, name, defaults);
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
                  <TableCell className="font-medium">{segmentName(s.name)}</TableCell>
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
                  <TableCell>{segmentName(c.segment)}</TableCell>
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
