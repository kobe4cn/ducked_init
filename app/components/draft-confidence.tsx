// app/components/draft-confidence.tsx —— 用模型生成映射草稿后的「生成依据」（ADR-0035）：模型给的每项按置信度从低到高列出（路径、置信度、理由），
// 低于 0.5 标红、低于 0.8 琥珀色、其余绿色，颜色都配图标与文字；复用已发布映射或按规则生成时只写来源（复用时链接到来源映射）。
// 只是展示，保存不依赖它；置信度来自模型，展示前夹到 0..1，理由是纯文本
import { AlertTriangle, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import { StatusText, type StatusTone } from '~/components/status-text';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import type { ModelDraftResult } from '~/.server/mappings';

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

const levelOf = (c: number): { tone: StatusTone; level: 'low' | 'medium' | 'high'; label: string } =>
  c < 0.5 ? { tone: 'bad', level: 'low', label: '低' } : c < 0.8 ? { tone: 'pending', level: 'medium', label: '中' } : { tone: 'ok', level: 'high', label: '高' };

export function DraftConfidence({ origin, items, reusedFrom, notice }: {
  origin: ModelDraftResult['origin'];
  items: ModelDraftResult['items'];
  /** 复用时来源映射的 ID */
  reusedFrom?: string | null;
  /** 如没配置模型服务、已按规则生成 */
  notice?: string | null;
}) {
  const rows = items
    .map(i => ({ ...i, confidence: clamp(i.confidence) }))
    .sort((a, b) => a.confidence - b.confidence || a.path.localeCompare(b.path));
  return (
    <div data-draft-origin={origin} className="space-y-2 rounded-xl border bg-slate-50/60 p-4">
      <div className="flex items-center gap-1.5 text-sm font-medium"><Sparkles aria-hidden className="size-4 text-slate-400" />生成依据</div>
      {origin === 'reuse' && (
        <p className="text-sm text-slate-500">
          源表结构与已发布映射一致，直接复用{reusedFrom ? <>了<Link to={`/mappings/${reusedFrom}`} className="underline">那个映射</Link></> : null}，没有调用模型。
        </p>
      )}
      {origin === 'rules' && <p data-notice className="flex items-center gap-1.5 text-sm text-amber-600"><AlertTriangle aria-hidden className="size-4" />{notice ?? '按规则生成'}</p>}
      {origin === 'model' && (
        <>
          <p className="text-sm text-slate-500">模型给的每一项按置信度从低到高排列，低置信度的请先核对。</p>
          <Table>
            <TableHeader>
              <TableRow><TableHead>位置</TableHead><TableHead>置信度</TableHead><TableHead>理由</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {/* 模型可能给出重复的路径，key 带上序号 */}
              {rows.map((r, i) => {
                const { tone, level, label } = levelOf(r.confidence);
                return (
                  <TableRow key={`${i}:${r.path}`} data-confidence-path={r.path} data-confidence={r.confidence}>
                    <TableCell className="font-mono text-xs">{r.path}</TableCell>
                    <TableCell><StatusText tone={tone} data-confidence-level={level}>{`${label} ${Math.round(r.confidence * 100)}%`}</StatusText></TableCell>
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
