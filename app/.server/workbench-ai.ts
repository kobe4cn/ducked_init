// app/.server/workbench-ai.ts —— 工作台 AI 起草 SQL（ADR-0043）：按成员此刻能读的目录（listCatalog：表、字段与类型，不含取值）请模型写一条只读 SQL，
// 在只读挂载上按工作台白名单校验（checkDraftedSql，不执行），通过后只交给页面填进编辑框，由成员自己执行。
// 提示里的结果层快照按任务归组、每个指标 / 标签 / 模板只给最新一张；目录太长时先略去结果层与沙箱，silver 与原始表最后才裁（catalogText）。
// 审计 workbench.ai_drafted 记 SQL 与是否通过校验，不记需求原文；模型判断做不到时（需要的表不在目录里、要写数据）422 给出它的原因，审计只记 { unsupported: true }；不自动重试。成功时可带模型的口径假设 notes（最多 MAX_NOTES 条）给页面列出，notes 不进审计。
// 结果解读：成员确认后服务端按 SQL 重新执行（不信客户端传来的行），租户打开「发送脱敏样本」时把前 INTERPRET_ROWS 行发给模型服务，
// 没打开时只发 SQL、列名与类型、行数和每列统计（按全部结果行算），不发任何行；结果列无法回溯到字段，
// 所以按列名与取值保守剔除系统列、名字像敏感字段的列与取值里有 64 位十六进制哈希的列，再按解析树算出的派生敏感列（sensitiveOutputs）剔掉起别名躲过列名规则的列（#1318）（统计也只算留下的列）。审计 workbench.result_interpreted 不记取值，记 samples；
// 两种提示都带 SQL 与服务端按全部返回行算好的数值事实（合计、最大、最小、占比，模型只能引用这些数）；按 isDetail 区分分组汇总（可点名分组，事实带所在行）与明细（不点名、只谈分布，不带所在行），关闭开关时也不带所在行；
// 模型不一定照做：解读里的数字逐个在发出去的 user 消息里找出处（uncitedNumbers），找不到的只返回给页面标出、不重写，审计只记个数；
// 解读连同 SQL、行数与发送的列名存进本人的助手对话（appendInterpretation），不存结果行
import { and, eq, inArray } from 'drizzle-orm';
import { assertCan } from './access';
import { appendInterpretation, assertOwnConversation } from './assistant/conversations';
import { recordAudit } from './audit';
import type { CurrentMember } from './auth';
import { isSystemColumn } from './catalog';
import { getDb } from './db/client';
import { tasks } from './db/schema';
import { chatJson, LlmError, resolveProvider, throwIfAborted, withLlmContext, type LlmMessage } from './llm';
import { uncitedNumbers } from './interpretation-numbers';
import { dataOnlyNotice } from './llm-prompts';
import { normalizeWorkbenchSql, type WorkbenchResult } from './pipeline/workbench-engine';
import { checkDraftedSql, listCatalog, runQuery, WorkbenchError, type CatalogEntry, type QueryOutcome, type WorkbenchCatalog } from './workbench';
import { SNAPSHOT_TABLE } from './pipeline/task-contracts';
import { templateOfKind } from './pipeline/templates';
import { samplesAllowed } from './model-provider';
import { UUID } from './tenants';
import { looksSensitive } from '../lib/sensitive';

/** 可以展示给成员的错误；状态码与 WorkbenchError 对齐（透传它的 status） */
export class WorkbenchAiError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 422 | 429) { super(message); }
}

/** 需求最多的字数 */
export const MAX_REQUEST = 2000;
/** 目录在提示里最多占的字数，超出时按层略去整行（catalogText） */
const MAX_CATALOG = 30_000;

