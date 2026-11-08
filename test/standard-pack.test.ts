// test/standard-pack.test.ts —— 标准模板包（ADR-0046 入口②，#505）：数据与校验。纯函数、不碰库。
// 三项验收各一组：目标都在标准模型里、不是 pii 字段、不含自定义实体；口径声明的 type / value 过 isClaimValue、说明不超 NOTE_MAX_LENGTH 字；
// 别名在包内不重复、不超过 ALIAS_MAX_LENGTH 字、不和标准字段的 label 相同。上限常量在 .server 里（lib 不能 import），测试引用真实值对齐；
// 包里的口径声明只写结构上可证的（时间含义对照 knowledge/derive.ts 的 TIME_FIELDS，金额单位来自标准模型「金额以元计」）
import { describe, expect, it } from 'vitest';
import { ALIAS_MAX_LENGTH } from '../app/.server/knowledge/aliases';
import { NOTE_MAX_LENGTH } from '../app/.server/business-notes';
import { TIME_FIELDS } from '../app/.server/knowledge/derive';
import { CANONICAL_ENTITIES } from '../app/lib/canonical-model';
import { isClaimValue } from '../app/lib/semantic-claims';
import { PACK_VERSION, packErrors, STANDARD_PACK, type PackEntry } from '../app/lib/standard-pack';

const errorsOf = (entries: readonly PackEntry[]) =>
  packErrors(entries, { aliasMaxLength: ALIAS_MAX_LENGTH, noteMaxLength: NOTE_MAX_LENGTH });

