// app/.server/publish-rules.ts —— 双人发布规则（ADR-0015）：映射与模板定义共用。草稿由最后保存它的人以外的另一位有发布权限的成员发布，
// 发布后版本锁定；这里判断谁发布不了、为什么，以及保存草稿时记作者、发布前确认草稿没被改过。除 publisherCount 查库外都是纯函数
import { and, eq, inArray, sql } from 'drizzle-orm';
import { can, deniedReason } from './access';
import type { CurrentMember } from './auth';
import { getDb } from './db/client';
import { members, ROLES } from './db/schema';

/**
 * 有发布权限的成员发布不了某一版的原因（不是草稿、最后保存这一版草稿的是自己）；可以发布时为 null。发布权限由调用方另行检查。
 * 每一处改动都要由另一个人看过才能发布：最后保存的人之前的改动，最后保存的人保存时已经看过
 */
export function publishBlocker(actor: CurrentMember, version: { status: string; lastEditor: string }) {
  if (version.status !== 'draft') return '已发布的版本已锁定';
  if (version.lastEditor === actor.email) return '你最后改了这一版草稿，需由另一位数据工程师或管理员发布';
  return null;
}

/**
 * 给成员看的、当前成员发布不了这一版草稿的原因（没有发布权限、最后保存的是自己、租户里没有别人能发布）；可以发布或不是草稿时为 null。
 * version.publishBlocker 是 publishBlocker 的结果，publishers 是本租户有发布权限的成员人数
 */
export function publishReason(actor: CurrentMember, version: { status: string; lastEditor: string; publishBlocker: string | null }, publishers: number) {
  if (version.status !== 'draft') return null;
  if (!can(actor.role, 'publish')) return deniedReason('publish');
  if (version.publishBlocker && publishers === 1 && version.lastEditor === actor.email) return '本租户只有你有发布权限，请先邀请一位数据工程师或管理员';
  return version.publishBlocker;
}

/** 本租户有发布权限的成员人数 */
export async function publisherCount(tenantId: string) {
  const [{ n }] = await getDb().select({ n: sql<number>`count(*)::int` }).from(members)
    .where(and(eq(members.tenantId, tenantId), inArray(members.role, ROLES.filter(r => can(r, 'publish')))));
  return n;
}

/** 保存草稿后的作者列表：加上保存的人（已在其中时不变） */
export const withAuthor = (authors: string[], email: string) => (authors.includes(email) ? authors : [...authors, email]);

/** 发布前加锁后重新读出的版本与检查时的草稿不同（已被修改、发布或丢弃）。updatedAt 按毫秒比对，草稿时间须在应用层写入 */
export const isStale = (current: { status: string; updatedAt: Date } | undefined, draft: { updatedAt: Date }) =>
  !current || current.status !== 'draft' || current.updatedAt.getTime() !== draft.updatedAt.getTime();
