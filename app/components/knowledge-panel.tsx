// app/components/knowledge-panel.tsx —— 业务知识面板（ADR-0046）：左边是系统事实（目录条目的只读内容、系统口径文字与派生的口径声明），右边是成员写的知识
// （待确认的知识提案、别名、口径声明、业务说明、分析主题）。提案可以接受、修改后接受、填理由拒绝。每个表单都带 intent 与 targetId，交给路由 action 里的 handleKnowledgeIntent；不能编辑时不渲染任何表单和按钮。
// 需复核的知识配 amber 图标与「待复核」，生效的配 emerald。panel 为 null（定义从未发布过）时只提示发布后才能添加
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Form } from 'react-router';
import type { EntityEntry, FieldEntry, MetricEntry, TagEntry } from '~/.server/catalog';
import type { KnowledgePanel as Panel, PanelProposal } from '~/.server/knowledge/panel';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { CLAIM_TYPE_ORDER, CLAIM_TYPES, claimTypeLabel, claimValueLabel, isClaimType, type ClaimType } from '~/lib/semantic-claims';

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

/** 一条口径声明的说法：「币种：人民币」。claimPhrase 在 .server 下进不了客户端，这里用同一套标签 */
const phrase = (type: ClaimType, value: string) => `${claimTypeLabel(type)}：${claimValueLabel(type, value)}`;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-2 text-sm">
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-words">{value || '—'}</dd>
    </div>
  );
}

/** 面板左边展示的目录条目 */
export type PanelSystem = MetricEntry | TagEntry | EntityEntry | FieldEntry | null;

function SystemFacts({ system }: { system: PanelSystem }) {
  const definition = system?.kind === 'metric' || system?.kind === 'tag';
  const deps = definition ? [...system.dependencies.metrics, ...system.dependencies.entities, ...system.dependencies.fields] : [];
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
        {definition && <Fact label="依赖" value={deps.join('、')} />}
        {system?.kind === 'entity' && (
          <>
            <Fact label="字段" value={system.fields.map((f) => f.label && f.label !== f.name ? `${f.label}（${f.name}）` : f.name).join('、')} />
            <Fact label="关系" value={system.relations.join('、')} />
          </>
        )}
        {system?.kind === 'field' && (
          <>
            <Fact label="类型" value={system.type} />
            {system.enum && <Fact label="枚举" value={system.enum.join('、')} />}
            {system.lineage.length > 0 && (
              <div data-field-lineage className="grid grid-cols-[6rem_1fr] gap-2 text-sm">
                <dt className="text-slate-500">来源</dt>
                <dd className="space-y-1 break-all">
                  {system.lineage.map((l, i) => <p key={i}>{l.source} · {l.table} · <code>{l.expr}</code></p>)}
                </dd>
              </div>
            )}
          </>
        )}
      </dl>
      {/* 依赖与系统口径只属于指标、标签；没有目录条目时照旧显示占位 */}
      {(definition || !system) && (
        <div>
          <h4 className="text-sm text-slate-500">系统口径</h4>
          {definition ? (
            <>
              <p className="text-sm">{system.system.text}</p>
              <ul className="mt-2 space-y-1">
                {system.system.claims.map(c => <li key={c.type} data-system-claim={c.type} className="text-sm">{phrase(c.type, c.value)}</li>)}
              </ul>
            </>
          ) : <p className="text-sm text-slate-400">—</p>}
        </div>
      )}
    </div>
  );
}

const PROPOSAL_KIND_LABEL = { alias: '别名', claim: '口径声明', note: '业务说明' } as const;

function proposalText(p: PanelProposal): string {
  switch (p.kind) {
    case 'alias': return p.content.alias;
    case 'claim': return `${claimTypeLabel(p.content.type)}：${claimValueLabel(p.content.type, p.content.value)}`;
    case 'note': return p.content.note;
  }
}

/** 修改后接受：按种类给一个预填原值的输入 */
function EditedValue({ proposal: p }: { proposal: PanelProposal }) {
  switch (p.kind) {
    case 'alias':
      return <Input name="alias" required maxLength={50} defaultValue={p.content.alias} aria-label="改后的别名" className="w-48" />;
    case 'claim': {
      const { type } = p.content;
      return (
        <>
          <input type="hidden" name="type" value={type} />
          <NativeSelect name="value" size="sm" className="w-48" required defaultValue={p.content.value} aria-label={`改后的${claimTypeLabel(type)}`}>
            {(isClaimType(type) ? CLAIM_TYPES[type].values : []).map(v => <NativeSelectOption key={v.value} value={v.value}>{v.label}</NativeSelectOption>)}
          </NativeSelect>
        </>
      );
    }
    case 'note':
      return (
        <textarea
          name="note" rows={3} maxLength={2000} required defaultValue={p.content.note} aria-label="改后的业务说明"
          className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      );
  }
}