describe('标准模板包的数据', () => {
  it('PACK_VERSION 是从 1 开始的整数', () => {
    expect(Number.isInteger(PACK_VERSION)).toBe(true);
    expect(PACK_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('首版只覆盖 order 与 customer 的字段，且有条目', () => {
    expect(STANDARD_PACK.length).toBeGreaterThan(0);
    for (const entry of STANDARD_PACK) expect(entry.targetId, entry.targetId).toMatch(/^field:(order|customer)\./);
  });

  it('每个目标都是标准实体的字段、不是 pii', () => {
    for (const entry of STANDARD_PACK) {
      const [, entityName, fieldName] = /^field:([a-z_]+)\.([a-z_]+)$/.exec(entry.targetId)!;
      const field = CANONICAL_ENTITIES.find(e => e.name === entityName)?.fields.find(f => f.name === fieldName);
      expect(field, entry.targetId).toBeDefined();
      expect(field!.pii, entry.targetId).toBeUndefined();
    }
  });

  it('整个包过 packErrors，没有错误', () => {
    expect(errorsOf(STANDARD_PACK)).toEqual([]);
  });

  it('口径声明都过 isClaimValue；时间含义与 TIME_FIELDS 一致、金额单位是元；含税与扣退款不预设', () => {
    const claimsOf = (targetId: string) => STANDARD_PACK.find(e => e.targetId === targetId)?.claims ?? [];
    for (const entry of STANDARD_PACK) {
      for (const claim of entry.claims ?? []) expect(isClaimValue(claim.type, claim.value), `${entry.targetId} ${claim.type}`).toBe(true);
    }
    expect(claimsOf('field:order.created_at')).toContainEqual({ type: 'time_meaning', value: TIME_FIELDS['order.created_at'] });
    expect(claimsOf('field:order.paid_at')).toContainEqual({ type: 'time_meaning', value: TIME_FIELDS['order.paid_at'] });
    expect(claimsOf('field:order.amount')).toContainEqual({ type: 'unit', value: 'currency_major' });
    const amountTypes = claimsOf('field:order.amount').map(c => c.type);
    expect(amountTypes).not.toContain('tax_included');
    expect(amountTypes).not.toContain('refund_deducted');
  });

  it('说明都非空且不超过 NOTE_MAX_LENGTH 字，包里确实有说明', () => {
    for (const entry of STANDARD_PACK) {
      if (entry.note === undefined) continue;
      const len = [...entry.note.trim()].length;
      expect(len, entry.targetId).toBeGreaterThan(0);
      expect(len, entry.targetId).toBeLessThanOrEqual(NOTE_MAX_LENGTH);
    }
    expect(STANDARD_PACK.some(e => e.note !== undefined)).toBe(true);
  });

  it('别名都非空、不超过 ALIAS_MAX_LENGTH 字、不与目标字段的 label 相同、包内不重复（不分大小写）', () => {
    const seen = new Set<string>();
    for (const entry of STANDARD_PACK) {
      const [, entityName, fieldName] = /^field:([a-z_]+)\.([a-z_]+)$/.exec(entry.targetId)!;
      const label = CANONICAL_ENTITIES.find(e => e.name === entityName)?.fields.find(f => f.name === fieldName)?.label;
      for (const alias of entry.aliases ?? []) {
        const trimmed = alias.trim();
        const len = [...trimmed].length;
        expect(len, `${entry.targetId} ${alias}`).toBeGreaterThan(0);
        expect(len, `${entry.targetId} ${alias}`).toBeLessThanOrEqual(ALIAS_MAX_LENGTH);
        expect(trimmed, entry.targetId).not.toBe(label);
        expect(seen.has(trimmed.toLowerCase()), alias).toBe(false);
        seen.add(trimmed.toLowerCase());
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe('packErrors：目标', () => {
  it('不在标准模型、字段不存在、pii 字段、自定义实体、metric / tag / 没有字段名的目标都报错', () => {
    expect(errorsOf([{ targetId: 'field:order.no_such', aliases: ['甲'] }])).toEqual(['field:order.no_such：实体上没有这个字段']);
    expect(errorsOf([{ targetId: 'entity:custom_member', aliases: ['甲'] }])).toEqual(['entity:custom_member：目标不是标准模型里的实体或字段']);
    expect(errorsOf([{ targetId: 'field:customer.phone', aliases: ['甲'] }])).toEqual(['field:customer.phone：敏感字段不进包']);
    expect(errorsOf([{ targetId: 'field:customer.name', aliases: ['甲'] }])).toEqual(['field:customer.name：敏感字段不进包']);
    expect(errorsOf([{ targetId: 'metric:paid_revenue', aliases: ['甲'] }])).toEqual(['metric:paid_revenue：目标不是标准模型里的实体或字段']);
    expect(errorsOf([{ targetId: 'field:order', aliases: ['甲'] }])).toEqual(['field:order：目标不是标准模型里的实体或字段']);
  });

  it('标准实体与非 pii 字段都可以，pii 之外的字段名原样解析', () => {
    expect(errorsOf([{ targetId: 'entity:order', aliases: ['交易'] }, { targetId: 'field:customer.city', aliases: ['常住地'] }])).toEqual([]);
  });

  it('同一目标两条、什么都不带的条目报错', () => {
    expect(errorsOf([{ targetId: 'field:order.amount', note: '甲' }, { targetId: 'field:order.amount', note: '乙' }]))
      .toEqual(['field:order.amount：重复的条目']);
    expect(errorsOf([{ targetId: 'field:order.amount' }])).toEqual(['field:order.amount：条目至少要带别名、口径声明或说明中的一项']);
  });
});

describe('packErrors：口径声明与说明', () => {
  it('类型或取值未登记、同一条目里同类型声明两次都报错；登记表里的过', () => {
    expect(errorsOf([{ targetId: 'field:order.amount', claims: [{ type: 'unit', value: 'kg' }] }]))
      .toEqual(['field:order.amount：口径声明 unit=kg 未登记']);
    // 类型上不会出现未登记的类型，运行时脏数据仍要拦（isClaimValue 先看 type）
    expect(errorsOf([{ targetId: 'field:order.amount', claims: [{ type: 'size' as never, value: 'L' }] }]))
      .toEqual(['field:order.amount：口径声明 size=L 未登记']);
    expect(errorsOf([{ targetId: 'field:order.amount', claims: [{ type: 'unit', value: 'count' }, { type: 'unit', value: 'percent' }] }]))
      .toEqual(['field:order.amount：口径类型 unit 声明了多次']);
    expect(errorsOf([{ targetId: 'field:order.amount', claims: [{ type: 'unit', value: 'currency_major' }, { type: 'tax_included', value: 'unknown' }] }]))
      .toEqual([]);
  });

  it('说明空白或超过 NOTE_MAX_LENGTH 字报错，正好 NOTE_MAX_LENGTH 字可以', () => {
    expect(errorsOf([{ targetId: 'field:order.status', note: '  ' }]))
      .toEqual([`field:order.status：说明去掉首尾空白后要 1–${NOTE_MAX_LENGTH} 字`]);
    expect(errorsOf([{ targetId: 'field:order.status', note: '长'.repeat(NOTE_MAX_LENGTH + 1) }]))
      .toEqual([`field:order.status：说明去掉首尾空白后要 1–${NOTE_MAX_LENGTH} 字`]);
    expect(errorsOf([{ targetId: 'field:order.status', note: '长'.repeat(NOTE_MAX_LENGTH) }])).toEqual([]);
  });
});

describe('packErrors：别名', () => {
  it('空白、超过 ALIAS_MAX_LENGTH 字、与目标的 label 相同、包内重复（不分大小写）都报错；正好 ALIAS_MAX_LENGTH 字可以', () => {
    expect(errorsOf([{ targetId: 'field:order.amount', aliases: [' '] }]))
      .toEqual([`field:order.amount：别名「」去掉首尾空白后要 1–${ALIAS_MAX_LENGTH} 字`]);
    const tooLong = '长'.repeat(ALIAS_MAX_LENGTH + 1);
    expect(errorsOf([{ targetId: 'field:order.amount', aliases: [tooLong] }]))
      .toEqual([`field:order.amount：别名「${tooLong}」去掉首尾空白后要 1–${ALIAS_MAX_LENGTH} 字`]);
    expect(errorsOf([{ targetId: 'field:order.amount', aliases: ['实付金额'] }]))
      .toEqual(['field:order.amount：别名「实付金额」与条目的 label 相同']);
    expect(errorsOf([{ targetId: 'entity:order', aliases: ['订单'] }]))
      .toEqual(['entity:order：别名「订单」与条目的 label 相同']);
    expect(errorsOf([
      { targetId: 'field:order.amount', aliases: ['订单金额'] },
      { targetId: 'field:customer.city', aliases: ['订单金额'] },
    ])).toEqual(['field:customer.city：别名「订单金额」在包里重复']);
    expect(errorsOf([
      { targetId: 'field:order.amount', aliases: ['VIP 价'] },
      { targetId: 'field:customer.city', aliases: ['vip 价'] },
    ])).toEqual(['field:customer.city：别名「vip 价」在包里重复']);
    expect(errorsOf([{ targetId: 'field:order.amount', aliases: ['长'.repeat(ALIAS_MAX_LENGTH)] }])).toEqual([]);
  });
});
