// app/components/lineage-drawer.tsx —— 数据地图的标准层表字段抽屉：固定在右侧，列出表的行数与每个字段的说明；
// 有明细时（sources:read）每个字段再列出各映射的源表、表达式与源列，标出敏感哈希、值字典、扩展字段与兜底，兜底的附上最近一次合并的兜底统计。
// 关闭是去掉 ?node= 的链接；有明细时带「聚焦此表」链接，进入单表聚焦画布。
// 源表抽屉（TableDrawer，只给 sources:read）按源列列出它影响的标准层字段、映射与表达式
import { Link } from 'react-router';
import { AlertTriangle, ArrowRight, BookOpen, Focus, Lock, Puzzle, X } from 'lucide-react';
import { fallbackText } from '~/lib/fallback';
import type { FieldDrawer, FieldSource } from '~/lib/lineage-fields';
import type { TableImpact } from '~/lib/lineage-search';
import { Badge } from '~/components/ui/badge';

const ASIDE = 'fixed inset-y-0 right-0 z-50 w-[28rem] max-w-full overflow-y-auto rounded-l-2xl border bg-white shadow-xl';

/** focusHref：单表聚焦画布的链接，没有 sources:read 时为 null */
export function LineageDrawer({ drawer, closeHref, focusHref }: { drawer: FieldDrawer; closeHref: string; focusHref: string | null }) {
  return (
    <aside data-drawer={drawer.entity} aria-label={`silver.${drawer.entity} 的字段`} className={ASIDE}>
      <div className="sticky top-0 flex items-start justify-between gap-4 border-b bg-white px-6 py-4">
        <div>
          <h2 className="font-mono text-sm font-semibold">{`silver.${drawer.entity}`}</h2>
          <p className="mt-1 text-sm text-slate-500">
            {drawer.label !== drawer.entity && <span className="mr-3">{drawer.label}</span>}
            <span data-drawer-rows={drawer.rows}>{`${drawer.rows.toLocaleString('zh-CN')} 行`}</span>
          </p>
          {focusHref && (
            <Link to={focusHref} className="mt-2 inline-flex items-center gap-1 text-xs text-slate-600 hover:underline">
              <Focus className="size-3" />聚焦此表
            </Link>
          )}
        </div>
        <Close href={closeHref} />
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

/** 源表抽屉：这张源表每个被引用的列影响了哪些标准层字段 */
export function TableDrawer({ impact, closeHref }: { impact: TableImpact; closeHref: string }) {
  return (
    <aside data-table-drawer={`${impact.sourceId}:${impact.table}`} aria-label={`${impact.table} 影响的字段`} className={ASIDE}>
      <div className="sticky top-0 flex items-start justify-between gap-4 border-b bg-white px-6 py-4">
        <div>
          <h2 className="font-mono text-sm font-semibold">{impact.table}</h2>
          <p className="mt-1 text-sm text-slate-500">{`${impact.sourceName} · ${impact.columns.length} 个被引用的列`}</p>
        </div>
        <Close href={closeHref} />
      </div>
      <ul className="divide-y px-6">
        {impact.columns.map(({ column, fields }) => (
          <li key={column} data-column={column} className="space-y-2 py-4">
            <div className="font-mono text-xs font-semibold">{column}</div>
            {fields.map(f => (
              <div key={`${f.mapping}:${f.field}`} data-impact={`${column}→${f.entity}.${f.field}`} className="space-y-1.5 rounded-xl bg-slate-50 p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1 font-mono text-slate-900"><ArrowRight className="size-3 text-slate-400" />{`${f.entity}.${f.field}`}</span>
                  <Link to={`/mappings/${f.mapping}`} className="text-slate-500 hover:underline">{`映射 v${f.version}`}</Link>
                </div>
                <code className="block break-all font-mono text-slate-700">{f.expr}</code>
              </div>
            ))}
          </li>
        ))}
      </ul>
      {impact.columns.length === 0 && <p className="px-6 py-4 text-sm text-slate-500">已发布的映射没有引用这张表的列。</p>}
    </aside>
  );
}

function Close({ href }: { href: string }) {
  return (
    <Link to={href} preventScrollReset aria-label="关闭" className="rounded-lg p-1 text-slate-500 hover:bg-slate-100">
      <X className="size-4" />
    </Link>
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
