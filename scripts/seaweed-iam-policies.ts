// scripts/seaweed-iam-policies.ts —— policies.json 孤儿内联策略清理的纯函数（#621），供 scripts/prune-seaweed-iam-policies.ts
// 调用，测试直接导入本文件（不连 filer；导入那个脚本会真的读写本机的 policies.json）。
import { cmp } from '../app/lib/compare';

/** filer 上 policies.json 的形状（SeaweedFS credential/filer_etc 的 PoliciesCollection），未知字段原样保留 */
export type PoliciesCollection = { [key: string]: unknown };

export function prunePolicies(collection: PoliciesCollection, existingUsers: ReadonlySet<string>): {
  pruned: PoliciesCollection;
  removedUsers: string[];
} {
  const inline = collection.inlinePolicies;
  if (inline === null || typeof inline !== 'object' || Array.isArray(inline)) return { pruned: collection, removedUsers: [] };
  const entries = inline as Record<string, unknown>;
  const removedUsers = Object.keys(entries).filter(user => !existingUsers.has(user)).sort(cmp);
  if (removedUsers.length === 0) return { pruned: collection, removedUsers: [] };
  const prunedInline: Record<string, unknown> = { ...entries };
  for (const user of removedUsers) delete prunedInline[user];
  return { pruned: { ...collection, inlinePolicies: prunedInline }, removedUsers };
}
