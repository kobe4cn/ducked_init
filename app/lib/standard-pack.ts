// app/lib/standard-pack.ts —— 标准模板包（ADR-0046 知识入口②，#505）：平台随代码发布的一份标准实体字段的业务知识——别名、口径声明与业务说明。
// 成员在集中页点「应用标准模板包」后，系统按租户实际用到的实体把它生成知识提案，成员接受（可以先改值）才生效（#520、#521）；
// 包本身是静态数据，改动走 PR 评审并给 PACK_VERSION 加一，不做运营后台编辑。内容是平台通用说法、不含租户信息：
// 说明只写「是什么」，口径不确定的不写、不替租户猜（金额是否含税、是否扣除退款不预设，与系统扫描 knowledge/derive.ts 一样只认结构上可证的）；
// 别名是挂在目录条目上的检索用词（ADR-0046），不是映射草稿用的列名同义词（那是 field-synonyms.ts）。首版只覆盖 order、customer 的关键字段；
// pii 字段（ADR-0005，检索里不出现）与自定义实体不进包。长度上限沿用服务端的 ALIAS_MAX_LENGTH 与 NOTE_MAX_LENGTH——那两个模块在 .server 里，
// 前端不能 import，这里的默认值与它们对齐，测试里拿真实常量校验
import { entityOf } from './canonical-model';
import { isClaimValue, type ClaimType } from './semantic-claims';

/** 包版本：整数，从 1 开始；条目增删或内容改动时加一 */
export const PACK_VERSION = 1;

/** 一条口径声明：类型与取值都要在登记表里（isClaimValue） */
export interface PackClaim { type: ClaimType; value: string }

/** 包的一个条目：目标是目录条目标识 field:e.f 或 entity:x，至少带一项内容 */
export interface PackEntry {
  targetId: string;
  aliases?: readonly string[];
  claims?: readonly PackClaim[];
  note?: string;
}

export const STANDARD_PACK: readonly PackEntry[] = [
  { targetId: 'field:order.order_id', aliases: ['订单号', '订单编号'] },
  { targetId: 'field:order.customer_id', aliases: ['买家 ID', '下单用户 ID'] },
  {
    targetId: 'field:order.status',
    note: '订单状态是固定枚举：created 已创建、paid 已支付、shipped 已发货、completed 已完成、cancelled 已取消、refunded 已退款。'
      + '状态之间的先后与互斥关系取决于源端，未声明。',
  },
  {
    targetId: 'field:order.amount',
    aliases: ['订单金额', '支付金额', '实付'],
    claims: [{ type: 'unit', value: 'currency_major' }],
    note: '实付金额是消费者这笔订单实际支付的金额，单位是元。是否含税、是否已扣除退款取决于源端怎么记这笔金额，没有声明时按未知处理。',
  },
  { targetId: 'field:order.created_at', aliases: ['下单日期'], claims: [{ type: 'time_meaning', value: 'order_time' }] },
  { targetId: 'field:order.paid_at', aliases: ['付款时间'], claims: [{ type: 'time_meaning', value: 'pay_time' }] },
  { targetId: 'field:order.channel', aliases: ['下单渠道'] },
  { targetId: 'field:order.store_id', aliases: ['门店编号'] },
  { targetId: 'field:customer.customer_id', aliases: ['客户 ID', '用户 ID'] },
  { targetId: 'field:customer.city', aliases: ['所在城市'] },
  { targetId: 'field:customer.registered_at', aliases: ['注册日期'] },
];

/** 长度上限 */
export interface PackLimits { aliasMaxLength: number; noteMaxLength: number }

/** 与服务端的 ALIAS_MAX_LENGTH（app/.server/knowledge/aliases.ts）、NOTE_MAX_LENGTH（app/.server/business-notes.ts）一致，那边改了这里也要改 */
const DEFAULT_LIMITS: PackLimits = { aliasMaxLength: 50, noteMaxLength: 2000 };

/** 解析包里的目标：field:e.f（实体与字段名都非空）或 entity:x；解析不出（metric:、tag: 等其他目录条目）返回 null */
export function packTargetOf(targetId: string): { entity: string; field?: string } | null {
  const m = /^(entity|field):(.+)$/.exec(targetId);
  if (!m) return null;
  const [, kind, rest] = m;
  if (kind === 'entity') return { entity: rest };
  const dot = rest.indexOf('.');
  return dot > 0 && dot < rest.length - 1 ? { entity: rest.slice(0, dot), field: rest.slice(dot + 1) } : null;
}

/**
 * 校验一份模板包，返回错误列表（空数组表示合法），每条是「targetId：问题」。纯函数，测试与 #520 应用前都用它：
 * - 目标必须是标准实体或其字段（entityOf；自定义实体、metric: / tag: 与别的格式都不行），字段不能是 pii；
 *   同一目标只能有一条，每条至少带一项内容
 * - 口径声明的类型与取值要过 isClaimValue，同一条目里同一类型只声明一次（服务端每个 (目标, 类型) 只有一行生效）；
 *   说明去掉首尾空白后 1–noteMaxLength 字
 * - 别名去掉首尾空白后 1–aliasMaxLength 字、不与目标条目的 label 相同（字段用字段 label，实体用实体 label）、
 *   整个包内不重复（不分大小写）
 */
export function packErrors(pack: readonly PackEntry[], limits: PackLimits = DEFAULT_LIMITS): string[] {
  const errors: string[] = [];
  const seenTargets = new Set<string>();
  const seenAliases = new Set<string>();
  for (const entry of pack) {
    const where = `${entry.targetId}：`;
    if (seenTargets.has(entry.targetId)) errors.push(`${where}重复的条目`);
    seenTargets.add(entry.targetId);

    const target = packTargetOf(entry.targetId);
    const entity = target ? entityOf(target.entity) : undefined;
    const field = target?.field ? entity?.fields.find(f => f.name === target.field) : undefined;
    if (!entity) errors.push(`${where}目标不是标准模型里的实体或字段`);
    else if (target?.field && !field) errors.push(`${where}实体上没有这个字段`);
    else if (field?.pii) errors.push(`${where}敏感字段不进包`);

    if (!entry.aliases?.length && !entry.claims?.length && entry.note === undefined) {
      errors.push(`${where}条目至少要带别名、口径声明或说明中的一项`);
    }

    const label = target?.field ? field?.label : entity?.label;
    for (const alias of entry.aliases ?? []) {
      const trimmed = alias.trim();
      const len = [...trimmed].length;
      if (len < 1 || len > limits.aliasMaxLength) errors.push(`${where}别名「${trimmed}」去掉首尾空白后要 1–${limits.aliasMaxLength} 字`);
      if (label && trimmed.toLowerCase() === label.toLowerCase()) errors.push(`${where}别名「${trimmed}」与条目的 label 相同`);
      const key = trimmed.toLowerCase();
      if (seenAliases.has(key)) errors.push(`${where}别名「${trimmed}」在包里重复`);
      seenAliases.add(key);
    }

    const claimTypes = new Set<string>();
    for (const claim of entry.claims ?? []) {
      if (!isClaimValue(claim.type, claim.value)) errors.push(`${where}口径声明 ${claim.type}=${claim.value} 未登记`);
      if (claimTypes.has(claim.type)) errors.push(`${where}口径类型 ${claim.type} 声明了多次`);
      claimTypes.add(claim.type);
    }

    if (entry.note !== undefined) {
      const len = [...entry.note.trim()].length;
      if (len < 1 || len > limits.noteMaxLength) errors.push(`${where}说明去掉首尾空白后要 1–${limits.noteMaxLength} 字`);
    }
  }
  return errors;
}
