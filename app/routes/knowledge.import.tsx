// app/routes/knowledge.import.tsx —— 知识粘贴导入页（ADR-0046 入口③，#527）：有起草权限的成员粘贴标题、种类与来源原文，
// 提交后先 saveKnowledgeSource（保存不调模型，同租户同标题再粘贴不新建来源）再 importFromSource（同步调模型解析成提案），
// 成功 302 回集中页带计数（跳过 = 已有 + 拒绝过 + 不合法 + 依据已变）。查看者 loader 就 403，GET 与 POST 都打不开。
// 失败原地显示错误并带回已填的值：校验不过（KnowledgeError 400）时来源没保存；模型没配置（409）或失败（422）时来源已保存，
// 给出来源页链接——再提交同标题同正文是安全的重试（保存走幂等、解析按指纹去重）。页面提示只粘贴元数据说明，不要粘贴业务数据
import { useState } from 'react';
import { data, Form, Link, redirect, useNavigation } from 'react-router';
import { AlertTriangle, ClipboardPaste } from 'lucide-react';
import type { Route } from './+types/knowledge.import';
import { requirePermission } from '~/.server/access';
import { KnowledgeError } from '~/.server/knowledge/basis';
import { ImportError, importFromSource } from '~/.server/knowledge/import';
import { saveKnowledgeSource } from '~/.server/knowledge/sources';
import { navFor } from '~/.server/nav';
import { AppShell } from '~/components/app-shell';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { PageHeader } from '~/components/page-header';
import {
  KNOWLEDGE_SOURCE_BODY_MAX, KNOWLEDGE_SOURCE_KINDS, KNOWLEDGE_SOURCE_KIND_LABELS, KNOWLEDGE_SOURCE_TITLE_MAX,
} from '~/lib/knowledge-source';

export function meta({}: Route.MetaArgs) {
  return [{ title: '粘贴导入 · 业务知识 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requirePermission(request, 'definitions:draft');
  return { email: member.email, nav: navFor(member) };
}

/** 提交失败时带回的已填值（原样回显成员输入，校验由服务端做） */
interface ImportValues { title: string; kind: string; body: string }

export async function action({ request }: Route.ActionArgs) {
  const member = await requirePermission(request, 'definitions:draft');
  const form = await request.formData();
  const values: ImportValues = {
    title: String(form.get('title') ?? ''),
    kind: String(form.get('kind') ?? ''),
    body: String(form.get('body') ?? ''),
  };

  let saved: { id: string; version: number };
  try {
    saved = await saveKnowledgeSource(member, values);
  } catch (e) {
    // 校验不过：来源没保存，不带来源页链接（sourceId 补 undefined 让 actionData 的类型统一）
    if (e instanceof KnowledgeError) return data({ error: e.message, values, sourceId: undefined }, { status: e.status });
    throw e;
  }
  try {
    const outcome = await importFromSource(member, saved.id);
    const params = new URLSearchParams({
      imported: values.title.trim(), created: String(outcome.created),
      skipped: String(outcome.existing + outcome.rejected + outcome.invalid + outcome.stale),
    });
    throw redirect(`/knowledge?${params.toString()}`);
  } catch (e) {
    // 未配置模型服务 409 / 模型失败 422：来源已保存，给出来源页链接，再提交同标题同正文是安全的重试
    if (e instanceof ImportError) return data({ error: e.message, values, sourceId: saved.id }, { status: e.status });
    throw e;
  }
}

export default function KnowledgeImport({ loaderData, actionData }: Route.ComponentProps) {
  const { email, nav } = loaderData;
  const navigation = useNavigation();
  const submitting = navigation.state === 'submitting';
  const values = actionData?.values;
  // 字数计数按 .length 实时更新（服务端校验同样按 trimmed.length 截断）
  const [body, setBody] = useState(values?.body ?? '');
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title="粘贴导入"
        description={<><Link to="/knowledge" className="hover:underline">← 业务知识</Link>　粘贴一份文档原文，保存后交给模型解析成知识提案</>}
      />

      {actionData?.error && (
        <Alert variant="destructive" role="alert" className="mb-4">
          <AlertTriangle />
          <AlertTitle>{actionData.error}</AlertTitle>
          {actionData.sourceId && (
            <AlertDescription>
              来源已保存：<Link to={`/knowledge/sources/${actionData.sourceId}`}>查看原文</Link>
              ，再提交同标题同正文是安全的重试。
            </AlertDescription>
          )}
        </Alert>
      )}

      <div className="max-w-2xl rounded-2xl border bg-white p-6 shadow-sm">
        <Form method="post">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="title">标题</FieldLabel>
              <Input id="title" name="title" required maxLength={KNOWLEDGE_SOURCE_TITLE_MAX} defaultValue={values?.title ?? ''} placeholder="如：营收指标口径文档" />
              <FieldDescription>同租户同标题的再粘贴不新建来源：内容变了版本 +1，没变返回现有版本。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="kind">种类</FieldLabel>
              <NativeSelect id="kind" name="kind" required defaultValue={values?.kind ?? 'dictionary'} className="w-48">
                {KNOWLEDGE_SOURCE_KINDS.map(k => <NativeSelectOption key={k} value={k}>{KNOWLEDGE_SOURCE_KIND_LABELS[k]}</NativeSelectOption>)}
              </NativeSelect>
              <FieldDescription>数据字典与指标说明按空行分段，SQL 按语句（分号）分段。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="body">来源原文</FieldLabel>
              <textarea
                id="body" name="body" rows={12} required maxLength={KNOWLEDGE_SOURCE_BODY_MAX} value={body}
                onChange={e => setBody(e.target.value)}
                placeholder="粘贴字段含义、口径说明或 SQL 原文（只粘贴元数据说明，不要粘贴业务数据）"
                className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <FieldDescription>
                <span data-char-count>{`已输入 ${body.length} / ${KNOWLEDGE_SOURCE_BODY_MAX} 字`}</span>
                ；只粘贴元数据说明（字段含义、口径、SQL），不要粘贴业务数据。
              </FieldDescription>
            </Field>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={submitting}>
                <ClipboardPaste />{submitting ? '解析中…' : '保存并解析'}
              </Button>
              <span className="text-sm text-slate-400">解析会同步调用模型服务，稍等片刻。</span>
            </div>
          </FieldGroup>
        </Form>
      </div>
    </AppShell>
  );
}
