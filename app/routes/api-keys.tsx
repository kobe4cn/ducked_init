// app/routes/api-keys.tsx —— 外部系统的 API Key（仅管理员）：创建（明文只在创建后的这次响应里展示一次）、修改范围（?edit=<id>，#977）、吊销；
// 创建与修改共用一份范围表单（接口范围与数据范围，ADR-0061）；「接口说明」标签页按 app/lib/api-docs.ts 的登记表渲染全部外部接口的调用方式（不查库，也没有任何真实 Key）
import { data, Form, Link, redirect, useNavigation, useSearchParams } from 'react-router';
import { Fragment, useState } from 'react';
import { CircleAlert, KeyRound } from 'lucide-react';
import type { Route } from './+types/api-keys';
import { requirePermission } from '~/.server/access';
import { ApiKeyError, createApiKey, listApiKeys, revokeApiKey, updateApiKeyScope, type RawDataScope } from '~/.server/api-keys';
import { apiCatalog } from '~/.server/api-catalog';
import { errorTextFor, formatServer } from '~/.server/i18n';
import { getLocale } from '~/.server/locale';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { SectionHeader } from '~/components/section-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import type { ApiDataScope } from '~/lib/api-data-scope';
import { API_ENDPOINTS, type ApiEndpoint } from '~/lib/api-docs';
import { API_SCOPES, type ApiScope } from '~/lib/api-scopes';
import { formatDateTime } from '~/lib/format';
import { makeT, msg, useLocale, useT, type Locale, type T } from '~/lib/i18n';

export function meta({ matches }: Route.MetaArgs) {
  // RR8 的 MetaMatch 把 loader 数据放在 loaderData 字段；root 出错时为空，回退中文
  const root = matches[0]?.loaderData;
  const t = makeT(root?.locale ?? 'zh-CN', root?.messages ?? null);
  return [{ title: `API Key · ${t('CRM 数据分析平台')}` }];
}

/** 页面的标签页：Key 列表与接口说明（接口说明由登记表生成，不查库） */
type Tab = 'keys' | 'docs';
const tabOf = (request: Request): Tab => {
  const tab = new URL(request.url).searchParams.get('tab');
  return tab === 'docs' ? tab : 'keys';
};

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'api_keys:manage');
  const tab = tabOf(request);
  const base = { email: member.email, nav: navFor(member), tab };
  if (tab === 'docs') return { ...base, keys: [], definitions: [] };
  // 「指定」的勾选清单只列本租户已发布的定义（kind、key、当前版本说明），与目录接口同一来源
  const [rows, catalog] = await Promise.all([listApiKeys(member), apiCatalog(member.tenant.id)]);
  return {
    ...base,
    keys: rows.map(r => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      scopes: r.scopes,
      dataScope: r.dataScope,
      createdByEmail: r.createdByEmail,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      revoked: r.revokedAt !== null,
    })),
    definitions: catalog.definitions.map(d => ({ kind: d.kind, key: d.key, version: d.version, description: d.description })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'api_keys:manage');
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  // 创建与「修改范围」两份表单的字段相同，数据范围的组装抽出来共用
  const rawDataScope = (): RawDataScope => ({
    all: field('dataScope') !== 'some',
    tags: form.getAll('tag').map(String),
    metrics: form.getAll('metric').map(String),
    rfm: form.get('rfm') !== null,
  });
  try {
    switch (field('intent')) {
      case 'create': {
        // 不重定向：明文只在这次响应里出现，刷新或离开后再也看不到
        const { key, row } = await createApiKey(member, field('name'), form.getAll('scope').map(String), rawDataScope());
        return { created: { name: row.name, key } };
      }
      case 'update-scope':
        await updateApiKeyScope(member, field('id'), form.getAll('scope').map(String), rawDataScope());
        break;
      case 'revoke':
        await revokeApiKey(member, field('keyId'));
        break;
      default:
        return data({ error: formatServer(await getLocale(request), msg('未知操作')) }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof ApiKeyError) {
      return data({ error: await errorTextFor(request, e) }, { status: e.status });
    }
    throw e;
  }
  throw redirect('/api-keys');
}

const formatTime = (locale: Locale, iso: string) => formatDateTime(locale, iso, { hour12: false });

/** 参数位置的页面文案：写成 select 句式而不是 t('查询')，因为「查询」这个词条是侧导航的 Workbench，这里要译成 Query */
const paramInText = (t: T, p: 'path' | 'query' | 'body') => t('{where, select, path {路径} query {查询} other {请求体}}', { where: p });

