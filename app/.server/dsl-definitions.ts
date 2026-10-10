// app/.server/dsl-definitions.ts —— 指标与标签定义（ADR-0025）：成员用 YAML 写定义，按种类（pipeline/dsl 的注册表）校验通过才能保存为草稿。
// 键在租户与种类内唯一；每个定义同时只有一份草稿，再次保存改的是同一份，记下作者与最后保存的人，之后按映射同样的规则双人发布（ADR-0015）。
// 校验对照本租户已发布的自定义实体登记与已发布映射的扩展字段；定义页展示编译出的 SQL。一律限定在操作者所属租户内
import { and, desc, eq } from 'drizzle-orm';
import { assertCan } from './access';
import { recordAudit, type Tx } from './audit';
import type { CurrentMember } from './auth';
import { publishedCustomEntities } from './custom-entities';
import { getDb, isUniqueViolation } from './db/client';
import { dslDefinitions, dslVersions } from './db/schema';
import { publishedPlans } from './mappings';
import { DSL_KINDS, isDslKind, type DslKind } from './pipeline/dsl';
import type { DslContext, DslIssue } from './pipeline/dsl/metric-spec';
import { withAuthor } from './publish-rules';
import { todayUtc } from './templates';

/** 定义的键：小写字母开头，只用小写字母、数字与下划线 */
export const DSL_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/** 可以展示给成员的业务错误；定义校验不通过时带上按行列的问题 */
export class DslError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400, readonly issues: DslIssue[] = []) { super(message); }
}

function requireKind(kind: string): asserts kind is DslKind {
  if (!isDslKind(kind)) throw new DslError(`没有 ${kind} 这种定义`, 404);
}

/** 校验与编译定义要用的本租户上下文：已发布的自定义实体登记与已发布映射的合并计划 */
export async function dslContext(db: Tx | ReturnType<typeof getDb>, tenantId: string): Promise<DslContext> {
  return { published: await publishedCustomEntities(db, tenantId), plans: await publishedPlans(db, tenantId) };
}

/** 校验定义，不通过时抛出带问题的 DslError */
async function assertValid(kind: DslKind, tenantId: string, yaml: string) {
  const result = DSL_KINDS[kind].check(yaml, await dslContext(getDb(), tenantId));
  if (!result.ok) throw new DslError(`${DSL_KINDS[kind].label}定义有 ${result.issues.length} 个问题，没有保存`, 400, result.issues);
  return result.spec;
}

const ofDefinition = (tenantId: string, kind: DslKind, key: string) =>
  and(eq(dslDefinitions.tenantId, tenantId), eq(dslDefinitions.kind, kind), eq(dslDefinitions.key, key));

/** 新建定义：键要合规且在本租户这一种类里没用过，YAML 校验通过后保存为第 1 版草稿 */
export async function createDefinition(actor: CurrentMember, kind: string, key: string, yaml: string) {
  assertCan(actor, 'definitions:draft');
  requireKind(kind);
  if (!DSL_KEY_PATTERN.test(key)) throw new DslError('键要以小写字母开头，只用小写字母、数字与下划线，最长 63 个字符');
  await assertValid(kind, actor.tenant.id, yaml);
  try {
    return await getDb().transaction(async tx => {
      const [definition] = await tx.insert(dslDefinitions).values({ tenantId: actor.tenant.id, kind, key }).returning({ id: dslDefinitions.id });
      await tx.insert(dslVersions).values({ definitionId: definition!.id, version: 1, yaml, authors: [actor.email], lastEditor: actor.email });
      await recordAudit(tx, {
        tenantId: actor.tenant.id, actor, action: 'definition.drafted', targetType: 'definition', targetId: definition!.id, detail: { kind, key, version: 1 },
      });
      return { kind, key, version: 1 };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new DslError(`已经有键为 ${key} 的${DSL_KINDS[kind].label}`);
    throw e;
  }
}

/**
 * 保存草稿：已有草稿时改它（记下又一位作者与最后保存的人），否则在最新版本之上新建一版草稿（已发布的版本不变）。
 * 定义要已经存在（新建走 createDefinition）。返回草稿的版本号
 */
export async function saveDslDraft(actor: CurrentMember, kind: string, key: string, yaml: string) {
  assertCan(actor, 'definitions:draft');
  requireKind(kind);
  await assertValid(kind, actor.tenant.id, yaml);
  return getDb().transaction(async tx => {
    // 锁住定义行：与发布、丢弃互斥
    const [locked] = await tx.select({ id: dslDefinitions.id }).from(dslDefinitions).where(ofDefinition(actor.tenant.id, kind, key)).for('update');
    if (!locked) throw new DslError(`没有键为 ${key} 的${DSL_KINDS[kind].label}`, 404);
    const [latest] = await tx.select().from(dslVersions)
      .where(eq(dslVersions.definitionId, locked.id)).orderBy(desc(dslVersions.version)).limit(1);
    if (latest?.status === 'draft') {
      await tx.update(dslVersions).set({ yaml, authors: withAuthor(latest.authors, actor.email), lastEditor: actor.email, updatedAt: new Date() })
        .where(eq(dslVersions.id, latest.id));
      return latest.version;
    }
    const version = (latest?.version ?? 0) + 1;
    await tx.insert(dslVersions).values({ definitionId: locked.id, version, yaml, authors: [actor.email], lastEditor: actor.email });
    await recordAudit(tx, {
      tenantId: actor.tenant.id, actor, action: 'definition.drafted', targetType: 'definition', targetId: locked.id, detail: { kind, key, version },
    });
    return version;
  });
}

/**
 * 本租户的一个定义：各版本（最新的在前）、草稿与最近的已发布版本，
 * 以及最新一版（有草稿时是草稿）按今天（UTC）编译出的 SQL；它对照当前的登记与映射不再通过校验时给出问题
 */
export async function getDefinition(actor: CurrentMember, kind: string, key: string) {
  assertCan(actor, 'definitions:read');
  requireKind(kind);
  const versions = await getDb().select({
    version: dslVersions.version, status: dslVersions.status, yaml: dslVersions.yaml,
    authors: dslVersions.authors, lastEditor: dslVersions.lastEditor,
    publishedByEmail: dslVersions.publishedByEmail, publishedAt: dslVersions.publishedAt, updatedAt: dslVersions.updatedAt,
  }).from(dslVersions)
    .innerJoin(dslDefinitions, eq(dslDefinitions.id, dslVersions.definitionId))
    .where(ofDefinition(actor.tenant.id, kind, key))
    .orderBy(desc(dslVersions.version));
  if (!versions.length) throw new DslError(`没有键为 ${key} 的${DSL_KINDS[kind].label}`, 404);
  const draft = versions.find(v => v.status === 'draft') ?? null;
  const published = versions.find(v => v.status === 'published') ?? null;
  const ctx = await dslContext(getDb(), actor.tenant.id);
  const result = DSL_KINDS[kind].check(versions[0]!.yaml, ctx);
  return {
    kind,
    key,
    label: DSL_KINDS[kind].label,
    versions,
    draft,
    published,
    compiled: result.ok
      ? { version: versions[0]!.version, sql: DSL_KINDS[kind].compile(result.spec, ctx, todayUtc()), issues: [] as DslIssue[] }
      : { version: versions[0]!.version, sql: null, issues: result.issues },
  };
}
