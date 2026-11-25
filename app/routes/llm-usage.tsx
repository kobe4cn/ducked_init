// app/routes/llm-usage.tsx —— 「模型调用」页（仅管理员，#303）：按用途看近 7/30 天的调用次数、token、平均与 P95 耗时、
// Schema 通过率、错误率与按当前单价折算的金额（ADR-0057，#745），映射草稿一行另有「校验通过率」（#802，部分采用单独计数），
// 指标卡另有「调用来源」（#844）：租户 / 平台端点分开计数，旧行计入「未记录」，
// 并列出最近的调用明细（分页）；失败的调用标红、错误摘要截到 120 字（全文在 title）；
// #1254 加两个视图（?tab=）：默认「按用途」（统计 + 明细），「按轮次」按 turn_id 看每轮的请求次数、token 合计与发起人，
// 统计表与总计加「超时」列（error_kind = 'timeout'，超时的调用拿不到 token）；
// 数字与日期跟随界面语言（#928，ADR-0060），页面文字接入双语（#1047），金额列仍来自服务端 formatCost（#1126 不在本票）
import type { Route } from './+types/llm-usage';
import { Link } from 'react-router';
import { requirePermission } from '~/.server/access';
import { LLM_CALL_PAGE_SIZE, listCalls, listTurns, parseDays, usageByPurpose, type PurposeUsage, type TurnUsage } from '~/.server/llm-usage';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { SectionHeader } from '~/components/section-header';
import { StatTile } from '~/components/stat-tile';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { formatDateTime, formatNumber } from '~/lib/format';
import { makeT, useLocale, useT, type T } from '~/lib/i18n';
import { cn } from '~/lib/utils';

export function meta({ matches }: Route.MetaArgs) {
  // RR8 的 MetaMatch 把 loader 数据放在 loaderData 字段（没有 data）；root 出错时为空，回退中文
  const root = matches[0]?.loaderData;
  const t = makeT(root?.locale ?? 'zh-CN', root?.messages ?? null);
  return [{ title: t('模型调用 · CRM 数据分析平台') }];
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : '—');
const brief = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);
/** 来源列（#843）：这次调用用的端点是租户的还是平台的（中文与文案一致，写成字面量 t('…') 才能与词典对账）；迁移前的旧行 source 为空，显示 — */
const sourceLabel = (t: T, source: 'tenant' | 'platform') => ({ tenant: t('租户'), platform: t('平台') })[source];
/** 视图白名单（#1254）：按用途（默认）或按轮次；其他值回退按用途 */
export function parseTab(v: string | null): 'purpose' | 'turns' {
  return v === 'turns' ? 'turns' : 'purpose';
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'model_provider:manage');
  const url = new URL(request.url);
  const days = parseDays(url.searchParams.get('days'));
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const tab = parseTab(url.searchParams.get('tab'));
  // 两个视图都先取按用途统计（指标卡）；列表按视图取轮次或明细，不用的那份为 null
  const [usage, calls, turns] = await Promise.all([
    usageByPurpose(member.tenant.id, days),
    tab === 'purpose' ? listCalls(member.tenant.id, days, page) : Promise.resolve(null),
    tab === 'turns' ? listTurns(member.tenant.id, days, page) : Promise.resolve(null),
  ]);
  return {
    email: member.email,
    nav: navFor(member),
    days,
    tab,
    pageSize: LLM_CALL_PAGE_SIZE,
    usage,
    calls: calls && { ...calls, rows: calls.rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })) },
    turns: turns && { ...turns, rows: turns.rows.map(r => ({ ...r, startedAt: r.startedAt.toISOString() })) },
  };
}