/**
 * 起草的 SQL，或做不到的原因（二选一；都给且原因不是空白时按做不到处理）。不用 oneOf：ajv allErrors 下报错很杂。
 * 长度限制写在 anyOf 的分支里而不是顶层 properties：另一项是空字符串时（{"sql": "", "unsupported": "原因"}、
 * {"sql": "SELECT 1", "unsupported": ""}）只要有一个分支成立就通过，不报 Schema 错误
 */
export const WORKBENCH_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { sql: { type: 'string' }, unsupported: { type: 'string' }, notes: { type: 'array' } },
  anyOf: [
    { required: ['unsupported'], properties: { unsupported: { minLength: 1, pattern: '\\S' } } },
    { required: ['sql'], properties: { sql: { minLength: 1 } } },
  ],
};
/** 做不到的原因最多的字数 */
const MAX_UNSUPPORTED = 500;
/** 口径假设最多的条数与每条最多的字数。WORKBENCH_DRAFT_SCHEMA 里 notes 不限条目类型与长度：模型的小偏差（条目是 null、数字，条数过多）不报 Schema 错，在代码里过滤和截断 */
const MAX_NOTES = 3;
const MAX_NOTE = 200;

const tableLine = (t: { ref: string; columns: { name: string; type: string }[] }) => `${t.ref}(${t.columns.map(c => `${c.name} ${c.type}`).join(', ')})`;

/** 提示里的中文片段（给模型看的提示词，不是界面文案） */
const NOTE = { metric: '指标', tag: '标签', template: '模板', latest: '最新快照', truncated: '…（目录太长，部分表略去）' } as const;

/**
 * 结果层写进提示的行：<种类>__<任务 ID> 的快照按本租户的 platform.tasks 归组（模板任务按 kind，gold.dsl 按 params.kind:params.key），
 * 每组只留 finished_at 最新、succeeded 的那张并在行尾注明是谁的最新快照；名字不是快照、查不到任务或任务没成功的表原样保留。
 * 只用在提示里，listCatalog 的输出（目录树、补全）不变
 */
async function goldSnapshots(tenantId: string, gold: WorkbenchCatalog['gold']): Promise<string[]> {
  const taskIdOf = (e: CatalogEntry) => (SNAPSHOT_TABLE.test(`gold.${e.name}`) && UUID.test(e.name.slice(-36)) ? e.name.slice(-36) : undefined);
  const ids = gold.map(taskIdOf).filter((id): id is string => id !== undefined);
  const found = ids.length
    ? await getDb().select({ id: tasks.id, kind: tasks.kind, params: tasks.params, status: tasks.status, finishedAt: tasks.finishedAt })
      .from(tasks).where(and(eq(tasks.tenantId, tenantId), inArray(tasks.id, ids)))
    : [];
  const byId = new Map(found.map(t => [t.id, t]));
  /** 快照所属的组与注释；不归组时 undefined */
  const groupOf = (e: CatalogEntry) => {
    const id = taskIdOf(e);
    const task = id === undefined ? undefined : byId.get(id);
    if (!task || task.status !== 'succeeded') return undefined;
    const { kind, key } = task.params;
    if (task.kind === 'gold.dsl' && (kind === 'metric' || kind === 'tag') && typeof key === 'string') {
      return { key: `${kind}:${key}`, note: `${NOTE[kind]} ${key}`, at: task.finishedAt?.getTime() ?? 0 };
    }
    const template = templateOfKind(task.kind);
    return template ? { key: task.kind, note: `${NOTE.template} ${template}`, at: task.finishedAt?.getTime() ?? 0 } : undefined;
  };
  const groups = gold.map(groupOf);
  const latest = new Map<string, number>();
  groups.forEach((g, i) => {
    if (!g) return;
    const best = latest.get(g.key);
    if (best === undefined || g.at > groups[best]!.at) latest.set(g.key, i);
  });
  return gold.flatMap((e, i) => {
    const g = groups[i];
    if (!g) return [tableLine(e)];
    return latest.get(g.key) === i ? [`${tableLine(e)}  -- ${g.note} ${NOTE.latest}`] : [];
  });
}