/** 待确认的知识提案：没有时整块不渲染 */
function Proposals({ panel, targetId }: { panel: Panel; targetId: string }) {
  if (!panel.proposals.length) return null;
  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
      <h4 className="flex items-center gap-2 text-sm text-slate-500">
        待确认的知识提案
        <span className="inline-flex items-center gap-1 text-xs text-amber-600"><AlertTriangle className="size-3" />待确认</span>
      </h4>
      <ul className="space-y-3">
        {panel.proposals.map(p => (
          <li key={p.id} data-proposal={p.id} className="space-y-1 text-sm">
            <div className="whitespace-pre-wrap">{`${PROPOSAL_KIND_LABEL[p.kind]}：${proposalText(p)}`}</div>
            {p.evidence.length > 0 && (
              <div className="text-xs text-slate-500">
                {'证据：'}{p.evidence.map(e => (e.version === undefined ? e.ref : `${e.ref} v${e.version}`)).join('、')}
              </div>
            )}
            {panel.canEdit && (
              <div className="flex flex-wrap items-start gap-3">
                <KnowledgeForm intent="proposal.accept" targetId={targetId}>
                  <input type="hidden" name="proposalId" value={p.id} />
                  <Button type="submit" size="xs" variant="outline">接受</Button>
                </KnowledgeForm>
                <details className="text-xs">
                  <summary className="cursor-pointer py-1 text-slate-500 hover:text-slate-900">修改后接受</summary>
                  <KnowledgeForm intent="proposal.acceptEdited" targetId={targetId} className="mt-2 flex max-w-2xl flex-wrap items-start gap-2">
                    <input type="hidden" name="proposalId" value={p.id} />
                    <input type="hidden" name="kind" value={p.kind} />
                    <EditedValue proposal={p} />
                    <Button type="submit" size="sm" variant="outline">接受修改</Button>
                  </KnowledgeForm>
                </details>
                <details className="text-xs">
                  <summary className="cursor-pointer py-1 text-slate-500 hover:text-slate-900">拒绝</summary>
                  <KnowledgeForm intent="proposal.reject" targetId={targetId} className="mt-2 flex gap-2">
                    <input type="hidden" name="proposalId" value={p.id} />
                    <Input name="reason" required maxLength={500} placeholder="拒绝理由，最多 500 字" aria-label="拒绝理由" className="w-64" />
                    <Button type="submit" size="sm" variant="outline">拒绝</Button>
                  </KnowledgeForm>
                </details>
              </div>
            )}
          </li>
        ))}
      </ul>
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
            ? `${phrase(type, claim.value)}（待复核，原为 ${claimValueLabel(type, claim.previous ?? '')}）`
            : (claim ? phrase(type, claim.value) : `${claimTypeLabel(type)}：未声明`);
          return (
            <li key={type} data-claim={claim ? type : undefined} className="flex flex-wrap items-center gap-3 text-sm">
              <span className={claim ? '' : 'text-slate-400'}>{text}</span>
              {claim && <Status needsReview={Boolean(claim.needsReview)} />}
              {panel.canEdit && (
                <KnowledgeForm intent="claim.save" targetId={targetId} className="ml-auto flex gap-2">
                  <input type="hidden" name="type" value={type} />
                  <NativeSelect name="value" size="sm" className="w-48" required defaultValue={claim?.needsReview ? '' : (claim?.value ?? '')} aria-label={claimTypeLabel(type)}>
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

/** 详情页里的业务知识面板；error 是上一次面板提交的错误消息。
 * hideNote：字段面板不显示说明区（字段说明由数据地图抽屉里的 Note 编辑）；compact：抽屉里用，单列、窄内边距 */
export function KnowledgePanel({ panel, system, targetId, error, hideNote = false, compact = false }: {
  panel: Panel | null; system: PanelSystem; targetId: string; error: string | null; hideNote?: boolean; compact?: boolean;
}) {
  return (
    <section data-knowledge-panel={targetId} className={`rounded-2xl border bg-white shadow-sm ${compact ? 'p-4' : 'p-6'}`}>
      <h2 className="mb-4 font-medium">业务知识</h2>
      {panel ? (
        <div className={compact ? 'grid gap-6' : 'grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]'}>
          <SystemFacts system={system} />
          <div className="min-w-0 space-y-6">
            <h3 className="text-sm font-medium">成员写的知识</h3>
            {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
            <Proposals panel={panel} targetId={targetId} />
            <Aliases panel={panel} targetId={targetId} />
            <Claims panel={panel} targetId={targetId} />
            {!hideNote && <Note panel={panel} targetId={targetId} />}
            <Subjects panel={panel} targetId={targetId} />
          </div>
        </div>
      ) : <p className="text-sm text-slate-500">发布后才能添加业务知识</p>}
    </section>
  );
}
