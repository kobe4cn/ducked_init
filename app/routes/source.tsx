// app/routes/source.tsx —— 单个数据源：连接参数（凭据不显示）、测试连接、修改与轮换凭据、重新采集；
// 各表的行数、列统计、同步方式与水位线候选，成员从候选中确认水位线字段
import { useEffect } from 'react';
import { data, Form, Link, redirect, useNavigation, useRevalidator } from 'react-router';
import { CircleAlert, CircleCheck } from 'lucide-react';
import type { Route } from './+types/source';
import { can, requirePermission } from '~/.server/access';
import { navFor } from '~/.server/nav';
import { confirmWatermark, getSource, refreshSourceProfile, SourceError, testSource, updateSource } from '~/.server/sources';
import { TASK_STATUS_LABELS } from '~/.server/tasks';
import { formValues, SOURCE_KIND_LABELS, SYNC_MODES } from '~/lib/sources';
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
      tables: source.tables,
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
      case 'confirm-watermark':
        await confirmWatermark(member, params.sourceId, field('table'), field('column'));
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

const PROFILE_VARIANTS = { none: 'outline', queued: 'outline', running: 'secondary', succeeded: 'default', failed: 'destructive' } as const;
const SYNC_VARIANTS = { watermark: 'default', needs_confirmation: 'secondary', full_compare: 'outline' } as const;
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

type TableView = Route.ComponentProps['loaderData']['tables'][number];

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

export default function Source({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, canWrite, source, profile, tables } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  const profiling = profile.status === 'queued' || profile.status === 'running';
  // 采集在调度器里异步进行：进行中时定时刷新，结束后停下
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!profiling) return;
    const timer = setInterval(() => { if (revalidator.state === 'idle') revalidator.revalidate(); }, 2000);
    return () => clearInterval(timer);
  }, [profiling, revalidator]);
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
            <Badge variant={PROFILE_VARIANTS[profile.status]} data-profile-status={profile.status}>{`采集${profile.statusLabel}`}</Badge>
          </CardTitle>
          <CardDescription>
            {`有更新时间或自增主键的表按水位线增量同步（需确认字段）；没有的表全量比对（大表默认每天一次）。最近采集：${time(profile.profiledAt)}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
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
                    <Badge variant={SYNC_VARIANTS[t.syncMode]}>{SYNC_MODES[t.syncMode]}</Badge>
                    <div className="text-xs text-muted-foreground">{t.syncModeNote}</div>
                    <Watermark table={t} canWrite={canWrite} submitting={submitting} />
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
