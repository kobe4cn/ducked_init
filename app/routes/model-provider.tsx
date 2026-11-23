// app/routes/model-provider.tsx —— 模型服务（仅管理员）：看当前用平台默认还是本租户配置；保存端点、模型名与 API Key（Key 不回显，留空沿用）、
// 恢复平台默认、测试连通性（同时显示是否支持工具调用）、开关发送脱敏样本；embedding 端点（ADR-0049）单独一张卡，与 chat 互不影响；
// fast / reasoning 档位（ADR-0055 路由③a）再一张卡，按用途换模型，端点留空沿用本租户的端点与 Key；chat 与两档各有可选的服务商参数（#1170，JSON 对象，如关思考）；
// 向量存储（ADR-0058，#848）一张卡：选系统自带还是外部 pgvector，连接串加密不回显，保存时先测连通失败不保存
import { data, Form, redirect, useNavigation } from 'react-router';
import { AlertTriangle, CheckCircle2, CircleAlert } from 'lucide-react';
import type { Route } from './+types/model-provider';
import { requirePermission } from '~/.server/access';
import { prefetchEmbeddings } from '~/.server/catalog/versions';
import { errorTextFor, formatServer } from '~/.server/i18n';
import { getLocale } from '~/.server/locale';
import {
  getModelProvider, ModelProviderError, resetEmbeddingProvider, resetModelProvider, resetTierProvider, SAMPLE_ROWS, saveEmbeddingProvider,
  saveModelProvider, saveTierProvider, saveVectorStore, setAllowSamples, testEmbeddingProvider, testModelProvider, testVectorStore,
} from '~/.server/model-provider';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { SectionHeader } from '~/components/section-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { formatDateTime, formatNumber } from '~/lib/format';
import { makeT, msg, useLocale, useT, type T } from '~/lib/i18n';

export function meta({ matches }: Route.MetaArgs) {
  // RR8 的 MetaMatch 把 loader 数据放在 loaderData 字段；root 出错时为空，回退中文
  const root = matches[0]?.loaderData;
  const t = makeT(root?.locale ?? 'zh-CN', root?.messages ?? null);
  return [{ title: `${t('模型服务')} · ${t('CRM 数据分析平台')}` }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'model_provider:manage');
  return { email: member.email, nav: navFor(member), provider: await getModelProvider(member), sampleRows: SAMPLE_ROWS };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'model_provider:manage');
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  // 服务商参数：表单没带这个字段时传 undefined，后端不动已存的值（只有带了且为空才清掉）
  const chatExtraField = () => (form.has('chatExtra') ? field('chatExtra') : undefined);
  // 档位表单带的 tier 字段，取值不是 fast / reasoning 时按不合法输入返回 400
  const tierField = () => {
    const tier = field('tier');
    return tier === 'fast' || tier === 'reasoning' ? tier : null;
  };
  try {
    switch (field('intent')) {
      case 'save':
        await saveModelProvider(member, { baseUrl: field('baseUrl'), model: field('model'), apiKey: field('apiKey'), chatExtra: chatExtraField() });
        break;
      case 'tier_save': {
        const tier = tierField();
        if (!tier) return data({ error: formatServer(await getLocale(request), msg('档位须是 fast 或 reasoning')) }, { status: 400 });
        await saveTierProvider(member, tier, { baseUrl: field('baseUrl'), model: field('model'), apiKey: field('apiKey'), chatExtra: chatExtraField() });
        break;
      }
      case 'tier_reset': {
        const tier = tierField();
        if (!tier) return data({ error: formatServer(await getLocale(request), msg('档位须是 fast 或 reasoning')) }, { status: 400 });
        await resetTierProvider(member, tier);
        break;
      }
      case 'embedding_save':
        await saveEmbeddingProvider(member, { baseUrl: field('embeddingBaseUrl'), model: field('embeddingModel'), apiKey: field('embeddingApiKey') });
        // 保存了 embedding 配置时提前补一次检索向量（#824）：没开混合检索的租户 prefetchEmbeddings 自己返回 off，这里不用再判断
        await prefetchEmbeddings(member.tenant.id)
          .catch(e => console.warn('保存 embedding 配置后提前补算向量失败', member.tenant.id, e instanceof Error ? e.message : e));
        break;
      case 'embedding_reset':
        await resetEmbeddingProvider(member);
        break;
      case 'embedding_test':
        // 不重定向：测试结果只在这次响应里展示
        return { embeddingTested: await testEmbeddingProvider(member) };
      // 向量存储（#848）：保存时先测连通、失败不保存，结果（连同「测试连接」的）只在这次响应里展示；
      // 切回「系统自带」不测连通，照别的保存一样重定向
      case 'vector_store_save': {
        const checked = await saveVectorStore(member, { kind: field('vectorStore'), url: field('vectorStoreUrl') });
        if (checked.ok && field('vectorStore') === 'platform') break;
        return { vectorStoreChecked: checked };
      }
      case 'vector_store_test':
        return { vectorStoreChecked: await testVectorStore(member) };
      case 'reset':
        await resetModelProvider(member);
        break;
      case 'samples':
        await setAllowSamples(member, form.get('allowSamples') === 'on');
        break;
      case 'test':
        // 不重定向：测试结果只在这次响应里展示
        return { tested: await testModelProvider(member) };
      default:
        return data({ error: formatServer(await getLocale(request), msg('未知操作')) }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof ModelProviderError) return data({ error: await errorTextFor(request, e) }, { status: e.status });
    throw e;
  }
  throw redirect('/model-provider');
}