/** 接口范围的名称：中文与 lib/api-scopes 的 API_SCOPE_LABELS 一致，这里写成字面量 t('…') 才能与词典对账 */
const scopeLabel = (t: T, scope: ApiScope) => ({ catalog: t('目录'), consumers: t('点查'), exports: t('导出') })[scope];

/** 数据范围在列表里的一行文字：「全部」，或「N 个标签」「M 个指标」「RFM」中非零的部分 */
const dataScopeLabel = (t: T, scope: ApiDataScope) => {
  if (scope.all) return t('全部');
  return [
    (scope.tags ?? []).length > 0 && t('{n} 个标签', { n: scope.tags.length }),
    (scope.metrics ?? []).length > 0 && t('{n} 个指标', { n: scope.metrics.length }),
    scope.rfm === true && t('RFM'),
  ].filter(Boolean).join(t('、'));
};

/** 「指定」勾选清单里一个定义的标签文字：key 加当前版本的说明（没写说明就只有 key） */
const definitionLabel = (d: { key: string; version: number; description: string | null }) =>
  d.description ? `${d.key}（${d.description}）` : d.key;

/** 创建与「修改范围」共用的范围表单字段：接口勾选与数据范围单选、「指定」勾选区；initial 是预填的当前范围（创建时三类全勾、「全部」） */
function ScopeFields({ initial, definitions }: {
  initial: { scopes: ApiScope[]; dataScope: ApiDataScope };
  definitions: { kind: 'metric' | 'tag'; key: string; version: number; description: string | null }[];
}) {
  const t = useT();
  // 「指定」的勾选区跟着单选走：服务端渲染只带「全部」（创建）或预填的「指定」（修改），切换后展开（浏览器验收里看）
  const [specific, setSpecific] = useState(!initial.dataScope.all);
  // 预填的勾选：「全部」时勾选区不渲染；jsonb 读出来没校验，缺的字段按空数组 / false 处理（同 templateInScope）
  const narrow = initial.dataScope.all ? null : initial.dataScope;
  const current = { tags: narrow?.tags ?? [], metrics: narrow?.metrics ?? [], rfm: narrow?.rfm === true };
  const ofKind = (kind: 'tag' | 'metric') => definitions.filter(d => d.kind === kind);
  return (
    <>
      <Field>
        <FieldLabel>{t('可用接口')}</FieldLabel>
        <div className="flex items-center gap-4 pb-2">
          {API_SCOPES.map(scope => (
            <label key={scope} className="flex items-center gap-1.5 text-sm text-slate-700">
              <input type="checkbox" name="scope" value={scope} defaultChecked={initial.scopes.includes(scope)} className="size-4" />
              {scopeLabel(t, scope)}
            </label>
          ))}
        </div>
      </Field>
      <Field className="basis-full">
        <FieldLabel>{t('数据范围')}</FieldLabel>
        <div className="flex items-center gap-4 pb-2">
          <label className="flex items-center gap-1.5 text-sm text-slate-700">
            <input type="radio" name="dataScope" value="all" checked={!specific} onChange={() => setSpecific(false)} className="size-4" />
            {t('全部（含以后新发布的）')}
          </label>
          <label className="flex items-center gap-1.5 text-sm text-slate-700">
            <input type="radio" name="dataScope" value="some" checked={specific} onChange={() => setSpecific(true)} className="size-4" />
            {t('指定')}
          </label>
        </div>
        {specific && (
          <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
            {(['tag', 'metric'] as const).map(kind => (
              <div key={kind} className="space-y-1">
                <p className="text-xs text-slate-500">{kind === 'tag' ? t('标签') : t('指标')}</p>
                {ofKind(kind).map(d => (
                  <label key={d.key} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      name={kind}
                      value={d.key}
                      defaultChecked={(kind === 'tag' ? current.tags : current.metrics).includes(d.key)}
                      className="size-4"
                    />
                    {definitionLabel(d)}
                  </label>
                ))}
              </div>
            ))}
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="rfm" defaultChecked={current.rfm} className="size-4" />
              {t('RFM')}
            </label>
          </div>
        )}
        <p className="text-xs text-slate-400">{t('范围外的定义，点查、目录与导出都不会出现。')}</p>
      </Field>
    </>
  );
}

