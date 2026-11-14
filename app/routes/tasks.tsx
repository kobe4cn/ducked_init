// app/routes/tasks.tsx —— 任务（需登录，任何角色）：本租户最近的任务及其状态、成功任务的结果
import type { Route } from './+types/tasks';
import { requireMember } from '~/.server/auth';
import { navFor } from '~/.server/nav';
import { listTasks, TASK_PAGE_SIZE, TASK_STATUS_LABELS } from '~/.server/tasks';
import { isTaskKind, readResult } from '~/.server/pipeline/task-contracts';
import { templateOfKind } from '~/.server/pipeline/templates';
import { entityLabel } from '~/lib/canonical-model';
import type { KeyCheckTaskResult } from '~/.server/source-key-check';
import { AppShell } from '~/components/app-shell';
import { KeyCheckFindings } from '~/components/key-check-findings';
import { PageHeader } from '~/components/page-header';
import { StatusText, TASK_TONES } from '~/components/status-text';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '任务 · CRM 数据分析平台' }];
}

/** 成功任务的结果在任务页上的展示：按表的行数、主键检查结果与运行配额（taskResult 按任务的 kind 整理） */
interface TaskResult {
  /** rows 为 null：这张表没有行数（同步失败、源端已删除、核对时读不了）；dropped：快照过期删掉的表 */
  tables: { name: string; rows: number | null; dropped?: true }[];
  /** RFM 分层：打通不到消费者、没计入的订单数 */
  unlinkedOrders?: number;
  /** 校验业务主键：是否通过、空值行数与前几个重复键（敏感列的 key 为 null） */
  keyCheck?: KeyCheckTaskResult;
  /** 工作进程往每个结果里写的运行配额（pipeline/worker.ts） */
  engine?: { memoryLimit: string; threads: number };
}

/** 结果里的运行配额：形状不对时为 undefined */
const engineOf = (raw: unknown): TaskResult['engine'] => {
  if (!raw || typeof raw !== 'object') return undefined;
  const { memoryLimit, threads } = raw as Record<string, unknown>;
  return typeof memoryLimit === 'string' && typeof threads === 'number' ? { memoryLimit, threads } : undefined;
};

/**
 * 按任务的 kind 把成功结果整理成任务页的展示（ADR-0052）：kind 决定结果的形状，各分支用 readResult
 * 读出该 kind 的契约结果类型，不再按结果里有没有某个字段去猜
 */
