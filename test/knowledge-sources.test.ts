// test/knowledge-sources.test.ts —— 知识来源分段的纯函数（ADR-0046 入口③，#525）：paragraphsOf 对数据字典与指标说明按空行切段、
// 对 SQL 按语句（分号）切段，段号从 1 开始，每段去首尾空白、空段丢弃，连续空行与结尾分号不产生空段（纯函数，不碰库）
import { describe, expect, it } from 'vitest';
import { paragraphsOf } from '../app/.server/knowledge/sources';

describe('paragraphsOf', () => {
  it('数据字典与指标说明按空行切段：段号从 1 开始，每段去首尾空白，连续空行不产生空段', () => {
    expect(paragraphsOf('customers 表\n客户表\n\n  orders 表：订单  \n\n\norder_id 订单号', 'dictionary')).toEqual([
      { no: 1, text: 'customers 表\n客户表' },
      { no: 2, text: 'orders 表：订单' },
      { no: 3, text: 'order_id 订单号' },
    ]);
    expect(paragraphsOf('统计口径\n以实付为准', 'metric')).toEqual([{ no: 1, text: '统计口径\n以实付为准' }]);
  });

  it('SQL 按语句切段：分号分隔，结尾或连写的分号不产生空段，语句内的空白保留', () => {
    expect(paragraphsOf('SELECT 1;\nSELECT 2;\n', 'sql')).toEqual([
      { no: 1, text: 'SELECT 1' },
      { no: 2, text: 'SELECT 2' },
    ]);
    expect(paragraphsOf('WITH t AS (SELECT 1)\nSELECT * FROM t;;\n;\nSELECT 3', 'sql')).toEqual([
      { no: 1, text: 'WITH t AS (SELECT 1)\nSELECT * FROM t' },
      { no: 2, text: 'SELECT 3' },
    ]);
  });

  it('CRLF 换行按空行切段时先归一，段内的回车不留', () => {
    expect(paragraphsOf('第一段\r\n另起一行\r\n\r\n第二段', 'dictionary')).toEqual([
      { no: 1, text: '第一段\n另起一行' },
      { no: 2, text: '第二段' },
    ]);
  });

  it('只有空白的内容切出空段落列表', () => {
    expect(paragraphsOf('  \n\n \n', 'dictionary')).toEqual([]);
    expect(paragraphsOf(';', 'sql')).toEqual([]);
  });
});
