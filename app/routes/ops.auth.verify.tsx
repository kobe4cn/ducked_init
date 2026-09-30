// app/routes/ops.auth.verify.tsx —— 打开运营后台的 Magic Link 后确认登录，随后进入 TOTP 验证
import { Form, Link, redirect, useNavigation } from 'react-router';
import { CircleAlert } from 'lucide-react';
import type { Route } from './+types/ops.auth.verify';
import { consumeOperatorMagicLink } from '~/.server/ops-auth';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';

export function meta({}: Route.MetaArgs) {
  return [{ title: '确认登录 · 运营后台' }];
}

// 与成员登录一样：GET 只展示确认按钮，POST 才消费令牌，避免邮件网关预取链接时把一次性令牌用掉
export async function loader({ request }: Route.LoaderArgs) {
  return { hasToken: !!new URL(request.url).searchParams.get('token') };
}

export async function action({ request }: Route.ActionArgs) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const headers = await consumeOperatorMagicLink(token);
  if (!headers) return { error: '登录链接无效、已过期或已被使用，请重新申请。' };
  throw redirect('/ops/totp', { headers });
}

export default function OpsVerify({ loaderData, actionData }: Route.ComponentProps) {
  const error = actionData?.error ?? (loaderData.hasToken ? null : '登录链接无效，请重新申请。');
  const submitting = useNavigation().state === 'submitting';
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">确认登录运营后台</CardTitle>
          <CardDescription>登录链接只能使用一次，确认后需要输入 TOTP 验证码。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <>
              <Alert variant="destructive" role="alert">
                <CircleAlert />
                <AlertTitle>无法登录</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
              <Button variant="outline" asChild>
                <Link to="/ops/login">重新申请登录链接</Link>
              </Button>
            </>
          ) : (
            <Form method="post">
              <Button type="submit" className="w-full" disabled={submitting}>{submitting ? '确认中…' : '继续'}</Button>
            </Form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
