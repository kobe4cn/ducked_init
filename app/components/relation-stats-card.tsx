// app/components/relation-stats-card.tsx —— 实体页的「已发布关系」（ADR-0019，单条统计的显示 StatLine 数据地图也用）：本实体相关的每条已发布关系在最近一次合并后的孤儿比例
// （起点有值、在终点主键里找不到的行占起点有值行数的比例）与样例键；起点敏感时标准层里是哈希，不给样例键（ADR-0005）
import { StatusText } from '~/components/status-text';
import { type RelationStat, relationText } from '~/lib/canonical-model';
import { cn } from '~/lib/utils';

/** 孤儿比例，保留一位小数；起点没有有值行时为 0% */
export const percent = (orphans: number, withValue: number) => `${withValue ? Number(((orphans / withValue) * 100).toFixed(1)) : 0}%`;

/** 一条关系的统计：尚未合并、统计失败（标红），或孤儿比例（有孤儿标红）与样例键 */
export function StatLine({ stat }: { stat: RelationStat }) {
  if ('status' in stat) return <StatusText tone="none">尚未合并</StatusText>;
  if ('error' in stat) return <StatusText tone="bad">{`统计失败：${stat.error}`}</StatusText>;
  const { withValue, orphans, samples } = stat;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusText tone={orphans ? 'bad' : 'ok'} data-orphans={orphans}>{`孤儿 ${percent(orphans, withValue)}（${orphans} / ${withValue} 行）`}</StatusText>
      {samples.length > 0 && <span className="text-sm text-slate-500" data-samples>{'样例键：'}<span className="font-mono">{samples.join('、')}</span></span>}
    </div>
  );
}

export function RelationStatsCard({ relations, at }: { relations: RelationStat[]; at: string | null }) {
  const bad = relations.some(r => 'error' in r || ('orphans' in r && r.orphans > 0));
  return (
    <div className={cn('space-y-4 rounded-2xl border bg-white p-6 shadow-sm', bad && 'border-red-200')} data-relation-stats>
      <div className="space-y-1">
        <h2 className="font-semibold">已发布关系</h2>
        <p className="max-w-2xl text-sm text-slate-500">
          {`孤儿：起点有值、在终点主键里找不到的行。${at ? `统计于最近一次合并（${new Date(at).toLocaleString('zh-CN')}）。` : ''}敏感字段在标准层里是哈希，不给样例键。`}
        </p>
      </div>
      <ul className="divide-y">
        {relations.map(r => {
          const text = relationText(r);
          return (
            <li key={text} className="flex flex-wrap items-center justify-between gap-4 py-3" data-relation-stat={text}>
              <span className="font-mono text-sm">{text}</span>
              <StatLine stat={r} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
