// app/components/draft-confidence.tsx —— 用模型生成映射草稿或建议断言后的「生成依据」（ADR-0035）：模型给的每项按置信度从低到高列出（路径、置信度、理由），
// 低于 0.5 标红、低于 0.8 琥珀色、其余绿色，颜色都配图标与文字；个别项不过校验被去掉时先单独列出「已去掉」的项（路径加原因，红色配图标），
// 这些项不进置信度表。复用已发布映射或按规则生成时只写来源（复用时链接到来源映射）。
// 只是展示，保存不依赖它；置信度来自模型，展示前夹到 0..1，理由是纯文本
import { AlertTriangle, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import { StatusText, type StatusTone } from '~/components/status-text';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { cmp } from '~/lib/compare';
import { useT, type T } from '~/lib/i18n';
import type { ModelDraftResult } from '~/.server/mappings';

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const levelOf = (c: number): { tone: StatusTone; level: 'low' | 'medium' | 'high' } =>
  c < 0.5 ? { tone: 'bad', level: 'low' } : c < 0.8 ? { tone: 'pending', level: 'medium' } : { tone: 'ok', level: 'high' };

/** 置信度档的文字（低 / 中 / 高 加百分比）：写成字面量 t('…') 才能与词典对账（同 api-keys 的 scopeLabel） */
const levelText = (t: T, level: 'low' | 'medium' | 'high', pct: number): string =>
  ({ low: t('低 {n}%', { n: pct }), medium: t('中 {n}%', { n: pct }), high: t('高 {n}%', { n: pct }) })[level];

export function DraftConfidence({ origin, items, reusedFrom, notice }: {
  origin: ModelDraftResult['origin'];
  items: ModelDraftResult['items'];
  /** 复用时来源映射的 ID */
  reusedFrom?: string | null;
  /** 如没配置模型服务、已按规则生成（服务端中文，随 #932 翻译；为空时用本组件的「按规则生成」） */
  notice?: string | null;
}) {
  const t = useT();
  const rows = items
    .filter(i => !i.dropped)
    .map(i => ({ ...i, confidence: clamp(i.confidence) }))
    .sort((a, b) => a.confidence - b.confidence || cmp(a.path, b.path));
  const dropped = items.filter(i => i.dropped);
  return (
    <div data-draft-origin={origin} className="space-y-2 rounded-xl border bg-slate-50/60 p-4">
      <div className="flex items-center gap-1.5 text-sm font-medium"><Sparkles aria-hidden className="size-4 text-slate-400" />{t('生成依据')}</div>
      {origin === 'reuse' && (
        <p className="text-sm text-slate-500">
          {t('源表结构与已发布映射一致，直接复用')}{reusedFrom ? <>{t('了')}<Link to={`/mappings/${reusedFrom}`} className="underline">{t('那个映射')}</Link></> : null}{t('，没有调用模型。')}
        </p>
      )}
      {origin === 'rules' && <p data-notice className="flex items-center gap-1.5 text-sm text-amber-600"><AlertTriangle aria-hidden className="size-4" />{notice ?? t('按规则生成')}</p>}
      {(origin === 'model' || origin === 'assertions') && (
        <>
          {dropped.length > 0 && (
            <div className="space-y-1">
              <p className="text-sm text-slate-500">{t('这些项没有通过校验，已去掉（退回规则草稿或删除），不在下面的列表里：')}</p>
              {/* 模型可能给出重复的路径，key 带上序号 */}
              {dropped.map((d, i) => (
                <p key={`${i}:${d.path}`} data-dropped={d.path} className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="font-mono text-xs">{d.path}</span>
                  <StatusText tone="bad">{d.dropped}</StatusText>
                </p>
              ))}
            </div>
          )}
          <p className="text-sm text-slate-500">
            {origin === 'assertions' ? t('只替换了 assertions 块（位置里的序号从 0 起），') : ''}{t('模型给的每一项按置信度从低到高排列，低置信度的请先核对。')}
          </p>
          <Table>
            <TableHeader>
              <TableRow><TableHead>{t('位置')}</TableHead><TableHead>{t('置信度')}</TableHead><TableHead>{t('理由')}</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {/* 模型可能给出重复的路径，key 带上序号 */}
              {rows.map((r, i) => {
                const { tone, level } = levelOf(r.confidence);
                return (
                  <TableRow key={`${i}:${r.path}`} data-confidence-path={r.path} data-confidence={r.confidence}>
                    <TableCell className="font-mono text-xs">{r.path}</TableCell>
                    <TableCell><StatusText tone={tone} data-confidence-level={level}>{levelText(t, level, Math.round(r.confidence * 100))}</StatusText></TableCell>
                    <TableCell className="whitespace-normal text-sm text-slate-600">{r.reason}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}
