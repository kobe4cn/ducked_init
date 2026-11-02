// app/components/knowledge-panel.tsx —— 业务知识面板（ADR-0046）：左边是系统事实（目录条目的只读内容与系统口径的空位），右边是成员写的知识
// （别名、口径声明、业务说明、分析主题）。每个表单都带 intent 与 targetId，交给路由 action 里的 handleKnowledgeIntent；不能编辑时不渲染任何表单和按钮。
// 需复核的知识配 amber 图标与「待复核」，生效的配 emerald。panel 为 null（定义从未发布过）时只提示发布后才能添加
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Form } from 'react-router';
import type { MetricEntry, TagEntry } from '~/.server/catalog';
import type { KnowledgePanel as Panel } from '~/.server/knowledge/panel';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { CLAIM_TYPE_ORDER, CLAIM_TYPES, claimTypeLabel, claimValueLabel } from '~/lib/semantic-claims';

/** 一个面板表单：带上 intent 与 targetId */
function KnowledgeForm({ intent, targetId, className, children }: { intent: string; targetId: string; className?: string; children: React.ReactNode }) {
  return (
    <Form method="post" preventScrollReset className={className}>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="targetId" value={targetId} />
      {children}
    </Form>
  );
}

/** 生效或待复核：颜色配图标与文字 */
function Status({ needsReview }: { needsReview: boolean }) {
  return needsReview
    ? <span className="inline-flex items-center gap-1 text-xs text-amber-600"><AlertTriangle className="size-3" />待复核</span>
    : <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 className="size-3" />已生效</span>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-all">{value || '—'}</dd>
    </div>
  );
}

function SystemFacts({ system }: { system: MetricEntry | TagEntry | null }) {
  const deps = system ? [...system.dependencies.metrics, ...system.dependencies.entities, ...system.dependencies.fields] : [];
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium">系统事实</h3>
      <dl className="space-y-2">
        {system?.kind === 'metric' && (
          <>
            <Fact label="基础实体" value={system.base} />
            <Fact label="度量" value={system.measure} />
            <Fact label="维度" value={system.dimensions.join('、')} />
          </>
        )}
        {system?.kind === 'tag' && <Fact label="取值" value={system.values.join('、')} />}
        <Fact label="依赖" value={deps.join('、')} />
      </dl>
      <div>
        <h4 className="text-sm text-slate-500">系统口径</h4>
        <p className="text-sm text-slate-400">系统扫描尚未生成</p>
      </div>
    </div>
  );
}

