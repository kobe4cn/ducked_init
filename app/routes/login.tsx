// app/routes/login.tsx —— 登录页：申请 Magic Link（仅限已登记邮箱，不开放注册）
import { data, Form, redirect, useNavigation } from 'react-router';
import { MailCheck } from 'lucide-react';
import type { Route } from './+types/login';
import { formatServer } from '~/.server/i18n';
import { getCurrentMember, requestMagicLink } from '~/.server/auth';
import { getLocale } from '~/.server/locale';
import { makeT, msg, useT } from '~/lib/i18n';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { LocaleSwitch } from '~/components/locale-switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';

export function meta({ matches }: Route.MetaArgs) {
  // RR8 的 MetaMatch 把 loader 数据放在 loaderData 字段（没有 data）；root 出错时为空，回退中文
  const root = matches[0]?.loaderData;
  const t = makeT(root?.locale ?? 'zh-CN', root?.messages ?? null);
  return [{ title: t('登录 · CRM 数据分析平台') }];
}

export async function loader({ request }: Route.LoaderArgs) {
  if (await getCurrentMember(request)) throw redirect('/');
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const email = String((await request.formData()).get('email') ?? '');
  const result = await requestMagicLink(email, new URL(request.url).origin);
  if (!result.ok) {
    const minutes = Math.ceil(result.retryAfterSeconds / 60);
    return data(
      { sent: false, error: formatServer(await getLocale(request), msg('申请过于频繁，请 {minutes} 分钟后再试。', { minutes })) },
      { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } },
    );
  }
  // 无论邮箱是否已登记都给出同样的答复，避免被用来探测成员邮箱
  return { sent: true, error: null };
}

export default function Login({ actionData }: Route.ComponentProps) {
  const t = useT();
  const submitting = useNavigation().state === 'submitting';
  return (
    <main className="relative flex min-h-svh items-center justify-center bg-muted p-6">
      <div className="absolute right-6 top-6"><LocaleSwitch /></div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t('登录 CRM 数据分析平台')}</CardTitle>
          <CardDescription>{t('输入受邀邮箱，我们会发送一次性登录链接。')}</CardDescription>
        </CardHeader>
        <CardContent>
          {actionData?.sent ? (
            <Alert>
              <MailCheck />
              <AlertTitle>{t('请查收邮件')}</AlertTitle>
              <AlertDescription>{t('如果该邮箱已被邀请加入平台，你会收到一封含登录链接的邮件。')}</AlertDescription>
            </Alert>
          ) : (
            <Form method="post">
              <FieldGroup>
                <Field data-invalid={!!actionData?.error}>
                  <FieldLabel htmlFor="email">{t('工作邮箱')}</FieldLabel>
                  <Input id="email" type="email" name="email" required autoComplete="email" placeholder="name@company.com" aria-invalid={!!actionData?.error} />
                  {actionData?.error && <FieldError role="alert">{actionData.error}</FieldError>}
                </Field>
                <Field>
                  <Button type="submit" disabled={submitting}>{submitting ? t('发送中…') : t('发送登录链接')}</Button>
                  <FieldDescription className="text-center">{t('平台仅限受邀成员使用，不开放注册。')}</FieldDescription>
                </Field>
              </FieldGroup>
            </Form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
