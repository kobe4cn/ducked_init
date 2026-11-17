// app/routes/ops.llm-usage.tsx —— 运营后台「模型调用汇总」页（#746，仅运营者）：跨租户按（租户、模型、用途、来源）看近 7/30 天的
// 调用次数、输入 / 输出 token、按当前单价折算的金额（ADR-0057）与错误「次数（错误率）」。只放聚合数，不放调用明细与
// 错误原文（ADR-0007）；排序：租户名 zh-CN、模型与用途按码点（ADR-0045，见 usageAcrossTenants）。
// 来源（#844）是分组键之一：tenant「租户」/ platform「平台」，迁移前的旧行（为空）显示「—」
import type { Route } from './+types/ops.llm-usage';
import { parseDays, usageAcrossTenants, type TenantModelUsage } from '~/.server/llm-usage';
import { requireOperator } from '~/.server/ops-auth';
import { OpsShell } from '~/components/ops-shell';
import { PageHeader } from '~/components/page-header';
import { PillTabs } from '~/components/pill-tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '模型调用 · 运营后台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const operator = await requireOperator(request);
  const days = parseDays(new URL(request.url).searchParams.get('days'));
  const rows = await usageAcrossTenants(days);
  return { email: operator.email, days, rows };
}

const n = (v: number) => v.toLocaleString('zh-CN');
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : '—');
/** 来源列（#844）：与租户页各定义一份，不从路由模块导出复用 */
const SOURCE_LABEL = { tenant: '租户', platform: '平台' } as const;

/** 汇总表的一行 */
function UsageRow({ row }: { row: TenantModelUsage }) {
  return (
    <TableRow data-tenant={row.tenantName} data-model={row.model} data-purpose={row.purpose} data-source={row.source ?? 'none'}>
      <TableCell>{row.tenantName}</TableCell>
      <TableCell className="text-slate-500">{row.model}</TableCell>
      <TableCell>{row.purpose}</TableCell>
      <TableCell data-col="source" className="text-slate-500">{(row.source && SOURCE_LABEL[row.source]) ?? '—'}</TableCell>
      <TableCell data-col="calls">{n(row.calls)}</TableCell>
      <TableCell data-col="tokens" className="text-slate-500">{`${n(row.promptTokens)} / ${n(row.completionTokens)}`}</TableCell>
      <TableCell data-col="cost">{row.cost}</TableCell>
      <TableCell data-col="errors" className={row.errors ? 'text-red-600' : 'text-slate-500'}>{`${n(row.errors)}（${pct(row.errors, row.calls)}）`}</TableCell>
    </TableRow>
  );
}

export default function OpsLlmUsage({ loaderData }: Route.ComponentProps) {
  const { email, days, rows } = loaderData;
  return (
    <OpsShell email={email}>
      <PageHeader title="模型调用" description={`近 ${days} 天各租户的模型调用按（租户、模型、用途、来源）汇总：次数、token、按当前单价折算的金额与错误率。只有聚合数，没有调用明细。`} />

      <PillTabs
        tabs={[
          { key: '7', label: '近 7 天', href: '/ops/llm-usage?days=7' },
          { key: '30', label: '近 30 天', href: '/ops/llm-usage?days=30' },
        ]}
        current={String(days)}
      />

      {rows.length === 0 ? (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">
          暂无模型调用。各租户里测试连通性、生成映射草稿、AI 解读等每次调用（成功与失败）都会汇总在这里。
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>租户</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>用途</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>调用</TableHead>
                <TableHead>token（输入 / 输出）</TableHead>
                <TableHead>金额</TableHead>
                <TableHead>错误</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => <UsageRow key={i} row={r} />)}
            </TableBody>
          </Table>
        </div>
      )}
    </OpsShell>
  );
}
