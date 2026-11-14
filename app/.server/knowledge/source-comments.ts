// app/.server/knowledge/source-comments.ts —— 源端注释生成业务说明提案（ADR-0046 知识入口③，#523）：保存注释的同一事务里，
// 把已发布映射直接引用的源列上的列注释提成目录字段的业务说明提案（note、不带映射 ID）。注释只是数据：正文原样进提案、
// 绝不执行，成员接受后才成为业务说明。敏感字段、源视图输入、没被映射的列、表注释都不提；去重与「拒绝过不再提出」由
// proposeMany 的指纹保证。证据 ref 用注释的组合定位（注释表没有 id 列）：source_comment:<源 ID>/<schema>.<表>.<列>，version 是注释的版本号。
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Tx } from '../audit';
import { publishedCustomEntities } from '../custom-entities';
import { sourceComments } from '../db/schema';
import { publishedPlans } from '../mappings';
import { isSensitiveField } from '../pipeline/mapping-spec';
import { parseExpression } from '../../lib/mapping-expr';
import { proposeMany, type ProposalInput, type ProposeManyResult } from './proposals';

/**
 * 在保存注释的同一事务里，为本源还活着的列注释生成业务说明提案：只有已发布映射里 expr 恰好是源列名（不是源视图、不是
 * 函数或运算）的字段，且该字段不敏感，其列注释才提成 `field:<entity>.<field>` 上的 note 提案。返回 proposeMany 的结果
 */
export async function proposeFromComments(tx: Tx, tenantId: string, sourceId: string): Promise<ProposeManyResult> {
  // 本源还活着的列注释：columnName 为空串的是表注释，不提；原文去空白后为空的没有可提的内容
  const comments = (await tx.select().from(sourceComments).where(and(
    eq(sourceComments.tenantId, tenantId),
    eq(sourceComments.sourceId, sourceId),
    isNull(sourceComments.goneAt),
    ne(sourceComments.columnName, ''),
  ))).filter(c => c.commentText.trim() !== '');
  if (!comments.length) return { created: [], existing: 0, rejected: 0, invalid: [], stale: 0 };

  // 已发布映射里直接读本源源表的：源视图输入的没有源列可言（plan 带 sourceView）。敏感口径仍看全部已发布映射（all）
  const all = await publishedPlans(tx, tenantId);
  const plans = all.filter(p => p.sourceId === sourceId && !p.sourceView);
  if (!plans.length) return { created: [], existing: 0, rejected: 0, invalid: [], stale: 0 };

  const custom = await publishedCustomEntities(tx, tenantId);
  const inputs: ProposalInput[] = [];
  for (const plan of plans) {
    for (const column of plan.columns) {
      // 敏感字段先自己过滤掉，不能只靠 assertTarget 落进 invalid；任一已发布映射（别的源、源视图映射）标了就算敏感
      if (isSensitiveField({ entity: plan.entity, field: column.name }, e => custom.get(e)?.fields, all)) continue;
      // expr 恰好是源列名才算直接引用：解析失败（不该发生）与函数调用、运算都不算
      let expr;
      try {
        expr = parseExpression(column.expr);
      } catch {
        continue;
      }
      if (expr.kind !== 'column') continue;
      // publishedPlans 只比 tableName 不比 schema（与 source_tables 主键同口径），这里同样只比表名
      const comment = comments.find(c => c.tableName === plan.table && c.columnName === expr.name);
      if (!comment) continue;
      inputs.push({
        targetId: `field:${plan.entity}.${column.name}`,
        mappingId: null,
        kind: 'note',
        content: { note: comment.commentText },
        evidence: [{
          ref: `source_comment:${sourceId}/${comment.tableSchema}.${comment.tableName}.${comment.columnName}`,
          version: comment.version,
        }],
        generatorVersion: 'source-comment@1',
      });
    }
  }
  return proposeMany(tx, tenantId, inputs);
}
