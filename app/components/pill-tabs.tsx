// app/components/pill-tabs.tsx —— 胶囊标签页：每一项是链接，当前标签放在 URL（?tab=）里，页面在服务端按标签渲染
import { Link } from 'react-router';
import { cn } from '~/lib/utils';

export function PillTabs<K extends string>({ tabs, current }: {
  tabs: { key: K; label: React.ReactNode; href: string }[];
  current: K;
}) {
  return (
    <nav className="flex gap-1 self-start rounded-full bg-slate-200/60 p-1">
      {tabs.map(t => (
        <Link
          key={t.key}
          to={t.href}
          data-tab={t.key}
          aria-current={t.key === current ? 'page' : undefined}
          className={cn('rounded-full px-4 py-1.5 text-sm text-slate-600 hover:text-slate-900', t.key === current && 'bg-white font-medium text-slate-900 shadow-sm')}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
