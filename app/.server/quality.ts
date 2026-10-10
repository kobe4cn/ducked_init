// app/.server/quality.ts —— 数据质量告警（ADR-0026）：结果层任务因 error 级断言失败时，给租户管理员发邮件并记审计。
// 邮件与审计只写断言名、实体与不合格行数，不写行内容
import { and, eq } from 'drizzle-orm';
import { recordAudit } from './audit';
import { getDb } from './db/client';
import { members } from './db/schema';
import { getMailer } from './mailer';
import { describeAssertion, failedErrors, type AssertionResult } from './pipeline/assertions';
import { HANDLERS, type TaskKind } from './pipeline/handlers';

/** 任务结果里有失败的 error 级断言时告警；没有时什么也不做。单个管理员发信失败只记日志，不影响其他人 */
export async function alertAssertionFailure(tenantId: string, task: { id: string; kind: TaskKind }, result: Record<string, unknown> | undefined) {
  const failed = failedErrors((result?.assertions as AssertionResult[] | undefined) ?? []);
  if (!failed.length) return;
  const { label } = HANDLERS[task.kind];
  const summaries = failed.map(describeAssertion);
  await recordAudit(getDb(), {
    tenantId, system: true, action: 'assertion.failed', targetType: 'task', targetId: task.id,
    detail: { task: label, summaries, assertions: failed },
  });
  const admins = await getDb().select({ email: members.email }).from(members)
    .where(and(eq(members.tenantId, tenantId), eq(members.role, 'admin')));
  const text = [
    `「${label}」任务（${task.id}）计算前的数据检查没有通过，本次没有产出新快照，分析页继续使用上一版：`,
    '',
    ...summaries.map(s => `- ${s}`),
    '',
    '请检查对应映射的源数据，修正后重新合并并重算。',
  ].join('\n');
  for (const { email } of admins) {
    await getMailer().send({ to: email, subject: `数据检查未通过：${label}`, text })
      .catch(e => console.error(`[告警] 给 ${email} 发断言失败邮件出错`, e));
  }
}