/**
 * 目录写进提示：每张表一行「引用(字段 类型, …)」，按 silver、gold、mine、shared、原始表的顺序。
 * 超过 MAX_CATALOG 字时按整行、按层裁剪：silver 与原始表 > 自己的沙箱 > 分享给我的 > 结果层；
 * 某层放不下时只留这层开头放得下的行，后面的层全部略去，truncated 为真
 */
export function catalogText(catalog: WorkbenchCatalog, gold: string[]): { text: string; truncated: boolean } {
  const sections: { tier: number; lines: string[] }[] = [
    { tier: 0, lines: catalog.silver.map(tableLine) },
    { tier: 3, lines: gold },
    { tier: 1, lines: catalog.mine.map(tableLine) },
    { tier: 2, lines: catalog.shared.map(tableLine) },
    { tier: 0, lines: catalog.raw.flatMap(s => s.tables.map(tableLine)) },
  ];
  const keep = sections.map(s => s.lines.map(() => false));
  let budget = MAX_CATALOG;
  let truncated = false;
  for (const tier of [0, 1, 2, 3]) {
    for (const [si, section] of sections.entries()) {
      if (section.tier !== tier) continue;
      for (const [li, line] of section.lines.entries()) {
        if (truncated || line.length + 1 > budget) { truncated = true; continue; }
        budget -= line.length + 1;
        keep[si]![li] = true;
      }
    }
  }
  const text = sections.flatMap((s, si) => s.lines.filter((_, li) => keep[si]![li])).join('\n');
  return { text: truncated ? `${text}\n${NOTE.truncated}` : text, truncated };
}

export function draftMessages(request: string, catalog: string): LlmMessage[] {
  return [
    {
      role: 'system',
      content: [
        '你为 DuckDB 写一条只读查询 SQL，回答 JSON 对象 {"sql": "..."}，做不到时回答 {"unsupported": "原因"}；写出 SQL 时可以再给 "notes": ["..."]，最多 3 条、每条一句，只写你做的口径假设——时间锚点（今天还是数据里最后一天）、取哪张表（原始表还是标准层）、空值怎么处理，没有需要说明的假设就不给 notes。',
        '只写一条 SELECT（可以带 WITH），不写 INSERT / UPDATE / DELETE / CREATE / DROP 等写语句，不写多条语句。',
        '只能读下面列出的表，表名照列出的引用写（带 schema 或数据源名与引号），不要编造表或字段；需要的表或字段不在下面列出的目录里，或需求要删除 / 修改 / 写入数据（工作台只读）时，不要编造、不要改写成别的查询，回答 {"unsupported": "一句话原因"}。',
        '能读的表（引用(字段 类型, …)）：',
        catalog || '（没有能读的表）',
      ].join('\n'),
    },
    { role: 'user', content: request },
  ];
}

/**
 * 按需求起草一条工作台 SQL，通过白名单校验后返回，不执行（ADR-0043）。
 * 需求为空或超过 MAX_REQUEST 字时 400；没配置模型服务时 409（都不发请求）；模型失败或 SQL 没通过校验时 422（没通过时审计 valid: false）；
 * 客户端中止（signal）时 422，不写任何审计（回复到手也一样，#1250）；
 * 模型判断做不到时 422，报错就是它给的原因（截到 MAX_UNSUPPORTED 字），审计 { unsupported: true }，不记原因（可能复述需求）；
 * 同租户已有查询在运行时 429。目录太长、提示里略去了表时 catalogTruncated 为真；
 * 模型给了口径假设时带 notes（去掉空白条，最多 MAX_NOTES 条、每条截到 MAX_NOTE 字，没有就不带这个键），notes 不进审计
 */
