// app/routes/ops.login.tsx —— 运营后台登录页：申请 Magic Link（仅限运营命令创建的运营者），与成员登录页 /login 完全分开
import { data, Form, useNavigation } from 'react-router';
import { CircleAlert, MailCheck } from 'lucide-react';
import type { Route } from './+types/ops.login';
import { requestOperatorMagicLink } from '~/.server/ops-auth';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';

export function meta({}: Route.MetaArgs) {
  return [{ title: '运营后台登录 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return { locked: new URL(request.url).searchParams.get('reason') === 'totp_locked' };
}

export async function action({ request }: Route.ActionArgs) {
  const email = String((await request.formData()).get('email') ?? '');
  const result = await requestOperatorMagicLink(email, new URL(request.url).origin);
  if (!result.ok) {
    const minutes = Math.ceil(result.retryAfterSeconds / 60);
    return data(
      { sent: false, error: `申请过于频繁，请 ${minutes} 分钟后再试。` },
      { status: 429, headers: { 'Retry-After': String(result.retryAfterSeconds) } },
    );
  }
  // 无论邮箱是否属于运营者都给出同样的答复，避免被用来探测运营者邮箱
  return { sent: true, error: null };
}

export default function OpsLogin({ loaderData, actionData }: Route.ComponentProps) {
  const submitting = useNavigation().state === 'submitting';
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">登录运营后台</CardTitle>
          <CardDescription>输入运营者邮箱，我们会发送一次性登录链接；随后需要输入 TOTP 验证码。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {loaderData.locked && !actionData && (
            <Alert variant="destructive" role="alert">
              <CircleAlert />
              <AlertTitle>验证码错误次数过多</AlertTitle>
              <AlertDescription>本次登录已作废，请重新申请登录链接。</AlertDescription>
            </Alert>
          )}
          {actionData?.sent ? (
            <Alert>
              <MailCheck />
              <AlertTitle>请查收邮件</AlertTitle>
              <AlertDescription>如果该邮箱属于运营者，你会收到一封含登录链接的邮件。</AlertDescription>
            </Alert>
          ) : (
            <Form method="post">
              <FieldGroup>
                <Field data-invalid={!!actionData?.error}>
                  <FieldLabel htmlFor="email">运营者邮箱</FieldLabel>
                  <Input id="email" type="email" name="email" required autoComplete="email" aria-invalid={!!actionData?.error} />
                  {actionData?.error && <FieldError role="alert">{actionData.error}</FieldError>}
                </Field>
                <Field>
                  <Button type="submit" disabled={submitting}>{submitting ? '发送中…' : '发送登录链接'}</Button>
                  <FieldDescription className="text-center">运营者只能在服务器上用运营命令创建。</FieldDescription>
                </Field>
              </FieldGroup>
            </Form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