/** 当前配置一行：chat 与 embedding 各自的来源说明（写成字面量 t('…') 的对照表，才能与词典对账） */
const sourceLabel = (t: T, source: 'tenant' | 'platform' | 'none') => ({
  tenant: t('当前使用本租户的配置'),
  platform: t('当前使用平台默认的模型服务'),
  none: t('还没有可用的模型服务：平台没有配置默认，请在下面填写'),
})[source];

const embeddingSourceLabel = (t: T, source: 'tenant' | 'platform' | 'none') => ({
  tenant: t('当前使用本租户的 embedding 配置'),
  platform: t('当前使用平台默认的 embedding 端点'),
  none: t('还没有配置 embedding：不配置时目录检索只用关键词'),
})[source];

/** 向量存储（ADR-0058，#848）两种选型的名字 */
const vectorStoreLabel = (t: T, kind: 'platform' | 'pgvector') => ({ platform: t('系统自带'), pgvector: t('外部 pgvector') })[kind];

/** 向量存储卡上的「上次检查」状态行：失败 / 通过 / 还没测过 */
function VectorStoreStatus({ checkedAt, error }: { checkedAt: string | null; error: string | null }) {
  const t = useT();
  const locale = useLocale();
  if (error) {
    return (
      <span data-vector-store-status="failed" className="flex items-center gap-1 text-red-600">
        <CircleAlert className="size-4" />{t('上次检查未通过：{error}', { error })}
      </span>
    );
  }
  if (checkedAt) {
    return (
      <span data-vector-store-status="ok" className="flex items-center gap-1 text-emerald-600">
        <CheckCircle2 className="size-4" />{t('上次检查 {time}，连接正常', { time: formatDateTime(locale, checkedAt) })}
      </span>
    );
  }
  return (
    <span data-vector-store-status="never" className="flex items-center gap-1 text-slate-400">
      <AlertTriangle className="size-4" />{t('还没有测试过连接')}
    </span>
  );
}

/** 每档的名字与它管哪些用途（ADR-0055 的 PURPOSE_TIER 决定，页面只做说明） */
const tierLabel = (t: T, tier: 'fast' | 'reasoning') => ({
  fast: { title: t('快速档（fast）'), hint: t('断言草稿、工作台结果解读、一句话解析这类要快的用途') },
  reasoning: { title: t('推理档（reasoning）'), hint: t('AI 助手、起草映射、指标、标签这类要推理的用途') },
})[tier];

/** 服务商参数（#1170）：可选的 JSON 对象，随每次 chat 请求带给服务商（如关思考）。示例含花括号，放 placeholder 而不进 t()（ICU 会当成变量） */
function ChatExtraField({ id, defaultValue, children }: { id: string; defaultValue: string | null; children: React.ReactNode }) {
  const t = useT();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{t('服务商参数（可选）')}</FieldLabel>
      <textarea
        id={id} name="chatExtra" rows={3} defaultValue={defaultValue ?? ''}
        placeholder='{"enable_thinking": false}'
        className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <p className="text-sm text-slate-400">{children}</p>
    </Field>
  );
}