export async function draftWorkbenchSql(actor: CurrentMember, request: string, signal?: AbortSignal): Promise<{ sql: string; catalogTruncated: boolean; notes?: string[] }> {
  // 整个入口包进 withLlmContext（#1257）：这次操作里的模型调用在 llm_calls 里记发起人、共用一个 turn_id（不发请求的分支不受影响）
  return withLlmContext({ actorEmail: actor.email }, async () => {
    assertCan(actor, 'sandbox');
    if (!request.trim()) throw new WorkbenchAiError('请先写下要查什么', 400);
    if (request.length > MAX_REQUEST) throw new WorkbenchAiError(`需求最多 ${MAX_REQUEST} 字`, 400);
    const tenantId = actor.tenant.id;
    if (!(await resolveProvider(tenantId))) throw new WorkbenchAiError('未配置模型服务：请让租户管理员在「模型服务」页配置，或由平台配置默认模型服务', 409);
    try {
      const catalog = await listCatalog(actor);
      const { text, truncated } = catalogText(catalog, await goldSnapshots(tenantId, catalog.gold));
      let output: { sql?: string; unsupported?: string; notes?: unknown[] };
      try {
        output = await chatJson<{ sql?: string; unsupported?: string; notes?: unknown[] }>(tenantId, 'workbench_draft', draftMessages(request, text), WORKBENCH_DRAFT_SCHEMA, { signal });
        // 客户端中止（#1250）：回复到手也不继续，unsupported 审计与 checkDraftedSql 的 valid 审计都不写
        throwIfAborted(signal);
      } catch (e) {
        if (e instanceof LlmError) throw new WorkbenchAiError(`模型起草 SQL 失败：${e.message}`, 422);
        throw e;
      }
      const reason = output.unsupported?.trim();
      if (reason) {
        await recordAudit(getDb(), { tenantId, actor, action: 'workbench.ai_drafted', targetType: 'workbench', detail: { unsupported: true } });
        throw new WorkbenchAiError(reason.slice(0, MAX_UNSUPPORTED), 422);
      }
      // unsupported 没给或只有空白时 WORKBENCH_DRAFT_SCHEMA anyOf 的第一个分支不成立（它要求有非空白字符），通过校验靠的是第二个分支，所以一定有非空的 sql
      const { sql, problem } = await checkDraftedSql(actor, output.sql!);
      if (problem) throw new WorkbenchAiError(`AI 起草的 SQL 没有通过校验：${problem}`, 422);
      const notes = (output.notes ?? []).filter((n): n is string => typeof n === 'string').map(n => n.trim()).filter(Boolean)
        .slice(0, MAX_NOTES).map(n => n.slice(0, MAX_NOTE));
      return notes.length ? { sql, catalogTruncated: truncated, notes } : { sql, catalogTruncated: truncated };
    } catch (e) {
      // 目录读取、校验时挂载出错或已有查询在运行：照原状态码给出
      if (e instanceof WorkbenchError) throw new WorkbenchAiError(e.message, e.status);
      throw e;
    }
  });
}

/** 解读时发给模型服务的行数 */
export const INTERPRET_ROWS = 50;
/** 每格最多的字数与解读最多的字数 */
export const MAX_CELL = 200;
const MAX_INTERPRETATION = 4000;
/** 平台的哈希（加盐 sha256）：取值里出现就剔除整列，拼接、取子串等改写也躲不过 */
const HASH = /[0-9a-f]{64}/i;

export const INTERPRET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['interpretation'],
  properties: { interpretation: { type: 'string', minLength: 1 } },
};

/** 单元格转成字符串（BigInt、日期、列表与结构体都能转），NULL 保持 null */
const cellText = (v: unknown): string | null =>
  v === null || v === undefined ? null
    : typeof v === 'object' ? JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
      : String(v);

/** 空的派生敏感列集合：没算过（如 MCP 的 run_query）时 sendable 的默认值 */
const NONE = new Set<string>();

