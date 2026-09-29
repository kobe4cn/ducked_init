// app/routes/auth.verify.tsx —— 打开 Magic Link 后确认登录
import { Form, Link, redirect, useNavigation } from 'react-router';
import { CircleAlert } from 'lucide-react';
import type { Route } from './+types/auth.verify';
import { consumeMagicLink } from '~/.server/auth';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';

export function meta({}: Route.MetaArgs) {
  return [{ title: '确认登录 · CRM 数据分析平台' }];
}

// 打开链接（GET）只展示确认按钮，真正消费令牌放在 POST：避免邮件网关预取链接时把一次性令牌用掉
export async function loader({ request }: Route.LoaderArgs) {
  return { hasToken: !!new URL(request.url).searchParams.get('token') };
}

export async function action({ request }: Route.ActionArgs) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const setCookie = await consumeMagicLink(token);
  if (!setCookie) return { error: '登录链接无效、已过期或已被使用，请重新申请。' };
  throw redirect('/', { headers: { 'Set-Cookie': setCookie } });
}

export default function Verify({ loaderData, actionData }: Route.ComponentProps) {
  const error = actionData?.error ?? (loaderData.hasToken ? null : '登录链接无效，请重新申请。');
  const submitting = useNavigation().state === 'submitting';
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">确认登录</CardTitle>
          <CardDescription>登录链接只能使用一次。</CardDescription>
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
                <Link to="/login">重新申请登录链接</Link>
              </Button>
            </>
          ) : (
            <Form method="post">
              <Button type="submit" className="w-full" disabled={submitting}>{submitting ? '登录中…' : '登录'}</Button>
            </Form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