/** 统计表的一行（用途行与总计行共用） */
function UsageRow({ row, isTotal = false }: { row: PurposeUsage; isTotal?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const checked = row.schemaChecked;
  const dc = row.draftCheck; // 只有映射草稿一行有（#802），其他用途与总计显示「—」
  return (
    <TableRow data-purpose={row.purpose} className={isTotal ? 'font-medium' : undefined}>
      <TableCell>{isTotal ? t('总计') : row.purpose}</TableCell>
      <TableCell data-col="calls">{formatNumber(locale, row.calls)}</TableCell>
      <TableCell data-col="tokens" className="text-slate-500">{`${formatNumber(locale, row.promptTokens)} / ${formatNumber(locale, row.completionTokens)}`}</TableCell>
      <TableCell data-col="avg">{`${formatNumber(locale, row.avgMs)} ms`}</TableCell>
      <TableCell data-col="p95">{`${formatNumber(locale, row.p95Ms)} ms`}</TableCell>
      <TableCell data-col="schema">{checked ? t('{n}/{total}（{pct}）', { n: row.schemaValid, total: checked, pct: pct(row.schemaValid, checked) }) : '—'}</TableCell>
      <TableCell data-col="draft-check">{dc && dc.checked ? t('{n}/{total}（{pct}），部分采用 {partial}', { n: dc.passed, total: dc.checked, pct: pct(dc.passed, dc.checked), partial: dc.partial }) : '—'}</TableCell>
      <TableCell data-col="errors" className={row.errors ? 'text-red-600' : 'text-slate-500'}>{t('{n}（{pct}）', { n: formatNumber(locale, row.errors), pct: pct(row.errors, row.calls) })}</TableCell>
      {/* 超时（#1254）：error_kind = 'timeout' 的行数，是错误的子集；0 显示灰色 */}
      <TableCell data-col="timeouts" className={row.timeouts ? undefined : 'text-slate-500'}>{formatNumber(locale, row.timeouts)}</TableCell>
      <TableCell data-col="cost">{row.cost}</TableCell>
    </TableRow>
  );
}

/** 明细里一次调用的 Schema 校验结果：没校验（null）显示「—」 */
function SchemaResult({ valid }: { valid: boolean | null }) {
  const t = useT();
  if (valid === null) return <>—</>;
  return valid ? <span className="text-emerald-600">{t('通过')}</span> : <span className="text-red-600">{t('未通过')}</span>;
}

/** 上一页 / 下一页 */
function Pager({ page, pages, pageSize, href }: { page: number; pages: number; pageSize: number; href: (p: number) => string }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between text-sm text-slate-500">
      <span data-page={page}>{t('第 {page} / {pages} 页，每页 {pageSize, plural, other {# 条}}', { page, pages, pageSize })}</span>
      <div className="flex gap-3">
        {page > 1 && <Link to={href(page - 1)} className="hover:underline">{`← ${t('上一页')}`}</Link>}
        {page < pages && <Link to={href(page + 1)} className="hover:underline">{`${t('下一页')} →`}</Link>}
      </div>
    </div>
  );
}

/** 「按轮次」表的一行（#1254）：loader 已把 startedAt 序列化成 ISO 字符串；发起人为 null 显示「—」，不显示金额 */
function TurnRow({ row }: { row: Omit<TurnUsage, 'startedAt'> & { startedAt: string } }) {
  const locale = useLocale();
  return (
    <TableRow data-turn={row.turnId}>
      <TableCell className="text-slate-500">{formatDateTime(locale, row.startedAt)}</TableCell>
      <TableCell data-col="actor" className="text-slate-500">{row.actorEmail ?? '—'}</TableCell>
      {/* 用途是原始 key（不翻译，和按用途表一样），去重后按字典序用 ', ' 拼（英文界面不能拼出中文分隔符） */}
      <TableCell data-col="purposes" className="text-slate-500">{row.purposes.join(', ')}</TableCell>
      <TableCell data-col="calls">{formatNumber(locale, row.calls)}</TableCell>
      <TableCell data-col="tokens" className="text-slate-500">{`${formatNumber(locale, row.promptTokens)} / ${formatNumber(locale, row.completionTokens)}`}</TableCell>
      <TableCell data-col="cached" className="text-slate-500">{formatNumber(locale, row.cachedTokens)}</TableCell>
    </TableRow>
  );
}