/** 结果列里由敏感源列算出的列名（workbench-engine 校验时按解析树算出，追别名链，#1318） */
const derivedOf = (result: WorkbenchResult): ReadonlySet<string> => new Set(result.sensitive ?? []);

/** 每列发不发：系统列、名字像敏感字段的列、由敏感源列算出的列（起个别名也躲不过）、前 limit 行里有取值含哈希的列都不发（按位置，重名的列也不会取错） */
const sendable = (result: WorkbenchResult, limit = INTERPRET_ROWS, derived: ReadonlySet<string> = NONE): boolean[] => {
  const rows = result.rows.slice(0, limit);
  return result.columns.map(({ name }, i) =>
    !isSystemColumn(name) && !looksSensitive({ name }) && !derived.has(name.toLowerCase()) && !rows.some(row => HASH.test(cellText(row[i]) ?? '')));
};

/** 列名像标识（customer_id、openid、unionid、mobile）；`(^|_)id$` 不误伤 paid */
const DETAIL_NAME = /(^|_)id$|openid|unionid|mobile/i;

/**
 * 结果是不是明细（每行是一个人或一条记录）：有列因为敏感被剔除（敏感列名或取值含哈希；系统列被剔除不算），或列名像标识。
 * 明细结果的解读不点名、不引用单行取值，数值事实也不带所在行
 */
export function isDetail(result: WorkbenchResult, keep: boolean[]): boolean {
  return result.columns.some(({ name }, i) => (!keep[i] && !isSystemColumn(name)) || DETAIL_NAME.test(name));
}

/** 要发送与剔除的列名 */
export function pickColumns(result: WorkbenchResult, keep = sendable(result)): { sent: string[]; dropped: string[] } {
  return {
    sent: result.columns.filter((_, i) => keep[i]).map(c => c.name),
    dropped: result.columns.filter((_, i) => !keep[i]).map(c => c.name),
  };
}

/**
 * 剔除后交出去的结果：前 limit 行里没被剔除的列，单元格转成字符串、每格最多 MAX_CELL 字；dropped 是剔除的列名。
 * 哈希按交出去的这些行判断：解读只发前 INTERPRET_ROWS 行，MCP 的 run_query 交出全部行（limit 传 Infinity，不传 derived，行为不变）
 */
export function redactResult(result: WorkbenchResult, limit = INTERPRET_ROWS, derived: ReadonlySet<string> = NONE): { columns: WorkbenchResult['columns']; rows: (string | null)[][]; dropped: string[] } {
  const keep = sendable(result, limit, derived);
  const indexes = keep.flatMap((k, i) => (k ? [i] : []));
  return {
    columns: indexes.map(i => result.columns[i]),
    rows: result.rows.slice(0, limit).map(row => indexes.map(i => cellText(row[i])?.slice(0, MAX_CELL) ?? null)),
    dropped: pickColumns(result, keep).dropped,
  };
}

/** 发给模型服务的行数 */
const sentRows = (result: WorkbenchResult) => Math.min(result.rows.length, INTERPRET_ROWS);

/** DuckDB 的数值类型（DECIMAL(18,2) 之类带参数的按前缀判断） */
const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)\b/i;

interface ColumnStats { name: string; type: string; nonNull: number; distinct: number; min?: number; max?: number; avg?: number }

/** 不发样本时交出去的结构：SQL、行数与 keep 留下的列的统计（按全部结果行算）；文本、日期等只给非空数与去重数（ADR-0016），数值列再给最小 / 最大 / 平均 */
function columnStats(sql: string, result: WorkbenchResult, keep: boolean[]) {
  const columns = result.columns.flatMap(({ name, type }, i): ColumnStats[] => {
    if (!keep[i]) return [];
    const cells = result.rows.map(row => row[i]).filter(v => v !== null && v !== undefined);
    const stats: ColumnStats = { name, type, nonNull: cells.length, distinct: new Set(cells.map(cellText)).size };
    const numbers = NUMERIC.test(type) ? cells.map(Number).filter(Number.isFinite) : [];
    if (!numbers.length) return [stats];
    return [{
      ...stats,
      min: numbers.reduce((a, b) => Math.min(a, b)),
      max: numbers.reduce((a, b) => Math.max(a, b)),
      avg: numbers.reduce((a, b) => a + b, 0) / numbers.length,
    }];
  });
  return { sql, rowCount: result.rows.length, truncated: result.truncated, columns };
}

