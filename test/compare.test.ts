// test/compare.test.ts —— 共用的字符串比较（ADR-0045）：给用户看的名字按 zh-CN（拼音、汉字在拉丁字母前），内部键按码点；结果与进程的默认 locale 无关（纯函数）
import { describe, expect, it } from 'vitest';
import { cmp, cmpName } from '../app/lib/compare';

describe('cmpName：名字按 zh-CN 排序', () => {
  it('汉字排在拉丁字母前', () => {
    expect(['「CRM」orders → order', '「会员」orders → order'].sort(cmpName))
      .toEqual(['「会员」orders → order', '「CRM」orders → order']);
  });

  it('汉字之间按拼音', () => {
    expect(['会员', '订单', '岸边', '中心'].sort(cmpName)).toEqual(['岸边', '订单', '会员', '中心']);
  });

  it('相同为 0，结果符号对称', () => {
    expect(cmpName('会员', '会员')).toBe(0);
    expect(Math.sign(cmpName('会员', 'CRM'))).toBe(-Math.sign(cmpName('CRM', '会员')));
  });
});

describe('cmp：内部键按码点', () => {
  it('数字 < 冒号 < 大写 < 下划线 < 小写', () => {
    expect(['a', '_x', 'B', ':k', '9'].sort(cmp)).toEqual(['9', ':k', 'B', '_x', 'a']);
  });

  it('前缀排在更长的串前，不忽略标点', () => {
    expect(['order_item', 'order', 'order:1', 'orders'].sort(cmp)).toEqual(['order', 'order:1', 'order_item', 'orders']);
  });

  it('相同为 0', () => {
    expect(cmp('silver.order', 'silver.order')).toBe(0);
  });
});
