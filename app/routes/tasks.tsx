// app/routes/tasks.tsx —— 任务（需登录，任何角色）：本租户最近的任务及其状态、成功任务的结果
import type { Route } from './+types/tasks';
import { requireMember } from '~/.server/auth';
import { getLocale } from '~/.server/locale';
import { navFor } from '~/.server/nav';
import { listTasks, TASK_PAGE_SIZE, TASK_STATUS_LABELS, taskErrorText } from '~/.server/tasks';
import { isTaskKind, readResult } from '~/.server/pipeline/task-contracts';
import { templateOfKind } from '~/.server/pipeline/templates';
import { entityLabel } from '~/lib/canonical-model';
import { builtinName, CANONICAL_NAMES } from '~/lib/builtin-names';
import { formatDateTime, formatNumber } from '~/lib/format';
import { useLocale, useT, type Locale, type T } from '~/lib/i18n';
import type { KeyCheckTaskResult } from '~/.server/source-key-check';
import type { ServingRows } from '~/.server/pipeline/serving-engine';
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
  /** rows 为 null：这张表没有行数（同步失败、源端已删除、核对时读不了）；dropped：快照过期删掉的表；
   *  entity / table 只在合并到标准层的行上带（实体的标准中文名与源表名，页面按界面语言显示「实体 ← 表」） */
  tables: { name: string; rows: number | null; dropped?: true; entity?: string; table?: string }[];
  /** 生成服务库：服务库版本与各部分的行数 */
  serving?: { version: number; rows: ServingRows };
  /** 盘点数据湖时表还没有建：提示「数据湖里还没有表」；其他没有表清单的 kind 不提示 */
  emptyHint?: true;
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
    // 盘点数据湖：tables 是 { name, rows }[]；没有表时提示数据湖还没有表（emptyHint 只在这里设置）
    case 'lake.inventory': {
      const result = readResult(task.kind, task);
      return result && { tables: result.tables.map(t => ({ name: t.name, rows: t.rows })), engine: result.engine, emptyHint: true };
    }
    // 造数与采集：tables 是 { name, rows }[]
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
    // 合并到标准层：按映射展示「实体 ← 表」，失败和跳过的映射没有 rows（name 与 data-result-table 仍用中文拼好的串）
    case 'silver.merge': {
      const result = readResult(task.kind, task);
      return result && {
        tables: result.mappings.map(m => ({
          name: `${entityLabel(m.entity)} ← ${m.table}`,
          entity: entityLabel(m.entity),
          table: m.table,
          rows: 'rows' in m ? m.rows : null,
        })),
        engine: result.engine,
      };
    }
    // 指标与标签：只写一张快照表，表名与行数在顶层
    case 'gold.dsl': {
      const result = readResult(task.kind, task);
      return result && { tables: [{ name: result.table, rows: result.rows }], engine: result.engine };
    }
    // 生成服务库：结果没有表清单，是版本号与各部分的行数（ADR-0033）
    case 'serving.build': {
      const result = readResult(task.kind, task);
      return result && { tables: [], serving: { version: result.version, rows: result.rows }, engine: result.engine };
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
      // 刷新检索投影、补算检索向量、漂移检查、主键冲突体检、人群导出等：只展示运行配额
      return { tables: [], engine: result.engine };
    }
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  const member = await requireMember(request);
  // 失败原因按读者的界面语言出文字（ADR-0060）：带句式（error_msg）时查词典，旧任务显示原中文
  const locale = await getLocale(request);
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
      error: taskErrorText(locale, t),
      result: t.status === 'succeeded' ? taskResult(t) : null,
      createdAt: t.createdAt.toISOString(),
      startedAt: t.startedAt?.toISOString() ?? null,
      finishedAt: t.finishedAt?.toISOString() ?? null,
    })),
  };
}

const time = (locale: Locale, iso: string | null) => (iso ? formatDateTime(locale, iso) : '—');

/** 服务库各部分在任务页上的名称（对象顺序即展示顺序，各部分见 serving-engine 的 ServingRows）；
 *  写成字面量 t('…') 才能与词典对账（RFM 两种语言一样，不翻） */
const SERVING_PART_LABELS: Record<keyof ServingRows, (t: T) => string> = {
  rfm: () => 'RFM',
  tags: t => t('标签'),
  metrics: t => t('指标'),
  consumer_aliases: t => t('退役 ID 对照'),
  consumer_sources: t => t('源端 ID 对照'),
};

/** 契约任务类型在任务页上的名称：中文与 task-contracts 的 CONTRACTS label 逐字一致（label 本身不改，翻译只在页面做）；
 *  写成字面量 t('…') 才能与词典对账 */
const KIND_LABELS: Record<string, (t: T) => string> = {
  'catalog.projection': t => t('刷新检索投影'),
  'catalog.embed': t => t('补算检索向量'),
  'lake.inventory': t => t('盘点数据湖'),
  'demo.seed': t => t('生成演示数据'),
  'source.profile': t => t('采集数据源'),
  'source.sync': t => t('同步数据源'),
  'source.keycheck': t => t('校验业务主键'),
  'source.verify': t => t('核对湖中数据'),
  'lake.inspect': t => t('漂移检查'),
  'silver.keycheck': t => t('主键冲突体检'),
  'silver.merge': t => t('合并到标准层'),
  'gold.dsl': t => t('指标与标签'),
  'gold.expire': t => t('快照过期'),
  'source.drop': t => t('删除原始层'),
  'sandbox.expire': t => t('沙箱表过期'),
  'serving.build': t => t('生成服务库'),
  'export.tags': t => t('人群导出'),
};

