// app/routes/model-provider.tsx —— 模型服务（仅管理员）：看当前用平台默认还是本租户配置；保存端点、模型名与 API Key（Key 不回显，留空沿用）、
// 恢复平台默认、测试连通性（同时显示是否支持工具调用）、开关发送脱敏样本；embedding 端点（ADR-0049）单独一张卡，与 chat 互不影响；
// fast / reasoning 档位（ADR-0055 路由③a）再一张卡，按用途换模型，端点留空沿用本租户的端点与 Key
import { data, Form, redirect, useNavigation } from 'react-router';
import { AlertTriangle, CheckCircle2, CircleAlert } from 'lucide-react';
import type { Route } from './+types/model-provider';
import { requirePermission } from '~/.server/access';
import {
  getModelProvider, ModelProviderError, resetEmbeddingProvider, resetModelProvider, resetTierProvider, SAMPLE_ROWS, saveEmbeddingProvider,
  saveModelProvider, saveTierProvider, setAllowSamples, testEmbeddingProvider, testModelProvider,
} from '~/.server/model-provider';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { PageHeader } from '~/components/page-header';
import { SectionHeader } from '~/components/section-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';

export function meta({}: Route.MetaArgs) {
  return [{ title: '模型服务 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'model_provider:manage');
  return { email: member.email, nav: navFor(member), provider: await getModelProvider(member), sampleRows: SAMPLE_ROWS };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'model_provider:manage');
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  // 档位表单带的 tier 字段，取值不是 fast / reasoning 时按不合法输入返回 400
  const tierField = () => {
    const tier = field('tier');
    return tier === 'fast' || tier === 'reasoning' ? tier : null;
  };
  try {
    switch (field('intent')) {
      case 'save':
        await saveModelProvider(member, { baseUrl: field('baseUrl'), model: field('model'), apiKey: field('apiKey') });
        break;
      case 'tier_save': {
        const tier = tierField();
        if (!tier) return data({ error: '档位须是 fast 或 reasoning' }, { status: 400 });
        await saveTierProvider(member, tier, { baseUrl: field('baseUrl'), model: field('model'), apiKey: field('apiKey') });
        break;
      }
      case 'tier_reset': {
        const tier = tierField();
        if (!tier) return data({ error: '档位须是 fast 或 reasoning' }, { status: 400 });
        await resetTierProvider(member, tier);
        break;
      }
      case 'embedding_save':
        await saveEmbeddingProvider(member, { baseUrl: field('embeddingBaseUrl'), model: field('embeddingModel'), apiKey: field('embeddingApiKey') });
        break;
      case 'embedding_reset':
        await resetEmbeddingProvider(member);
        break;
      case 'embedding_test':
        // 不重定向：测试结果只在这次响应里展示
        return { embeddingTested: await testEmbeddingProvider(member) };
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
        return data({ error: '未知操作' }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof ModelProviderError) return data({ error: e.message }, { status: e.status });
    throw e;
  }
  throw redirect('/model-provider');
}

const SOURCE_LABEL = {
  tenant: '当前使用本租户的配置',
  platform: '当前使用平台默认的模型服务',
  none: '还没有可用的模型服务：平台没有配置默认，请在下面填写',
} as const;

const EMBEDDING_SOURCE_LABEL = {
  tenant: '当前使用本租户的 embedding 配置',
  platform: '当前使用平台默认的 embedding 端点',
  none: '还没有配置 embedding：不配置时目录检索只用关键词',
} as const;

/** 每档的名字与它管哪些用途（ADR-0055 的 PURPOSE_TIER 决定，页面只做说明） */
const TIER_LABEL: Record<'fast' | 'reasoning', { title: string; hint: string }> = {
  fast: { title: '快速档（fast）', hint: '断言草稿、工作台结果解读、一句话解析这类要快的用途' },
  reasoning: { title: '推理档（reasoning）', hint: 'AI 助手、起草映射、指标、标签这类要推理的用途' },
};

/** 「按用途选模型」卡片里的一档：当前绑定 + 换模型的表单。chatReady 是本租户的模型服务（chat 三项）是否已保存，没有时档位无从生效 */
function TierSection({ tier, state, chatReady, submitting }: {
  tier: 'fast' | 'reasoning';
  state: { model: string | null; baseUrl: string | null; apiKeySet: boolean };
  chatReady: boolean;
  submitting: boolean;
}) {
  const label = TIER_LABEL[tier];
  const bound = Boolean(state.model);
  return (
    <div className="space-y-3 border-t pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">{label.title}</h3>
          <p className="text-sm text-slate-500" {...{ [`data-tier-${tier}`]: bound ? 'tenant' : 'default' }}>
            {bound ? `模型 ${state.model}，${state.baseUrl ? `端点 ${state.baseUrl}` : '端点沿用本租户默认'}` : '使用默认'}
          </p>
          <p className="text-sm text-slate-400">{label.hint}</p>
        </div>
        {bound && (
          <Form
            method="post"
            onSubmit={e => { if (!confirm(`确定恢复${label.title}的默认？将清空该档的模型、端点与 API Key。`)) e.preventDefault(); }}
          >
            <input type="hidden" name="intent" value="tier_reset" />
            <input type="hidden" name="tier" value={tier} />
            <Button type="submit" variant="destructive" disabled={submitting}>恢复默认</Button>
          </Form>
        )}
      </div>
      {/* 输入框是非受控的：保存 / 恢复默认后 loader 给的是新值，但已挂载的输入框不会跟着 defaultValue 刷新。key 只用已保存值拼，值一变表单重挂载显示新值；提交失败（400）时这些值不变，用户改到一半的内容不会丢 */}
      <Form method="post" key={`${state.model ?? ''}|${state.baseUrl ?? ''}|${state.apiKeySet}`}>
        <input type="hidden" name="intent" value="tier_save" />
        <input type="hidden" name="tier" value={tier} />
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${tier}-model`}>模型名</FieldLabel>
            <Input id={`${tier}-model`} name="model" required defaultValue={state.model ?? ''} placeholder="如：qwen-max" />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${tier}-base-url`}>端点</FieldLabel>
            <Input id={`${tier}-base-url`} name="baseUrl" defaultValue={state.baseUrl ?? ''} placeholder="留空沿用本租户的端点与 Key" />
            <FieldDescription>只换模型名时留空；填写后平台请求「端点/chat/completions」。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${tier}-api-key`}>API Key</FieldLabel>
            <Input
              id={`${tier}-api-key`}
              name="apiKey"
              type="password"
              autoComplete="off"
              placeholder={state.apiKeySet ? '已设置，留空不修改' : '端点留空时不需要'}
            />
            {state.apiKeySet && <FieldDescription>改了端点须重新填写，原来的 Key 不会发给新的端点。</FieldDescription>}
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={submitting || !chatReady}>保存</Button>
            {!chatReady && <span className="text-sm text-slate-400">先保存本租户的模型服务后档位才生效</span>}
          </div>
        </FieldGroup>
      </Form>
    </div>
  );
}

export default function ModelProvider({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, provider, sampleRows } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  // 三个成员的联合会被 TS 规范化成带交叉可选属性的形状（tested?: undefined），in 之后属性仍可能 undefined，先收进局部再判空
  const tested = actionData && 'tested' in actionData ? actionData.tested : null;
  const embeddingTested = actionData && 'embeddingTested' in actionData ? actionData.embeddingTested : null;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title="模型服务"
        description="起草映射等设计时功能会调用 OpenAI 兼容的模型服务。填写本租户的端点后整套改用本租户的配置，否则使用平台默认。"
      />

      {actionData && 'error' in actionData && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {tested && (tested.ok ? (
        <Alert role="status" data-connectivity="ok">
          <CheckCircle2 className="text-emerald-600" />
          <AlertTitle>连通成功</AlertTitle>
          <AlertDescription className="space-y-1">
            <div data-model={tested.model} data-duration-ms={tested.durationMs}>
              模型 {tested.model}，耗时 {tested.durationMs} ms
            </div>
            {tested.tools ? (
              <div data-tools="yes" className="flex items-center gap-1 text-emerald-600">
                <CheckCircle2 className="size-4" />支持工具调用
              </div>
            ) : tested.tools === false ? (
              <div data-tools="no" className="flex items-center gap-1 text-amber-600">
                <AlertTriangle className="size-4" />该模型服务不支持工具调用，AI 助手无法使用
              </div>
            ) : (
              <div data-tools="unknown" className="flex items-center gap-1 text-muted-foreground">
                <AlertTriangle className="size-4" />这次没能确认是否支持工具调用（模型没有调用探测工具，或服务暂时不可用），可以再测一次
              </div>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive" role="alert" data-connectivity="failed">
          <CircleAlert />
          <AlertTitle>连通失败</AlertTitle>
          <AlertDescription>{tested.error}</AlertDescription>
        </Alert>
      ))}

      {embeddingTested && (embeddingTested.ok ? (
        <Alert role="status" data-embedding-test="ok">
          <CheckCircle2 className="text-emerald-600" />
          <AlertTitle>连通成功</AlertTitle>
          <AlertDescription>
            <div
              data-embedding-model={embeddingTested.model}
              data-embedding-dimensions={embeddingTested.dimensions}
              data-embedding-duration-ms={embeddingTested.durationMs}
            >
              模型 {embeddingTested.model}，维度 {embeddingTested.dimensions}，耗时 {embeddingTested.durationMs} ms
            </div>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive" role="alert" data-embedding-test="failed">
          <CircleAlert />
          <AlertTitle>连通失败</AlertTitle>
          <AlertDescription>{embeddingTested.error}</AlertDescription>
        </Alert>
      ))}

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="当前配置">
          <span data-provider-source={provider.source}>{SOURCE_LABEL[provider.source]}</span>
        </SectionHeader>
        <div className="flex flex-wrap gap-2">
          <Form method="post">
            <input type="hidden" name="intent" value="test" />
            <Button type="submit" variant="outline" disabled={submitting || provider.source === 'none'}>测试连通性</Button>
          </Form>
          {provider.source === 'tenant' && (
            <Form
              method="post"
              onSubmit={e => { if (!confirm('确定恢复平台默认？将清空本租户填写的端点、模型名与 API Key。')) e.preventDefault(); }}
            >
              <input type="hidden" name="intent" value="reset" />
              <Button type="submit" variant="destructive" disabled={submitting}>恢复平台默认</Button>
            </Form>
          )}
        </div>
      </div>

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="本租户的模型服务">API Key 加密保存，保存后不再显示。</SectionHeader>
        {/* 同档位表单：非受控输入框不跟着新 defaultValue 刷新，恢复平台默认后靠 key 重挂载回服务端新值 */}
        <Form method="post" key={`${provider.baseUrl ?? ''}|${provider.model ?? ''}|${provider.apiKeySet}`}>
          <input type="hidden" name="intent" value="save" />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="model-base-url">端点</FieldLabel>
              <Input id="model-base-url" name="baseUrl" required defaultValue={provider.baseUrl ?? ''} placeholder="https://api.openai.com/v1" />
              <FieldDescription>平台会请求「端点/chat/completions」。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="model-name">模型名</FieldLabel>
              <Input id="model-name" name="model" required defaultValue={provider.model ?? ''} placeholder="如：gpt-4o-mini" />
            </Field>
            <Field>
              <FieldLabel htmlFor="model-api-key">API Key</FieldLabel>
              <Input
                id="model-api-key"
                name="apiKey"
                type="password"
                autoComplete="off"
                required={!provider.apiKeySet}
                placeholder={provider.apiKeySet ? '已设置，留空不修改' : '未设置'}
              />
              {provider.apiKeySet && <FieldDescription>改了端点须重新填写，原来的 Key 不会发给新的端点。</FieldDescription>}
            </Field>
            <div>
              <Button type="submit" disabled={submitting}>保存</Button>
            </div>
          </FieldGroup>
        </Form>
      </div>

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="向量检索（可选）">
          <span data-embedding-source={provider.embedding.source}>{EMBEDDING_SOURCE_LABEL[provider.embedding.source]}</span>
        </SectionHeader>
        <div className="flex flex-wrap gap-2">
          <Form method="post">
            <input type="hidden" name="intent" value="embedding_test" />
            <Button type="submit" variant="outline" disabled={submitting || provider.embedding.source === 'none'}>测试 embedding</Button>
          </Form>
          {provider.embedding.source === 'tenant' && (
            <Form
              method="post"
              onSubmit={e => { if (!confirm('确定恢复平台默认？将清空本租户填写的 embedding 端点、模型名与 API Key。')) e.preventDefault(); }}
            >
              <input type="hidden" name="intent" value="embedding_reset" />
              <Button type="submit" variant="destructive" disabled={submitting}>恢复平台默认</Button>
            </Form>
          )}
        </div>
        {/* 同上：恢复平台默认后靠 key 重挂载，输入框回服务端新值 */}
        <Form method="post" key={`${provider.embedding.baseUrl ?? ''}|${provider.embedding.model ?? ''}|${provider.embedding.apiKeySet}`}>
          <input type="hidden" name="intent" value="embedding_save" />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="embedding-base-url">端点</FieldLabel>
              <Input id="embedding-base-url" name="embeddingBaseUrl" required defaultValue={provider.embedding.baseUrl ?? ''} placeholder="https://api.openai.com/v1" />
              <FieldDescription>平台会请求「端点/embeddings」，配置后语义检索把文字转成向量比对。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="embedding-model">模型名</FieldLabel>
              <Input id="embedding-model" name="embeddingModel" required defaultValue={provider.embedding.model ?? ''} placeholder="如：text-embedding-v3" />
            </Field>
            <Field>
              <FieldLabel htmlFor="embedding-api-key">API Key</FieldLabel>
              <Input
                id="embedding-api-key"
                name="embeddingApiKey"
                type="password"
                autoComplete="off"
                required={!provider.embedding.apiKeySet}
                placeholder={provider.embedding.apiKeySet ? '已设置，留空不修改' : '未设置'}
              />
              {provider.embedding.apiKeySet && <FieldDescription>改了端点须重新填写，原来的 Key 不会发给新的端点。</FieldDescription>}
            </Field>
            <div>
              <Button type="submit" disabled={submitting}>保存</Button>
            </div>
          </FieldGroup>
        </Form>
      </div>

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="按用途选模型">
          {provider.source === 'tenant'
            ? '两档可各自换模型；端点留空时沿用本租户的端点与 Key。'
            : '先保存本租户的模型服务后档位才生效。'}
        </SectionHeader>
        <TierSection tier="fast" state={provider.tiers.fast} chatReady={provider.source === 'tenant'} submitting={submitting} />
        <TierSection tier="reasoning" state={provider.tiers.reasoning} chatReady={provider.source === 'tenant'} submitting={submitting} />
      </div>

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="发送脱敏样本">默认只把表结构与列统计发给模型服务。</SectionHeader>
        <Form method="post">
          <input type="hidden" name="intent" value="samples" />
          <FieldGroup>
            <Field orientation="horizontal">
              <input type="checkbox" id="model-allow-samples" name="allowSamples" defaultChecked={provider.allowSamples} className="size-4" />
              <FieldLabel htmlFor="model-allow-samples">发送脱敏样本</FieldLabel>
            </Field>
            <FieldDescription>打开后会把每张表最新 {sampleRows} 行发给模型服务，像手机号、邮箱、姓名的列先换成哈希。</FieldDescription>
            <div>
              <Button type="submit" variant="outline" disabled={submitting}>保存</Button>
            </div>
          </FieldGroup>
        </Form>
      </div>
    </AppShell>
  );
}
