// app/routes/source.tsx —— 单个数据源：连接参数（凭据不显示）、测试连接、修改与轮换凭据、重新采集；
// 各表的行数、列统计、同步方式、是否已进湖与水位线候选，成员从候选中确认水位线字段，没有主键的表确认业务主键；手动触发同步，查看每张表的同步历史
import { useEffect } from 'react';
import { data, Form, Link, redirect, useNavigation, useRevalidator } from 'react-router';
import { CircleAlert, CircleCheck } from 'lucide-react';
import type { Route } from './+types/source';
import { can, requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { getSyncStatus, syncSource } from '~/.server/source-sync';
import { confirmKey, confirmWatermark, getSource, refreshSourceProfile, SourceError, testSource, updateSource } from '~/.server/sources';
import { TASK_STATUS_LABELS } from '~/.server/tasks';
import { formValues, SOURCE_KIND_LABELS, SYNC_MODES, type SyncMode } from '~/lib/sources';
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

export async function loader({ request, params }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'sources:read');
  try {
    const source = await getSource(member, params.sourceId);
    const sync = await getSyncStatus(member, params.sourceId);
    return {
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
      tables: source.tables.map(t => ({ ...t, notInLake: notInLakeReason(t, sync.history[t.name]) })),
      sync: {
        status: sync.status,
        statusLabel: sync.status === 'none' ? '未同步' : TASK_STATUS_LABELS[sync.status],
        error: sync.error,
        attemptedAt: sync.attemptedAt?.toISOString() ?? null,
        finishedAt: sync.finishedAt?.toISOString() ?? null,
        history: sync.history,
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
        const skipped = unreadable.length ? `；${unreadable.length} 张表没有读权限，采集时跳过：${unreadable.join('、')}` : '';
        return { ok: `连接正常：${tables.length} 张表，账号只读${skipped}`, error: null, values: null };
      }
      case 'update':
        await updateSource(member, params.sourceId, Object.fromEntries([...form].map(([k, v]) => [k, String(v)])));
        break;
      case 'refresh':
        await refreshSourceProfile(member, params.sourceId);
        break;
      case 'sync':
        await syncSource(member, params.sourceId);
        break;
      case 'confirm-watermark':
        await confirmWatermark(member, params.sourceId, field('table'), field('column'));
        break;
      case 'confirm-key':
        await confirmKey(member, params.sourceId, field('table'), field('column'));
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
  throw redirect(`/sources/${params.sourceId}`);
}

/**
 * 源表为什么没有进湖；同步成功过（写出过变更批次）的表返回 null。
 * 同步页只列出同步过的表，这里从源端的全部表出发，没进湖的表不会被漏看
 */
function notInLakeReason(t: { syncMode: SyncMode }, history: object[] | undefined): string | null {
  if (history?.some(e => !('error' in e))) return null;
  if (t.syncMode === 'full_compare') return '全量比对尚未上线';
  if (t.syncMode === 'needs_confirmation') return '待确认水位线';
  return history?.length ? '同步失败' : '等待首次同步';
}

const TASK_VARIANTS = { none: 'outline', queued: 'outline', running: 'secondary', succeeded: 'default', failed: 'destructive' } as const;
const SYNC_VARIANTS = { watermark: 'default', needs_confirmation: 'secondary', full_compare: 'outline' } as const;
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

type TableView = Route.ComponentProps['loaderData']['tables'][number];
type SyncEntry = Route.ComponentProps['loaderData']['sync']['history'][string][number];

const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const BATCH_MODES = { full: '全表读取', incremental: '增量', reconcile: '主键比对' } as const;
const count = (n: number) => n.toLocaleString('zh-CN');

/** 批次的读取范围：增量批次从水位线往回退了回看窗口时一并说明 */
function watermarkRange(e: Extract<SyncEntry, { batch: number }>) {
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
            <TableRow key={`${e.taskId}-${i}`} data-sync-error>
              <TableCell>—</TableCell>
              <TableCell colSpan={3} className="whitespace-normal text-destructive">{`失败：${e.error}`}</TableCell>
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

/** 进湖情况：源端的表（含账号读不了的）有几张已经进湖，没进湖的逐张说明原因 */
function LakeCoverage({ tables, unreadable }: { tables: TableView[]; unreadable: string[] }) {
  const missing = [
    ...tables.filter(t => t.notInLake).map(t => `${t.name}（${t.notInLake}）`),
    ...unreadable.map(name => `${name}（账号没有读权限）`),
  ];
  const inLake = tables.length - tables.filter(t => t.notInLake).length;
  return (
    <div className={`text-sm ${missing.length ? 'text-destructive' : 'text-muted-foreground'}`} data-lake-coverage>
      {`已进湖 ${inLake} 张，未进湖 ${missing.length} 张${missing.length ? `：${missing.join('、')}` : ''}`}
    </div>
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

/** 主键：源端主键；没有时列出业务主键候选供成员确认。都没有时同步看不到删除、增量行一律记为新增 */
function Key({ table, canWrite, submitting }: { table: TableView; canWrite: boolean; submitting: boolean }) {
  if (table.primaryKey.length) return <div className="text-xs text-muted-foreground">{`主键：${table.primaryKey.join('、')}`}</div>;
  if (!table.keyCandidates.length) {
    return <div className="text-xs text-muted-foreground" data-no-key>没有主键：增量行一律记为新增，看不到源端的删除</div>;
  }
  return (
    <ul className="space-y-1 text-xs">
      {table.keyCandidates.map(column => (
        <li key={column} className="flex items-center gap-2" data-key-candidate={column}>
          <span className="font-mono">{column}</span>
          <span className="text-muted-foreground">没有主键；样本中非空且唯一，可作业务主键（据此区分新增与更新、发现删除）</span>
          {table.key === column ? (
            <Badge variant="secondary">{`已确认${table.keyConfirmedBy ? `（${table.keyConfirmedBy}）` : ''}`}</Badge>
          ) : canWrite ? (
            <Form method="post">
              <input type="hidden" name="intent" value="confirm-key" />
              <input type="hidden" name="table" value={table.name} />
              <input type="hidden" name="column" value={column} />
              <Button type="submit" variant="outline" size="sm" disabled={submitting}>确认为业务主键</Button>
            </Form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export default function Source({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canWrite, source, profile, tables, sync } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const profiling = profile.status === 'queued' || profile.status === 'running';
  const syncing = sync.status === 'queued' || sync.status === 'running';
  // 采集与同步在调度器里异步进行：进行中时定时刷新，结束后停下
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!profiling && !syncing) return;
    const timer = setInterval(() => { if (revalidator.state === 'idle') revalidator.revalidate(); }, 2000);
    return () => clearInterval(timer);
  }, [profiling, syncing, revalidator]);
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
                <Button type="submit" variant="outline" disabled={submitting}>重新采集</Button>
              </Form>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            源表
            <Badge variant={TASK_VARIANTS[profile.status]} data-profile-status={profile.status}>{`采集${profile.statusLabel}`}</Badge>
          </CardTitle>
          <CardDescription>
            {`有更新时间或自增主键的表按水位线增量同步（需确认字段）；没有的表需要全量比对，这种同步方式尚未上线。最近采集：${time(profile.profiledAt)}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(tables.length > 0 || profile.unreadable.length > 0) && <LakeCoverage tables={tables} unreadable={profile.unreadable} />}
          {profile.status === 'failed' && profile.error && (
            <div className="text-sm text-destructive">{`${time(profile.attemptedAt)} 提交的采集失败：${profile.error}`}</div>
          )}
          {profile.unreadable.length > 0 && (
            <div className="text-sm text-muted-foreground" data-unreadable>
              {`账号没有读权限，已跳过 ${profile.unreadable.length} 张表：${profile.unreadable.join('、')}。需要时在源库授予 SELECT 后重新采集`}
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
                  </TableCell>
                </TableRow>
              ))}
              {!tables.length && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    {profiling ? '正在采集表清单与列统计…' : '暂无表'}
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
            {`已确认水位线的表每小时增量同步一次，变化以变更批次追加到原始层；首次同步为全量。有主键的表每天再比对一次主键全集，补上源端的删除与漏掉的行。最近一次：${time(sync.attemptedAt)} 提交`}
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
    </AppShell>
  );
}
