// app/lib/claim-labels.ts —— 口径类型与取值标签按界面语言的显示（ADR-0046 / ADR-0060，#1048）：semantic-claims 的登记表
// 继续存中文（服务端的目录、计划、审计与 Markdown 拿中文，本文件不改它），页面显示走这里。中文键与 CLAIM_TYPES 的
// label 逐字一致——中文界面输出不变；t() 的参数必须是字符串字面量（i18n-catalog.test.ts 对账），所以对照表按
// 类型 / 取值代码重写，不能写成 t(CLAIM_TYPES[x].label)。未登记的类型 / 取值原样返回，与 claimTypeLabel / claimValueLabel 一致
import type { T } from './i18n';
import { isClaimType, type ClaimType } from './semantic-claims';

/** 类型代码 → 界面语言的说法；五种类型各一条，顺序与登记表无关（键是代码） */
const typeText = (t: T, type: ClaimType): string => ({
  unit: t('单位'),
  currency: t('币种'),
  tax_included: t('是否含税'),
  refund_deducted: t('是否扣除退款'),
  time_meaning: t('时间含义'),
})[type];

/** 取值代码 → 界面语言的说法：登记表里的每个取值都有一条；「未知」「不适用」五种类型共用同一对词条 */
const valueText = (t: T, type: ClaimType, value: string): string => {
  const labels = ((): Record<string, string> => {
    switch (type) {
      case 'unit': return {
        currency_major: t('主币种单位（元等）'),
        currency_minor: t('分（最小币种单位）'),
        count: t('个数'),
        percent: t('百分比'),
        ratio: t('比率'),
        day: t('天'),
        unknown: t('未知'),
        not_applicable: t('不适用'),
      };
      case 'currency': return {
        CNY: t('人民币'),
        USD: t('美元'),
        HKD: t('港币'),
        EUR: t('欧元'),
        JPY: t('日元'),
        unknown: t('未知'),
        not_applicable: t('不适用'),
      };
      // 是 / 否 两种类型取同一组词
      case 'tax_included':
      case 'refund_deducted': return {
        yes: t('是'),
        no: t('否'),
        unknown: t('未知'),
        not_applicable: t('不适用'),
      };
      case 'time_meaning': return {
        order_time: t('下单时间'),
        pay_time: t('支付时间'),
        ship_time: t('发货时间'),
        complete_time: t('完成时间'),
        refund_time: t('退款时间'),
        event_time: t('事件发生时间'),
        record_time: t('记录写入时间'),
        unknown: t('未知'),
        not_applicable: t('不适用'),
      };
    }
  })();
  return labels[value] ?? value;
};

/** 类型代码的界面语言说法；未登记的原样返回（同 claimTypeLabel） */
export const claimTypeText = (t: T, type: string): string => (isClaimType(type) ? typeText(t, type) : type);

/** 取值代码的界面语言说法；类型或取值未登记时原样返回（同 claimValueLabel） */
export const claimValueText = (t: T, type: string, value: string): string => (isClaimType(type) ? valueText(t, type, value) : value);
