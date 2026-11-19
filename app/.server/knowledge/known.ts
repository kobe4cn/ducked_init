// app/.server/knowledge/known.ts —— 粘贴导入与按主题生成落库前比对已生效知识的纯函数（ADR-0046，#948）：模型的输入里只有条目的
// {id, kind, name}（import-draft / suggest），看不到目标上已生效的知识，会原样再提成员刚写进去的口径、别名与说明——审阅人
// 逐条点「接受」也不会有任何变化。dropKnown 按目录条目（调用方调模型前读的 tenantCatalog，条目里已带着要比的数据）把和已生效
// 知识相同的提案丢掉、计入 skipped，交给 proposeMany 的就只剩可能带来变化的；调模型期间新写的知识比不到，可接受。
// 与 apply-pack 的过滤不是一条规则（那边同类型已有声明就跳过、不看取值，说明非空就跳过，也不比系统口径），不共用函数：
// 本票要求同类型同取值才跳过，取值不同的声明照常提出——那是要人判断的冲突。比较规则：
// - alias：去首尾空白、不分大小写地相同（与 addAlias 入库的规范化一致）
// - claim：同类型同取值（取值是登记表枚举字符串，直接比较）；和成员声明比，也和系统口径比（只有指标与标签有系统口径）。
//   系统口径取值 unknown 是「从结构派不出来」（claimsFrom 每种类型都填值），不是声明了未知，不参与比较——否则无证据、
//   被 outputToProposals 改成 unknown 的提案会被误丢；需复核的成员声明取值已被改成 unknown、原值在 previous，也不参与比较
// - note：两边去首尾空白后比全文；实体、指标、标签比挂载的 knowledge.note，字段比条目顶层的 note（字段的说明按 entity.field
//   存在 business_notes、不进 knowledge）
// subject（只有按主题生成会产生）与 term_default（这两个入口不产生）没有可比的已生效取值，不过滤；目录里没有的目标
// （已不在 restricted 目录里）与带 mappingId 的映射字段提案（知识挂在血缘项上，条目顶层的 knowledge 里没有）不比，照原样
// 交给 proposeMany 拦下
import type { CatalogEntry } from '../catalog';
import type { Claim } from './catalog';
import type { ProposalInput } from './proposals';

/** dropKnown 的结果：保留下来的提案与因和已生效知识相同而被丢掉的条数 */
export interface DropKnownResult { inputs: ProposalInput[]; skipped: number }

/** 参与比较的成员声明：需复核的取值已被改成 unknown（原值在 previous），不知道成员写的是什么，不比 */
const comparableClaims = (claims: Claim[] | undefined): Claim[] => (claims ?? []).filter(c => !c.needsReview);

/** 提案内容按 Record 取键（形状由 outputToProposals 保证，这里只取要比较的键，取不到按不同处理） */
const asRecord = (content: unknown): Record<string, unknown> => (content && typeof content === 'object' ? content as Record<string, unknown> : {});

/** 这条提案和目标上已生效的知识相同：接受了也不会带来任何变化，不该再提 */
function isKnown(input: ProposalInput, byId: Map<string, CatalogEntry>): boolean {
  if (input.mappingId) return false;
  const entry = byId.get(input.targetId);
  if (!entry) return false;
  // 挂在条目上的业务知识：实体、字段、指标、标签有，数据源、源表等整类没有
  const knowledge = 'knowledge' in entry ? entry.knowledge : undefined;
  const content = asRecord(input.content);
  if (input.kind === 'alias') {
    const alias = typeof content.alias === 'string' ? content.alias.trim().toLowerCase() : '';
    return alias !== '' && (knowledge?.aliases ?? []).some(a => a.trim().toLowerCase() === alias);
  }
  if (input.kind === 'claim') {
    const { type, value } = content;
    if (typeof type !== 'string' || typeof value !== 'string') return false;
    const system = entry.kind === 'metric' || entry.kind === 'tag' ? entry.system.claims.filter(c => c.value !== 'unknown') : [];
    return [...comparableClaims(knowledge?.claims), ...system].some(c => c.type === type && c.value === value);
  }
  if (input.kind === 'note') {
    if (typeof content.note !== 'string') return false;
    const existing = entry.kind === 'field' ? entry.note : knowledge?.note;
    return typeof existing === 'string' && existing.trim() === content.note.trim();
  }
  return false;
}

/** 丢掉和目标上已生效知识相同的提案（不查库，entries 用调模型前读的目录），返回保留下来的提案与丢掉的条数 */
export function dropKnown(inputs: ProposalInput[], entries: CatalogEntry[]): DropKnownResult {
  const byId = new Map(entries.map(e => [e.id, e]));
  const kept: ProposalInput[] = [];
  let skipped = 0;
  for (const input of inputs) {
    if (isKnown(input, byId)) skipped++;
    else kept.push(input);
  }
  return { inputs: kept, skipped };
}