export default function LlmUsage({ loaderData }: Route.ComponentProps) {
  const { email, nav, days, tab, pageSize, usage, calls, turns } = loaderData;
  const t = useT();
  const locale = useLocale();
  const href = (p: number) => `/llm-usage?days=${days}&tab=${tab}&page=${p}`;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title={t('模型调用')} description={t('近 {days} 天本租户的模型调用：次数、token、耗时与质量（Schema 通过率、错误率）。「校验通过率」只统计映射草稿：通过 / 做了映射校验的生成，部分采用另计。', { days })} />

      <div className="flex flex-col gap-2">
        <PillTabs
          tabs={[
            { key: '7', label: t('近 {days} 天', { days: 7 }), href: `/llm-usage?days=7&tab=${tab}` },
            { key: '30', label: t('近 {days} 天', { days: 30 }), href: `/llm-usage?days=30&tab=${tab}` },
          ]}
          current={String(days)}
        />
        {/* 视图（#1254）：默认按用途（统计 + 明细），按轮次看每个 turn_id 的请求次数与 token；链接同时带 days 和 tab */}
        <PillTabs
          tabs={[
            { key: 'purpose', label: t('按用途'), href: `/llm-usage?days=${days}&tab=purpose` },
            { key: 'turns', label: t('按轮次'), href: `/llm-usage?days=${days}&tab=turns` },
          ]}
          current={tab}
        />
      </div>

      {usage.total.calls === 0 ? (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">
          {t('暂无模型调用。测试连通性、生成映射草稿、AI 解读等每次调用（成功与失败）都会记在这里，可以先到')}
          <Link to="/model-provider" className="mx-1 underline">{t('模型服务')}</Link>
          {t('测试一次连通性。')}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatTile label={t('总调用')} value={formatNumber(locale, usage.total.calls)} hint={t('近 {days} 天，全部用途', { days })} />
            <StatTile label={t('总 token')} value={formatNumber(locale, usage.total.promptTokens + usage.total.completionTokens)}
              hint={t('输入 {in} · 输出 {out}', { in: formatNumber(locale, usage.total.promptTokens), out: formatNumber(locale, usage.total.completionTokens) })} />
            <StatTile label={t('P95 耗时')} value={`${formatNumber(locale, usage.total.p95Ms)} ms`} hint={t('全部用途合计')} />
            <StatTile label={t('错误率')} value={pct(usage.total.errors, usage.total.calls)} tone={usage.total.errors ? 'text-red-600' : undefined}
              hint={t('{count, plural, other {# 次失败}}', { count: usage.total.errors })} />
            {/* 调用来源（#844）：本租户、本窗口按租户 / 平台端点分开计数；旧行（source 为空）单独提示，没有时不渲染 */}
            <StatTile label={t('调用来源')} value={<span data-col="source-split">{t('租户 {tenant} / 平台 {platform}', { tenant: formatNumber(locale, usage.bySource.tenant), platform: formatNumber(locale, usage.bySource.platform) })}</span>}
              hint={usage.bySource.unknown ? <span data-col="source-unknown">{t('未记录 {n}', { n: formatNumber(locale, usage.bySource.unknown) })}</span> : t('近 {days} 天', { days })} />
          </div>

          {tab === 'turns' ? (
            <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
              <SectionHeader title={t('按轮次')}>{t('助手的一轮对话共用一个轮次，其他用途的每次调用各自一轮；开始时间取这轮最早一次调用，token 是这轮的合计（超时的调用拿不到 token，不计入合计）。')}</SectionHeader>
              {turns && (turns.rows.length > 0 ? (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('开始时间')}</TableHead>
                        <TableHead>{t('发起人')}</TableHead>
                        <TableHead>{t('用途')}</TableHead>
                        <TableHead>{t('请求次数')}</TableHead>
                        <TableHead>{t('token（输入 / 输出）')}</TableHead>
                        <TableHead>{t('其中缓存 token')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {turns.rows.map(r => <TurnRow key={r.turnId} row={r} />)}
                    </TableBody>
                  </Table>
                  <Pager page={turns.page} pages={turns.pages} pageSize={pageSize} href={href} />
                </>
              ) : (
                // 有调用但都不带 turn_id（旧行）：轮次视图的一句空状态
                <p className="text-slate-500">{t('近 {days} 天没有按轮次记录的调用', { days })}</p>
              ))}
            </div>
          ) : (
            <>
              <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
                <SectionHeader title={t('按用途统计')}>{t('Schema 通过率的分母只算做了校验的调用（工具对话与向量检索没有 Schema）；P95 按每次调用的原始耗时算，不是各用途的平均。校验通过率只在映射草稿一行有值：分母是做了映射校验的映射草稿生成（采用的含部分采用，加上校验不过整份放弃的），部分采用单独计数。')}</SectionHeader>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('用途')}</TableHead>
                      <TableHead>{t('调用')}</TableHead>
                      <TableHead>{t('token（输入 / 输出）')}</TableHead>
                      <TableHead>{t('平均耗时')}</TableHead>
                      <TableHead>{t('P95 耗时')}</TableHead>
                      <TableHead>{t('Schema 通过率')}</TableHead>
                      <TableHead>{t('校验通过率')}</TableHead>
                      <TableHead>{t('错误')}</TableHead>
                      <TableHead>{t('超时')}</TableHead>
                      <TableHead>{t('金额')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usage.rows.map(r => <UsageRow key={r.purpose} row={r} />)}
                    <UsageRow row={usage.total} isTotal />
                  </TableBody>
                </Table>
                {/* 超时的调用四种 token 都是 null（llm.ts 拿不到 usage）：表下注明这些调用的 token 不在统计里（#1254） */}
                <p data-note="timeouts" className="text-sm text-slate-500">{t('超时的调用拿不到 token，这些调用的 token 不在统计里')}</p>
              </div>

              <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
                <SectionHeader title={t('最近调用')}>{t('按时间倒序，失败的红字标出；错误摘要截到 120 字，悬停可看全文。')}</SectionHeader>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('时间')}</TableHead>
                      <TableHead>{t('用途')}</TableHead>
                      <TableHead>{t('模型')}</TableHead>
                      <TableHead>{t('来源')}</TableHead>
                      <TableHead>{t('输入 token')}</TableHead>
                      <TableHead>{t('输出 token')}</TableHead>
                      <TableHead>{t('耗时')}</TableHead>
                      <TableHead>Schema</TableHead>
                      <TableHead>{t('错误')}</TableHead>
                      <TableHead>{t('金额')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {calls && calls.rows.map(r => (
                      <TableRow key={r.id} data-call-id={r.id}>
                        <TableCell className="text-slate-500">{formatDateTime(locale, r.createdAt)}</TableCell>
                        <TableCell>{r.purpose}</TableCell>
                        <TableCell className="text-slate-500">{r.model}</TableCell>
                        {/* 来源（#843）：这次调用用的端点是租户的还是平台的；迁移前的旧行为空，显示 — */}
                        <TableCell data-col="source" className="text-slate-500">{(r.source && sourceLabel(t, r.source)) ?? '—'}</TableCell>
                        <TableCell>{r.promptTokens === null ? '—' : formatNumber(locale, r.promptTokens)}</TableCell>
                        <TableCell>{r.completionTokens === null ? '—' : formatNumber(locale, r.completionTokens)}</TableCell>
                        <TableCell>{`${formatNumber(locale, r.durationMs)} ms`}</TableCell>
                        <TableCell><SchemaResult valid={r.schemaValid} /></TableCell>
                        <TableCell className={cn('max-w-2xl truncate', r.error ? 'text-red-600' : 'text-slate-400')} title={r.error ?? undefined}>
                          {r.error ? brief(r.error) : '—'}
                        </TableCell>
                        <TableCell data-col="cost">{r.cost}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {calls && <Pager page={calls.page} pages={calls.pages} pageSize={pageSize} href={href} />}
              </div>
            </>
          )}
        </>
      )}
    </AppShell>
  );
}
