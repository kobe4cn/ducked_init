// app/routes/auth.verify.tsx —— 打开 Magic Link 后确认登录。页面文字接入双语（#1047）：这是未登录页，
// getLocale 没有账号时读 crm_locale cookie，root 对未登录页也下发词典（照 login.tsx）
import { Form, Link, redirect, useNavigation } from 'react-router';
import { CircleAlert } from 'lucide-react';
import type { Route } from './+types/auth.verify';
import { consumeMagicLink } from '~/.server/auth';
import { formatServer } from '~/.server/i18n';
import { getLocale } from '~/.server/locale';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { makeT, msg, useT } from '~/lib/i18n';

export function meta({ matches }: Route.MetaArgs) {
  // RR8 的 MetaMatch 把 loader 数据放在 loaderData 字段（没有 data）；root 出错时为空，回退中文
  const root = matches[0]?.loaderData;
  const t = makeT(root?.locale ?? 'zh-CN', root?.messages ?? null);
  return [{ title: t('确认登录 · CRM 数据分析平台') }];
}

// 打开链接（GET）只展示确认按钮，真正消费令牌放在 POST：避免邮件网关预取链接时把一次性令牌用掉
export async function loader({ request }: Route.LoaderArgs) {
  return { hasToken: !!new URL(request.url).searchParams.get('token') };
}

export async function action({ request }: Route.ActionArgs) {
  const token = new URL(request.url).searchParams.get('token') ?? '';
  const setCookie = await consumeMagicLink(token);
  // 这里不是 catch 点（没有可格式化的业务错误），直接按请求语言格式化一句报错
  if (!setCookie) return { error: formatServer(await getLocale(request), msg('登录链接无效、已过期或已被使用，请重新申请。')) };
  throw redirect('/', { headers: { 'Set-Cookie': setCookie } });
}

export default function Verify({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const error = actionData?.error ?? (loaderData.hasToken ? null : t('登录链接无效，请重新申请。'));
  const submitting = useNavigation().state === 'submitting';
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t('确认登录')}</CardTitle>
          <CardDescription>{t('登录链接只能使用一次。')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <>
              <Alert variant="destructive" role="alert">
                <CircleAlert />
                <AlertTitle>{t('无法登录')}</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
              <Button variant="outline" asChild>
                <Link to="/login">{t('重新申请登录链接')}</Link>
              </Button>
            </>
          ) : (
            <Form method="post">
              <Button type="submit" className="w-full" disabled={submitting}>{submitting ? t('登录中…') : t('登录')}</Button>
            </Form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
