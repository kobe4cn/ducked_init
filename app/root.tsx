// app/root.tsx —— 页面外壳与全局错误边界
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';

import type { Route } from './+types/root';
import './app.css';

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
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
