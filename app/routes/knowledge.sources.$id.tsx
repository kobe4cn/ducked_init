// app/routes/knowledge.sources.$id.tsx —— 知识来源原文页（ADR-0046 入口③，#527）：有 definitions:read 就能看（原文是成员写的元数据说明，不是业务数据）。
// 正文按保存时的段落逐段显示，每段带 p<段号> 锚点与段号，知识面板里 source:<id>#p<段号> 的证据链接就跳到这里（?v= 是证据记下的版本）。
// 表里只存当前正文，不存历史版本：URL 带 ?v= 且与当前 version 不同时，页顶提示段号可能对不上。非 UUID、不存在、属于别的租户都是 400
import { AlertTriangle } from 'lucide-react';
import { data, Link } from 'react-router';
import type { Route } from './+types/knowledge.sources.$id';
import { requirePermission } from '~/.server/access';
import { KnowledgeError } from '~/.server/knowledge/basis';
import { getKnowledgeSource } from '~/.server/knowledge/sources';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { Alert, AlertTitle } from '~/components/ui/alert';
import { PageHeader } from '~/components/page-header';
import { KNOWLEDGE_SOURCE_KIND_LABELS } from '~/lib/knowledge-source';

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: `${loaderData ? `${loaderData.source.title} · 来源原文` : '来源原文'} · CRM 数据分析平台` }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'definitions:read');
  // 证据链接里带的 ?v=（证据记下的版本，版本从 1 起）；不是正整数时当作没带
  const raw = new URL(request.url).searchParams.get('v');
  const parsed = raw === null ? null : Number(raw);
  const evidenceVersion = parsed !== null && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  try {
    const source = await getKnowledgeSource(member, params.sourceId);
    return {
      email: member.email,
      nav: navFor(member),
      source: {
        title: source.title,
        kindLabel: KNOWLEDGE_SOURCE_KIND_LABELS[source.kind],
        version: source.version,
        // 读取时由 paragraphsOf 现切，不存段落表
        paragraphs: source.paragraphs.map(p => ({ no: p.no, text: p.text })),
        updatedAt: source.updatedAt.toISOString(),
      },
      evidenceVersion,
    };
  } catch (e) {
    if (e instanceof KnowledgeError) throw data({ message: e.message }, { status: e.status });
    throw e;
  }
}

const when = (iso: string) => new Date(iso).toLocaleString('zh-CN');

export default function KnowledgeSourcePage({ loaderData }: Route.ComponentProps) {
  const { email, nav, source, evidenceVersion } = loaderData;
  // 证据记的是旧版本、表里只存当前正文：段号可能对不上，页顶提示
  const staleEvidence = evidenceVersion !== null && evidenceVersion !== source.version;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={source.title}
        description={
          <>
            <Link to="/knowledge" className="hover:underline">← 业务知识</Link>
            {`　${source.kindLabel} · 第 ${source.version} 版 · 更新于 ${when(source.updatedAt)}`}
          </>
        }
      />

      {staleEvidence && (
        <Alert role="status" className="mb-4" data-stale-evidence>
          <AlertTriangle className="text-amber-600" />
          <AlertTitle>{`证据来自 v${evidenceVersion}，原文已更新到 v${source.version}，段号可能对不上`}</AlertTitle>
        </Alert>
      )}

      <section className="max-w-3xl rounded-2xl border bg-white p-6 shadow-sm">
        <div className="space-y-4" data-paragraphs>
          {source.paragraphs.map(p => (
            <p key={p.no} id={`p${p.no}`} className="scroll-mt-24 whitespace-pre-wrap font-mono text-sm text-slate-700">
              <span className="mr-2 select-none text-xs text-slate-400">{`¶${p.no}`}</span>
              {p.text}
            </p>
          ))}
        </div>
      </section>
    </AppShell>
  );
}
