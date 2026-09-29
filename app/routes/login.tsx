// app/routes/login.tsx —— 登录页：申请 Magic Link（仅限已登记邮箱，不开放注册）
import { data, Form, redirect, useNavigation } from 'react-router';
import { MailCheck } from 'lucide-react';
import type { Route } from './+types/login';
import { getCurrentMember, requestMagicLink } from '~/.server/auth';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';

export function meta({}: Route.MetaArgs) {
  return [{ title: '登录 · CRM 数据分析平台' }];
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
      { sent: false, error: `申请过于频繁，请 ${minutes} 分钟后再试。` },
      { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } },
    );
  }
  // 无论邮箱是否已登记都给出同样的答复，避免被用来探测成员邮箱
  return { sent: true, error: null };
}

export default function Login({ actionData }: Route.ComponentProps) {
  const submitting = useNavigation().state === 'submitting';
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">登录 CRM 数据分析平台</CardTitle>
          <CardDescription>输入受邀邮箱，我们会发送一次性登录链接。</CardDescription>
        </CardHeader>
        <CardContent>
          {actionData?.sent ? (
            <Alert>
              <MailCheck />
              <AlertTitle>请查收邮件</AlertTitle>
              <AlertDescription>如果该邮箱已被邀请加入平台，你会收到一封含登录链接的邮件。</AlertDescription>
            </Alert>
          ) : (
            <Form method="post">
              <FieldGroup>
                <Field data-invalid={!!actionData?.error}>
                  <FieldLabel htmlFor="email">工作邮箱</FieldLabel>
                  <Input id="email" type="email" name="email" required autoComplete="email" placeholder="name@company.com" aria-invalid={!!actionData?.error} />
                  {actionData?.error && <FieldError role="alert">{actionData.error}</FieldError>}
                </Field>
                <Field>
                  <Button type="submit" disabled={submitting}>{submitting ? '发送中…' : '发送登录链接'}</Button>
                  <FieldDescription className="text-center">平台仅限受邀成员使用，不开放注册。</FieldDescription>
                </Field>
              </FieldGroup>
            </Form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
