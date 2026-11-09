// app/.server/knowledge/apply-pack.ts —— 应用标准模板包（ADR-0046 知识入口②，#505、#520）：把平台随代码发布的标准知识包（lib/standard-pack.ts）按租户
// 实际用到的实体展开成知识提案，成员在集中页接受（可以先改值）才生效，包不直接写知识。只处理已发布映射写入的实体的条目——tenantCatalog 不论有没有映射
// 都列出全部标准实体，不能用它判断实体在不在用。目标上已有同类知识的跳过（计 skipped）：别名与已有别名去首尾空白、不分大小写地相同；口径该类型已有声明
// （不管取值，成员声明过的优先于包）；说明已有非空值（清空过的空串不算）。重跑不重复、拒绝过的不再出现、内容变了提新提案、旧的未处理提案保留，
// 都由 proposeMany 的指纹（目标 + 种类 + 内容 + 依据摘要，不含 generatorVersion 与证据）保证。调用方负责权限与事务；包是代码数据，
// packErrors 校验不过说明包本身有 bug，直接抛错不用温和的 invalid 计数
import { type Tx } from '../audit';
import { currentNotes, NOTE_MAX_LENGTH } from '../business-notes';
import { publishedPlans } from '../mappings';
import { noteKey } from '../../lib/business-note-key';
import { PACK_VERSION, packErrors, packTargetOf, STANDARD_PACK, type PackEntry } from '../../lib/standard-pack';
import { ALIAS_MAX_LENGTH } from './aliases';
import { knowledgeKey, loadKnowledge } from './catalog';
import { proposeMany, type ProposalInput, type ProposeManyResult } from './proposals';

/**
 * 在给定事务里应用标准模板包：只对已发布映射写入的实体生成提案，目标上已有同类知识的跳过。
 * pack 与 version 可换（包升级后用新包与新版本号再跑），默认是当前代码里的 STANDARD_PACK 与 PACK_VERSION。
 * 返回 proposeMany 的结果加 skipped（跳过计数）
 */
export async function applyStandardPack(
  tx: Tx, tenantId: string,
  pack: readonly PackEntry[] = STANDARD_PACK,
  version: number = PACK_VERSION,
): Promise<ProposeManyResult & { skipped: number }> {
  const errors = packErrors(pack, { aliasMaxLength: ALIAS_MAX_LENGTH, noteMaxLength: NOTE_MAX_LENGTH });
  if (errors.length) throw new Error(`标准模板包不合法：\n${errors.join('\n')}`);

  const entities = new Set((await publishedPlans(tx, tenantId)).map(p => p.entity));
  const { byTarget } = await loadKnowledge(tx, tenantId);
  // 字段说明按 entity.field 存在 business_notes 里、不进 byTarget（byTarget 里只有实体、指标、标签的说明）
  const notes = await currentNotes(tx, tenantId);
  const evidence = [{ ref: 'pack:standard', version }];
  const generatorVersion = `standard-pack@${version}`;
  const inputs: ProposalInput[] = [];
  let skipped = 0;
  for (const entry of pack) {
    const target = packTargetOf(entry.targetId);
    if (!target || !entities.has(target.entity)) continue;
    const k = byTarget.get(knowledgeKey(entry.targetId));
    const note = target.field ? notes.get(noteKey(target.entity, target.field)) : k?.note;
    for (const alias of entry.aliases ?? []) {
      // 提出时会去首尾空白，比较也按去空白后的值
      const normalized = alias.trim().toLowerCase();
      if (k?.aliases?.some(a => a.trim().toLowerCase() === normalized)) { skipped++; continue; }
      inputs.push({ targetId: entry.targetId, mappingId: null, kind: 'alias', content: { alias }, evidence, generatorVersion });
    }
    for (const claim of entry.claims ?? []) {
      if (k?.claims?.some(c => c.type === claim.type)) { skipped++; continue; }
      inputs.push({ targetId: entry.targetId, mappingId: null, kind: 'claim', content: { type: claim.type, value: claim.value }, evidence, generatorVersion });
    }
    if (entry.note !== undefined) {
      if (note?.trim()) { skipped++; continue; }
      inputs.push({ targetId: entry.targetId, mappingId: null, kind: 'note', content: { note: entry.note }, evidence, generatorVersion });
    }
  }
  return { ...await proposeMany(tx, tenantId, inputs), skipped };
}