function Aliases({ panel, targetId }: { panel: Panel; targetId: string }) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm text-slate-500">别名</h4>
      {panel.aliases.length ? (
        <ul className="flex flex-wrap gap-2">
          {panel.aliases.map(a => (
            <li key={a.id} data-alias={a.alias} data-needs-review={a.needsReview || undefined} className="flex items-center gap-2 rounded-full border px-3 py-1 text-sm">
              {a.alias}
              {a.needsReview && <Status needsReview />}
              {panel.canEdit && (
                <KnowledgeForm intent="alias.retire" targetId={targetId}>
                  <input type="hidden" name="aliasId" value={a.id} />
                  <Button type="submit" size="xs" variant="ghost">停用</Button>
                </KnowledgeForm>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-slate-400">还没有别名</p>}
      {panel.canEdit && (
        <KnowledgeForm intent="alias.add" targetId={targetId} className="flex max-w-md gap-2">
          <Input name="alias" required maxLength={50} placeholder="成员习惯的说法，最多 50 字" aria-label="新别名" />
          <Button type="submit" size="sm" variant="outline">新增别名</Button>
        </KnowledgeForm>
      )}
    </div>
  );
}

function Claims({ panel, targetId }: { panel: Panel; targetId: string }) {
  return (
    <div className="space-y-2">
      <h4 className="text-sm text-slate-500">口径声明</h4>
      <ul className="space-y-2">
        {CLAIM_TYPE_ORDER.map(type => {
          const claim = panel.claims.find(c => c.type === type);
          const text = claim?.needsReview
            ? `${claimTypeLabel(type)}：${claimValueLabel(type, claim.value)}（待复核，原为 ${claimValueLabel(type, claim.previous ?? '')}）`
            : `${claimTypeLabel(type)}：${claim ? claimValueLabel(type, claim.value) : '未声明'}`;
          return (
            <li key={type} data-claim={claim ? type : undefined} className="flex flex-wrap items-center gap-3 text-sm">
              <span className={claim ? '' : 'text-slate-400'}>{text}</span>
              {claim && <Status needsReview={Boolean(claim.needsReview)} />}
              {panel.canEdit && (
                <KnowledgeForm intent="claim.save" targetId={targetId} className="ml-auto flex gap-2">
                  <input type="hidden" name="type" value={type} />
                  <NativeSelect name="value" size="sm" required defaultValue={claim?.needsReview ? '' : (claim?.value ?? '')} aria-label={claimTypeLabel(type)}>
                    <NativeSelectOption value="" disabled>选择取值</NativeSelectOption>
                    {CLAIM_TYPES[type].values.map(v => <NativeSelectOption key={v.value} value={v.value}>{v.label}</NativeSelectOption>)}
                  </NativeSelect>
                  <Button type="submit" size="sm" variant="outline">保存</Button>
                </KnowledgeForm>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Note({ panel, targetId }: { panel: Panel; targetId: string }) {
  const { current, history, needsReview } = panel.note;
  return (
    <div className="space-y-2">
      <h4 className="text-sm text-slate-500">业务说明</h4>
      {current ? (
        <div className="space-y-1">
          <p data-note={current} data-needs-review={needsReview || undefined} className="whitespace-pre-wrap text-sm text-slate-700">{current}</p>
          <Status needsReview={needsReview} />
        </div>
      ) : <p className="text-sm text-slate-400">还没有业务说明</p>}
      {panel.canEdit && (
        <div className="max-w-2xl space-y-2">
          <KnowledgeForm intent="note.save" targetId={targetId} className="space-y-2">
            <textarea
              name="note" rows={3} maxLength={2000} defaultValue={current} aria-label="业务说明"
              placeholder="这个定义在本租户的业务口径，最多 2000 字"
              className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <Button type="submit" size="sm" variant="outline">保存说明</Button>
          </KnowledgeForm>
          {current && (
            <KnowledgeForm intent="note.save" targetId={targetId}>
              <input type="hidden" name="note" value="" />
              <Button type="submit" size="sm" variant="ghost">清空说明</Button>
            </KnowledgeForm>
          )}
        </div>
      )}
      {history.length > 0 && (
        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer hover:text-slate-900">{`历史（${history.length} 版）`}</summary>
          <div className="mt-2 space-y-2">
            {[...history].reverse().map((v, i) => (
              <div key={`${v.at}:${i}`} className="border-l-2 pl-2">
                <div>{`${v.by} · ${new Date(v.at).toLocaleString('zh-CN')}`}</div>
                <div className="whitespace-pre-wrap text-slate-700">{v.note || <span className="text-slate-400">（已清空）</span>}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function Subjects({ panel, targetId }: { panel: Panel; targetId: string }) {
  const { all, memberOf } = panel.subjects;
  const joined = all.filter(s => memberOf.includes(s.id));
  const others = all.filter(s => !memberOf.includes(s.id));
  return (
    <div className="space-y-2">
      <h4 className="text-sm text-slate-500">分析主题</h4>
      {joined.length ? (
        <ul className="flex flex-wrap gap-2">
          {joined.map(s => (
            <li key={s.id} data-member-of={s.id} className="flex items-center gap-2 rounded-full border px-3 py-1 text-sm">
              {s.name}
              {panel.canEdit && (
                <KnowledgeForm intent="subject.remove" targetId={targetId}>
                  <input type="hidden" name="subjectId" value={s.id} />
                  <Button type="submit" size="xs" variant="ghost">移出</Button>
                </KnowledgeForm>
              )}
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-slate-400">还没有加入分析主题</p>}
      {panel.canEdit && (
        <div className="flex flex-wrap gap-4">
          {others.length > 0 && (
            <KnowledgeForm intent="subject.add" targetId={targetId} className="flex gap-2">
              <NativeSelect name="subjectId" size="sm" required defaultValue="" aria-label="已有主题">
                <NativeSelectOption value="" disabled>选择主题</NativeSelectOption>
                {others.map(s => <NativeSelectOption key={s.id} value={s.id}>{s.name}</NativeSelectOption>)}
              </NativeSelect>
              <Button type="submit" size="sm" variant="outline">加入</Button>
            </KnowledgeForm>
          )}
          <KnowledgeForm intent="subject.create" targetId={targetId} className="flex gap-2">
            <Input name="name" required maxLength={30} placeholder="新主题名，最多 30 字" aria-label="新主题名" className="w-48" />
            <Button type="submit" size="sm" variant="outline">新建并加入</Button>
          </KnowledgeForm>
        </div>
      )}
    </div>
  );
}

/** 详情页里的业务知识面板；error 是上一次面板提交的错误消息 */
export function KnowledgePanel({ panel, system, targetId, error }: {
  panel: Panel | null; system: MetricEntry | TagEntry | null; targetId: string; error: string | null;
}) {
  return (
    <section data-knowledge-panel className="rounded-2xl border bg-white p-6 shadow-sm">
      <h2 className="mb-4 font-medium">业务知识</h2>
      {panel ? (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <SystemFacts system={system} />
          <div className="space-y-6">
            <h3 className="text-sm font-medium">成员写的知识</h3>
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <Aliases panel={panel} targetId={targetId} />
            <Claims panel={panel} targetId={targetId} />
            <Note panel={panel} targetId={targetId} />
            <Subjects panel={panel} targetId={targetId} />
          </div>
        </div>
      ) : <p className="text-sm text-slate-500">发布后才能添加业务知识</p>}
    </section>
  );
}
