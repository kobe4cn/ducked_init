// app/routes/model-provider.tsx —— 模型服务（仅管理员）：看当前用平台默认还是本租户配置；保存端点、模型名与 API Key（Key 不回显，留空沿用）、
// 恢复平台默认、测试连通性
import { data, Form, redirect, useNavigation } from 'react-router';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import type { Route } from './+types/model-provider';
import { requirePermission } from '~/.server/access';
import { getModelProvider, ModelProviderError, resetModelProvider, saveModelProvider, testModelProvider } from '~/.server/model-provider';
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
  return { email: member.email, nav: navFor(member), provider: await getModelProvider(member) };
}

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'model_provider:manage');
  const form = await request.formData();
  const field = (name: string) => String(form.get(name) ?? '');
  try {
    switch (field('intent')) {
      case 'save':
        await saveModelProvider(member, { baseUrl: field('baseUrl'), model: field('model'), apiKey: field('apiKey') });
        break;
      case 'reset':
        await resetModelProvider(member);
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

export default function ModelProvider({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav, provider } = loaderData;
  const submitting = useNavigation().state === 'submitting';
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

      {actionData && 'tested' in actionData && (actionData.tested.ok ? (
        <Alert role="status" data-connectivity="ok">
          <CheckCircle2 className="text-emerald-600" />
          <AlertTitle>连通成功</AlertTitle>
          <AlertDescription data-model={actionData.tested.model} data-duration-ms={actionData.tested.durationMs}>
            模型 {actionData.tested.model}，耗时 {actionData.tested.durationMs} ms
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive" role="alert" data-connectivity="failed">
          <CircleAlert />
          <AlertTitle>连通失败</AlertTitle>
          <AlertDescription>{actionData.tested.error}</AlertDescription>
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
        <Form method="post">
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
    </AppShell>
  );
}
