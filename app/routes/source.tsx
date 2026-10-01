// app/routes/source.tsx —— 单个数据源：连接参数（凭据不显示）、测试连接、修改与轮换凭据、重新列出表并采集；
// 同步范围：列出的表（估算行数、读权限、新表、源端已不存在），成员按 schema 全选、按名称过滤后批量选，保存的是逐张的表清单（ADR-0013）；
// 范围内各表的行数、列统计、同步方式与频率、是否已进湖与水位线候选，成员从候选中确认水位线字段，没有主键的表声明业务主键（可多列），
// 有主键的表声明软删除字段；手动触发同步，查看每张表的同步历史。
// 「湖中数据」标签页（?tab=lake）：最近一次核对的结果，每表一行显示覆盖、位置与文件、结构、数据量四项，可展开明细；
// 手动触发核对，有差异时触发一次主键比对同步
import { useEffect, useState } from 'react';
import { data, Form, Link, redirect, useNavigation, useRevalidator } from 'react-router';
import { CircleAlert, CircleCheck } from 'lucide-react';
import type { Route } from './+types/source';
import { can, requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { getSyncStatus, syncSource } from '~/.server/source-sync';
import { getVerifyStatus, notInLakeReason, verifySource } from '~/.server/source-verify';
import {
  confirmKey, confirmSoftDelete, confirmWatermark, getSource, relistSource, setSyncScope, SourceError, testSource, updateSource,
} from '~/.server/sources';
import { TASK_STATUS_LABELS } from '~/.server/tasks';
import type { DataCheck, FailedCheck, FileCheck, StructureCheck, VerifyRecord } from '~/.server/pipeline/verify-engine';
import { formValues, LAKE_COVERAGE, SOURCE_KIND_LABELS, SYNC_MODES, type LakeCoverage } from '~/lib/sources';
import { AppShell } from '~/components/app-shell';
import { SourceFields } from '~/components/source-fields';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData?.source.name ?? '数据源'} · CRM 数据分析平台` }];
}

const CONFIG_LABELS: Record<string, string> = {
  host: '主机', port: '端口', database: '数据库名', schema: 'schema', user: '用户名', srv: 'SRV 记录', tls: 'TLS', authSource: '认证库',
  path: '路径', format: '文件格式', endpoint: '对象存储地址', region: '区域', urlStyle: '寻址方式', useSsl: 'HTTPS',
};

const FORMAT_LABELS: Record<string, string> = {
  email: '邮箱', mobile: '手机号', integer: '整数', decimal: '小数', date: '日期', datetime: '日期时间', uuid: 'UUID', json: 'JSON', objectid: 'ObjectId',
};

/** 页面的标签页：概览（连接、同步范围、源表、同步）与湖中数据（核对结果） */
const tabOf = (request: Request): 'overview' | 'lake' => (new URL(request.url).searchParams.get('tab') === 'lake' ? 'lake' : 'overview');

export async function loader({ request, params }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  try {
    const source = await getSource(member, params.sourceId);
    const sync = await getSyncStatus(member, params.sourceId);
    const verify = await getVerifyStatus(member, params.sourceId);
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
      tables: source.tables.map(t => ({ ...t, notInLake: notInLake(t.name) })),
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
        const { tables, unreadable } = await testSource(member, params.sourceId);
        const skipped = unreadable.length ? `；${unreadable.length} 张表没有读权限，不能选入同步范围：${unreadable.join('、')}` : '';
        return { ok: `连接正常：${tables.length} 张表，账号只读${skipped}`, error: null, values: null };
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
      default:
        return data({ ok: null, error: '未知操作', values: null }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof SourceError) {
      return data({ ok: null, error: e.message, values: field('intent') === 'update' ? formValues(form) : null }, { status: e.status });
    }
    throw e;
  }
  // 回到提交时所在的标签页
  throw redirect(`/sources/${params.sourceId}${tabOf(request) === 'lake' ? '?tab=lake' : ''}`);
}

const TASK_VARIANTS = { none: 'outline', queued: 'outline', running: 'secondary', succeeded: 'default', failed: 'destructive' } as const;
const SYNC_VARIANTS = { watermark: 'default', needs_confirmation: 'secondary', full_compare: 'outline' } as const;
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

type TableView = Route.ComponentProps['loaderData']['tables'][number];
type ListedView = Route.ComponentProps['loaderData']['listing'][number];
type SyncEntry = Route.ComponentProps['loaderData']['sync']['history'][string][number];

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const BATCH_MODES = { full: '全表读取', incremental: '增量', reconcile: '主键比对', compare: '全量比对' } as const;
const count = (n: number) => n.toLocaleString('zh-CN');

/** 批次的读取范围：增量批次从水位线往回退了回看窗口时一并说明 */
function watermarkRange(e: Extract<SyncEntry, { batch: number }>) {
  if (e.watermarkColumn === null) return '—（没有水位线）';
  if (e.mode === 'reconcile') return `${e.watermarkColumn}：${e.watermarkTo ?? '—'}（不变）`;
  const lookback = e.readFrom !== null && e.readFrom !== e.watermarkFrom ? `（回看自 ${e.readFrom}）` : '';
  return `${e.watermarkColumn}：${e.watermarkFrom ?? '起始'} → ${e.watermarkTo ?? '—'}${lookback}`;
}

/** 一张表的同步历史：每次同步一个变更批次（新的在前） */
function SyncHistory({ table, entries }: { table: string; entries: SyncEntry[] }) {
  return (
    <div data-sync-table={table} className="space-y-1">
      <div className="font-mono text-sm font-medium">{table}</div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>批次</TableHead>
            <TableHead>方式</TableHead>
            <TableHead>行数</TableHead>
            <TableHead>耗时</TableHead>
            <TableHead>水位线</TableHead>
            <TableHead>开始时间</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e, i) => 'error' in e ? (
            <TableRow key={`${e.taskId}-${i}`} data-sync-error={e.gone ? undefined : true} data-sync-gone={e.gone ? true : undefined}>
              <TableCell>—</TableCell>
              <TableCell colSpan={3} className={`whitespace-normal ${e.gone ? 'text-muted-foreground' : 'text-destructive'}`}>
                {e.gone ? `跳过：${e.error}` : `失败：${e.error}`}
              </TableCell>
              <TableCell>—</TableCell>
              <TableCell>{time(e.startedAt)}</TableCell>
            </TableRow>
          ) : (
            <TableRow key={`${e.taskId}-${i}`} data-batch={e.batch} data-batch-mode={e.mode}>
              <TableCell>{e.batch}</TableCell>
              <TableCell>{BATCH_MODES[e.mode]}</TableCell>
              <TableCell>{`${count(e.rows)}（新增 ${count(e.inserted)}，更新 ${count(e.updated)}，删除 ${count(e.deleted)}）`}</TableCell>
              <TableCell>{duration(e.durationMs)}</TableCell>
              <TableCell className="font-mono text-xs whitespace-normal">{watermarkRange(e)}</TableCell>
              <TableCell>{time(e.startedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** 进湖情况：同步范围内的表有几张已经进湖，没进湖的逐张说明原因；范围外的表只计数 */
function LakeCoverage({ listing }: { listing: ListedView[] }) {
  const scoped = listing.filter(t => t.inScope);
  const missing = scoped.filter(t => t.notInLake).map(t => `${t.name}（${t.notInLake}）`);
  const outside = listing.filter(t => !t.inScope);
  const unreadable = outside.filter(t => !t.readable).length;
  const others = [
    outside.length - unreadable ? `不在同步范围 ${outside.length - unreadable} 张` : '',
    unreadable ? `账号没有读权限 ${unreadable} 张` : '',
  ].filter(Boolean).join('，');
  return (
    <div className={`text-sm ${missing.length ? 'text-destructive' : 'text-muted-foreground'}`} data-lake-coverage>
      {`已进湖 ${scoped.length - missing.length} 张，未进湖 ${missing.length} 张${missing.length ? `：${missing.join('、')}` : ''}${others ? `；${others}` : ''}`}
    </div>
  );
}

/**
 * 同步范围：列出的全部表，按 schema 分组。可按名称过滤、按 schema 全选；过滤只是隐藏，保存时提交的是逐张勾选的表。
 * 账号读不了、源端已不存在的表不能选入（已在范围内的可以移出）。服务端的范围变了（保存、重新列出表）时由调用方换 key 重置勾选
 */
function SyncScope({ listing, newTables, canWrite, submitting }: { listing: ListedView[]; newTables: number; canWrite: boolean; submitting: boolean }) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(() => new Set(listing.filter(t => t.inScope).map(t => t.name)));
  const visible = (t: ListedView) => t.name.toLowerCase().includes(filter.trim().toLowerCase());
  const addable = (t: ListedView) => canWrite && t.readable && !t.gone;
  const selectable = (t: ListedView) => addable(t) || (canWrite && t.inScope);
  const schemas = [...new Set(listing.map(t => t.schema))];
  const toggle = (names: string[], on: boolean) => setSelected(prev => {
    const next = new Set(prev);
    for (const n of names) on ? next.add(n) : next.delete(n);
    return next;
  });
  return (
    <Form method="post" className="space-y-3">
      <input type="hidden" name="intent" value="scope" />
      {newTables > 0 && (
        <div className="text-sm text-destructive" data-new-tables={newTables}>{`有 ${newTables} 张新表未选`}</div>
      )}
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="max-w-64" placeholder="按名称过滤" value={filter} onChange={e => setFilter(e.target.value)} aria-label="按名称过滤" />
          <Button type="button" variant="outline" size="sm" onClick={() => toggle(listing.filter(t => visible(t) && addable(t)).map(t => t.name), true)}>
            全选过滤结果
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => toggle(listing.filter(visible).map(t => t.name), false)}>
            取消过滤结果
          </Button>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8" />
            <TableHead>表</TableHead>
            <TableHead>估算行数</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        {schemas.map(schema => {
          const group = listing.filter(t => t.schema === schema);
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
                        aria-label={`全选 ${schema || '全部'}`}
                        disabled={!choices.length}
                        checked={choices.length > 0 && choices.every(t => selected.has(t.name))}
                        onChange={e => toggle(choices.map(t => t.name), e.target.checked)}
                      />
                    )}
                  </TableCell>
                  <TableCell colSpan={3} className="font-medium">{schema || '（无 schema）'}</TableCell>
                </TableRow>
              ) : null}
              {group.map(t => (
                <TableRow key={t.name} hidden={!visible(t)} data-listed={t.name} data-in-scope={String(t.inScope)}>
                  <TableCell>
                    <input type="hidden" name="listed" value={t.name} />
                    <input
                      type="checkbox"
                      name="table"
                      value={t.name}
                      aria-label={t.name}
                      disabled={!selectable(t)}
                      checked={selected.has(t.name)}
                      onChange={e => toggle([t.name], e.target.checked)}
                    />
                  </TableCell>
                  <TableCell className="font-mono">{t.name}</TableCell>
                  <TableCell>{t.estimatedRows === null ? '—' : `约 ${t.estimatedRows.toLocaleString('zh-CN')}`}</TableCell>
                  <TableCell className="space-x-1 whitespace-normal">
                    {t.gone && <Badge variant="destructive" data-gone>源端已不存在</Badge>}
                    {!t.readable && !t.gone && <Badge variant="outline">账号没有读权限</Badge>}
                    {t.isNew && <Badge variant="secondary" data-new>新表</Badge>}
                    {t.inScope && (
                      <span className="text-xs text-muted-foreground">{`已选入${t.scopedBy ? `（${t.scopedBy}，${time(t.scopedAt)}）` : ''}`}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          );
        })}
      </Table>
      {canWrite && <Button type="submit" disabled={submitting}>保存同步范围</Button>}
    </Form>
  );
}

function ColumnStats({ table }: { table: TableView }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none">
        {`列统计（${table.columns.length} 列，基于前 ${table.sampleRows.toLocaleString('zh-CN')} 行样本）`}
      </summary>
      <Table className="mt-2">
        <TableHeader>
          <TableRow>
            <TableHead>列</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>空值率</TableHead>
            <TableHead>基数</TableHead>
            <TableHead>取值范围</TableHead>
            <TableHead>格式特征</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.columns.map(c => (
            <TableRow key={c.name} data-column={c.name}>
              <TableCell className="font-mono">{c.name}</TableCell>
              <TableCell className="font-mono text-muted-foreground">{c.type}</TableCell>
              <TableCell>{pct(c.nullRate)}</TableCell>
              <TableCell>{c.distinct.toLocaleString('zh-CN')}</TableCell>
              <TableCell className="whitespace-normal">
                {c.min !== null ? `${c.min} ～ ${c.max}` : c.length ? `长度 ${c.length.min}～${c.length.max}` : '—'}
              </TableCell>
              <TableCell>{c.formats?.map(f => `${FORMAT_LABELS[f.format] ?? f.format} ${pct(f.share)}`).join('，') || '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </details>
  );
}

function Watermark({ table, canWrite, submitting }: { table: TableView; canWrite: boolean; submitting: boolean }) {
  if (!table.watermarkCandidates.length) return null;
  return (
    <ul className="space-y-1 text-xs">
      {table.watermarkCandidates.map(c => (
        <li key={c.column} className="flex items-center gap-2" data-candidate={c.column}>
          <span className="font-mono">{c.column}</span>
          <span className="text-muted-foreground">{`${c.kind === 'updated_at' ? '更新时间' : '自增主键'}：${c.reason}`}</span>
          {table.watermark === c.column ? (
            <Badge variant="secondary">{`已确认${table.confirmedBy ? `（${table.confirmedBy}）` : ''}`}</Badge>
          ) : canWrite ? (
            <Form method="post">
              <input type="hidden" name="intent" value="confirm-watermark" />
              <input type="hidden" name="table" value={table.name} />
              <input type="hidden" name="column" value={c.column} />
              <Button type="submit" variant="outline" size="sm" disabled={submitting}>确认为水位线</Button>
            </Form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * 主键：源端主键；没有时成员可以声明业务主键（一列或多列，平台标出样本中唯一的单列作参考，确认前在源端校验）。
 * 都没有时，全量比对按整行比对（修改记为一删一增），水位线同步的增量行一律记为新增、每天整行比对一次补上删除
 */
function Key({ table, canWrite, submitting }: { table: TableView; canWrite: boolean; submitting: boolean }) {
  if (table.primaryKey.length) return <div className="text-xs text-muted-foreground">{`主键：${table.primaryKey.join('、')}`}</div>;
  return (
    <div className="space-y-1 text-xs">
      {table.key ? (
        <div className="flex items-center gap-2" data-declared-key={table.key.join(',')}>
          <span>{`业务主键：${table.key.join('、')}`}</span>
          <Badge variant="secondary">{`已确认${table.keyConfirmedBy ? `（${table.keyConfirmedBy}）` : ''}`}</Badge>
        </div>
      ) : (
        <div className="text-muted-foreground" data-no-key>
          {table.syncMode === 'full_compare'
            ? '没有主键：按整行比对，完全相同的重复行按出现次数计，修改记为一删一增'
            : '没有主键：增量行一律记为新增；每天整行全量比对一次，补上源端的删除'}
        </div>
      )}
      {canWrite && table.keyEligibleColumns.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground select-none">
            {table.key ? '改为其他业务主键' : '声明业务主键（一列或多列的组合，能唯一标识一行；据此区分新增与更新）'}
          </summary>
          <Form method="post" className="mt-1 space-y-1">
            <input type="hidden" name="intent" value="confirm-key" />
            <input type="hidden" name="table" value={table.name} />
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {table.keyEligibleColumns.map(column => (
                <label key={column} className="flex items-center gap-1" data-key-column={column}>
                  <input type="checkbox" name="column" value={column} defaultChecked={table.key?.includes(column)} />
                  <span className="font-mono">{column}</span>
                  {table.keyCandidates.includes(column) && <span className="text-muted-foreground" data-key-candidate={column}>（样本中唯一）</span>}
                </label>
              ))}
            </div>
            <Button type="submit" variant="outline" size="sm" disabled={submitting}>在源端校验并确认</Button>
          </Form>
        </details>
      )}
    </div>
  );
}

/** 软删除字段：有主键（源端主键或业务主键）的表可以从候选中确认，标记为删除的行同步时记为删除 */
function SoftDelete({ table, canWrite, submitting }: { table: TableView; canWrite: boolean; submitting: boolean }) {
  if (!table.primaryKey.length && !table.key) return null;
  const candidates = [...new Set([...(table.softDelete ? [table.softDelete] : []), ...table.softDeleteCandidates])];
  if (!candidates.length) return null;
  return (
    <ul className="space-y-1 text-xs">
      {candidates.map(column => (
        <li key={column} className="flex items-center gap-2" data-soft-delete-candidate={column}>
          <span className="font-mono">{column}</span>
          <span className="text-muted-foreground">软删除字段：为真、非零或非空的行记为删除</span>
          {table.softDelete === column ? (
            <Badge variant="secondary">{`已确认${table.softDeleteConfirmedBy ? `（${table.softDeleteConfirmedBy}）` : ''}`}</Badge>
          ) : canWrite ? (
            <Form method="post">
              <input type="hidden" name="intent" value="confirm-soft-delete" />
              <input type="hidden" name="table" value={table.name} />
              <input type="hidden" name="column" value={column} />
              <Button type="submit" variant="outline" size="sm" disabled={submitting}>确认为软删除字段</Button>
            </Form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const COVERAGE_VARIANTS: Record<LakeCoverage, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  in_lake: 'secondary',
  out_of_scope: 'outline',
  pending_profile: 'outline',
  needs_watermark: 'outline',
  pending_sync: 'outline',
  sync_failed: 'destructive',
  unreadable: 'outline',
  gone: 'destructive',
};

const failed = (c: { ok: boolean } | undefined): c is FailedCheck => !!c && 'error' in c;
/** 核对成功的一项；没有核对或出错时为 null */
const passed = <T extends { ok: boolean }>(c: T | FailedCheck | undefined) => (c && !failed(c) ? c as T : null);

/** 一项核对的简要状态：一致、有差异的要点或出错；没有核对这一项时为 — */
function CheckCell<T extends { ok: boolean }>({ name, check, summary }: { name: string; check: T | FailedCheck | undefined; summary: (c: T) => string }) {
  if (!check) return <TableCell className="text-muted-foreground">—</TableCell>;
  return (
    <TableCell className={`whitespace-normal ${check.ok ? '' : 'text-destructive'}`} data-check={name} data-ok={String(check.ok)}>
      {failed(check) ? '出错' : summary(check as T)}
    </TableCell>
  );
}

const fileSummary = (f: FileCheck) => {
  const issues = [
    f.missing.length && `缺失 ${f.missing.length} 个`,
    f.sizeMismatch.length && `大小不符 ${f.sizeMismatch.length} 个`,
    f.footer.length && `尾部元数据不符 ${f.footer.length} 个`,
    f.orphans.length && `孤儿文件 ${f.orphans.length} 个`,
  ].filter(Boolean);
  return issues.length ? issues.join('，') : `一致（${f.registered} 个文件${f.inlinedRows ? `，内联 ${count(f.inlinedRows)} 行` : ''}）`;
};
const structureSummary = (s: StructureCheck) => {
  const issues = [
    s.missingInLake.length && `湖中缺列 ${s.missingInLake.length}`,
    s.typeChanged.length && `类型不同 ${s.typeChanged.length}`,
  ].filter(Boolean);
  if (issues.length) return issues.join('，');
  return s.extraInLake.length ? `一致（湖中多出 ${s.extraInLake.length} 列）` : '一致';
};
const dataSummary = (d: DataCheck) => {
  if (!d.keyed) return d.ok ? `一致（${count(d.lakeRows)} 行）` : `源端 ${count(d.sourceRows)} 行，湖中 ${count(d.lakeRows)} 行`;
  const pending = d.pendingSync ? `；待下次同步 ${count(d.pendingSync)} 个` : '';
  if (d.ok) return `一致（${count(d.lakeRows)} 个主键${pending}）`;
  return `${[d.missing && `湖中缺失 ${count(d.missing)}`, d.extra && `湖中多出 ${count(d.extra)}`].filter(Boolean).join('，')}${pending}`;
};

const samples = (list: string[], total: number) => (list.length ? `：${list.join('、')}${total > list.length ? ' 等' : ''}` : '');

/** 一张表的核对明细：位置与四项各自的细节 */
function VerifyDetail({ t }: { t: VerifyRecord }) {
  const files = passed<FileCheck>(t.files);
  const structure = passed<StructureCheck>(t.structure);
  const data = passed<DataCheck>(t.data);
  const errors = [
    t.error,
    failed(t.files) && `文件核对出错：${t.files.error}`,
    failed(t.structure) && `结构核对出错：${t.structure.error}`,
    failed(t.data) && `数据量核对出错：${t.data.error}`,
  ].filter((e): e is string => !!e);
  const lines: string[] = [];
  if (t.location) {
    lines.push(`原始层：${t.location.schema}.${t.location.table}`, `存储前缀：${t.location.prefix}`);
    lines.push(t.location.state ? `${t.location.state.includes('_keys.') ? '当前主键状态' : '当前镜像'}：${t.location.state}` : '当前主键状态 / 镜像：还没有');
  }
  if (t.outOfScope) lines.push('已移出同步范围：湖中数据不再更新，只核对位置与文件');
  if (files) {
    lines.push(`目录登记 ${files.registered} 个文件，当前 ${files.current} 个数据文件共 ${count(files.fileRows)} 行；内联在目录库中 ${count(files.inlinedRows)} 行（没有对应文件）`);
    for (const path of files.missing) lines.push(`缺失：${path}`);
    for (const f of files.sizeMismatch) lines.push(`大小不符：${f.path}（目录 ${count(f.expected)} 字节，存储上 ${count(f.actual)} 字节）`);
    for (const f of files.footer) lines.push(`尾部元数据：${f.path}（${f.problem}）`);
    for (const path of files.orphans) lines.push(`孤儿文件（目录未登记，只报告不删除）：${path}`);
  }
  if (structure) {
    for (const c of structure.missingInLake) lines.push(`湖中缺列（源端新增字段）：${c.name} ${c.type}`);
    for (const c of structure.extraInLake) lines.push(`湖中多出（源端删除字段，保留旧列属预期）：${c.name} ${c.type}`);
    for (const c of structure.typeChanged) lines.push(`类型不同（${c.widened ? '源端放宽' : '不兼容'}）：${c.name} 湖中 ${c.lake}，源端 ${c.source}`);
  }
  if (data?.keyed) {
    lines.push(`按主键 ${data.keys.join('、')} 比对：源端 ${count(data.sourceRows)} 个，湖中回放后 ${count(data.lakeRows)} 个${data.syncedThrough ? `；最近一次同步到 ${data.syncedThrough}` : ''}`);
    if (data.missing) lines.push(`湖中缺失 ${count(data.missing)} 个${samples(data.samples.missing, data.missing)}`);
    if (data.pendingSync) lines.push(`同步后新增，待下次同步 ${count(data.pendingSync)} 个${samples(data.samples.pendingSync, data.pendingSync)}`);
    if (data.extra) lines.push(`湖中多出（源端已删）${count(data.extra)} 个${samples(data.samples.extra, data.extra)}`);
  } else if (data) {
    lines.push(`没有主键，按行数比较：源端 ${count(data.sourceRows)} 行，湖中回放后 ${count(data.lakeRows)} 行`);
  }
  if (!lines.length && !errors.length) return null;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground select-none">明细</summary>
      <ul className="mt-1 space-y-0.5 font-mono break-all whitespace-normal">
        {lines.map(l => <li key={l}>{l}</li>)}
        {errors.map(e => <li key={e} className="text-destructive">{e}</li>)}
      </ul>
    </details>
  );
}

/** 核对结果的汇总：源端的表有几张进湖、没进湖的按原因计数，源端已删除的另计，以及有差异的表数 */
function verifySummary(tables: VerifyRecord[], differences: number) {
  const atSource = tables.filter(t => t.coverage !== 'gone');
  const inLake = atSource.filter(t => t.coverage === 'in_lake').length;
  const reasons = (Object.keys(LAKE_COVERAGE) as LakeCoverage[])
    .filter(c => c !== 'in_lake' && c !== 'gone')
    .map(c => [c, atSource.filter(t => t.coverage === c).length] as const)
    .filter(([, n]) => n)
    .map(([c, n]) => `${LAKE_COVERAGE[c]} ${n} 张`);
  const gone = tables.length - atSource.length;
  return `源端 ${atSource.length} 张表：已进湖 ${inLake} 张，未进湖 ${atSource.length - inLake} 张${reasons.length ? `（${reasons.join('、')}）` : ''}`
    + `${gone ? `；源端已删除 ${gone} 张` : ''}；有差异 ${differences} 张`;
}

type VerifyView = Route.ComponentProps['loaderData']['verify'];

/**
 * 湖中数据：最近一次核对的结果。每张源表一行：覆盖情况与源端行数；已进湖的表另有位置与文件、结构、数据量三项的简要状态，可展开明细。
 * 结构或数据量有差异时可以立即触发一次主键比对同步（修复只走同步这一条写入路径）；只有文件的问题时主键比对修不了，只作说明
 */
function LakeData({ verify, canWrite, submitting, busy }: { verify: VerifyView; canWrite: boolean; submitting: boolean; busy: boolean }) {
  const reconcilable = verify.tables.some(t => passed(t.structure)?.ok === false || passed(t.data)?.ok === false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          湖中数据
          <Badge variant={TASK_VARIANTS[verify.status]} data-verify-status={verify.status}>{`核对${verify.statusLabel}`}</Badge>
        </CardTitle>
        <CardDescription>
          {`从源端的全部表出发，核对每张表的数据进了湖里的什么位置、文件是否真实存在、结构与数据量是否与源端一致。核对只读、只出报告，不修改湖中数据；每天自动核对一次。最近一次核对：${time(verify.verifiedAt)}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {verify.status === 'failed' && verify.error && (
          <div className="text-sm text-destructive">{`${time(verify.attemptedAt)} 提交的核对失败：${verify.error}`}</div>
        )}
        {canWrite && (
          <div className="flex gap-2">
            <Form method="post">
              <input type="hidden" name="intent" value="verify" />
              <Button type="submit" variant="outline" disabled={submitting || busy}>{busy ? '同步或核对进行中…' : '核对'}</Button>
            </Form>
            {reconcilable && (
              <Form method="post">
                <input type="hidden" name="intent" value="reconcile" />
                <Button type="submit" disabled={submitting || busy}>立即主键比对</Button>
              </Form>
            )}
          </div>
        )}
        {verify.verifiedAt && (
          <div className={`text-sm ${verify.differences ? 'text-destructive' : 'text-muted-foreground'}`} data-verify-summary>
            {verifySummary(verify.tables, verify.differences)}
          </div>
        )}
        {verify.differences > 0 && !reconcilable && (
          <div className="text-sm text-muted-foreground" data-files-only>
            差异只在文件上（文件缺失、大小或尾部元数据不符、孤儿文件）：主键比对修不了，请联系运营者检查存储
          </div>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>表</TableHead>
              <TableHead>覆盖</TableHead>
              <TableHead>源端行数</TableHead>
              <TableHead>位置</TableHead>
              <TableHead>文件</TableHead>
              <TableHead>结构</TableHead>
              <TableHead>数据量</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {verify.tables.map(t => (
              <TableRow key={t.table} data-verify-table={t.table} data-coverage={t.coverage} data-verify-ok={t.ok === null ? undefined : String(t.ok)}>
                <TableCell className="align-top">
                  <div className="font-mono font-medium">{t.table}</div>
                  <VerifyDetail t={t} />
                </TableCell>
                <TableCell className="align-top">
                  <Badge variant={COVERAGE_VARIANTS[t.coverage]}>{LAKE_COVERAGE[t.coverage]}</Badge>
                </TableCell>
                <TableCell className="align-top">
                  {t.sourceRows === null ? '—' : `${t.rowsEstimated ? '约 ' : ''}${count(t.sourceRows)}`}
                </TableCell>
                <TableCell className="align-top font-mono text-xs">{t.location ? `${t.location.schema}.${t.location.table}` : '—'}</TableCell>
                <CheckCell name="files" check={t.files} summary={fileSummary} />
                <CheckCell name="structure" check={t.structure} summary={structureSummary} />
                <CheckCell name="data" check={t.data} summary={dataSummary} />
              </TableRow>
            ))}
            {!verify.tables.length && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  {verify.status === 'queued' || verify.status === 'running' ? '正在核对…' : '还没有核对结果'}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** 标签页：概览与湖中数据 */
function Tabs({ sourceId, tab }: { sourceId: string; tab: 'overview' | 'lake' }) {
  const link = (to: string, active: boolean, label: string, name: string) => (
    <Link
      to={to}
      data-tab={name}
      aria-current={active ? 'page' : undefined}
      className={`border-b-2 px-3 py-2 text-sm ${active ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
    >
      {label}
    </Link>
  );
  return (
    <nav className="flex border-b">
      {link(`/sources/${sourceId}`, tab === 'overview', '概览', 'overview')}
      {link(`/sources/${sourceId}?tab=lake`, tab === 'lake', '湖中数据', 'lake')}
    </nav>
  );
}

export default function Source({ loaderData, actionData }: Route.ComponentProps) {
  const { tab, email, nav, canWrite, source, profile, listing, newTables, tables, sync, verify } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const profiling = profile.status === 'queued' || profile.status === 'running';
  const syncing = sync.status === 'queued' || sync.status === 'running';
  const verifying = verify.status === 'queued' || verify.status === 'running';
  // 采集、同步与核对在调度器里异步进行：进行中时定时刷新，结束后停下
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!profiling && !syncing && !verifying) return;
    const timer = setInterval(() => { if (revalidator.state === 'idle') revalidator.revalidate(); }, 2000);
    return () => clearInterval(timer);
  }, [profiling, syncing, verifying, revalidator]);
  const synced = Object.entries(sync.history);
  const values = actionData?.values ?? { name: source.name, ...source.config };
  return (
    <AppShell email={email} nav={nav}>
      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}
      {actionData?.ok && (
        <Alert role="status">
          <CircleCheck />
          <AlertTitle>测试连接</AlertTitle>
          <AlertDescription>{actionData.ok}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{source.name}</CardTitle>
          <CardDescription>
            <Link to="/sources" className="hover:underline">数据源</Link>
            {` · ${SOURCE_KIND_LABELS[source.kind]} · 登记于 ${time(source.createdAt)}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-sm">
            {Object.entries(source.config).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{CONFIG_LABELS[k] ?? k}</dt>
                <dd className="font-mono">{v}</dd>
              </div>
            ))}
            <dt className="text-muted-foreground">凭据</dt>
            <dd>{`已加密保存，不可查看${source.credentialsRotatedAt ? `（${time(source.credentialsRotatedAt)} 轮换）` : ''}`}</dd>
          </dl>
          {canWrite && (
            <div className="flex gap-2">
              <Form method="post">
                <input type="hidden" name="intent" value="test" />
                <Button type="submit" variant="outline" disabled={submitting}>测试连接</Button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="refresh" />
                <Button type="submit" variant="outline" disabled={submitting}>重新列出表并采集</Button>
              </Form>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs sourceId={source.id} tab={tab} />
      {tab === 'lake' ? (
        <LakeData verify={verify} canWrite={canWrite} submitting={submitting} busy={syncing || verifying} />
      ) : (<>
      <Card>
        <CardHeader>
          <CardTitle>同步范围</CardTitle>
          <CardDescription>
            只有选入同步范围的表才会采集列统计、同步进原始层。新出现的表默认不选；移出范围只停止同步，已进湖的数据保留，重新选回后接着同步。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SyncScope
            key={listing.map(t => `${t.name}:${t.inScope}`).join('\n')}
            listing={listing}
            newTables={newTables}
            canWrite={canWrite}
            submitting={submitting}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            源表
            <Badge variant={TASK_VARIANTS[profile.status]} data-profile-status={profile.status}>{`采集${profile.statusLabel}`}</Badge>
          </CardTitle>
          <CardDescription>
            {`同步范围内的表：有更新时间或自增主键的按水位线增量同步（需确认字段），没有的全量比对：每小时一次，大表每天一次。最近采集：${time(profile.profiledAt)}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {listing.length > 0 && <LakeCoverage listing={listing} />}
          {profile.status === 'failed' && profile.error && (
            <div className="text-sm text-destructive">{`${time(profile.attemptedAt)} 提交的采集失败：${profile.error}`}</div>
          )}
          {profile.unreadable.length > 0 && (
            <div className="text-sm text-muted-foreground" data-unreadable>
              {`账号没有读权限的 ${profile.unreadable.length} 张表不能选入同步范围：${profile.unreadable.join('、')}。需要时在源库授予 SELECT 后重新列出表`}
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>表</TableHead>
                <TableHead>行数</TableHead>
                <TableHead>同步方式</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tables.map(t => (
                <TableRow key={t.name} data-table={t.name} data-sync-mode={t.syncMode}>
                  <TableCell className="align-top">
                    <div className="font-mono font-medium">{t.name}</div>
                    <ColumnStats table={t} />
                  </TableCell>
                  <TableCell className="align-top">{t.rows.toLocaleString('zh-CN')}</TableCell>
                  <TableCell className="space-y-1 align-top whitespace-normal">
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={SYNC_VARIANTS[t.syncMode]}>{SYNC_MODES[t.syncMode]}</Badge>
                      <Badge variant={t.notInLake ? 'destructive' : 'secondary'} data-in-lake={String(!t.notInLake)}>
                        {t.notInLake ? `未进湖：${t.notInLake}` : '已进湖'}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">{t.syncModeNote}</div>
                    <Watermark table={t} canWrite={canWrite} submitting={submitting} />
                    <Key table={t} canWrite={canWrite} submitting={submitting} />
                    <SoftDelete table={t} canWrite={canWrite} submitting={submitting} />
                  </TableCell>
                </TableRow>
              ))}
              {!tables.length && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    {profiling ? '正在采集列统计…' : '同步范围内还没有采集过的表'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            同步
            <Badge variant={TASK_VARIANTS[sync.status]} data-sync-status={sync.status}>{sync.statusLabel}</Badge>
          </CardTitle>
          <CardDescription>
            {`已确认水位线的表每小时增量同步一次，首次同步为全表读取，每天再比对一次（有主键的比对主键全集，没有的整行比对），补上源端的删除与漏掉的行。没有水位线的表全量比对，大表每天一次（立即同步时大表一并同步）。变化都以变更批次追加到原始层。最近一次：${time(sync.attemptedAt)} 提交`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {sync.status === 'failed' && sync.error && <div className="text-sm text-destructive">{`同步失败：${sync.error}`}</div>}
          {canWrite && (
            <Form method="post">
              <input type="hidden" name="intent" value="sync" />
              <Button type="submit" variant="outline" disabled={submitting || syncing}>{syncing ? '同步中…' : '立即同步'}</Button>
            </Form>
          )}
          {synced.map(([table, entries]) => <SyncHistory key={table} table={table} entries={entries} />)}
          {!synced.length && <div className="text-sm text-muted-foreground">还没有同步记录</div>}
        </CardContent>
      </Card>

      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>修改与轮换凭据</CardTitle>
            <CardDescription>保存前重新校验连接与只读。凭据留空表示沿用已保存的；主机、库名、用户名或路径变了时须重新填写。</CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post">
              <input type="hidden" name="intent" value="update" />
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="source-name">名称</FieldLabel>
                  <Input id="source-name" name="name" required defaultValue={values.name ?? ''} />
                </Field>
                <SourceFields kind={source.kind} values={values} editing />
                <div>
                  <Button type="submit" disabled={submitting}>{submitting ? '正在校验…' : '校验并保存'}</Button>
                </div>
              </FieldGroup>
            </Form>
          </CardContent>
        </Card>
      )}
      </>)}
    </AppShell>
  );
}
