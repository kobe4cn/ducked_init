// test/i18n-claim-labels.test.ts —— 口径类型与取值标签的界面语言显示（#1048，ADR-0046 / ADR-0060，纯函数，不连库）：
// claimTypeText / claimValueText 的中文键必须与 semantic-claims 的 CLAIM_TYPES 逐字一致（中文界面输出不变，服务端继续拿中文，验收标准 2）；
// 英文界面（en.client.json）每个类型与取值都没有汉字且真的换了语言（验收标准 1）；未登记的类型 / 取值原样返回（与 claimTypeLabel / claimValueLabel 一致）
import { describe, expect, it } from 'vitest';
import enClient from '../app/i18n/en.client.json';
import { claimTypeText, claimValueText } from '../app/lib/claim-labels';
import { makeT } from '../app/lib/i18n';
import { CLAIM_TYPES, CLAIM_TYPE_ORDER } from '../app/lib/semantic-claims';

describe('口径类型与取值标签的翻译', () => {
  it('中文界面：登记表里每个类型与取值的说法与 label 逐字一致', () => {
    const t = makeT('zh-CN', null);
    for (const type of CLAIM_TYPE_ORDER) {
      expect(claimTypeText(t, type)).toBe(CLAIM_TYPES[type].label);
      for (const v of CLAIM_TYPES[type].values) expect(claimValueText(t, type, v.value)).toBe(v.label);
    }
  });

  it('英文界面：每个类型与取值都没有汉字，且与中文不同', () => {
    const t = makeT('en', enClient);
    for (const type of CLAIM_TYPE_ORDER) {
      expect(claimTypeText(t, type), type).not.toMatch(/[一-鿿]/);
      expect(claimTypeText(t, type), type).not.toBe(CLAIM_TYPES[type].label);
      for (const v of CLAIM_TYPES[type].values) {
        expect(claimValueText(t, type, v.value), `${type}:${v.value}`).not.toMatch(/[一-鿿]/);
      }
    }
    // 具体的说法（不只是「没有汉字」）：类型、共用取值与具体取值各举一例
    expect(claimTypeText(t, 'unit')).toBe('Unit');
    expect(claimValueText(t, 'unit', 'unknown')).toBe('Unknown');
    expect(claimValueText(t, 'currency', 'CNY')).toBe('Chinese yuan');
    expect(claimValueText(t, 'time_meaning', 'order_time')).toBe('Placed At');
  });

  it('未登记的类型与取值原样返回，与 claimTypeLabel / claimValueLabel 一致', () => {
    const t = makeT('en', enClient);
    expect(claimTypeText(t, 'bogus')).toBe('bogus');
    expect(claimValueText(t, 'unit', 'bogus')).toBe('bogus');
    expect(claimValueText(t, 'bogus', 'CNY')).toBe('CNY');
  });
});