export interface NumericFact { column: string; sum: number; max: number; min: number; maxShare?: number; minShare?: number; maxAt?: string; minAt?: string }

const share = (part: number, sum: number) => Math.round((part / sum) * 1000) / 1000;

/**
 * 服务端算好的数值事实（按全部结果行、keep 留下的数值列）：合计、最大、最小；合计为正且没有负数时再给最大 / 最小占合计的比例。
 * detail 为假时再给 maxAt / minAt：第一次出现最大 / 最小值那一行在标签列（第一个留下的、不是这一列本身的列）的取值
 */
function numericFacts(result: WorkbenchResult, keep: boolean[], detail: boolean): NumericFact[] {
  return result.columns.flatMap(({ name, type }, i): NumericFact[] => {
    if (!keep[i] || !NUMERIC.test(type)) return [];
    const values = result.rows.map(row => (row[i] === null || row[i] === undefined ? NaN : Number(row[i])));
    const numbers = values.filter(Number.isFinite);
    if (!numbers.length) return [];
    const sum = numbers.reduce((a, b) => a + b, 0);
    const max = numbers.reduce((a, b) => Math.max(a, b));
    const min = numbers.reduce((a, b) => Math.min(a, b));
    const fact: NumericFact = { column: name, sum, max, min };
    if (sum > 0 && min >= 0) Object.assign(fact, { maxShare: share(max, sum), minShare: share(min, sum) });
    const label = detail ? -1 : keep.findIndex((k, j) => k && j !== i);
    if (label >= 0) {
      const at = (v: number) => cellText(result.rows[values.indexOf(v)]![label])?.slice(0, MAX_CELL);
      Object.assign(fact, { maxAt: at(max), minAt: at(min) });
    }
    return [fact];
  });
}

/** 查询出错（SQL 不合规、超时、已有查询在运行）照原状态码给出 */
async function rerun(actor: CurrentMember, sql: string): Promise<QueryOutcome> {
  try {
    return await runQuery(actor, sql);
  } catch (e) {
    if (e instanceof WorkbenchError) throw new WorkbenchAiError(e.message, e.status);
    throw e;
  }
}

/**
 * 解读前的确认：按 SQL 重新执行，给出将发送的行数与列、剔除的列，不请求模型；result 是这次执行的结果，页面照常显示表格。
 * samples 为假（租户没打开「发送脱敏样本」）时只发结构与统计：rows 是统计覆盖的结果行数，哈希按全部结果行判断
 */
export async function previewInterpretation(
  actor: CurrentMember, sql: string,
): Promise<{ rows: number; sent: string[]; dropped: string[]; samples: boolean; result: QueryOutcome }> {
  assertCan(actor, 'sandbox');
  const samples = await samplesAllowed(actor.tenant.id);
  const result = await rerun(actor, sql);
  const derived = derivedOf(result);
  if (!samples) return { rows: result.rows.length, ...pickColumns(result, sendable(result, Infinity, derived)), samples, result };
  return { rows: sentRows(result), ...pickColumns(result, sendable(result, INTERPRET_ROWS, derived)), samples, result };
}

