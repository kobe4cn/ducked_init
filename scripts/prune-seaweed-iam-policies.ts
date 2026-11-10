// scripts/prune-seaweed-iam-policies.ts —— 清理本机 seaweedfs 的 /etc/iam/policies.json：删掉账号已不在 /etc/iam/identities/ 里的内联策略（#621）。
// 背景：SeaweedFS 的 DeleteUser 只删身份文件、不清内联策略，DeleteUserPolicy 对已不存在的账号只会回 NoSuchEntity，
// 测试反复建删账号会攒下删不掉的孤儿条目；每次 IAM 改动又整份重写这个文件，条目多了 filer 元数据日志跟着暴涨。
// 由 scripts/prune-seaweed-metalog.sh 每轮调用（pnpm sandcastle:prune-metalog），也可单独跑：
//   SEAWEED_FILER_URL=http://localhost:8888 node --import tsx scripts/prune-seaweed-iam-policies.ts
//
// 并发安全（写回期间 SeaweedFS 自己也可能在写这份文件，它也是整份重写）：
// - 只删不改：现存账号的策略、policies 与其他字段一律原样保留，宁可少删也不误删；
// - 写回前重新读一次文件、重列一次账号，对着最新的内容删，把丢更新的时间窗压到毫秒级；
// - 写回用 PUT 整份 JSON（不要用 multipart，2026-11-10 手工清理时 multipart 把文件写成过 0 字节）；
// - 写回后必须再读一次核对：文件能解析、保留的策略与写回前逐条一致，不一致立刻用备份原文写回。
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

const FILER = process.env.SEAWEED_FILER_URL ?? 'http://localhost:8888';
const POLICIES_URL = `${FILER}/etc/iam/policies.json`;
const IDENTITIES_URL = `${FILER}/etc/iam/identities/`;

/** 读 policies.json；不可达或没有这个文件时返回 null（此时没有可清理的） */
async function readPolicies(): Promise<string | null> {
  try {
    const res = await fetch(POLICIES_URL, { signal: AbortSignal.timeout(5000) });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** 列出 /etc/iam/identities/ 里的全部账号名（文件名是 <用户名>.json，按 lastFileName 翻页）；请求失败时抛错 */
async function listUsers(): Promise<Set<string>> {
  const users = new Set<string>();
  let last = '';
  for (;;) {
    const res = await fetch(`${IDENTITIES_URL}?lastFileName=${encodeURIComponent(last)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`列 identities 失败：HTTP ${res.status}`);
    const page = await res.json() as { Entries?: { FullPath?: string }[]; LastFileName?: string };
    const names = (page.Entries ?? [])
      .map(e => e.FullPath?.split('/').pop() ?? '')
      .filter(name => name.endsWith('.json'))
      .map(name => name.slice(0, -'.json'.length));
    for (const name of names) users.add(name);
    if (!page.LastFileName || page.LastFileName === last || names.length === 0) break;
    last = page.LastFileName;
  }
  return users;
}

async function putPolicies(body: string): Promise<void> {
  const res = await fetch(POLICIES_URL, { method: 'PUT', body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`写回 policies.json 失败：HTTP ${res.status}`);
}

/** 读文件 + 列账号后算一次清理结果；文件读不了或 JSON 解析不了时返回 null（别的进程正在写之类，跳过这一轮） */
async function planPrune(): Promise<{ raw: string; pruned: PoliciesCollection; removedUsers: string[] } | null> {
  const raw = await readPolicies();
  if (raw === null || raw.length === 0) return null;
  let collection: PoliciesCollection;
  try {
    collection = JSON.parse(raw) as PoliciesCollection;
  } catch (e) {
    throw new Error(`policies.json 不是合法 JSON（先看文件是否被写坏）：${e instanceof Error ? e.message : e}`);
  }
  const { pruned, removedUsers } = prunePolicies(collection, await listUsers());
  return { raw, pruned, removedUsers };
}

try {
  const first = await planPrune();
  if (!first) console.log('内联策略：没有 policies.json，无需清理');
  else if (first.removedUsers.length === 0) {
    console.log(`内联策略：无残留（${Object.keys((first.pruned.inlinePolicies as object | undefined) ?? {}).length} 条都对应现存账号）`);
  } else {
    // 有残留才动文件：写回前重新读、重新算，只把删掉孤儿后的最新内容写回
    const fresh = await planPrune();
    if (!fresh || fresh.removedUsers.length === 0) {
      console.log('内联策略：重新读取后已无残留（期间别的进程写过），不写回');
    } else {
      const before = fresh.raw.length;
      const body = JSON.stringify(fresh.pruned);
      await putPolicies(body);
      // 核对：文件能解析，保留的策略与写回前逐条一致，删掉的账号确实不在了；不一致立刻用备份原文写回
      let verified: PoliciesCollection | null = null;
      const reread = await readPolicies();
      try {
        verified = reread === null ? null : JSON.parse(reread) as PoliciesCollection;
      } catch { /* 下面统一按核对失败处理 */ }
      const kept = JSON.stringify(fresh.pruned.inlinePolicies ?? {});
      const okNow = verified !== null && JSON.stringify(verified.inlinePolicies ?? {}) === kept;
      if (okNow) {
        console.log(`内联策略：删除 ${fresh.removedUsers.length} 条账号已不存在的内联策略，保留 `
          + `${Object.keys(fresh.pruned.inlinePolicies as object).length} 条，policies.json ${before} → ${reread?.length ?? '?'} 字节`);
      } else {
        await putPolicies(fresh.raw);
        console.error(`内联策略清理失败：写回后核对不一致，已用备份原文写回（删除 ${fresh.removedUsers.length} 条未生效）`);
        process.exit(1);
      }
    }
  }
} catch (e) {
  console.error(`内联策略清理失败：${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
