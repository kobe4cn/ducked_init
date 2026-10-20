// app/.server/workbench.ts —— 数据查询工作台：分析师、数据工程师在 web 请求内对本租户只读挂载的数据湖执行一条只读 SQL（ADR-0036）。
// 只能读标准层 silver、结果层 gold、成员自己的沙箱与别人分享给他的沙箱表（白名单见 pipeline/workbench-engine.ts），最多给出 WORKBENCH_ROWS 行、不导出。
// 查询的挂载用本租户的只读数据库角色与只读对象存储账号，凭据本身写不进 catalog 与存储；
// 把查询结果保存为个人沙箱表时用可写挂载，CREATE 语句由平台拼出、只写进成员自己的 sandbox_<成员>，并在平台库登记（保存后 SANDBOX_TTL_DAYS 天过期）。
// 表的主人可以把沙箱表只读分享给本租户有沙箱权限的成员；每次查询都按被分享人当前的角色与分享登记重新算能读的表，不缓存。
// 每个租户同时只有一个交互查询（PG 事务级 advisory lock，持有到查询结束），不经任务队列、不占正式任务名额；
// 超时或客户端中止请求时 interrupt 本进程里的这个查询。每次查询都记审计（SQL、耗时、行数，失败时加原因），不记查询结果
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { assertCan, can } from './access';
import { recordAudit, type AuditAction, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { getDb, type Db } from './db/client';
import { members, SANDBOX_TTL_DAYS, sandboxShares, sandboxTables, type tenantLakes } from './db/schema';
import { ensureReadOnlyLakeAccess, lakeReady, lakeRow, lakeSpecOf, readOnlyAccessReady, readOnlyLakeSpecOf } from './lake';
import { openTenantLake, redactLakeSecrets, type LakeSpec, type TenantLakeSession } from './pipeline/lake-engine';
import {
  checkWorkbenchSql, normalizeWorkbenchSql, runWorkbenchQuery, sandboxSchema, saveSandboxTable, WorkbenchSqlError, type SandboxAccess, type WorkbenchResult,
} from './pipeline/workbench-engine';
import { lockForSave } from './sandbox';
import { normalizeEmail } from './tenants';

export { SANDBOX_TTL_DAYS } from './db/schema';
export { sandboxSchema } from './pipeline/workbench-engine';

/** 可以展示给成员的错误 */
export class WorkbenchError extends Error {
  constructor(message: string, readonly status: 400 | 429 = 400) { super(message); }
}

/** 最多给出的行数、默认超时与所用的计算资源 */
export const WORKBENCH_ROWS = 10_000;
export const WORKBENCH_TIMEOUT_MS = 60_000;
const WORKBENCH_LIMITS = { memoryLimitMb: 1024, threads: 2 };

type TenantLake = typeof tenantLakes.$inferSelect;

export interface QueryOutcome extends WorkbenchResult { durationMs: number }

/** 查询被打断的原因与报给成员的说法 */
type Stop = 'timeout' | 'cancel';
const STOP_MESSAGES: Record<Stop, (timeoutMs: number) => string> = {
  timeout: timeoutMs => `查询超过 ${timeoutMs / 1000} 秒，已中断`,
  cancel: () => '查询已取消',
};

/**
 * 在本租户只读挂载的数据湖上执行 SQL（还能读成员自己的沙箱与分享给他的表），返回列、前 WORKBENCH_ROWS 行、是否截断与耗时。
 * 本租户已有查询在运行时抛出 429；SQL 不合规、执行出错、超时（timeoutMs）或 signal 中止时抛出 WorkbenchError（报错里抹掉凭据）
 */
export async function runQuery(
  actor: CurrentMember, rawSql: string, signal?: AbortSignal, { timeoutMs = WORKBENCH_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<QueryOutcome> {
  const query = normalizeWorkbenchSql(rawSql);
  return inWorkbench(actor, { signal, timeoutMs, readOnly: true }, async ({ session, throwIfStopped, started, tx }) => {
    const checked = await checkWorkbenchSql(session.con, query, await sandboxAccess(tx, actor));
    throwIfStopped();
    const read = await runWorkbenchQuery(session.con, checked, { limit: WORKBENCH_ROWS });
    return { ...read, durationMs: Date.now() - started };
  }, (result, durationMs, error) => ({
    action: 'workbench.query',
    detail: { sql: query, durationMs: result?.durationMs ?? durationMs, rows: result?.rows.length ?? 0, truncated: result?.truncated ?? false, ...(error && { error }) },
  }));
}

/** 保存好的沙箱表 */
export interface SandboxTable { name: string; rowCount: number; createdAt: Date; expiresAt: Date }
/** 「我的沙箱表」里的一行：另带分享给了谁（邮箱，按字母排序） */
export interface ListedSandboxTable extends SandboxTable { sharedWith: string[] }

/** 别人分享给成员的沙箱表：主人的邮箱、主人的沙箱 schema、表名与过期时间 */
export interface SharedWithMe { owner: string; schema: string; name: string; expiresAt: Date }

/**
 * 把一条 SELECT 的结果存为成员沙箱里的表 name（湖里的 sandbox_<成员>.name；同名表覆盖，过期时间重新从现在算起），返回登记的表。
 * 在本租户可写挂载的数据湖上、与工作台查询同一把并发锁下执行：先按工作台白名单校验（可以读分享来的表），再由平台拼出 CREATE 语句，
 * 目标永远是成员自己的沙箱。
 * 同名表已到期、正在过期清理时拒绝（lockForSave）。成功、失败都记审计 sandbox.save；出错时与 runQuery 一样抛出 WorkbenchError
 */
export async function saveAsSandbox(
  actor: CurrentMember, name: string, rawSql: string, signal?: AbortSignal, { timeoutMs = WORKBENCH_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<SandboxTable> {
  const query = normalizeWorkbenchSql(rawSql);
  const schema = sandboxSchema(actor.memberId);
  return inWorkbench(actor, { signal, timeoutMs, readOnly: false }, async ({ session, throwIfStopped, tx }) => {
    if (!await lockForSave(tx, actor.tenant.id, actor.memberId, name)) throw new WorkbenchSqlError('这张沙箱表已到期、正在清理，请稍后再保存或换个表名');
    const checked = await checkWorkbenchSql(session.con, query, await sandboxAccess(tx, actor));
    throwIfStopped();
    const rowCount = await saveSandboxTable(session.con, schema, name, checked);
    const now = new Date();
    const values = { rowCount, createdAt: now, expiresAt: new Date(now.getTime() + SANDBOX_TTL_DAYS * 86_400_000), expiredAt: null };
    await tx.insert(sandboxTables).values({ tenantId: actor.tenant.id, memberId: actor.memberId, name, ...values })
      .onConflictDoUpdate({ target: [sandboxTables.tenantId, sandboxTables.memberId, sandboxTables.name], set: values });
    return { name, ...values };
  }, (result, durationMs, error) => ({
    action: 'sandbox.save',
    detail: { name, sql: query, durationMs, rows: result?.rowCount ?? 0, ...(error && { error }) },
  }));
}

/** 成员自己还没过期的沙箱表与各自分享给了谁，按表名排序 */
export async function listSandboxTables(actor: CurrentMember): Promise<ListedSandboxTable[]> {
  assertCan(actor, 'sandbox');
  const db = getDb();
  const tables = await db.select({
    id: sandboxTables.id, name: sandboxTables.name, rowCount: sandboxTables.rowCount, createdAt: sandboxTables.createdAt, expiresAt: sandboxTables.expiresAt,
  }).from(sandboxTables)
    .where(and(eq(sandboxTables.tenantId, actor.tenant.id), eq(sandboxTables.memberId, actor.memberId), isNull(sandboxTables.expiredAt)))
    .orderBy(asc(sandboxTables.name));
  const shares = tables.length ? await db.select({ tableId: sandboxShares.tableId, email: members.email }).from(sandboxShares)
    .innerJoin(members, eq(members.id, sandboxShares.memberId))
    .where(inArray(sandboxShares.tableId, tables.map(t => t.id))).orderBy(asc(members.email)) : [];
  return tables.map(({ id, ...t }) => ({ ...t, sharedWith: shares.filter(s => s.tableId === id).map(s => s.email) }));
}

/**
 * 别人分享给成员、还没过期的沙箱表，按主人与表名排序。按当前的成员关系算：成员被移出租户时分享随之删除，
 * 主人与表都限定在本租户；查看者没有沙箱权限，到不了这里
 */
async function sharedToMember(db: Tx | Db, actor: CurrentMember): Promise<SharedWithMe[]> {
  const rows = await db.select({ owner: members.email, ownerId: sandboxTables.memberId, name: sandboxTables.name, expiresAt: sandboxTables.expiresAt })
    .from(sandboxShares)
    .innerJoin(sandboxTables, eq(sandboxTables.id, sandboxShares.tableId))
    .innerJoin(members, and(eq(members.id, sandboxTables.memberId), eq(members.tenantId, actor.tenant.id)))
    .where(and(eq(sandboxShares.memberId, actor.memberId), eq(sandboxTables.tenantId, actor.tenant.id), isNull(sandboxTables.expiredAt)))
    .orderBy(asc(members.email), asc(sandboxTables.name));
  return rows.map(({ ownerId, ...r }) => ({ ...r, schema: sandboxSchema(ownerId) }));
}

/** 别人分享给成员、还没过期的沙箱表（工作台「分享给我的」） */
export async function listSharedWithMe(actor: CurrentMember): Promise<SharedWithMe[]> {
  assertCan(actor, 'sandbox');
  return sharedToMember(getDb(), actor);
}

/** 这次查询能读的沙箱：自己的沙箱 schema 与此刻分享给自己的表 */
async function sandboxAccess(tx: Tx, actor: CurrentMember): Promise<SandboxAccess> {
  const shared = (await sharedToMember(tx, actor)).map(t => ({ schema: t.schema, table: t.name }));
  return { sandbox: sandboxSchema(actor.memberId), shared };
}

/**
 * 把自己的沙箱表 name 只读分享给本租户的成员 email（已分享过时不变），记审计 sandbox.share，返回规范化后的邮箱。
 * 没有这张表、表已到期、对方不是本租户成员、没有沙箱权限（查看者）或是自己时抛出 WorkbenchError，不记审计
 */
export async function shareSandboxTable(actor: CurrentMember, name: string, email: string) {
  assertCan(actor, 'sandbox');
  const target = normalizeEmail(email);
  await getDb().transaction(async tx => {
    const table = await ownTable(tx, actor, name);
    if (table.expiresAt <= new Date()) throw new WorkbenchError(`沙箱表 ${name} 已到期，不能分享`);
    const member = await memberByEmail(tx, actor, target);
    if (member.id === actor.memberId) throw new WorkbenchError('不用分享给自己');
    if (!can(member.role, 'sandbox')) throw new WorkbenchError(`${target} 没有沙箱权限，不能分享给他们`);
    await tx.insert(sandboxShares).values({ tableId: table.id, memberId: member.id }).onConflictDoNothing();
    await recordAudit(tx, { tenantId: actor.tenant.id, actor, action: 'sandbox.share', targetType: 'sandbox_table', targetId: table.id, detail: { name, member: target } });
  });
  return target;
}

/** 撤销把自己的沙箱表 name 分享给成员 email，记审计 sandbox.unshare，返回规范化后的邮箱；没有这张表或没有分享给对方时抛出 WorkbenchError */
export async function unshareSandboxTable(actor: CurrentMember, name: string, email: string) {
  assertCan(actor, 'sandbox');
  const target = normalizeEmail(email);
  await getDb().transaction(async tx => {
    const table = await ownTable(tx, actor, name);
    const member = await memberByEmail(tx, actor, target);
    const deleted = await tx.delete(sandboxShares).where(and(eq(sandboxShares.tableId, table.id), eq(sandboxShares.memberId, member.id))).returning();
    if (!deleted.length) throw new WorkbenchError(`沙箱表 ${name} 没有分享给 ${target}`);
    await recordAudit(tx, { tenantId: actor.tenant.id, actor, action: 'sandbox.unshare', targetType: 'sandbox_table', targetId: table.id, detail: { name, member: target } });
  });
  return target;
}

/** 成员自己还没过期的沙箱表 name 的登记（锁住这一行，与过期标记互斥）；没有时抛出 WorkbenchError */
async function ownTable(tx: Tx, actor: CurrentMember, name: string) {
  const [table] = await tx.select({ id: sandboxTables.id, expiresAt: sandboxTables.expiresAt }).from(sandboxTables)
    .where(and(eq(sandboxTables.tenantId, actor.tenant.id), eq(sandboxTables.memberId, actor.memberId), eq(sandboxTables.name, name), isNull(sandboxTables.expiredAt)))
    .for('update');
  if (!table) throw new WorkbenchError(`没有沙箱表 ${name}`);
  return table;
}

/** 本租户邮箱为 email 的成员；没有时抛出 WorkbenchError（其他租户的成员也一样） */
async function memberByEmail(tx: Tx, actor: CurrentMember, email: string) {
  const [member] = await tx.select({ id: members.id, role: members.role }).from(members)
    .where(and(eq(members.tenantId, actor.tenant.id), eq(members.email, email)));
  if (!member) throw new WorkbenchError(`本租户没有成员 ${email}`);
  return member;
}

/**
 * 工作台的一次操作：在 PG 事务里拿本租户的并发锁（拿不到抛 429），挂载数据湖（readOnly 时用只读凭据），执行 work，
 * 超时或 signal 中止时 interrupt；work 在两步之间调 throwIfStopped()，挂载或上一步期间已被打断时就此停下。
 * 不论成败都在同一事务里按 audit 给出的动作与详情记审计（error 是展示给成员的原因），失败时抛出 WorkbenchError
 */
async function inWorkbench<T>(
  actor: CurrentMember,
  { signal, timeoutMs, readOnly }: { signal?: AbortSignal; timeoutMs: number; readOnly: boolean },
  work: (ctx: { session: TenantLakeSession; throwIfStopped: () => void; started: number; tx: Tx }) => Promise<T>,
  audit: (result: T | undefined, durationMs: number, error: string | undefined) => { action: AuditAction; detail: Record<string, unknown> },
): Promise<T> {
  assertCan(actor, 'sandbox');
  const tenantId = actor.tenant.id;
  const lake = await lakeRow(tenantId);
  if (!lake || !lakeReady(lake)) throw new WorkbenchError('本租户的数据湖还没有初始化');
  const outcome = await getDb().transaction(async tx => {
    const { rows: [{ locked }] } = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtext(${`workbench:${tenantId}`})) AS locked`);
    if (!locked) return { kind: 'busy' as const };
    const started = Date.now();
    let result: { value: T } | undefined;
    let error: string | undefined;
    let stopped: Stop | undefined;
    let session: TenantLakeSession | undefined;
    let spec: LakeSpec | undefined;
    const interrupt = (why: Stop) => { stopped ??= why; session?.con.interrupt(); };
    const onAbort = () => interrupt('cancel');
    const timer = setTimeout(() => interrupt('timeout'), timeoutMs);
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) onAbort();
    // 挂载或校验期间到了超时、被中止：interrupt 打断不到还没开始的查询，在这里停下
    const throwIfStopped = () => { if (stopped) throw new Error(stopped); };
    try {
      spec = readOnly ? await readOnlySpec(lake) : lakeSpecOf(lake);
      session = await openTenantLake(spec, WORKBENCH_LIMITS, undefined, { readOnly });
      throwIfStopped();
      result = { value: await work({ session, throwIfStopped, started, tx }) };
    } catch (e) {
      error = stopped ? STOP_MESSAGES[stopped](timeoutMs)
        : e instanceof WorkbenchSqlError ? e.message
          : `查询出错：${spec ? redactLakeSecrets((e as Error).message, spec) : (e as Error).message}`;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      session?.close();
    }
    const { action, detail } = audit(result?.value, Date.now() - started, error);
    await recordAudit(tx, { tenantId, actor, action, targetType: 'workbench', detail });
    return result ? { kind: 'ok' as const, value: result.value } : { kind: 'failed' as const, error: error! };
  });
  if (outcome.kind === 'busy') throw new WorkbenchError('本租户已有查询在运行，请等它结束后再试', 429);
  if (outcome.kind === 'failed') throw new WorkbenchError(outcome.error);
  return outcome.value;
}

/**
 * 只读凭据给出的挂载信息：即使白名单被绕过，写入也会被数据库与存储服务拒绝。
 * 本功能上线前开通的租户还没有只读凭据，在这里补建（出错照常记审计）
 */
async function readOnlySpec(lake: TenantLake) {
  if (readOnlyAccessReady(lake)) return readOnlyLakeSpecOf(lake);
  await ensureReadOnlyLakeAccess(lake.tenantId);
  return readOnlyLakeSpecOf((await lakeRow(lake.tenantId))!);
}
