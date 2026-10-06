// app/components/lineage-drawer.tsx —— 数据地图的标准层表字段抽屉：固定在右侧，列出表的行数与每个字段的说明；
// 有明细时（sources:read）每个字段再列出各映射的源表、表达式与源列，标出敏感哈希、值字典、扩展字段与兜底，兜底的附上最近一次合并的兜底统计。
// 关闭是去掉 ?node= 的链接
import { Link } from 'react-router';
import { AlertTriangle, BookOpen, Lock, Puzzle, X } from 'lucide-react';
import { fallbackText } from '~/lib/fallback';
import type { FieldDrawer, FieldSource } from '~/lib/lineage-fields';
import { Badge } from '~/components/ui/badge';

export function LineageDrawer({ drawer, closeHref }: { drawer: FieldDrawer; closeHref: string }) {
  return (
    <aside
      data-drawer={drawer.entity}
      aria-label={`silver.${drawer.entity} 的字段`}
      className="fixed inset-y-0 right-0 z-50 w-[28rem] max-w-full overflow-y-auto rounded-l-2xl border bg-white shadow-xl"
    >
      <div className="sticky top-0 flex items-start justify-between gap-4 border-b bg-white px-6 py-4">
        <div>
          <h2 className="font-mono text-sm font-semibold">{`silver.${drawer.entity}`}</h2>
          <p className="mt-1 text-sm text-slate-500">
            {drawer.label !== drawer.entity && <span className="mr-3">{drawer.label}</span>}
            <span data-drawer-rows={drawer.rows}>{`${drawer.rows.toLocaleString('zh-CN')} 行`}</span>
          </p>
        </div>
        <Link to={closeHref} preventScrollReset aria-label="关闭" className="rounded-lg p-1 text-slate-500 hover:bg-slate-100">
          <X className="size-4" />
        </Link>
      </div>
      <ul className="divide-y px-6">
        {drawer.fields.map(f => (
          <li key={f.name} data-field={f.name} className="space-y-2 py-4">
            <div>
              <span className="font-mono text-xs font-semibold">{f.name}</span>
              {f.label !== f.name && <span className="ml-2 text-sm">{f.label}</span>}
            </div>
            {f.description && <p className="text-xs text-slate-500">{f.description}</p>}
            {'sources' in f && f.sources.map(s => <Source key={s.mapping} source={s} />)}
          </li>
        ))}
      </ul>
      {drawer.fields.length === 0 && <p className="px-6 py-4 text-sm text-slate-500">已发布的映射还没有写入这张表的字段。</p>}
    </aside>
  );
}

/** 一个映射里这个字段从哪来 */
function Source({ source: s }: { source: FieldSource }) {
  return (
    <div data-field-mapping={s.mapping} className="space-y-1.5 rounded-xl bg-slate-50 p-3 text-xs">
      <div className="flex items-center justify-between gap-2 text-slate-500">
        <span>{`${s.sourceName} · `}<span className="font-mono">{s.table}</span></span>
        <span>{`v${s.version}`}</span>
      </div>
      <code className="block break-all font-mono text-slate-900">{s.expr}</code>
      {s.sourceColumns.length > 0 && (
        <div className="text-slate-500">源列：<span className="font-mono">{s.sourceColumns.join('、')}</span></div>
      )}
      {(s.sensitive || s.dictionary || s.extension || s.fallback) && (
        <div className="flex flex-wrap gap-1.5">
          {s.sensitive && <Badge variant="outline"><Lock />敏感哈希</Badge>}
          {s.dictionary && <Badge variant="outline"><BookOpen />值字典</Badge>}
          {s.extension && <Badge variant="outline"><Puzzle />扩展字段</Badge>}
          {s.fallback && <Badge variant="outline">{`兜底：${s.fallback.value ?? '空'}`}</Badge>}
        </div>
      )}
      {s.fallback?.stat && (
        <div data-fallback-rows={s.fallback.stat.rows} className="flex items-start gap-1 text-amber-600">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          {fallbackText('最近一次合并', s.fallback.stat)}
        </div>
      )}
    </div>
  );
}