function taskResult(task: { kind: string; result: unknown }): TaskResult | null {
  // 历史数据里不在契约中的 kind：读不出契约结果，只带出运行配额
  if (!isTaskKind(task.kind)) {
    if (task.result == null) return null;
    return { tables: [], engine: engineOf((task.result as { engine?: unknown }).engine) };
  }
  switch (task.kind) {
    // 盘点、造数与采集：tables 是 { name, rows }[]
    case 'lake.inventory':
    case 'demo.seed':
    case 'source.profile': {
      const result = readResult(task.kind, task);
      return result && { tables: result.tables.map(t => ({ name: t.name, rows: t.rows })), engine: result.engine };
    }
    // 同步：失败和源端已删除（gone）的表没有 rows
    case 'source.sync': {
      const result = readResult(task.kind, task);
      return result && {
        tables: result.tables.map(t => ({ name: t.table, rows: 'rows' in t ? t.rows : null })),
        engine: result.engine,
      };
    }
    // 校验业务主键：没有表清单，结果本身就是检查结果，不用强转
    case 'source.keycheck': {
      const result = readResult(task.kind, task);
      return result && { tables: [], keyCheck: result, engine: result.engine };
    }
    // 核对：读不了行数的表 sourceRows 为 null
    case 'source.verify': {
      const result = readResult(task.kind, task);
      return result && {
        tables: result.tables.map(t => ({ name: t.table, rows: t.sourceRows ?? null })),
        engine: result.engine,
      };
    }
    // 合并到标准层：按映射展示「实体 ← 表」，失败和跳过的映射没有 rows
    case 'silver.merge': {
      const result = readResult(task.kind, task);
      return result && {
        tables: result.mappings.map(m => ({ name: `${entityLabel(m.entity)} ← ${m.table}`, rows: 'rows' in m ? m.rows : null })),
        engine: result.engine,
      };
    }
    // 指标与标签：只写一张快照表，表名与行数在顶层
    case 'gold.dsl': {
      const result = readResult(task.kind, task);
      return result && { tables: [{ name: result.table, rows: result.rows }], engine: result.engine };
    }
    // 快照过期、沙箱表过期与删除原始层：tables 是删掉的表名
    case 'gold.expire':
    case 'sandbox.expire':
    case 'source.drop': {
      const result = readResult(task.kind, task);
      return result && { tables: result.tables.map(name => ({ name, rows: null, dropped: true })), engine: result.engine };
    }
    default: {
      const result = readResult(task.kind, task);
      if (!result) return null;
      // 模板任务（gold.rfm 等 6 个）：契约结果是 Record<string, unknown>，局部按字段类型收窄；unlinkedOrders 目前只有 RFM 分层会报
      if (templateOfKind(task.kind)) {
        const { table, rows, unlinkedOrders } = result as Record<string, unknown>;
        return {
          tables: typeof table === 'string' && typeof rows === 'number' ? [{ name: table, rows }] : [],
          unlinkedOrders: typeof unlinkedOrders === 'number' ? unlinkedOrders : undefined,
          engine: result.engine,
        };
      }
      // 刷新检索投影、补算检索向量、漂移检查、主键冲突体检、生成服务库、人群导出等：只展示运行配额
      return { tables: [], engine: result.engine };
    }
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  const tasks = await listTasks(member.tenant.id);
  return {
    email: member.email,
    nav: navFor(member),
    pageSize: TASK_PAGE_SIZE,
    tasks: tasks.map(t => ({
      id: t.id,
      kind: t.kind,
      kindLabel: t.kindLabel,
      status: t.status,
      statusLabel: TASK_STATUS_LABELS[t.status],
      error: t.error,
      result: t.status === 'succeeded' ? taskResult(t) : null,
      createdAt: t.createdAt.toISOString(),
      startedAt: t.startedAt?.toISOString() ?? null,
      finishedAt: t.finishedAt?.toISOString() ?? null,
    })),
  };
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');

function ResultDetails({ result: { tables, unlinkedOrders, keyCheck, engine } }: { result: TaskResult }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">查看结果</summary>
      <div className="mt-1 space-y-1 pl-3">
        {keyCheck ? (
          <div className="space-y-0.5">
            <div data-keycheck-result={keyCheck.tableName}>
              {`${keyCheck.tableName} 的业务主键 ${keyCheck.keyColumns.join('、')}：`}
              <StatusText tone={keyCheck.ok ? 'ok' : 'bad'} className="text-xs">{keyCheck.ok ? '通过' : '不通过'}</StatusText>
            </div>
            {!keyCheck.ok && <KeyCheckFindings result={keyCheck} className="pl-3" />}
          </div>
        ) : tables.length ? (
          <ul>
            {/* 同步结果按批次记录，同一张表可能出现多次（如增量后接全量比对），key 要带上序号 */}
            {tables.map((t, i) => (
              <li key={`${i}-${t.name}`} data-result-table={t.name}>
                {`${t.name}：`}<span className="text-foreground">{t.dropped ? '已删除' : t.rows === null ? '—' : `${t.rows.toLocaleString('zh-CN')} 行`}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div>数据湖里还没有表</div>
        )}
        {unlinkedOrders !== undefined && (
          <div>打通不到消费者的订单：<span className="text-foreground">{unlinkedOrders.toLocaleString('zh-CN')}</span></div>
        )}
        {engine && <div>{`运行配额：内存 ${engine.memoryLimit} · ${engine.threads} 线程`}</div>}
      </div>
    </details>
  );
}

export default function Tasks({ loaderData }: Route.ComponentProps) {
  const { email, nav, pageSize, tasks } = loaderData;
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title="任务" description={`本租户最近 ${pageSize} 个任务，按提交时间倒序。超出并发上限的任务排队等待；成功的任务可展开查看结果。`} />

      {tasks.length ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>任务</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>提交时间</TableHead>
                <TableHead>开始时间</TableHead>
                <TableHead>结束时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map(t => (
                <TableRow key={t.id} data-task-kind={t.kind} data-task-status={t.status}>
                  <TableCell>
                    {t.kindLabel}
                    {t.error && <div className="text-xs whitespace-normal text-red-600">{t.error}</div>}
                    {t.result && <ResultDetails result={t.result} />}
                  </TableCell>
                  <TableCell><StatusText tone={TASK_TONES[t.status]}>{t.statusLabel}</StatusText></TableCell>
                  <TableCell className="text-slate-500">{time(t.createdAt)}</TableCell>
                  <TableCell className="text-slate-500">{time(t.startedAt)}</TableCell>
                  <TableCell className="text-slate-500">{time(t.finishedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">暂无任务。采集、同步、核对、合并等后台任务提交后会出现在这里。</div>
      )}
    </AppShell>
  );
}