/** 「Key」标签页：创建表单与 Key 列表 */
function KeysTab({ keys, definitions, submitting }: {
  keys: { id: string; name: string; prefix: string; scopes: ApiScope[]; dataScope: ApiDataScope; createdByEmail: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }[];
  definitions: { kind: 'metric' | 'tag'; key: string; version: number; description: string | null }[];
  submitting: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  // ?edit=<id> 时只在这一行下渲染「修改范围」表单（SSR 预填当前范围），平时页面不多出第二组单选
  const edit = useSearchParams()[0].get('edit');
  return (
    <>
      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title={t('创建 API Key')}>{t('每个外部系统各用一把，便于单独吊销。')}</SectionHeader>
        <Form method="post">
          <input type="hidden" name="intent" value="create" />
          <FieldGroup className="flex-row flex-wrap items-end">
            <Field>
              <FieldLabel htmlFor="api-key-name">{t('名称')}</FieldLabel>
              <Input id="api-key-name" name="name" required maxLength={100} placeholder={t('如：营销自动化系统')} />
            </Field>
            <ScopeFields initial={{ scopes: [...API_SCOPES], dataScope: { all: true } }} definitions={definitions} />
            <Button type="submit" disabled={submitting}>{t('创建')}</Button>
          </FieldGroup>
          <p className="mt-1 text-xs text-slate-400">{t('不勾的那类接口，这把 Key 调用时返回 403。')}</p>
        </Form>
      </div>

      {keys.length === 0 ? (
        <div className="rounded-2xl border bg-white p-6 text-sm text-slate-500 shadow-sm">{t('还没有 API Key。在上面填写名称创建第一把，交给要调用接口的外部系统。')}</div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('名称')}</TableHead>
                <TableHead>{t('前缀')}</TableHead>
                <TableHead>{t('接口')}</TableHead>
                <TableHead>{t('数据')}</TableHead>
                <TableHead>{t('创建人')}</TableHead>
                <TableHead>{t('创建时间')}</TableHead>
                <TableHead>{t('最近使用')}</TableHead>
                <TableHead className="text-right">{t('操作')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map(k => (
                <Fragment key={k.id}>
                  <TableRow data-api-key-id={k.id}>
                    <TableCell>{k.name}</TableCell>
                    <TableCell className="font-mono">{`${k.prefix}…`}</TableCell>
                    <TableCell className="text-slate-500">{k.scopes.map(s => scopeLabel(t, s)).join(t('、'))}</TableCell>
                    <TableCell className="text-slate-500">{dataScopeLabel(t, k.dataScope)}</TableCell>
                    <TableCell>{k.createdByEmail}</TableCell>
                    <TableCell className="text-slate-500">{formatTime(locale, k.createdAt)}</TableCell>
                    <TableCell className="text-slate-500">{k.lastUsedAt ? formatTime(locale, k.lastUsedAt) : t('从未使用')}</TableCell>
                    <TableCell className="text-right">
                      {k.revoked ? (
                        <Badge variant="secondary">{t('已吊销')}</Badge>
                      ) : (
                        <div className="flex items-center justify-end gap-3">
                          <Link to={`/api-keys?edit=${k.id}`} className="text-sm text-slate-600 hover:underline">{t('修改范围')}</Link>
                          <Form
                            method="post"
                            onSubmit={e => { if (!confirm(t('确定吊销「{name}」？用这把 Key 的外部系统将立即无法调用接口。', { name: k.name }))) e.preventDefault(); }}
                          >
                            <input type="hidden" name="intent" value="revoke" />
                            <input type="hidden" name="keyId" value={k.id} />
                            <Button type="submit" variant="destructive" size="sm" disabled={submitting}>{t('吊销')}</Button>
                          </Form>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                  {edit === k.id && !k.revoked && (
                    <TableRow data-edit-key-id={k.id}>
                      <TableCell colSpan={8}>
                        <Form method="post" className="space-y-3 rounded-lg bg-slate-50 p-4">
                          <input type="hidden" name="intent" value="update-scope" />
                          <input type="hidden" name="id" value={k.id} />
                          <p className="text-sm font-semibold text-slate-900">{t('修改「{name}」的范围', { name: k.name })}</p>
                          <FieldGroup className="flex-row flex-wrap items-end">
                            <ScopeFields initial={{ scopes: k.scopes, dataScope: k.dataScope }} definitions={definitions} />
                            <div className="flex items-center gap-3 pb-2">
                              <Button type="submit" size="sm" disabled={submitting}>{t('保存')}</Button>
                              <Link to="/api-keys" className="text-sm text-slate-500 hover:underline">{t('取消')}</Link>
                            </div>
                          </FieldGroup>
                          <p className="text-xs text-slate-400">{t('提交后这把 Key 的下一个请求即按新范围。')}</p>
                        </Form>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

/** 「接口说明」标签页的一张卡片：一个外部接口的调用方式，全部来自登记表（卡片外壳的文字走词条，登记表内容是 #1125） */
function EndpointCard({ endpoint }: { endpoint: ApiEndpoint }) {
  const t = useT();
  return (
    <section data-endpoint={endpoint.route} className="rounded-2xl border bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono">{endpoint.method}</Badge>
        <code className="font-mono text-sm font-semibold text-slate-900">{endpoint.path}</code>
      </div>
      <p className="mt-3 max-w-3xl text-sm text-slate-600">{endpoint.purpose}</p>
      <p className="mt-2 text-sm text-slate-600"><span className="text-slate-500">{t('鉴权：')}</span>{endpoint.auth}</p>

      {endpoint.params.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-sm font-semibold text-slate-900">{t('参数')}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('参数')}</TableHead>
                <TableHead>{t('位置')}</TableHead>
                <TableHead>{t('必填')}</TableHead>
                <TableHead>{t('说明')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoint.params.map(p => (
                <TableRow key={p.name}>
                  <TableCell className="font-mono">{p.name}</TableCell>
                  <TableCell>{paramInText(t, p.in)}</TableCell>
                  <TableCell>{p.required ? t('必填') : t('可选')}</TableCell>
                  <TableCell className="text-slate-600">{p.desc}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="mt-4 space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">{t('成功响应示例')}</h3>
        <pre className="overflow-x-auto rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm text-slate-900">{endpoint.responseExample}</pre>
      </div>

      <div className="mt-4 space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">{t('错误')}</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('状态码')}</TableHead>
              <TableHead>{t('返回文案（error 字段）')}</TableHead>
              <TableHead>{t('什么时候出现')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {endpoint.errors.map(err => (
              <TableRow key={`${err.status}-${err.message}`}>
                <TableCell className="font-mono">{err.status}</TableCell>
                <TableCell className="font-mono text-xs">{err.message}</TableCell>
                <TableCell className="text-slate-600">{err.meaning}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="mt-4 space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">curl</h3>
        <pre className="overflow-x-auto rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm text-slate-900">{endpoint.curl}</pre>
      </div>
    </section>
  );
}

export default function ApiKeys({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, tab, keys, definitions } = loaderData;
  const t = useT();
  const submitting = useNavigation().state === 'submitting';
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="API Key" description={t("外部系统用 Authorization: Bearer '<Key> 调用 /api/v1/ 下的接口。吊销后用这把 Key 的请求立即被拒绝。")} />

      <PillTabs
        current={tab}
        tabs={[
          { key: 'keys', label: 'Key', href: '/api-keys' },
          { key: 'docs', label: t('接口说明'), href: '/api-keys?tab=docs' },
        ]}
      />

      {actionData && 'error' in actionData && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>{t('操作未完成')}</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {actionData && 'created' in actionData && (
        <Alert role="status">
          <KeyRound />
          <AlertTitle>{t('已创建「{name}」', { name: actionData.created.name })}</AlertTitle>
          <AlertDescription>
            <p>{t('请现在复制并妥善保存。这把 Key 只展示这一次，平台不保存明文，之后无法再查看。')}</p>
            <code data-api-key className="mt-2 block break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm text-slate-900">{actionData.created.key}</code>
          </AlertDescription>
        </Alert>
      )}

      {tab === 'docs' ? (
        <div className="space-y-4">
          <p className="max-w-3xl text-sm text-slate-500">
            {t("全部外部接口的调用方式如下，示例里的地址与 Key 都是占位符（'<平台地址>、'<你的 API Key>）。接口的增改以这份登记表为准。")}
          </p>
          <p className="max-w-3xl text-sm text-slate-500">
            {t('每把 Key 还有数据范围：范围外的标签、指标不会出现在目录与点查里；范围外的快照返回 404（与不存在相同）；导出条件用到范围外的标签时返回 400。范围在创建 Key 时设置，之后可随时在 Key 列表里「修改范围」，下一个请求即按新范围。')}
          </p>
          {API_ENDPOINTS.map(endpoint => <EndpointCard key={endpoint.route} endpoint={endpoint} />)}
        </div>
      ) : (
        <KeysTab keys={keys} definitions={definitions} submitting={submitting} />
      )}
    </AppShell>
  );
}
