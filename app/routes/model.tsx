// app/routes/model.tsx —— 标准模型（需登录，任何角色）：平台内置的标准实体与字段说明（类型、标准枚举、主键、敏感信息），
// 以及映射里可用的白名单函数。数据工程师据此编写映射
import type { Route } from './+types/model';
import { requireMember } from '~/.server/auth';
import { navFor } from '~/.server/nav';
import { functionList } from '~/lib/mapping-expr';
import { CANONICAL_ENTITIES, FIELD_TYPES, MODEL_VERSION } from '~/lib/canonical-model';
import { AppShell } from '~/components/app-shell';
import { Badge } from '~/components/ui/badge';
import { PageHeader } from '~/components/page-header';
import { SectionHeader } from '~/components/section-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '标准模型 · CRM 数据分析平台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  return {
    email: member.email,
    nav: navFor(member),
    functions: functionList(),
  };
}

export default function Model({ loaderData }: Route.ComponentProps) {
  const { email, nav, functions } = loaderData;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader
        title={`标准模型 v${MODEL_VERSION}`}
        description="平台内置的标准实体，所有指标与标签只基于它定义。同一大版本内只新增字段，不改名、不改语义。租户特有的字段以扩展字段（x_ 开头）追加到标准实体上，或定义自定义实体（custom_ 开头），与标准实体一起参与映射。"
      />

      <nav className="flex flex-wrap gap-2">
        {CANONICAL_ENTITIES.map(e => (
          <a key={e.name} href={`#entity-${e.name}`} className="rounded-full border bg-white px-3 py-1 text-sm hover:bg-slate-100">{`${e.label}（${e.name}）`}</a>
        ))}
      </nav>

      {CANONICAL_ENTITIES.map(e => (
        <section key={e.name} id={`entity-${e.name}`} data-entity={e.name} className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
          <SectionHeader title={`${e.label}（${e.name}）`}>{`${e.description}主键：${e.key.join('、')}。`}</SectionHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>字段</TableHead>
                <TableHead>名称</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>说明</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {e.fields.map(f => (
                <TableRow key={f.name} data-field={f.name}>
                  <TableCell className="space-x-1 font-mono text-xs">
                    <span>{f.name}</span>
                    {e.key.includes(f.name) && <Badge variant="secondary">主键</Badge>}
                    {f.pii && <Badge variant="outline">敏感信息</Badge>}
                  </TableCell>
                  <TableCell>{f.label}</TableCell>
                  <TableCell>{FIELD_TYPES[f.type].label}</TableCell>
                  <TableCell className="whitespace-normal text-slate-500">
                    {f.description}
                    {f.enum && <div className="font-mono text-xs">{`标准枚举：${f.enum.join('、')}`}</div>}
                    {f.ref && <div className="font-mono text-xs" data-ref={`${f.ref.entity}.${f.ref.field}`}>{`→ ${f.ref.entity}.${f.ref.field}`}</div>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ))}

      <section className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="字段表达式可用的函数">
          映射里的字段表达式只能引用源表字段（字段名特殊时用双引号括起），使用单引号字符串、数字、+ - * / 与下列函数，不能写任意 SQL。
        </SectionHeader>
        <Table>
          <TableBody>
            {functions.map(f => (
              <TableRow key={f.name} data-function={f.name}>
                <TableCell className="font-mono text-xs">{f.signature}</TableCell>
                <TableCell className="whitespace-normal text-slate-500">{f.label}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </AppShell>
  );
}