/** 「按用途选模型」卡片里的一档：当前绑定 + 换模型的表单。chatReady 是本租户的模型服务（chat 三项）是否已保存，没有时档位无从生效 */
function TierSection({ tier, state, chatReady, submitting }: {
  tier: 'fast' | 'reasoning';
  state: { model: string | null; baseUrl: string | null; apiKeySet: boolean; chatExtra: string | null };
  chatReady: boolean;
  submitting: boolean;
}) {
  const t = useT();
  const label = tierLabel(t, tier);
  const bound = Boolean(state.model);
  let bindingText: string;
  if (!bound) bindingText = t('使用默认');
  else if (state.baseUrl) bindingText = t('模型 {model}，端点 {baseUrl}', { model: state.model, baseUrl: state.baseUrl });
  else bindingText = t('模型 {model}，端点沿用本租户默认', { model: state.model });
  return (
    <div className="space-y-3 border-t pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">{label.title}</h3>
          <p className="text-sm text-slate-500" {...{ [`data-tier-${tier}`]: bound ? 'tenant' : 'default' }}>
            {bindingText}
          </p>
          <p className="text-sm text-slate-400">{label.hint}</p>
        </div>
        {bound && (
          <Form
            method="post"
            onSubmit={e => { if (!confirm(t('确定恢复{tier}的默认？将清空该档的模型、端点与 API Key。', { tier: label.title }))) e.preventDefault(); }}
          >
            <input type="hidden" name="intent" value="tier_reset" />
            <input type="hidden" name="tier" value={tier} />
            <Button type="submit" variant="destructive" disabled={submitting}>{t('恢复默认')}</Button>
          </Form>
        )}
      </div>
      {/* 输入框是非受控的：保存 / 恢复默认后 loader 给的是新值，但已挂载的输入框不会跟着 defaultValue 刷新。key 只用已保存值拼，值一变表单重挂载显示新值；提交失败（400）时这些值不变，用户改到一半的内容不会丢 */}
      <Form method="post" key={`${state.model ?? ''}|${state.baseUrl ?? ''}|${state.apiKeySet}|${state.chatExtra ?? ''}`}>
        <input type="hidden" name="intent" value="tier_save" />
        <input type="hidden" name="tier" value={tier} />
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${tier}-model`}>{t('模型名')}</FieldLabel>
            <Input id={`${tier}-model`} name="model" required defaultValue={state.model ?? ''} placeholder={t('如：qwen-max')} />
          </Field>
          <ChatExtraField id={`${tier}-chat-extra`} defaultValue={state.chatExtra}>
            {t('不填时沿用本租户默认的那份；model、messages 等平台字段写了也不生效。')}
          </ChatExtraField>
          <Field>
            <FieldLabel htmlFor={`${tier}-base-url`}>{t('端点')}</FieldLabel>
            <Input id={`${tier}-base-url`} name="baseUrl" defaultValue={state.baseUrl ?? ''} placeholder={t('留空沿用本租户的端点与 Key')} />
            <FieldDescription>{t('只换模型名时留空；填写后平台请求「端点/chat/completions」。')}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${tier}-api-key`}>API Key</FieldLabel>
            <Input
              id={`${tier}-api-key`}
              name="apiKey"
              type="password"
              autoComplete="off"
              placeholder={state.apiKeySet ? t('已设置，留空不修改') : t('端点留空时不需要')}
            />
            {state.apiKeySet && <FieldDescription>{t('改了端点须重新填写，原来的 Key 不会发给新的端点。')}</FieldDescription>}
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={submitting || !chatReady}>{t('保存')}</Button>
            {!chatReady && <span className="text-sm text-slate-400">{t('先保存本租户的模型服务后档位才生效')}</span>}
          </div>
        </FieldGroup>
      </Form>
    </div>
  );
}