/** 任务类型名：契约 kind 用上表，模板任务（gold.rfm 等，模板名已在词典）与不认识的 kind 走 builtinName（缺键回退原文） */
const kindName = (t: T, kind: string, kindLabel: string) => KIND_LABELS[kind]?.(t) ?? builtinName(t, kindLabel);

/** 结果的主体：主键检查、服务库、表清单、空表提示四选一（按 taskResult 整理出的字段） */
function ResultBody({ result: { tables, serving, emptyHint, keyCheck } }: { result: TaskResult }) {
  const t = useT();
  if (keyCheck) {
    return (
      <div className="space-y-0.5">
        <div data-keycheck-result={keyCheck.tableName}>
          {t('{table} 的业务主键 {columns}：', { table: keyCheck.tableName, columns: keyCheck.keyColumns.join(t('、')) })}
          <StatusText tone={keyCheck.ok ? 'ok' : 'bad'} className="text-xs">{keyCheck.ok ? t('通过') : t('不通过')}</StatusText>
        </div>
        {!keyCheck.ok && <KeyCheckFindings result={keyCheck} className="pl-3" />}
      </div>
    );
  }
  if (serving) {
    return (
      <div className="space-y-0.5">
        <div data-serving-version={serving.version}>{t('服务库第 {version} 版', { version: serving.version })}</div>
        {(Object.keys(SERVING_PART_LABELS) as (keyof ServingRows)[]).map(part => (
          <div key={part} data-serving-part={part} className="pl-3">
            {t('{part}：', { part: SERVING_PART_LABELS[part](t) })}
            <span className="text-foreground">{t('{rows, plural, other {# 行}}', { rows: serving.rows[part] })}</span>
          </div>
        ))}
      </div>
    );
  }
  if (tables.length) {
    return (
      <ul>
        {/* 同步结果按批次记录，同一张表可能出现多次（如增量后接全量比对），key 要带上序号 */}
        {tables.map((table, i) => (
          <li key={`${i}-${table.name}`} data-result-table={table.name}>
            {table.entity === undefined
              ? t('{table}：', { table: table.name })
              : t('{entity} ← {table}：', { entity: builtinName(t, table.entity, CANONICAL_NAMES), table: table.table })}
            <span className="text-foreground">{table.dropped ? t('已删除') : table.rows === null ? '—' : t('{rows, plural, other {# 行}}', { rows: table.rows })}</span>
          </li>
        ))}
      </ul>
    );
  }
  return emptyHint ? <div>{t('数据湖里还没有表')}</div> : null;
}

function ResultDetails({ result }: { result: TaskResult }) {
  const t = useT();
  const locale = useLocale();
  const { unlinkedOrders, engine } = result;
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">{t('查看结果')}</summary>
      <div className="mt-1 space-y-1 pl-3">
        <ResultBody result={result} />
        {unlinkedOrders !== undefined && (
          <div>{t('打通不到消费者的订单：')}<span className="text-foreground">{formatNumber(locale, unlinkedOrders)}</span></div>
        )}
        {engine && <div>{t('运行配额：内存 {memory} · {threads, plural, other {# 线程}}', { memory: engine.memoryLimit, threads: engine.threads })}</div>}
      </div>
    </details>
  );
}

export default function Tasks({ loaderData }: Route.ComponentProps) {
  const { email, nav, pageSize, tasks } = loaderData;
  const t = useT();
  const locale = useLocale();
  return (
    <AppShell email={email} nav={nav}>
      <PageHeader title={t('任务')} description={t('本租户最近 {count} 个任务，按提交时间倒序。超出并发上限的任务排队等待；成功的任务可展开查看结果。', { count: pageSize })} />

      {tasks.length ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('任务')}</TableHead>
                <TableHead>{t('状态')}</TableHead>
                <TableHead>{t('提交时间')}</TableHead>
                <TableHead>{t('开始时间')}</TableHead>
                <TableHead>{t('结束时间')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map(task => (
                <TableRow key={task.id} data-task-kind={task.kind} data-task-status={task.status}>
                  <TableCell>
                    {kindName(t, task.kind, task.kindLabel)}
                    {task.error && <div className="text-xs whitespace-normal text-red-600">{task.error}</div>}
                    {task.result && <ResultDetails result={task.result} />}
                  </TableCell>
                  <TableCell><StatusText tone={TASK_TONES[task.status]}>{builtinName(t, task.statusLabel)}</StatusText></TableCell>
                  <TableCell className="text-slate-500">{time(locale, task.createdAt)}</TableCell>
                  <TableCell className="text-slate-500">{time(locale, task.startedAt)}</TableCell>
                  <TableCell className="text-slate-500">{time(locale, task.finishedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">{t('暂无任务。采集、同步、核对、合并等后台任务提交后会出现在这里。')}</div>
      )}
    </AppShell>
  );
}
