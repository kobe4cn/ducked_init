// app/.server/catalog/tx.ts —— 成员事务与目录版本（ADR-0054）：catalogTx(tenantId, fn) 开事务，用 AsyncLocalStorage 放上下文，
// recordAudit 只把白名单目录动作登记进上下文；fn 正常返回后如果登记过，就在同一事务的最后一步记一版目录版本（原因取第一个目录动作），
// 所以快照包含事务里的全部写入，多个目录动作也只记一版。嵌套 catalogTx、审计别的租户的目录动作与在 catalogTx 外审计目录动作
// 都是写代码时的错误，生产环境也抛错。versions.ts 只在记版本时动态 import：它静态 import ./load，load 又静态 import mappings、
// custom-entities 等会 import 本模块的模块，静态引入就成环；全代码库只此一处动态 import（ADR-0054）
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuditAction, Tx } from '../audit';
import { getDb } from '../db/client';

/** 会改变目录结构或含义的审计动作；只发起停用（mapping.disable_requested）目录不变，不在里面 */
export const CATALOG_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'mapping.published', 'mapping.disabled', 'mapping.restored',
  'custom_entity.published', 'custom_entity.deleted',
  'merge_group.published', 'source_view.published',
  'source.scope_changed', 'source.registered', 'source.updated', 'source.deleted',
  'definition.published', 'definition.deleted',
  'template.published', 'template.auto_enabled',
  'business_note.updated', 'alias.added', 'alias.retired', 'semantic_claim.saved',
  'analysis_subject.created', 'analysis_subject.renamed', 'analysis_subject.deleted',
  'subject_membership.added', 'subject_membership.removed',
]);

/** catalogTx 的上下文：事务所属租户与登记过的目录动作（按登记顺序） */
export interface CatalogTxContext { tenantId: string; actions: AuditAction[] }

const storage = new AsyncLocalStorage<CatalogTxContext>();

/** 当前 catalogTx 的上下文；不在 catalogTx 里时为 undefined。给 recordAudit 登记目录动作用 */
export const currentCatalogTx = (): CatalogTxContext | undefined => storage.getStore();

/**
 * 在一个事务里做成员操作：白名单目录动作经 recordAudit 登记进上下文，fn 正常返回后在同一事务的最后一步
 * 记一版目录版本，没有目录动作不记；fn 抛错则整个事务回滚、不记版本。嵌套调用抛错。
 * 接收 tx 参数的函数（如 addAliasTx）自己不开 catalogTx，由最外层调用方负责
 */
export async function catalogTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const outer = storage.getStore();
  if (outer) throw new Error(`嵌套 catalogTx：外层租户 ${outer.tenantId}，内层租户 ${tenantId}`);
  const ctx: CatalogTxContext = { tenantId, actions: [] };
  return getDb().transaction(tx => storage.run(ctx, async () => {
    const result = await fn(tx);
    const { actions } = ctx;
    if (actions.length) {
      const { recordCatalogVersion } = await import('./versions'); // 为什么动态 import：见头注释
      await recordCatalogVersion(tx, tenantId, actions[0]!);
    }
    return result;
  }));
}