export default function ModelProvider({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, provider, sampleRows } = loaderData;
  const t = useT();
  const locale = useLocale();
  const submitting = useNavigation().state === 'submitting';
  // 三个成员的联合会被 TS 规范化成带交叉可选属性的形状（tested?: undefined），in 之后属性仍可能 undefined，先收进局部再判空
  const tested = actionData && 'tested' in actionData ? actionData.tested : null;
  const embeddingTested = actionData && 'embeddingTested' in actionData ? actionData.embeddingTested : null;
  const vectorStoreChecked = actionData && 'vectorStoreChecked' in actionData ? actionData.vectorStoreChecked : null;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={t('模型服务')}
        description={t('起草映射等设计时功能会调用 OpenAI 兼容的模型服务。填写本租户的端点后整套改用本租户的配置，否则使用平台默认。')}
      />

      {actionData && 'error' in actionData && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>{t('操作未完成')}</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {tested && (tested.ok ? (
        <Alert role="status" data-connectivity="ok">
          <CheckCircle2 className="text-emerald-600" />
          <AlertTitle>{t('连通成功')}</AlertTitle>
          <AlertDescription className="space-y-1">
            <div data-model={tested.model} data-duration-ms={tested.durationMs}>
              {t('模型 {model}，耗时 {ms} ms', { model: tested.model, ms: tested.durationMs })}
            </div>
            {tested.tools ? (
              <div data-tools="yes" className="flex items-center gap-1 text-emerald-600">
                <CheckCircle2 className="size-4" />{t('支持工具调用')}
              </div>
            ) : tested.tools === false ? (
              <div data-tools="no" className="flex items-center gap-1 text-amber-600">
                <AlertTriangle className="size-4" />{t('该模型服务不支持工具调用，AI 助手无法使用')}
              </div>
            ) : (
              <div data-tools="unknown" className="flex items-center gap-1 text-muted-foreground">
                <AlertTriangle className="size-4" />{t('这次没能确认是否支持工具调用（模型没有调用探测工具，或服务暂时不可用），可以再测一次')}
              </div>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive" role="alert" data-connectivity="failed">
          <CircleAlert />
          <AlertTitle>{t('连通失败')}</AlertTitle>
          <AlertDescription>{tested.error}</AlertDescription>
        </Alert>
      ))}

      {embeddingTested && (embeddingTested.ok ? (
        <Alert role="status" data-embedding-test="ok">
          <CheckCircle2 className="text-emerald-600" />
          <AlertTitle>{t('连通成功')}</AlertTitle>
          <AlertDescription>
            <div
              data-embedding-model={embeddingTested.model}
              data-embedding-dimensions={embeddingTested.dimensions}
              data-embedding-duration-ms={embeddingTested.durationMs}
            >
              {t('模型 {model}，维度 {dimensions}，耗时 {ms} ms', {
                model: embeddingTested.model,
                dimensions: embeddingTested.dimensions,
                ms: embeddingTested.durationMs,
              })}
            </div>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive" role="alert" data-embedding-test="failed">
          <CircleAlert />
          <AlertTitle>{t('连通失败')}</AlertTitle>
          <AlertDescription>{embeddingTested.error}</AlertDescription>
        </Alert>
      ))}

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title={t('当前配置')}>
          <span data-provider-source={provider.source}>{sourceLabel(t, provider.source)}</span>
        </SectionHeader>
        <div className="flex flex-wrap gap-2">
          <Form method="post">
            <input type="hidden" name="intent" value="test" />
            <Button type="submit" variant="outline" disabled={submitting || provider.source === 'none'}>{t('测试连通性')}</Button>
          </Form>
          {provider.source === 'tenant' && (
            <Form
              method="post"
              onSubmit={e => { if (!confirm(t('确定恢复平台默认？将清空本租户填写的端点、模型名与 API Key。'))) e.preventDefault(); }}
            >
              <input type="hidden" name="intent" value="reset" />
              <Button type="submit" variant="destructive" disabled={submitting}>{t('恢复平台默认')}</Button>
            </Form>
          )}
        </div>
      </div>

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title={t('本租户的模型服务')}>{t('API Key 加密保存，保存后不再显示。')}</SectionHeader>
        {/* 同档位表单：非受控输入框不跟着新 defaultValue 刷新，恢复平台默认后靠 key 重挂载回服务端新值 */}
        <Form method="post" key={`${provider.baseUrl ?? ''}|${provider.model ?? ''}|${provider.apiKeySet}|${provider.chatExtra ?? ''}`}>
          <input type="hidden" name="intent" value="save" />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="model-base-url">{t('端点')}</FieldLabel>
              <Input id="model-base-url" name="baseUrl" required defaultValue={provider.baseUrl ?? ''} placeholder="https://api.openai.com/v1" />
              <FieldDescription>{t('平台会请求「端点/chat/completions」。')}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="model-name">{t('模型名')}</FieldLabel>
              <Input id="model-name" name="model" required defaultValue={provider.model ?? ''} placeholder={t('如：gpt-4o-mini')} />
            </Field>
            <ChatExtraField id="model-chat-extra" defaultValue={provider.chatExtra}>
              {t('model、messages 等平台字段写了也不生效。')}
            </ChatExtraField>
            <Field>
              <FieldLabel htmlFor="model-api-key">API Key</FieldLabel>
              <Input
                id="model-api-key"
                name="apiKey"
                type="password"
                autoComplete="off"
                required={!provider.apiKeySet}
                placeholder={provider.apiKeySet ? t('已设置，留空不修改') : t('未设置')}
              />
              {provider.apiKeySet && <FieldDescription>{t('改了端点须重新填写，原来的 Key 不会发给新的端点。')}</FieldDescription>}
            </Field>
            <div>
              <Button type="submit" disabled={submitting}>{t('保存')}</Button>
            </div>
          </FieldGroup>
        </Form>
      </div>

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title={t('向量检索（可选）')}>
          <span data-embedding-source={provider.embedding.source}>{embeddingSourceLabel(t, provider.embedding.source)}</span>
        </SectionHeader>
        <div className="flex flex-wrap gap-2">
          <Form method="post">
            <input type="hidden" name="intent" value="embedding_test" />
            <Button type="submit" variant="outline" disabled={submitting || provider.embedding.source === 'none'}>{t('测试 embedding')}</Button>
          </Form>
          {provider.embedding.source === 'tenant' && (
            <Form
              method="post"
              onSubmit={e => { if (!confirm(t('确定恢复平台默认？将清空本租户填写的 embedding 端点、模型名与 API Key。'))) e.preventDefault(); }}
            >
              <input type="hidden" name="intent" value="embedding_reset" />
              <Button type="submit" variant="destructive" disabled={submitting}>{t('恢复平台默认')}</Button>
            </Form>
          )}
        </div>
        {/* 同上：恢复平台默认后靠 key 重挂载，输入框回服务端新值 */}
        <Form method="post" key={`${provider.embedding.baseUrl ?? ''}|${provider.embedding.model ?? ''}|${provider.embedding.apiKeySet}`}>
          <input type="hidden" name="intent" value="embedding_save" />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="embedding-base-url">{t('端点')}</FieldLabel>
              <Input id="embedding-base-url" name="embeddingBaseUrl" required defaultValue={provider.embedding.baseUrl ?? ''} placeholder="https://api.openai.com/v1" />
              <FieldDescription>{t('平台会请求「端点/embeddings」，配置后语义检索把文字转成向量比对。')}</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="embedding-model">{t('模型名')}</FieldLabel>
              <Input id="embedding-model" name="embeddingModel" required defaultValue={provider.embedding.model ?? ''} placeholder={t('如：text-embedding-v3')} />
            </Field>
            <Field>
              <FieldLabel htmlFor="embedding-api-key">API Key</FieldLabel>
              <Input
                id="embedding-api-key"
                name="embeddingApiKey"
                type="password"
                autoComplete="off"
                required={!provider.embedding.apiKeySet}
                placeholder={provider.embedding.apiKeySet ? t('已设置，留空不修改') : t('未设置')}
              />
              {provider.embedding.apiKeySet && <FieldDescription>{t('改了端点须重新填写，原来的 Key 不会发给新的端点。')}</FieldDescription>}
            </Field>
            <div>
              <Button type="submit" disabled={submitting}>{t('保存')}</Button>
            </div>
          </FieldGroup>
        </Form>
      </div>

      {vectorStoreChecked && (vectorStoreChecked.ok ? (
        <Alert role="status" data-vector-store-test="ok">
          <CheckCircle2 className="text-emerald-600" />
          <AlertTitle>{t('连接成功')}</AlertTitle>
          <AlertDescription>{t('外部 pgvector 连通正常。')}</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive" role="alert" data-vector-store-test="failed">
          <CircleAlert />
          <AlertTitle>{t('连接失败')}</AlertTitle>
          <AlertDescription>{vectorStoreChecked.error}</AlertDescription>
        </Alert>
      ))}

      {/* 向量存储（ADR-0058，#848）：这里只存选型与连接串，补算与检索真正切到外部库在 #849 */}
      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title={t('向量存储')}>
          {t('当前：')}<span data-vector-store-kind={provider.vectorStore.kind}>{vectorStoreLabel(t, provider.vectorStore.kind)}</span>
        </SectionHeader>
        <p className="text-sm text-slate-500">{t('检索向量存在平台库，或租户自己的外部 PostgreSQL（pgvector 扩展）。连接串加密保存、保存后不再显示；选外部 pgvector 时保存前先测试连通，失败不保存。')}</p>
        {provider.vectorStore.kind === 'pgvector' && (
          <div data-vector-store-checked={provider.vectorStore.checkedAt ?? ''} className="text-sm">
            <VectorStoreStatus checkedAt={provider.vectorStore.checkedAt} error={provider.vectorStore.error} />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Form method="post">
            <input type="hidden" name="intent" value="vector_store_test" />
            <Button type="submit" variant="outline" disabled={submitting || !provider.vectorStore.urlSet}>{t('测试连接')}</Button>
          </Form>
        </div>
        {/* 同上：非受控输入框不跟着新 defaultValue 刷新，保存后靠 key 重挂载回服务端新值 */}
        <Form method="post" key={`${provider.vectorStore.kind}|${provider.vectorStore.urlSet}`}>
          <input type="hidden" name="intent" value="vector_store_save" />
          <FieldGroup>
            <Field>
              <FieldLabel>{t('存储')}</FieldLabel>
              <div className="space-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="vectorStore" value="platform" defaultChecked={provider.vectorStore.kind === 'platform'} className="size-4" />
                  {t('系统自带（存平台库）')}
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="vectorStore" value="pgvector" defaultChecked={provider.vectorStore.kind === 'pgvector'} className="size-4" />
                  {t('外部 pgvector（租户自己的 PostgreSQL）')}
                </label>
              </div>
              {provider.vectorStore.urlSet && provider.vectorStore.kind === 'platform' && (
                <FieldDescription>{t('已保存过外部库的连接串，切回外部 pgvector 时留空沿用。')}</FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="vector-store-url">{t('连接串')}</FieldLabel>
              <Input
                id="vector-store-url"
                name="vectorStoreUrl"
                type="password"
                autoComplete="off"
                placeholder={provider.vectorStore.urlSet ? t('已设置，留空不修改') : 'postgres://user:password@host:5432/dbname'}
              />
              <FieldDescription>{t('postgres:// 或 postgresql:// 开头；换主机时填新的连接串。')}</FieldDescription>
            </Field>
            <div>
              <Button type="submit" disabled={submitting}>{t('保存')}</Button>
            </div>
          </FieldGroup>
        </Form>
      </div>

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title={t('按用途选模型')}>
          {provider.source === 'tenant'
            ? t('两档可各自换模型；端点留空时沿用本租户的端点与 Key。')
            : t('先保存本租户的模型服务后档位才生效。')}
        </SectionHeader>
        <TierSection tier="fast" state={provider.tiers.fast} chatReady={provider.source === 'tenant'} submitting={submitting} />
        <TierSection tier="reasoning" state={provider.tiers.reasoning} chatReady={provider.source === 'tenant'} submitting={submitting} />
      </div>

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title={t('发送脱敏样本')}>{t('默认只把表结构与列统计发给模型服务。')}</SectionHeader>
        <Form method="post">
          <input type="hidden" name="intent" value="samples" />
          <FieldGroup>
            <Field orientation="horizontal">
              <input type="checkbox" id="model-allow-samples" name="allowSamples" defaultChecked={provider.allowSamples} className="size-4" />
              <FieldLabel htmlFor="model-allow-samples">{t('发送脱敏样本')}</FieldLabel>
            </Field>
            <FieldDescription>{t('打开后会把每张表最新 {rows} 行发给模型服务，像手机号、邮箱、姓名的列先换成哈希。', { rows: formatNumber(locale, sampleRows) })}</FieldDescription>
            <div>
              <Button type="submit" variant="outline" disabled={submitting}>{t('保存')}</Button>
            </div>
          </FieldGroup>
        </Form>
      </div>
    </AppShell>
  );
}
