// test/pipeline/source-connect-timeout.test.ts —— PostgreSQL 源库建连超时的解析（#545，纯函数）：
// SOURCE_CONNECT_TIMEOUT_SECONDS 是正整数字符串才用它，否则（不设、空、非数字、0、负数、小数）回到默认 10
import { describe, expect, it } from 'vitest';
import { sourceConnectTimeout } from '../../app/.server/pipeline/source-engine';

describe('PostgreSQL 源库的建连超时秒数', () => {
  it('不设或为空时用默认 10', () => {
    expect(sourceConnectTimeout({})).toBe(10);
    expect(sourceConnectTimeout({ SOURCE_CONNECT_TIMEOUT_SECONDS: '' })).toBe(10);
  });

  it('正整数字符串按设置的值', () => {
    expect(sourceConnectTimeout({ SOURCE_CONNECT_TIMEOUT_SECONDS: '30' })).toBe(30);
  });

  it('不是正整数（非数字、0、负数、小数）时回到默认 10', () => {
    expect(sourceConnectTimeout({ SOURCE_CONNECT_TIMEOUT_SECONDS: 'abc' })).toBe(10);
    expect(sourceConnectTimeout({ SOURCE_CONNECT_TIMEOUT_SECONDS: '0' })).toBe(10);
    expect(sourceConnectTimeout({ SOURCE_CONNECT_TIMEOUT_SECONDS: '-5' })).toBe(10);
    expect(sourceConnectTimeout({ SOURCE_CONNECT_TIMEOUT_SECONDS: '2.5' })).toBe(10);
  });
});
