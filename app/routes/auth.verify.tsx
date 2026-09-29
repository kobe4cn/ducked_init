// app/routes/auth.verify.tsx —— 打开 Magic Link 后确认登录
import { Form, redirect } from 'react-router';
import type { Route } from './+types/auth.verify';
import { consumeMagicLink } from '~/.server/auth';

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
  return (
    <main className="container mx-auto max-w-sm p-8 space-y-4">
      <h1 className="text-2xl font-semibold">确认登录</h1>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <a href="/login" className="underline">重新申请登录链接</a>
        </>
      ) : (
        <Form method="post">
          <button type="submit" className="w-full rounded bg-black text-white py-2">登录</button>
        </Form>
      )}
    </main>
  );
}
