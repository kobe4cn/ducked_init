// app/root.tsx —— 页面外壳与全局错误边界
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from 'react-router';

import type { Route } from './+types/root';
import { getLocale } from '~/.server/locale';
import { I18nProvider, makeT } from '~/lib/i18n';
import enClient from './i18n/en.client.json';
import './app.css';

// 界面语言与前端词典都由这里下发（ADR-0060）：中文界面不下发词典，英文界面下发 en.client.json，
// SSR 与 hydration 用同一份数据，英文界面不会先闪一下中文
export async function loader({ request }: Route.LoaderArgs) {
  const locale = await getLocale(request);
  return { locale, messages: locale === 'en' ? enClient : null };
}

// 词典只在语言变化时才变（语言来源是 cookie，请求间不会变），导航不必重新下发
export const shouldRevalidate = () => false;

export function Layout({ children }: { children: React.ReactNode }) {
  // ErrorBoundary 场景下 loader 数据为空，回退中文
  const data = useRouteLoaderData<typeof loader>('root');
  const locale = data?.locale ?? 'zh-CN';
  const messages = data?.messages ?? null;
  return (
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <I18nProvider t={makeT(locale, messages)} locale={locale}>{children}</I18nProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = '出错了';
  let details = '发生了意外错误。';
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      message = '404';
      details = '页面不存在。';
    } else if (error.status === 403) {
      message = '无权访问';
      // 服务端入口给出的说明（如“仅管理员可以……”）
      details = typeof error.data?.message === 'string' ? error.data.message : '当前角色无权进行此操作。';
    } else {
      details = error.statusText || details;
    }
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="container mx-auto flex flex-col gap-2 p-4 pt-16">
      <h1 className="text-xl font-semibold">{message}</h1>
      <p className="text-muted-foreground">{details}</p>
      {isRouteErrorResponse(error) && error.status === 403 && (
        <a href="/" className="text-sm underline underline-offset-4">返回首页</a>
      )}
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
