// app/routes/source.tsx —— 单个数据源：连接参数（凭据不显示）、测试连接、修改与轮换凭据、重新列出表并采集；
// 同步范围：列出的表（估算行数、读权限、新表、源端已不存在），成员按 schema 全选、按名称过滤后批量选，保存的是逐张的表清单（ADR-0013）；
// 范围内各表的行数、列统计、同步方式与频率、是否已进湖与水位线候选，成员从候选中确认水位线字段，没有主键的表声明业务主键（可多列），
// 有主键的表声明软删除字段；手动触发同步，查看每张表的同步历史。
// 「湖中数据」标签页（?tab=lake）：最近一次核对的结果，每表一行显示覆盖、位置与文件、结构、数据量四项，可展开明细；
// 手动触发核对，有差异时触发一次主键比对同步。
// 「源视图」标签页（?tab=views）：这个数据源下的源视图（只读原始层的 SELECT，ADR-0022）及其发布状态，数据工程师、管理员可以新建。
// 概览页还有「源端注释」区块（#524）：列出采集到的表注释与列注释（原文、版本、采集时间），组与行带锚点，知识面板的 source_comment 证据链回这里。
// 页头下是类型、目标、同步表数、核对状态四张指标卡，各标签页的内容放在一个白色面板里
import { Fragment, useEffect, useState } from 'react';
import { data, Form, Link, redirect, useNavigation, useRevalidator } from 'react-router';
import { CheckCircle2, CircleAlert, CircleCheck, Lock, PencilLine, PlugZap, Plus, RefreshCw, ScrollText, Trash2 } from 'lucide-react';
import type { Route } from './+types/source';
import { can, requirePermission } from '~/.server/access';
import { errorTextFor, formatServer } from '~/.server/i18n';
import { getLocale } from '~/.server/locale';
import { navFor } from '~/.server/nav';
import { sourceDrift } from '~/.server/source-drift';
import { getKeyChecks } from '~/.server/source-key-check';
import { getSyncStatus, syncSource } from '~/.server/source-sync';
import { getVerifyStatus, notInLakeReason, verifySource } from '~/.server/source-verify';
import { listSourceViews, type SourceViewSummary } from '~/.server/source-views';
import {
  confirmKey, confirmSoftDelete, confirmWatermark, deleteSource, getSource, relistSource, setSyncScope, sourceDeleteBlockers, SourceError, testSource,
  updateSource,
} from '~/.server/sources';
import { TASK_STATUS_LABELS } from '~/.server/tasks';
import type { DataCheck, FailedCheck, FileCheck, StructureCheck, VerifyRecord } from '~/.server/pipeline/verify-engine';
import type { SchemaDiff } from '~/.server/pipeline/schema-diff';
import { formValues, LAKE_COVERAGE, SOURCE_KIND_LABELS, SYNC_MODES, targetOf, type LakeCoverage } from '~/lib/sources';
import { builtinName, ENUM_LABELS } from '~/lib/builtin-names';
import { formatDateTime, formatNumber } from '~/lib/format';
import { msg, useLocale, useT, type Locale, type T } from '~/lib/i18n';
import { AppShell } from '~/components/app-shell';
import { KeyCheckFindings } from '~/components/key-check-findings';
import { KindIcon } from '~/components/kind-icon';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { SourceFields } from '~/components/source-fields';
import { NewSourceViewForm } from '~/components/source-view-form';
import { StatTile } from '~/components/stat-tile';
import { SectionHeader } from '~/components/section-header';
import { StatusText, TASK_TONES, type StatusTone } from '~/components/status-text';
import { VerifyBadge } from '~/components/verify-badge';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.source.name ?? '数据源'} · CRM 数据分析平台` }];
}

/** 连接配置项的中文名（键与界面表单同名）：schema、TLS、HTTPS 本来就是拉丁字，不进词典 */
const configLabel = (t: T, k: string) => (({
  host: t('主机'), port: t('端口'), database: t('数据库名'), schema: 'schema', user: t('用户名'), srv: t('SRV 记录'), tls: 'TLS', authSource: t('认证库'),
  path: t('路径'), format: t('文件格式'), endpoint: t('对象存储地址'), region: t('区域'), urlStyle: t('寻址方式'), useSsl: 'HTTPS',
}) as Record<string, string>)[k] ?? k;

/** 列统计里格式特征的中文名（键与 TEXT_FORMATS 同名）：UUID、JSON、ObjectId 本来就是拉丁字，不进词典 */
const formatLabel = (t: T, k: string) => (({
  email: t('邮箱'), mobile: t('手机号'), integer: t('整数'), decimal: t('小数'), date: t('日期'), datetime: t('日期时间'),
}) as Record<string, string>)[k] ?? k;

/** 页面的标签页：概览（连接、同步范围、源表、同步）、湖中数据（核对结果）与源视图 */
type Tab = 'overview' | 'lake' | 'views';
const tabOf = (request: Request): Tab => {
  const tab = new URL(request.url).searchParams.get('tab');
  return tab === 'lake' || tab === 'views' ? tab : 'overview';
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  try {
    const source = await getSource(member, params.sourceId);
    const sync = await getSyncStatus(member, params.sourceId);
    const verify = await getVerifyStatus(member, params.sourceId);
    const { views } = await listSourceViews(member, params.sourceId);
    const keyChecks = await getKeyChecks(member, params.sourceId);
    const drift = await sourceDrift(member.tenant.id, params.sourceId);
    const canDelete = can(member.role, 'publish');
    /**
     * 表最近一次业务主键检查：排队或运行中为 running，有空值或重复为 failed（带结果），任务出错为 error；
     * 通过的已写回声明，不再单独显示。检查期间与不通过时，原有声明照旧生效
     */
    const keyCheckOf = (name: string) => {
      const c = keyChecks.get(name);
      if (!c) return null;
      const { keyColumns } = c;
      if (c.status === 'queued' || c.status === 'running') return { status: 'running' as const, keyColumns };
      if (c.status === 'failed' || !c.result) return { status: 'error' as const, keyColumns, error: c.error ?? null };
      return c.result.ok ? null : { status: 'failed' as const, keyColumns, result: c.result };
    };
    /** 同步范围内的表没有进湖的原因（同步成功过的为 null） */
    const notInLake = (name: string) => {
      const t = source.listing.find(l => l.name === name)!;
      const profiled = source.tables.find(p => p.name === name);
      const reason = notInLakeReason(t, profiled && { needsWatermark: profiled.syncMode === 'needs_confirmation' }, sync.history[name]);
      return reason && LAKE_COVERAGE[reason];
    };
    return {
      tab: tabOf(request),
      email: member.email,
      nav: navFor(member),
      canWrite: can(member.role, 'sources:write'),
      // 有发布权限的成员才能删除数据源（ADR-0044），被挡时列出原因
      canDelete,
      deleteBlockers: canDelete ? await sourceDeleteBlockers(member, params.sourceId) : [],
      source: {
        id: source.id,
        name: source.name,
        kind: source.kind,
        config: source.config,
        createdAt: source.createdAt.toISOString(),
        credentialsRotatedAt: source.credentialsRotatedAt?.toISOString() ?? null,
      },
      profile: {
        status: source.profile.status,
        statusLabel: source.profile.status === 'none' ? '未采集' : TASK_STATUS_LABELS[source.profile.status],
        error: source.profile.error,
        attemptedAt: source.profile.attemptedAt?.toISOString() ?? null,
        unreadable: source.profile.unreadable,
        profiledAt: source.profile.profiledAt?.toISOString() ?? null,
      },
      listing: source.listing.map(t => ({
        ...t,
        scopedAt: t.scopedAt?.toISOString() ?? null,
        notInLake: t.inScope ? notInLake(t.name) : null,
      })),
      newTables: source.newTables,
      tables: source.tables.map(t => ({ ...t, notInLake: notInLake(t.name), keyCheck: t.primaryKey.length ? null : keyCheckOf(t.name), drift: drift.get(t.name) ?? [] })),
      comments: source.comments.map(c => ({ ...c, collectedAt: c.collectedAt.toISOString() })),
      sync: {
        status: sync.status,
        statusLabel: sync.status === 'none' ? '未同步' : TASK_STATUS_LABELS[sync.status],
        error: sync.error,
        attemptedAt: sync.attemptedAt?.toISOString() ?? null,
        finishedAt: sync.finishedAt?.toISOString() ?? null,
        history: sync.history,
      },
      verify: {
        status: verify.status,
        statusLabel: verify.status === 'none' ? '未核对' : TASK_STATUS_LABELS[verify.status],
        error: verify.error,
        attemptedAt: verify.attemptedAt?.toISOString() ?? null,
        verifiedAt: verify.verifiedAt?.toISOString() ?? null,
        differences: verify.differences,
        tables: verify.tables,
      },
      views,
    };
  } catch (e) {
    if (e instanceof SourceError) throw data(null, { status: e.status });
    throw e;
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  const member = await requirePermission(request, 'sources:write');
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  try {
    switch (field('intent')) {
      case 'test': {
        // 两条完整句式（有、没有不可读的表各一条），表数用 ICU 复数；表名连接符「、」也是服务端词条
        const locale = await getLocale(request);
        const { tables, unreadable } = await testSource(member, params.sourceId);
        const ok = unreadable.length
          ? formatServer(locale, msg('连接正常：{count, plural, other {# 张表}}，账号只读；{unreadable, plural, other {# 张表}}没有读权限，不能选入同步范围：{names}', {
              count: tables.length, unreadable: unreadable.length, names: unreadable.join(formatServer(locale, msg('、'))),
            }))
          : formatServer(locale, msg('连接正常：{count, plural, other {# 张表}}，账号只读', { count: tables.length }));
        return { ok, error: null, values: null };
      }
      case 'update':
        await updateSource(member, params.sourceId, Object.fromEntries([...form].map(([k, v]) => [k, String(v)])));
        break;
      case 'refresh':
        await relistSource(member, params.sourceId);
        break;
      case 'scope': {
        // 表单列出了哪些表（listed）、其中勾选了哪些（table）：勾选的选入，列出了却没勾选的移出
        const selected = form.getAll('table').map(String);
        const remove = form.getAll('listed').map(String).filter(name => !selected.includes(name));
        await setSyncScope(member, params.sourceId, { add: selected, remove });
        break;
      }
      case 'sync':
        await syncSource(member, params.sourceId);
        break;
      case 'verify':
        await verifySource(member, params.sourceId);
        break;
      case 'reconcile':
        await syncSource(member, params.sourceId, { reconcile: true });
        break;
      case 'confirm-watermark':
        await confirmWatermark(member, params.sourceId, field('table'), field('column'));
        break;
      case 'confirm-key':
        await confirmKey(member, params.sourceId, field('table'), form.getAll('column').map(String));
        break;
      case 'confirm-soft-delete':
        await confirmSoftDelete(member, params.sourceId, field('table'), field('column'));
        break;
      case 'delete':
        // deleteSource 另外要求发布权限
        await deleteSource(member, params.sourceId);
        throw redirect('/sources');
      default:
        return data({ ok: null, error: formatServer(await getLocale(request), msg('未知操作')), values: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof SourceError) {
      return data({ ok: null, error: await errorTextFor(request, e), values: field('intent') === 'update' ? formValues(form) : null }, { status: e.status });
    }
    throw e;
  }
  // 回到提交时所在的标签页
  throw redirect(`/sources/${params.sourceId}${tabOf(request) === 'lake' ? '?tab=lake' : ''}`);
}

const SYNC_VARIANTS = { watermark: 'default', needs_confirmation: 'secondary', full_compare: 'outline' } as const;
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
/** 按界面语言格式化的日期时间：空值返回 — */
const when = (locale: Locale, iso: string | null) => (iso ? formatDateTime(locale, iso) : '—');

type TableView = Route.ComponentProps['loaderData']['tables'][number];
type ListedView = Route.ComponentProps['loaderData']['listing'][number];
type CommentView = Route.ComponentProps['loaderData']['comments'][number];
type SyncEntry = Route.ComponentProps['loaderData']['sync']['history'][string][number];

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
/** 批次方式的中文名（键与同步历史的 batch mode 同名）：主键比对与全量比对是动作名，全量比对与同步方式共用词条 */
const batchLabel = (t: T, k: string) => (({
  full: t('全表读取'), incremental: t('增量'), reconcile: t('主键比对'), compare: t('全量比对'),
}) as Record<string, string>)[k] ?? k;

/** 批次的读取范围：增量批次从水位线往回退了回看窗口时一并说明 */
function watermarkRange(t: T, e: Extract<SyncEntry, { batch: number }>) {
  if (e.watermarkColumn === null) return t('—（没有水位线）');
  if (e.mode === 'reconcile') return t('{column}：{to}（不变）', { column: e.watermarkColumn, to: e.watermarkTo ?? '—' });
  const lookback = e.readFrom !== null && e.readFrom !== e.watermarkFrom ? t('（回看自 {at}）', { at: e.readFrom }) : '';
  return t('{column}：{from} → {to}{lookback}', { column: e.watermarkColumn, from: e.watermarkFrom ?? t('起始'), to: e.watermarkTo ?? '—', lookback });
}

/** 批次读到的源表结构与上一次相比的变化（ADR-0034）：删除与改类型的列标红 */
function SchemaChange({ schema }: { schema: SchemaDiff }) {
  const t = useT();
  return (
    <TableRow data-schema-change>
      <TableCell />
      <TableCell colSpan={5} className="text-xs whitespace-normal">
        <span className="mr-2 text-slate-500">{t('源表结构变化')}</span>
        {schema.removed.length > 0 && (
          <span data-schema-removed className="mr-3 inline-flex items-center gap-1 font-medium text-red-600">
            <CircleAlert className="size-3.5" />
            {t('删除')} <span className="font-mono">{schema.removed.join(t('、'))}</span>
          </span>
        )}
        {schema.typeChanged.length > 0 && (
          <span data-schema-type-changed className="mr-3 inline-flex items-center gap-1 font-medium text-red-600">
            <CircleAlert className="size-3.5" />
            {t('改类型')} <span className="font-mono">
              {schema.typeChanged.map(c => t('{name}（{from} → {to}{widened}）', { name: c.name, from: c.from, to: c.to, widened: c.widened ? t('，放宽') : '' })).join(t('、'))}
            </span>
          </span>
        )}
        {schema.added.length > 0 && (
          <span data-schema-added className="text-slate-600">{t('新增')} <span className="font-mono">{schema.added.join(t('、'))}</span></span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** 一张表的同步历史：每次同步一个变更批次（新的在前），源表结构有变化时在批次下面列出 */
function SyncHistory({ table, entries }: { table: string; entries: SyncEntry[] }) {
  const t = useT();
  const locale = useLocale();
  return (
    <div data-sync-table={table} className="space-y-1">
      <div className="font-mono text-sm font-medium">{table}</div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('批次')}</TableHead>
            <TableHead>{t('方式')}</TableHead>
            <TableHead>{t('行数')}</TableHead>
            <TableHead>{t('耗时')}</TableHead>
            <TableHead>{t('水位线')}</TableHead>
            <TableHead>{t('开始时间')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e, i) => 'error' in e ? (
            <TableRow key={`${e.taskId}-${i}`} data-sync-error={e.gone ? undefined : true} data-sync-gone={e.gone ? true : undefined}>
              <TableCell>—</TableCell>
              <TableCell colSpan={3} className={`whitespace-normal ${e.gone ? 'text-muted-foreground' : 'text-destructive'}`}>
                {e.gone ? t('跳过：{error}', { error: e.error }) : t('失败：{error}', { error: e.error })}
              </TableCell>
              <TableCell>—</TableCell>
              <TableCell>{when(locale, e.startedAt)}</TableCell>
            </TableRow>
          ) : (
            <Fragment key={`${e.taskId}-${i}`}>
              <TableRow data-batch={e.batch} data-batch-mode={e.mode}>
                <TableCell>{e.batch}</TableCell>
                <TableCell>{batchLabel(t, e.mode)}</TableCell>
                <TableCell>{t('{rows}（新增 {inserted}，更新 {updated}，删除 {deleted}）', {
                  rows: formatNumber(locale, e.rows), inserted: formatNumber(locale, e.inserted), updated: formatNumber(locale, e.updated), deleted: formatNumber(locale, e.deleted),
                })}</TableCell>
                <TableCell>{duration(e.durationMs)}</TableCell>
                <TableCell className="font-mono text-xs whitespace-normal">{watermarkRange(t, e)}</TableCell>
                <TableCell>{when(locale, e.startedAt)}</TableCell>
              </TableRow>
              {e.schema?.changed && <SchemaChange schema={e.schema} />}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** 进湖情况：同步范围内的表有几张已经进湖，没进湖的逐张说明原因；范围外的表只计数 */
function LakeCoverage({ listing }: { listing: ListedView[] }) {
  const t = useT();
  const scoped = listing.filter(row => row.inScope);
  const missing = scoped.filter(row => row.notInLake).map(row => t('{table}（{reason}）', { table: row.name, reason: builtinName(t, row.notInLake!, ENUM_LABELS) }));
  const outside = listing.filter(row => !row.inScope);
  const unreadable = outside.filter(row => !row.readable).length;
  const others = [
    outside.length - unreadable ? t('不在同步范围 {n, plural, other {# 张}}', { n: outside.length - unreadable }) : '',
    unreadable ? t('账号没有读权限 {n, plural, other {# 张}}', { n: unreadable }) : '',
  ].filter(Boolean).join(t('，'));
  return (
    <StatusText tone={missing.length ? 'bad' : scoped.length ? 'ok' : 'none'} data-lake-coverage>
      {t('已进湖 {inLake, plural, other {# 张}}，未进湖 {missing, plural, other {# 张}}{list}{others}', {
        inLake: scoped.length - missing.length,
        missing: missing.length,
        list: missing.length ? t('：{list}', { list: missing.join(t('、')) }) : '',
        others: others ? t('；{others}', { others }) : '',
      })}
    </StatusText>
  );
}

/**
 * 同步范围：列出的全部表，按 schema 分组。可按名称过滤、按 schema 全选；过滤只是隐藏，保存时提交的是逐张勾选的表。
 * 账号读不了、源端已不存在的表不能选入（已在范围内的可以移出）。服务端的范围变了（保存、重新列出表）时由调用方换 key 重置勾选
 */
function SyncScope({ listing, newTables, canWrite, submitting }: { listing: ListedView[]; newTables: number; canWrite: boolean; submitting: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(() => new Set(listing.filter(row => row.inScope).map(row => row.name)));
  const visible = (row: ListedView) => row.name.toLowerCase().includes(filter.trim().toLowerCase());
  const addable = (row: ListedView) => canWrite && row.readable && !row.gone;
  const selectable = (row: ListedView) => addable(row) || (canWrite && row.inScope);
  const schemas = [...new Set(listing.map(row => row.schema))];
  const toggle = (names: string[], on: boolean) => setSelected(prev => {
    const next = new Set(prev);
    for (const n of names) on ? next.add(n) : next.delete(n);
    return next;
  });
  return (
    <Form method="post" preventScrollReset className="space-y-3">
      <input type="hidden" name="intent" value="scope" />
      {newTables > 0 && (
        <StatusText tone="pending" data-new-tables={newTables}>{t('有 {n, plural, other {# 张新表}}未选', { n: newTables })}</StatusText>
      )}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="max-w-64" placeholder={t('按名称过滤')} value={filter} onChange={e => setFilter(e.target.value)} aria-label={t('按名称过滤')} />
          <Button type="button" variant="outline" size="sm" onClick={() => toggle(listing.filter(row => visible(row) && addable(row)).map(row => row.name), true)}>
            {t('全选过滤结果')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => toggle(listing.filter(visible).map(row => row.name), false)}>
            {t('取消过滤结果')}
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>{t('表')}</TableHead>
            <TableHead>{t('估算行数')}</TableHead>
            <TableHead>{t('状态')}</TableHead>
          </TableRow>
        </TableHeader>
        {schemas.map(schema => {
          const group = listing.filter(row => row.schema === schema);
          const shown = group.filter(visible);
          const choices = shown.filter(addable);
          return (
            <TableBody key={schema} data-schema={schema}>
              {schemas.length > 1 || schema ? (
                <TableRow hidden={!shown.length}>
                  <TableCell>
                    {canWrite && (
                      <input
                        type="checkbox"
                        aria-label={t('全选 {schema}', { schema: schema || t('全部') })}
                        disabled={!choices.length}
                        checked={choices.length > 0 && choices.every(row => selected.has(row.name))}
                        onChange={e => toggle(choices.map(row => row.name), e.target.checked)}
                      />
                    )}
                  </TableCell>
                  <TableCell colSpan={3} className="font-medium">{schema || t('（无 schema）')}</TableCell>
                </TableRow>
              ) : null}
              {group.map(row => (
                <TableRow key={row.name} hidden={!visible(row)} data-listed={row.name} data-in-scope={String(row.inScope)}>
                  <TableCell>
                    <input type="hidden" name="listed" value={row.name} />
                    <input
                      type="checkbox"
                      name="table"
                      value={row.name}
                      aria-label={row.name}
                      disabled={!selectable(row)}
                      checked={selected.has(row.name)}
                      onChange={e => toggle([row.name], e.target.checked)}
                    />
                  </TableCell>
                  <TableCell className="font-mono">{row.name}</TableCell>
                  <TableCell>{row.estimatedRows === null ? '—' : t('约 {n}', { n: formatNumber(locale, row.estimatedRows) })}</TableCell>
                  <TableCell className="space-x-1 whitespace-normal">
                    {row.gone && <StatusText tone="bad" data-gone>{t('源端已不存在')}</StatusText>}
                    {!row.readable && !row.gone && <Badge variant="outline">{t('账号没有读权限')}</Badge>}
                    {row.isNew && <Badge variant="secondary" data-new>{t('新表')}</Badge>}
                    {row.inScope && (
                      <span className="text-xs text-muted-foreground">
                        {t('已选入{by}', { by: row.scopedBy ? t('（{who}，{at}）', { who: row.scopedBy, at: when(locale, row.scopedAt) }) : '' })}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          );
        })}
      </Table>
      {canWrite && <Button type="submit" disabled={submitting}>{t('保存同步范围')}</Button>}
    </Form>
  );
}

function ColumnStats({ table }: { table: TableView }) {
  const t = useT();
  const locale = useLocale();
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none">
        {t('列统计（{cols, plural, other {# 列}}，基于前 {rows} 行样本）', { cols: table.columns.length, rows: formatNumber(locale, table.sampleRows) })}
      </summary>
      <Table className="mt-2">
        <TableHeader>
          <TableRow>
            <TableHead>{t('列')}</TableHead>
            <TableHead>{t('类型')}</TableHead>
            <TableHead>{t('空值率')}</TableHead>
            <TableHead>{t('基数')}</TableHead>
            <TableHead>{t('取值范围')}</TableHead>
            <TableHead>{t('格式特征')}</TableHead>
            <TableHead>{t('常见取值（样本行数）')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.columns.map(c => (
            <TableRow key={c.name} data-column={c.name}>
              <TableCell className="font-mono">{c.name}</TableCell>
              <TableCell className="font-mono text-muted-foreground">{c.type}</TableCell>
              <TableCell>{pct(c.nullRate)}</TableCell>
              <TableCell>{formatNumber(locale, c.distinct)}</TableCell>
              <TableCell className="whitespace-normal">
                {c.min !== null ? t('{min} ～ {max}', { min: c.min, max: c.max }) : c.length ? t('长度 {min}～{max}', { min: c.length.min, max: c.length.max }) : '—'}
              </TableCell>
              <TableCell>{c.formats?.map(f => `${formatLabel(t, f.format)} ${pct(f.share)}`).join(t('，')) || '—'}</TableCell>
              <TableCell className="whitespace-normal" data-top>
                {c.top?.map(v => t('{value}（{rows}）', { value: v.value, rows: formatNumber(locale, v.rows) })).join(t('，')) || '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </details>
  );
}

/** 这张表的已发布映射的列差异：每个映射一行，标出没映射的新列与源端已删除的引用列，链接到映射详情页 */
function TableMappingDrift({ drift }: { drift: TableView['drift'] }) {
  const t = useT();
  if (!drift.length) return null;
  return (
    <ul className="space-y-1">
      {drift.map(d => (
        <li key={d.mappingId}>
          <Link to={`/mappings/${d.mappingId}`} className="inline-flex flex-wrap items-center gap-2 hover:underline">
            {d.newColumns.length > 0 && (
              <StatusText tone="pending" data-drift-new={d.newColumns.join(',')}>{t('{entity}：{n, plural, other {# 个新列未映射}}', { entity: d.entity, n: d.newColumns.length })}</StatusText>
            )}
            {d.missing.length > 0 && (
              <StatusText tone="bad" data-drift-missing={d.missing.join(',')}>{t('{entity}：源端已删除 {n, plural, other {# 列}}', { entity: d.entity, n: d.missing.length })}</StatusText>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Watermark({ table, canWrite, submitting }: { table: TableView; canWrite: boolean; submitting: boolean }) {
  const t = useT();
  if (!table.watermarkCandidates.length) return null;
  return (
    <ul className="space-y-1 text-xs">
      {table.watermarkCandidates.map(c => (
        <li key={c.column} className="flex items-center gap-2" data-candidate={c.column}>
          <span className="font-mono">{c.column}</span>
          <span className="text-muted-foreground">{t('{kind}：{reason}', { kind: c.kind === 'updated_at' ? t('更新时间') : t('自增主键'), reason: c.reason })}</span>
          {table.watermark === c.column ? (
            <Badge variant="secondary">{t('已确认{by}', { by: table.confirmedBy ? t('（{who}）', { who: table.confirmedBy }) : '' })}</Badge>
          ) : canWrite ? (
            <Form method="post" preventScrollReset>
              <input type="hidden" name="intent" value="confirm-watermark" />
              <input type="hidden" name="table" value={table.name} />
              <input type="hidden" name="column" value={c.column} />
              <Button type="submit" variant="outline" size="sm" disabled={submitting}>{t('确认为水位线')}</Button>
            </Form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * 主键：源端主键；没有时成员可以声明业务主键（一列或多列，平台标出样本中唯一的单列作参考，在源端全表检查通过后才生效）。
 * 检查进行中与不通过时，在当前生效的声明下面显示新声明的检查状态；不通过时列出空值行数与重复键。
 * 都没有时，全量比对按整行比对（修改记为一删一增），水位线同步的增量行一律记为新增、每天整行比对一次补上删除
 */
function Key({ table, canWrite, submitting }: { table: TableView; canWrite: boolean; submitting: boolean }) {
  const t = useT();
  if (table.primaryKey.length) return <div className="text-xs text-muted-foreground">{t('主键：{cols}', { cols: table.primaryKey.join(t('、')) })}</div>;
  return (
    <div className="space-y-1 text-xs">
      {table.key ? (
        <div className="flex items-center gap-2" data-declared-key={table.key.join(',')}>
          <span>{t('业务主键：{cols}', { cols: table.key.join(t('、')) })}</span>
          <Badge variant="secondary">{t('已确认{by}', { by: table.keyConfirmedBy ? t('（{who}）', { who: table.keyConfirmedBy }) : '' })}</Badge>
        </div>
      ) : (
        <div className="text-muted-foreground" data-no-key>
          {table.syncMode === 'full_compare'
            ? t('没有主键：按整行比对，完全相同的重复行按出现次数计，修改记为一删一增')
            : t('没有主键：增量行一律记为新增；每天整行全量比对一次，补上源端的删除')}
        </div>
      )}
      {table.keyCheck && <KeyCheck check={table.keyCheck} />}
      {canWrite && table.keyEligibleColumns.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground select-none">
            {table.key ? t('改为其他业务主键') : t('声明业务主键（一列或多列的组合，能唯一标识一行；据此区分新增与更新）')}
          </summary>
          <Form method="post" preventScrollReset className="mt-1 space-y-1">
            <input type="hidden" name="intent" value="confirm-key" />
            <input type="hidden" name="table" value={table.name} />
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {table.keyEligibleColumns.map(column => (
                <label key={column} className="flex items-center gap-1" data-key-column={column}>
                  <input type="checkbox" name="column" value={column} defaultChecked={table.key?.includes(column)} />
                  <span className="font-mono">{column}</span>
                  {table.keyCandidates.includes(column) && <span className="text-muted-foreground" data-key-candidate={column}>{t('（样本中唯一）')}</span>}
                </label>
              ))}
            </div>
            <Button type="submit" variant="outline" size="sm" disabled={submitting || table.keyCheck?.status === 'running'}>{t('在源端全表检查并确认')}</Button>
          </Form>
        </details>
      )}
    </div>
  );
}

/** 新声明的业务主键检查：进行中、没通过（空值行数与重复键）或检查出错 */
function KeyCheck({ check }: { check: NonNullable<TableView['keyCheck']> }) {
  const t = useT();
  const columns = check.keyColumns.join(t('、'));
  switch (check.status) {
    case 'running':
      return <StatusText tone="pending" data-keycheck-status="running">{t('正在全表检查新声明：{columns}', { columns })}</StatusText>;
    case 'error':
      // loader 在任务没留下错误原文时下发 null，这里按界面语言兜底；其余是服务端原文
      return <StatusText tone="bad" data-keycheck-status="error">{t('新声明 {columns} 检查出错：{error}', { columns, error: check.error ?? t('未知错误') })}</StatusText>;
    case 'failed':
      return (
        <div className="space-y-0.5">
          <StatusText tone="bad" data-keycheck-status="failed">{t('新声明 {columns} 未通过全表检查，没有生效', { columns })}</StatusText>
          <KeyCheckFindings result={check.result} className="pl-5" />
        </div>
      );
  }
}

/** 软删除字段：有主键（源端主键或业务主键）的表可以从候选中确认，标记为删除的行同步时记为删除 */
function SoftDelete({ table, canWrite, submitting }: { table: TableView; canWrite: boolean; submitting: boolean }) {
  const t = useT();
  if (!table.primaryKey.length && !table.key) return null;
  const candidates = [...new Set([...(table.softDelete ? [table.softDelete] : []), ...table.softDeleteCandidates])];
  if (!candidates.length) return null;
  return (
    <ul className="space-y-1 text-xs">
      {candidates.map(column => (
        <li key={column} className="flex items-center gap-2" data-soft-delete-candidate={column}>
          <span className="font-mono">{column}</span>
          <span className="text-muted-foreground">{t('软删除字段：为真、非零或非空的行记为删除')}</span>
          {table.softDelete === column ? (
            <Badge variant="secondary">{t('已确认{by}', { by: table.softDeleteConfirmedBy ? t('（{who}）', { who: table.softDeleteConfirmedBy }) : '' })}</Badge>
          ) : canWrite ? (
            <Form method="post" preventScrollReset>
              <input type="hidden" name="intent" value="confirm-soft-delete" />
              <input type="hidden" name="table" value={table.name} />
              <input type="hidden" name="column" value={column} />
              <Button type="submit" variant="outline" size="sm" disabled={submitting}>{t('确认为软删除字段')}</Button>
            </Form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const COVERAGE_TONES: Record<LakeCoverage, StatusTone> = {
  in_lake: 'ok',
  out_of_scope: 'none',
  pending_profile: 'pending',
  needs_watermark: 'pending',
  pending_sync: 'pending',
  sync_failed: 'bad',
  unreadable: 'none',
  gone: 'bad',
};

const failed = (c: { ok: boolean } | undefined): c is FailedCheck => !!c && 'error' in c;
/** 核对成功的一项；没有核对或出错时为 null */
const passed = <T extends { ok: boolean }>(c: T | FailedCheck | undefined) => (c && !failed(c) ? c as T : null);

/** 一项核对的简要状态：一致、有差异的要点或出错；没有核对这一项时为 — */
function CheckCell<T extends { ok: boolean }>({ name, check, summary }: { name: string; check: T | FailedCheck | undefined; summary: (c: T) => string }) {
  const t = useT();
  if (!check) return <TableCell className="text-muted-foreground">—</TableCell>;
  return (
    <TableCell className="whitespace-normal">
      <StatusText tone={check.ok ? 'ok' : 'bad'} className="items-start [&>svg]:mt-0.5" data-check={name} data-ok={String(check.ok)}>
        {failed(check) ? t('出错') : summary(check as T)}
      </StatusText>
    </TableCell>
  );
}

const fileSummary = (t: T, locale: Locale, f: FileCheck) => {
  const issues = [
    f.missing.length && t('{n, plural, other {缺失 # 个}}', { n: f.missing.length }),
    f.sizeMismatch.length && t('{n, plural, other {大小不符 # 个}}', { n: f.sizeMismatch.length }),
    f.footer.length && t('{n, plural, other {尾部元数据不符 # 个}}', { n: f.footer.length }),
    f.orphans.length && t('{n, plural, other {孤儿文件 # 个}}', { n: f.orphans.length }),
  ].filter(Boolean);
  return issues.length ? issues.join(t('，')) : t('一致（{n, plural, other {# 个文件}}{inlined}）', {
    n: f.registered,
    inlined: f.inlinedRows ? t('，内联 {rows} 行', { rows: formatNumber(locale, f.inlinedRows) }) : '',
  });
};
const structureSummary = (t: T, s: StructureCheck) => {
  const issues = [
    s.missingInLake.length && t('湖中缺列 {n}', { n: s.missingInLake.length }),
    s.typeChanged.length && t('类型不同 {n}', { n: s.typeChanged.length }),
  ].filter(Boolean);
  if (issues.length) return issues.join(t('，'));
  return s.extraInLake.length ? t('一致（湖中多出 {n, plural, other {# 列}}）', { n: s.extraInLake.length }) : t('一致');
};
const dataSummary = (t: T, locale: Locale, d: DataCheck) => {
  if (!d.keyed) return d.ok
    ? t('一致（{rows} 行）', { rows: formatNumber(locale, d.lakeRows) })
    : t('源端 {source} 行，湖中 {lake} 行', { source: formatNumber(locale, d.sourceRows), lake: formatNumber(locale, d.lakeRows) });
  const pending = d.pendingSync ? t('；待下次同步 {n} 个', { n: formatNumber(locale, d.pendingSync) }) : '';
  if (d.ok) return t('一致（{rows} 个主键{pending}）', { rows: formatNumber(locale, d.lakeRows), pending });
  return t('{issues}{pending}', {
    issues: [d.missing && t('湖中缺失 {n}', { n: formatNumber(locale, d.missing) }), d.extra && t('湖中多出 {n}', { n: formatNumber(locale, d.extra) })]
      .filter(Boolean).join(t('，')),
    pending,
  });
};

/** 主键比对的样本值：只列前几个，还有更多时以「等」收尾 */
const samples = (t: T, list: string[], total: number) => (list.length ? t('：{list}{etc}', { list: list.join(t('、')), etc: total > list.length ? t(' 等') : '' }) : '');

/** 一张表的核对明细：位置与四项各自的细节 */
function VerifyDetail({ record }: { record: VerifyRecord }) {
  const t = useT();
  const locale = useLocale();
  const files = passed<FileCheck>(record.files);
  const structure = passed<StructureCheck>(record.structure);
  const data = passed<DataCheck>(record.data);
  const errors = [
    record.error,
    failed(record.files) && t('文件核对出错：{error}', { error: record.files.error }),
    failed(record.structure) && t('结构核对出错：{error}', { error: record.structure.error }),
    failed(record.data) && t('数据量核对出错：{error}', { error: record.data.error }),
  ].filter((e): e is string => !!e);
  const lines: string[] = [];
  if (record.location) {
    lines.push(t('原始层：{schema}.{table}', { schema: record.location.schema, table: record.location.table }), t('存储前缀：{prefix}', { prefix: record.location.prefix }));
    lines.push(record.location.state
      ? t('{kind}：{state}', { kind: record.location.state.includes('_keys.') ? t('当前主键状态') : t('当前镜像'), state: record.location.state })
      : t('当前主键状态 / 镜像：还没有'));
  }
  if (record.outOfScope) lines.push(t('已移出同步范围：湖中数据不再更新，只核对位置与文件'));
  if (files) {
    lines.push(t('目录登记 {registered, plural, other {# 个文件}}，当前 {current, plural, other {# 个数据文件}}共 {rows} 行；内联在目录库中 {inlined} 行（没有对应文件）', {
      registered: files.registered,
      current: files.current,
      rows: formatNumber(locale, files.fileRows),
      inlined: formatNumber(locale, files.inlinedRows),
    }));
    for (const path of files.missing) lines.push(t('缺失：{path}', { path }));
    for (const f of files.sizeMismatch) lines.push(t('大小不符：{path}（目录 {expected} 字节，存储上 {actual} 字节）', {
      path: f.path, expected: formatNumber(locale, f.expected), actual: formatNumber(locale, f.actual),
    }));
    for (const f of files.footer) lines.push(t('尾部元数据：{path}（{problem}）', { path: f.path, problem: f.problem }));
    for (const path of files.orphans) lines.push(t('孤儿文件（目录未登记，只报告不删除）：{path}', { path }));
  }
  if (structure) {
    for (const c of structure.missingInLake) lines.push(t('湖中缺列（源端新增字段）：{name} {type}', { name: c.name, type: c.type }));
    for (const c of structure.extraInLake) lines.push(t('湖中多出（源端删除字段，保留旧列属预期）：{name} {type}', { name: c.name, type: c.type }));
    for (const c of structure.typeChanged) lines.push(t('类型不同（{kind}）：{name} 湖中 {lake}，源端 {source}', {
      kind: c.widened ? t('源端放宽') : t('不兼容'), name: c.name, lake: c.lake, source: c.source,
    }));
  }
  if (data?.keyed) {
    lines.push(t('按主键 {keys} 比对：源端 {source} 个，湖中回放后 {lake} 个{synced}', {
      keys: data.keys.join(t('、')), source: formatNumber(locale, data.sourceRows), lake: formatNumber(locale, data.lakeRows),
      synced: data.syncedThrough ? t('；最近一次同步到 {at}', { at: data.syncedThrough }) : '',
    }));
    if (data.missing) lines.push(t('湖中缺失 {n} 个{samples}', { n: formatNumber(locale, data.missing), samples: samples(t, data.samples.missing, data.missing) }));
    if (data.pendingSync) lines.push(t('同步后新增，待下次同步 {n} 个{samples}', { n: formatNumber(locale, data.pendingSync), samples: samples(t, data.samples.pendingSync, data.pendingSync) }));
    if (data.extra) lines.push(t('湖中多出（源端已删）{n} 个{samples}', { n: formatNumber(locale, data.extra), samples: samples(t, data.samples.extra, data.extra) }));
  } else if (data) {
    lines.push(t('没有主键，按行数比较：源端 {source} 行，湖中回放后 {lake} 行', { source: formatNumber(locale, data.sourceRows), lake: formatNumber(locale, data.lakeRows) }));
  }
  if (!lines.length && !errors.length) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none">{t('明细')}</summary>
      <ul className="mt-1 space-y-0.5 font-mono break-all whitespace-normal">
        {lines.map(l => <li key={l}>{l}</li>)}
        {errors.map(e => <li key={e} className="text-destructive">{e}</li>)}
      </ul>
    </details>
  );
}

/** 核对结果的汇总：源端的表有几张进湖、没进湖的按原因计数，源端已删除的另计，以及有差异的表数 */
function verifySummary(t: T, tables: VerifyRecord[], differences: number) {
  const atSource = tables.filter(row => row.coverage !== 'gone');
  const inLake = atSource.filter(row => row.coverage === 'in_lake').length;
  const reasons = (Object.keys(LAKE_COVERAGE) as LakeCoverage[])
    .filter(c => c !== 'in_lake' && c !== 'gone')
    .map(c => [c, atSource.filter(row => row.coverage === c).length] as const)
    .filter(([, n]) => n)
    .map(([c, n]) => t('{label} {n, plural, other {# 张}}', { label: builtinName(t, LAKE_COVERAGE[c], ENUM_LABELS), n }));
  const gone = tables.length - atSource.length;
  return t('源端 {total, plural, other {# 张表}}：已进湖 {inLake, plural, other {# 张}}，未进湖 {missing, plural, other {# 张}}{reasons}{gone}；有差异 {diff, plural, other {# 张}}', {
    total: atSource.length,
    inLake,
    missing: atSource.length - inLake,
    reasons: reasons.length ? t('（{list}）', { list: reasons.join(t('、')) }) : '',
    gone: gone ? t('；源端已删除 {n, plural, other {# 张}}', { n: gone }) : '',
    diff: differences,
  });
}

type VerifyView = Route.ComponentProps['loaderData']['verify'];

/**
 * 湖中数据：最近一次核对的结果。每张源表一行：覆盖情况与源端行数；已进湖的表另有位置与文件、结构、数据量三项的简要状态，可展开明细。
 * 结构或数据量有差异时可以立即触发一次主键比对同步（修复只走同步这一条写入路径）；只有文件的问题时主键比对修不了，只作说明
 */
function LakeData({ verify, canWrite, submitting, busy }: { verify: VerifyView; canWrite: boolean; submitting: boolean; busy: boolean }) {
  const t = useT();
  const locale = useLocale();
  const reconcilable = verify.tables.some(row => passed(row.structure)?.ok === false || passed(row.data)?.ok === false);
  return (
    <section className="space-y-3">
      <SectionHeader title={t('湖中数据')} status={<StatusText tone={TASK_TONES[verify.status]} data-verify-status={verify.status}>{t('核对{status}', { status: builtinName(t, verify.statusLabel) })}</StatusText>}>
        {t('从源端的全部表出发，核对每张表的数据进了湖里的什么位置、文件是否真实存在、结构与数据量是否与源端一致。核对只读、只出报告，不修改湖中数据；每天自动核对一次。最近一次核对：{at}', { at: when(locale, verify.verifiedAt) })}
      </SectionHeader>
      {verify.status === 'failed' && verify.error && (
        <StatusText tone="bad">{t('{at} 提交的核对失败：{error}', { at: when(locale, verify.attemptedAt), error: verify.error })}</StatusText>
      )}
      {canWrite && (
        <div className="flex gap-2">
          <Form method="post" preventScrollReset>
            <input type="hidden" name="intent" value="verify" />
            <Button type="submit" variant="outline" disabled={submitting || busy}>{busy ? t('同步或核对进行中…') : t('核对')}</Button>
          </Form>
          {reconcilable && (
            <Form method="post" preventScrollReset>
              <input type="hidden" name="intent" value="reconcile" />
              <Button type="submit" disabled={submitting || busy}>{t('立即主键比对')}</Button>
            </Form>
          )}
        </div>
      )}
      {verify.verifiedAt && (
        <StatusText tone={verify.differences ? 'bad' : 'ok'} data-verify-summary>
          {verifySummary(t, verify.tables, verify.differences)}
        </StatusText>
      )}
      {verify.differences > 0 && !reconcilable && (
        <div className="text-sm text-muted-foreground" data-files-only>
          {t('差异只在文件上（文件缺失、大小或尾部元数据不符、孤儿文件）：主键比对修不了，请联系运营者检查存储')}
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('表')}</TableHead>
            <TableHead>{t('覆盖')}</TableHead>
            <TableHead>{t('源端行数')}</TableHead>
            <TableHead>{t('位置')}</TableHead>
            <TableHead>{t('文件')}</TableHead>
            <TableHead>{t('结构')}</TableHead>
            <TableHead>{t('数据量')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {verify.tables.map(row => (
            <TableRow key={row.table} data-verify-table={row.table} data-coverage={row.coverage} data-verify-ok={row.ok === null ? undefined : String(row.ok)}>
              <TableCell className="align-top">
                <div className="font-mono font-medium">{row.table}</div>
                <VerifyDetail record={row} />
              </TableCell>
              <TableCell className="align-top">
                <StatusText tone={COVERAGE_TONES[row.coverage]}>{builtinName(t, LAKE_COVERAGE[row.coverage], ENUM_LABELS)}</StatusText>
              </TableCell>
              <TableCell className="align-top">
                {row.sourceRows === null ? '—' : row.rowsEstimated ? t('约 {n}', { n: formatNumber(locale, row.sourceRows) }) : formatNumber(locale, row.sourceRows)}
              </TableCell>
              <TableCell className="align-top font-mono text-xs">{row.location ? `${row.location.schema}.${row.location.table}` : '—'}</TableCell>
              <CheckCell name="files" check={row.files} summary={c => fileSummary(t, locale, c)} />
              <CheckCell name="structure" check={row.structure} summary={c => structureSummary(t, c)} />
              <CheckCell name="data" check={row.data} summary={c => dataSummary(t, locale, c)} />
            </TableRow>
          ))}
          {!verify.tables.length && (
            <TableRow>
              <TableCell colSpan={7} className="text-center text-muted-foreground">
                {verify.status === 'queued' || verify.status === 'running' ? t('正在核对…') : t('还没有核对结果')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </section>
  );
}

/** 删除数据源：确认后提交；被挡时按钮禁用，旁边列出原因（ADR-0044，原因是服务端原文） */
function DeleteSource({ name, blockers, submitting }: { name: string; blockers: string[]; submitting: boolean }) {
  const t = useT();
  if (blockers.length) {
    return (
      <span className="flex items-center gap-2">
        <Button type="button" variant="destructive" disabled><Trash2 />{t('删除数据源')}</Button>
        <span className="flex max-w-xs items-start gap-1 text-sm text-slate-500" data-delete-blockers>
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          <span>{blockers.map(r => <span key={r} className="block">{r}</span>)}</span>
        </span>
      </span>
    );
  }
  return (
    <Form
      method="post"
      onSubmit={e => {
        if (!confirm(t('确认删除数据源「{name}」？删除后不能恢复：同步范围、凭据与湖里的原始层都会删掉，标准层里已合并的行保留。', { name }))) e.preventDefault();
      }}
    >
      <input type="hidden" name="intent" value="delete" />
      <Button type="submit" variant="destructive" disabled={submitting}><Trash2 />{t('删除数据源')}</Button>
    </Form>
  );
}

/** 源视图：每个一张卡片（名称、已发布版本、草稿），可新建时末尾是虚线的新建卡片；没有源视图时说明它是什么，可新建时直接给出新建表单 */
function SourceViews({ base, views, canWrite, submitting }: { base: string; views: SourceViewSummary[]; canWrite: boolean; submitting: boolean }) {
  const t = useT();
  const intro = t('源视图是一段只读本数据源原始层的 SELECT，用来把复杂的源表整理成可映射的形状。保存时在原始层上校验并预览，按双人发布规则由另一位成员发布。');
  if (!views.length) {
    return (
      <div className="space-y-3 py-6 text-center">
        <ScrollText className="mx-auto size-8 text-slate-300" />
        <p className="mx-auto max-w-2xl text-sm text-slate-500">{t('还没有源视图。{intro}', { intro })}</p>
        {canWrite && <NewSourceViewForm action={`${base}/views/new`} submitting={submitting} />}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-slate-500">{intro}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
        {views.map(v => (
          <Link key={v.id} to={`${base}/views/${v.id}`} data-source-view={v.name} className="rounded-2xl border bg-white p-5 shadow-sm transition hover:shadow-md">
            <span className="block truncate font-mono font-medium">{v.name}</span>
            <span className="mt-2 flex flex-wrap gap-3 text-sm">
              {v.published
                ? <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="size-3.5" />{t('已发布 v{version}', { version: v.published })}</span>
                : <span className="text-slate-500">{t('还没有发布')}</span>}
              {v.draft && <span className="inline-flex items-center gap-1 text-amber-600"><PencilLine className="size-3.5" />{t('草稿 v{version}', { version: v.draft })}</span>}
            </span>
          </Link>
        ))}
        {canWrite && (
          <Link to={`${base}/views/new`} className="flex items-center justify-center gap-2 rounded-2xl border border-dashed p-5 text-sm text-slate-500 hover:border-slate-400 hover:text-slate-900">
            <Plus className="size-4" />{t('新建源视图')}
          </Link>
        )}
      </div>
    </div>
  );
}

/** 概览页的「源端注释」区块（#524）：按 schema.表 分组，每组一张表列出列注释（表注释标「（表注释）」）；组与每行列注释带锚点，知识面板的证据链回这里 */
function SourceComments({ comments }: { comments: CommentView[] }) {
  const t = useT();
  const locale = useLocale();
  if (!comments.length) return <div className="text-sm text-muted-foreground">{t('还没有采集到源端注释')}</div>;
  // comments 已按 schema、表、列排好序，这里顺序分组
  const groups: [string, CommentView[]][] = [];
  for (const c of comments) {
    const group = `${c.tableSchema}.${c.tableName}`;
    let last = groups.at(-1);
    if (last?.[0] !== group) groups.push(last = [group, []]);
    last[1].push(c);
  }
  return (
    <div className="space-y-6">
      {groups.map(([group, rows]) => (
        <div key={group} className="space-y-2">
          <h3 id={`comment-${group}`} className="font-mono text-sm font-medium">{group}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('列')}</TableHead>
                <TableHead>{t('原文')}</TableHead>
                <TableHead>{t('版本')}</TableHead>
                <TableHead>{t('采集时间')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(c => (
                <TableRow key={`${c.tableName}:${c.columnName}`} id={c.columnName ? `comment-${group}.${c.columnName}` : undefined}>
                  <TableCell className="font-mono">{c.columnName || t('（表注释）')}</TableCell>
                  <TableCell className="max-w-xl whitespace-pre-wrap">{c.commentText}</TableCell>
                  <TableCell>{`v${c.version}`}</TableCell>
                  <TableCell>{when(locale, c.collectedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ))}
    </div>
  );
}

export default function Source({ loaderData, actionData }: Route.ComponentProps) {
  const { tab, email, nav, canWrite, canDelete, deleteBlockers, source, profile, listing, newTables, tables, sync, verify, views, comments } = loaderData;
  const t = useT();
  const locale = useLocale();
  const submitting = useNavigation().state === 'submitting';
  const profiling = profile.status === 'queued' || profile.status === 'running';
  const syncing = sync.status === 'queued' || sync.status === 'running';
  const verifying = verify.status === 'queued' || verify.status === 'running';
  const keyChecking = tables.some(table => table.keyCheck?.status === 'running');
  // 采集、同步、核对与业务主键检查在调度器里异步进行：进行中时定时刷新，结束后停下
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!profiling && !syncing && !verifying && !keyChecking) return;
    const timer = setInterval(() => { if (revalidator.state === 'idle') revalidator.revalidate(); }, 2000);
    return () => clearInterval(timer);
  }, [profiling, syncing, verifying, keyChecking, revalidator]);
  const synced = Object.entries(sync.history);
  const values = actionData?.values ?? { name: source.name, ...source.config };
  const base = `/sources/${source.id}`;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={source.name}
        description={<><Link to="/sources" className="hover:underline">{t('← 数据源')}</Link>{` · ${t('登记于 {date}', { date: when(locale, source.createdAt) })}`}</>}
        actions={(canWrite || canDelete) && (
          <>
            {canWrite && (
              <>
                <Form method="post" preventScrollReset>
                  <input type="hidden" name="intent" value="test" />
                  <Button type="submit" variant="outline" disabled={submitting}><PlugZap />{t('测试连接')}</Button>
                </Form>
                <Form method="post" preventScrollReset>
                  <input type="hidden" name="intent" value="refresh" />
                  <Button type="submit" variant="outline" disabled={submitting}><RefreshCw />{t('重新列出表并采集')}</Button>
                </Form>
              </>
            )}
            {canDelete && <DeleteSource name={source.name} blockers={deleteBlockers} submitting={submitting} />}
          </>
        )}
      />

      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>{t('操作未完成')}</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}
      {actionData?.ok && (
        <Alert role="status">
          <CircleCheck />
          <AlertTitle>{t('测试连接')}</AlertTitle>
          <AlertDescription>{actionData.ok}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label={t('类型')}
          value={<span className="flex items-center gap-3 text-xl"><KindIcon kind={source.kind} />{builtinName(t, SOURCE_KIND_LABELS[source.kind], ENUM_LABELS)}</span>}
        />
        <StatTile
          label={t('目标')}
          value={<span className="block truncate font-mono text-base">{targetOf(source.kind, source.config)}</span>}
        />
        <StatTile label={t('同步表数')} value={listing.filter(row => row.inScope).length} hint={t('共列出 {n, plural, other {# 张表}}', { n: listing.length })} />
        <StatTile
          label={t('核对状态')}
          value={<VerifyBadge differences={verify.verifiedAt ? verify.differences : null} className="gap-2 text-3xl font-semibold [&>svg]:size-6" />}
          hint={verifying ? t('核对进行中…') : t('最近一次核对：{at}', { at: when(locale, verify.verifiedAt) })}
        />
      </div>

      <PillTabs
        current={tab}
        tabs={[
          { key: 'overview', label: t('概览'), href: base },
          { key: 'lake', label: t('湖中数据'), href: `${base}?tab=lake` },
          { key: 'views', label: t('源视图（{n}）', { n: views.length }), href: `${base}?tab=views` },
        ]}
      />

      <div className="rounded-2xl border bg-white p-6 shadow-sm">
        {tab === 'lake' ? (
          <LakeData verify={verify} canWrite={canWrite} submitting={submitting} busy={syncing || verifying} />
        ) : tab === 'views' ? (
          <SourceViews base={base} views={views} canWrite={canWrite} submitting={submitting} />
        ) : (
          <div className="space-y-10">
            <section className="space-y-3">
              <SectionHeader title={t('连接')} />
              <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-sm">
                {Object.entries(source.config).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{configLabel(t, k)}</dt>
                    <dd className="font-mono">{v}</dd>
                  </div>
                ))}
                <dt className="text-muted-foreground">{t('凭据')}</dt>
                <dd>{t('已加密保存，不可查看{rotated}', { rotated: source.credentialsRotatedAt ? t('（{at} 轮换）', { at: when(locale, source.credentialsRotatedAt) }) : '' })}</dd>
              </dl>
            </section>

            <section className="space-y-3">
              <SectionHeader title={t('同步范围')}>
                {t('只有选入同步范围的表才会采集列统计、同步进原始层。新出现的表默认不选；移出范围只停止同步，已进湖的数据保留，重新选回后接着同步。')}
              </SectionHeader>
              <SyncScope
                key={listing.map(row => `${row.name}:${row.inScope}`).join('\n')}
                listing={listing}
                newTables={newTables}
                canWrite={canWrite}
                submitting={submitting}
              />
            </section>

            <section className="space-y-3">
              <SectionHeader
                title={t('源表')}
                status={<StatusText tone={TASK_TONES[profile.status]} data-profile-status={profile.status}>{t('采集{status}', { status: builtinName(t, profile.statusLabel) })}</StatusText>}
              >
                {t('同步范围内的表：有更新时间或自增主键的按水位线增量同步（需确认字段），没有的全量比对：每小时一次，大表每天一次。最近采集：{at}', { at: when(locale, profile.profiledAt) })}
              </SectionHeader>
              {listing.length > 0 && <LakeCoverage listing={listing} />}
              {profile.status === 'failed' && profile.error && (
                <StatusText tone="bad">{t('{at} 提交的采集失败：{error}', { at: when(locale, profile.attemptedAt), error: profile.error })}</StatusText>
              )}
              {profile.unreadable.length > 0 && (
                <div className="text-sm text-muted-foreground" data-unreadable>
                  {t('账号没有读权限的 {n, plural, other {# 张表}}不能选入同步范围：{names}。需要时在源库授予 SELECT 后重新列出表', { n: profile.unreadable.length, names: profile.unreadable.join(t('、')) })}
                </div>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('表')}</TableHead>
                    <TableHead>{t('行数')}</TableHead>
                    <TableHead>{t('同步方式')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tables.map(table => (
                    <Fragment key={table.name}>
                      <TableRow data-table={table.name} data-sync-mode={table.syncMode} className="border-b-0">
                        <TableCell className="align-top font-mono font-medium">{table.name}</TableCell>
                        <TableCell className="align-top">{formatNumber(locale, table.rows)}</TableCell>
                        <TableCell className="space-y-1 align-top whitespace-normal">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={SYNC_VARIANTS[table.syncMode]}>{builtinName(t, SYNC_MODES[table.syncMode], ENUM_LABELS)}</Badge>
                            <StatusText tone={table.notInLake ? 'bad' : 'ok'} data-in-lake={String(!table.notInLake)}>
                              {table.notInLake ? t('未进湖：{reason}', { reason: builtinName(t, table.notInLake, ENUM_LABELS) }) : t('已进湖')}
                            </StatusText>
                          </div>
                          <div className="text-xs text-muted-foreground">{table.syncModeNote}</div>
                          <TableMappingDrift drift={table.drift} />
                          <Watermark table={table} canWrite={canWrite} submitting={submitting} />
                          <Key table={table} canWrite={canWrite} submitting={submitting} />
                          <SoftDelete table={table} canWrite={canWrite} submitting={submitting} />
                        </TableCell>
                      </TableRow>
                      {/* 列统计单独一行占满表格宽度 */}
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={3} className="pt-0">
                          <ColumnStats table={table} />
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  ))}
                  {!tables.length && (
                    <TableRow>
                      <TableCell colSpan={3} className="text-center text-muted-foreground">
                        {profiling ? t('正在采集列统计…') : t('同步范围内还没有采集过的表')}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </section>

            <section className="space-y-3">
              <SectionHeader title={t('源端注释')} />
              <SourceComments comments={comments} />
            </section>

            <section className="space-y-4">
              <SectionHeader title={t('同步')} status={<StatusText tone={TASK_TONES[sync.status]} data-sync-status={sync.status}>{builtinName(t, sync.statusLabel)}</StatusText>}>
                {t('已确认水位线的表每小时增量同步一次，首次同步为全表读取，每天再比对一次（有主键的比对主键全集，没有的整行比对），补上源端的删除与漏掉的行。没有水位线的表全量比对，大表每天一次（立即同步时大表一并同步）。变化都以变更批次追加到原始层。最近一次：{at} 提交', { at: when(locale, sync.attemptedAt) })}
              </SectionHeader>
              {sync.status === 'failed' && sync.error && <StatusText tone="bad">{t('同步失败：{error}', { error: sync.error })}</StatusText>}
              {canWrite && (
                <Form method="post" preventScrollReset>
                  <input type="hidden" name="intent" value="sync" />
                  <Button type="submit" variant="outline" disabled={submitting || syncing}>{syncing ? t('同步中…') : t('立即同步')}</Button>
                </Form>
              )}
              {synced.map(([table, entries]) => <SyncHistory key={table} table={table} entries={entries} />)}
              {!synced.length && <div className="text-sm text-muted-foreground">{t('还没有同步记录')}</div>}
            </section>

            {canWrite && (
              <section className="max-w-2xl space-y-4">
                <SectionHeader title={t('修改与轮换凭据')}>
                  {t('保存前重新校验连接与只读。凭据留空表示沿用已保存的；主机、库名、用户名或路径变了时须重新填写。')}
                </SectionHeader>
                <Form method="post" preventScrollReset>
                  <input type="hidden" name="intent" value="update" />
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="source-name">{t('名称')}</FieldLabel>
                      <Input id="source-name" name="name" required defaultValue={values.name ?? ''} />
                    </Field>
                    <SourceFields kind={source.kind} values={values} editing />
                    <div>
                      <Button type="submit" disabled={submitting}>{submitting ? t('正在校验…') : t('校验并保存')}</Button>
                    </div>
                  </FieldGroup>
                </Form>
              </section>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
