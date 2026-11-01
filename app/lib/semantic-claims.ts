// app/lib/semantic-claims.ts —— 口径声明（ADR-0046）的登记表：首期五种类型，每种的取值是固定的枚举（不收自由文本），都含「未知」与「不适用」。
// 类型与取值的顺序就是目录、Markdown 与面板里的顺序；中文标签供 Markdown、检索文字、审计与面板使用。以后按黄金集里的缺项在这里加类型或取值

export interface ClaimValueDef { value: string; label: string }
export interface ClaimTypeDef { label: string; values: readonly ClaimValueDef[] }

const UNKNOWN: ClaimValueDef = { value: 'unknown', label: '未知' };
const NOT_APPLICABLE: ClaimValueDef = { value: 'not_applicable', label: '不适用' };
const YES_NO: ClaimValueDef[] = [{ value: 'yes', label: '是' }, { value: 'no', label: '否' }];

export const CLAIM_TYPES = {
  unit: {
    label: '单位',
    values: [
      { value: 'currency_major', label: '主币种单位（元等）' },
      { value: 'currency_minor', label: '分（最小币种单位）' },
      { value: 'count', label: '个数' },
      { value: 'percent', label: '百分比' },
      { value: 'ratio', label: '比率' },
      { value: 'day', label: '天' },
      UNKNOWN, NOT_APPLICABLE,
    ],
  },
  currency: {
    label: '币种',
    values: [
      { value: 'CNY', label: '人民币' },
      { value: 'USD', label: '美元' },
      { value: 'HKD', label: '港币' },
      { value: 'EUR', label: '欧元' },
      { value: 'JPY', label: '日元' },
      UNKNOWN, NOT_APPLICABLE,
    ],
  },
  tax_included: { label: '是否含税', values: [...YES_NO, UNKNOWN, NOT_APPLICABLE] },
  refund_deducted: { label: '是否扣除退款', values: [...YES_NO, UNKNOWN, NOT_APPLICABLE] },
  time_meaning: {
    label: '时间含义',
    values: [
      { value: 'order_time', label: '下单时间' },
      { value: 'pay_time', label: '支付时间' },
      { value: 'ship_time', label: '发货时间' },
      { value: 'complete_time', label: '完成时间' },
      { value: 'refund_time', label: '退款时间' },
      { value: 'event_time', label: '事件发生时间' },
      { value: 'record_time', label: '记录写入时间' },
      UNKNOWN, NOT_APPLICABLE,
    ],
  },
} as const satisfies Record<string, ClaimTypeDef>;

export type ClaimType = keyof typeof CLAIM_TYPES;

/** 登记顺序的类型列表 */
export const CLAIM_TYPE_ORDER = Object.keys(CLAIM_TYPES) as ClaimType[];

export const isClaimType = (type: unknown): type is ClaimType =>
  typeof type === 'string' && Object.prototype.hasOwnProperty.call(CLAIM_TYPES, type);

/** type 是登记的类型、value 是该类型登记的取值 */
export const isClaimValue = (type: unknown, value: unknown): value is string =>
  isClaimType(type) && typeof value === 'string' && CLAIM_TYPES[type].values.some(v => v.value === value);

/** 类型的中文标签；未登记的原样返回 */
export const claimTypeLabel = (type: string): string => (isClaimType(type) ? CLAIM_TYPES[type].label : type);

/** 取值的中文标签；未登记的原样返回 */
export const claimValueLabel = (type: string, value: string): string =>
  (isClaimType(type) ? CLAIM_TYPES[type].values.find(v => v.value === value)?.label : undefined) ?? value;
