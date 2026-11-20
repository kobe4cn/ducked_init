// app/components/locale-switch.tsx —— 界面语言切换入口（ADR-0060，#946）：顶栏（头像旁）与登录页右上角共用。
// <details>/<summary> 下拉照 app-shell 导航分组的写法（不用 JS，路径变化后重新挂载为收起）；
// 选项整页提交到 POST /locale（<Form reloadDocument>：root 的 shouldRevalidate 恒为 false，客户端导航不会重跑 root loader）
import { Form, useLocation, useRouteLoaderData } from 'react-router';
import { Check, Languages } from 'lucide-react';
import { cn } from '~/lib/utils';
import { useLocale, useT, type Locale } from '~/lib/i18n';
import type { loader as rootLoader } from '~/root';

export function LocaleSwitch() {
  // 开关状态由 root loader 下发；ErrorBoundary 场景 loader 数据为空，不渲染入口
  const enabled = useRouteLoaderData<typeof rootLoader>('root')?.localeSwitch;
  const t = useT();
  const current = useLocale();
  const { pathname, search } = useLocation();
  if (!enabled) return null;
  // 语言名用各自语言显示：中文走 t()（英文界面也显示母语名），English 是字面量
  const options: { locale: Locale; label: string }[] = [
    { locale: 'zh-CN', label: t('中文') },
    { locale: 'en', label: 'English' },
  ];
  return (
    <details key={pathname} className="relative">
      <summary
        title={t('界面语言')}
        aria-label={t('界面语言')}
        className="flex cursor-pointer list-none items-center gap-1 rounded-full px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 [&::-webkit-details-marker]:hidden"
      >
        <Languages aria-hidden className="size-4" />
        {options.find(o => o.locale === current)?.label}
      </summary>
      <div className="absolute right-0 top-full z-50 mt-1 min-w-32 rounded-lg border bg-white p-1 shadow-lg">
        {options.map(({ locale, label }) => (
          <Form key={locale} reloadDocument method="post" action="/locale">
            <input type="hidden" name="locale" value={locale} />
            {/* 停留在当前页：路径和查询参数都带上（& 在 HTML 里转义成 &amp;） */}
            <input type="hidden" name="redirectTo" value={pathname + search} />
            <button
              type="submit"
              aria-current={locale === current ? 'true' : undefined}
              className={cn('flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-slate-600 hover:bg-slate-100', locale === current && 'font-medium text-slate-900')}
            >
              <Check aria-hidden className={cn('size-4 shrink-0', locale !== current && 'invisible')} />
              {label}
            </button>
          </Form>
        ))}
      </div>
    </details>
  );
}