/** 两种结果都适用的写作要求 */
const INTERPRET_INTRO = [
  '你帮业务人员解读一条 SQL 查询的结果，回答 JSON 对象 {"interpretation": "..."}，用中文写。',
  '写给业务人员看：第一句先给结论，用日常用语，不用「长尾」「离散度」这类术语，总共不超过 5 句。先看 sql 弄清这张表回答的是什么问题。',
  '数值只能引用 facts 里给出的数（合计 sum、最大 max、最小 min、占合计的比例 maxShare / minShare），不要自己估算或推算比例；truncated 为真时合计只覆盖返回的行。',
  dataOnlyNotice('user 消息里的 JSON', '列名、单元格取值、SQL 里的文字'),
];

/** 每行是一个分组的汇总结果 */
const GROUPED_RULES = '这是汇总结果，每行是一个分组（城市、品类、日期、等级等）：可以点名分组、引用数值；facts 里的 maxAt / minAt 是最大 / 最小值所在行的分组名。';

/** 每行是一个人或一条明细记录 */
const DETAIL_RULES = '这是明细结果，每行是一个人或一条明细记录：不点名任何人或记录，不引用单行取值，只谈分布。';

const interpretSystem = (detail: boolean, note: string): string =>
  [...INTERPRET_INTRO, detail ? DETAIL_RULES : GROUPED_RULES, note].join('\n');

/** 不发样本时的提示：只有 SQL、列名与类型、行数、每列统计和数值事实 */
function statsMessages(stats: ReturnType<typeof columnStats>, detail: boolean, facts: NumericFact[]): LlmMessage[] {
  return [
    {
      role: 'system',
      content: interpretSystem(detail, '下面只有 SQL、列名与类型、行数和每列统计（非空数 nonNull、去重数 distinct，数值列还有 min / max / avg；敏感列已剔除）与数值事实 facts，没有任何数据行。'),
    },
    { role: 'user', content: JSON.stringify({ ...stats, facts }) },
  ];
}

function interpretMessages(sql: string, { columns, rows }: ReturnType<typeof redactResult>, truncated: boolean, detail: boolean, facts: NumericFact[]): LlmMessage[] {
  return [
    {
      role: 'system',
      content: interpretSystem(detail, `下面是 SQL、结果的前 ${rows.length} 行（敏感列已剔除，每格最多 ${MAX_CELL} 字）与按全部返回行算好的数值事实 facts。`),
    },
    { role: 'user', content: JSON.stringify({ sql, columns, rows, truncated, facts }) },
  ];
}

/**
 * 解读要发给模型的消息（不请求模型、不查权限，评测也用它）：samples 为真时发前 INTERPRET_ROWS 行里没被剔除的列，
 * 为假时只发 SQL、行数与留下的列的类型和统计；sent / dropped 是发送与剔除的列名（sent 为空时调用方自己报错），facts 是数值事实，detail 是不是明细结果
 */
export function interpretRequest(
  result: WorkbenchResult, sql: string, samples: boolean,
): { messages: LlmMessage[]; sent: string[]; dropped: string[]; facts: NumericFact[]; detail: boolean } {
  const normalized = normalizeWorkbenchSql(sql);
  let messages: LlmMessage[];
  let sent: string[];
  let dropped: string[];
  // 派生敏感列（起别名的敏感源列）在这里同样剔除；评测直接构造 WorkbenchResult 时没有 sensitive，集合为空、行为不变
  const derived = derivedOf(result);
  // 数值事实按全部返回行、用比发样本更严的 keep 算：标签列取值来自第 INTERPRET_ROWS 行之后也不会带出哈希；不发样本时不带所在行
  const factKeep = sendable(result, Infinity, derived);
  const detail = isDetail(result, factKeep);
  const facts = numericFacts(result, factKeep, detail || !samples);
  if (samples) {
    const redacted = redactResult(result, INTERPRET_ROWS, derived);
    ({ dropped } = redacted);
    sent = redacted.columns.map(c => c.name);
    messages = interpretMessages(normalized, redacted, result.truncated, detail, facts);
  } else {
    ({ sent, dropped } = pickColumns(result, factKeep));
    messages = statsMessages(columnStats(normalized, result, factKeep), detail, facts);
  }
  return { messages, sent, dropped, facts, detail };
}

