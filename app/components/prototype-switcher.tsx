// app/components/prototype-switcher.tsx —— PROTOTYPE（一次性，不进 main）：页面底部的视觉方向切换条，←/→ 或方向键切换 ?variant=，生产构建不显示
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export const VARIANTS = [
  { key: 'A', name: '控制台：侧边栏 + 紧凑表格' },
  { key: 'B', name: '概览：指标卡 + 卡片' },
  { key: 'C', name: '工作台：主从分栏' },
  { key: 'O', name: '现状' },
] as const;
export type VariantKey = (typeof VARIANTS)[number]['key'];

export function useVariant(): VariantKey {
  const [params] = useSearchParams();
  const v = params.get('variant');
  return (VARIANTS.find(x => x.key === v)?.key ?? 'A') as VariantKey;
}

export function PrototypeSwitcher() {
  const current = useVariant();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const i = VARIANTS.findIndex(v => v.key === current);
  const go = (step: number) => {
    const next = new URLSearchParams(params);
    next.set('variant', VARIANTS[(i + step + VARIANTS.length) % VARIANTS.length].key);
    navigate({ search: next.toString() }, { replace: true, preventScrollReset: true });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (import.meta.env.PROD) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black px-2 py-1.5 text-sm text-white shadow-2xl ring-4 ring-yellow-400">
      <button type="button" onClick={() => go(-1)} className="rounded-full p-1 hover:bg-white/20" aria-label="上一个方向"><ChevronLeft className="size-4" /></button>
      <span className="min-w-56 text-center">{`${current}（${VARIANTS[i].name}）`}</span>
      <button type="button" onClick={() => go(1)} className="rounded-full p-1 hover:bg-white/20" aria-label="下一个方向"><ChevronRight className="size-4" /></button>
    </div>
  );
}