/**
 * 成员确认后解读结果（ADR-0043）：没确认时 400，没配置模型服务时 409（都不发请求）；按 SQL 重新执行，
 * 租户打开「发送脱敏样本」时只发前 INTERPRET_ROWS 行里没被剔除的列，没打开时只发 SQL、行数与留下的列的类型和统计（samples: false，不发任何行）；
 * 全部被剔除时 400；模型失败时 422。
 * 客户端中止（signal）时 422：不写对话也不写审计（回复到手也一样，#1250）。
 * 解读存进本人的助手对话 conversationId（null 时新建；不是自己的对话时 404，不发请求），返回对话 id。
 * 解读里在发给模型的内容（含 facts 的占比与数值两两之比）里找不到出处的数字放进 unverified（原文片段，uncitedNumbers），只给页面标出，不进对话、不进审计。
 * 审计 workbench.result_interpreted { sql, rows, columns, dropped, samples, unverified }（unverified 只记个数），不记取值与解读。result 是这次执行的结果，只给页面显示表格，不进审计
 */
export async function interpretResult(
  actor: CurrentMember, sql: string, confirmed: boolean, conversationId: string | null, signal?: AbortSignal,
): Promise<{ text: string; unverified: string[]; rows: number; columns: string[]; dropped: string[]; samples: boolean; result: QueryOutcome; conversationId: string }> {
  // 整个入口包进 withLlmContext（#1257）：这次操作里的模型调用在 llm_calls 里记发起人、共用一个 turn_id（不发请求的分支不受影响）
  return withLlmContext({ actorEmail: actor.email }, async () => {
    assertCan(actor, 'sandbox');
    if (!confirmed) throw new WorkbenchAiError('请先确认要发送给模型服务的列', 400);
    const tenantId = actor.tenant.id;
    if (!(await resolveProvider(tenantId))) throw new WorkbenchAiError('未配置模型服务：请让租户管理员在「模型服务」页配置，或由平台配置默认模型服务', 409);
    if (conversationId !== null) await assertOwnConversation(actor, conversationId);
    const samples = await samplesAllowed(tenantId);
    const result = await rerun(actor, sql);
    const normalized = normalizeWorkbenchSql(sql);
    const { messages, sent, dropped } = interpretRequest(result, sql, samples);
    if (!sent.length) throw new WorkbenchAiError('没有可以发送的列：结果里的列都是系统列、敏感列或哈希', 400);
    let interpretation: string;
    try {
      ({ interpretation } = await chatJson<{ interpretation: string }>(tenantId, 'workbench_interpret', messages, INTERPRET_SCHEMA, { signal }));
      // 客户端中止（#1250）：解读到手也不继续，appendInterpretation 与审计都不写
      throwIfAborted(signal);
    } catch (e) {
      if (e instanceof LlmError) throw new WorkbenchAiError(`模型解读结果失败：${e.message}`, 422);
      throw e;
    }
    const rows = samples ? sentRows(result) : result.rows.length;
    const text = interpretation.slice(0, MAX_INTERPRETATION);
    // 出处只认发出去的 user 消息：开关关闭时结果行没发给模型，拿它当出处会让返回值间接泄露取值
    const unverified = uncitedNumbers(text, messages.find(m => m.role === 'user')?.content ?? '');
    const savedConversationId = await appendInterpretation(actor, conversationId, { sql: normalized, rows, columns: sent }, text);
    await recordAudit(getDb(), {
      tenantId, actor, action: 'workbench.result_interpreted', targetType: 'workbench',
      detail: { sql: normalized, rows, columns: sent, dropped, samples, unverified: unverified.length },
    });
    return { text, unverified, rows, columns: sent, dropped, samples, result, conversationId: savedConversationId };
  });
}
