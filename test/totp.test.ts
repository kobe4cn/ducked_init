import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateSecret, otpauthUri, totpCode, verifyTotp } from '../app/.server/totp';

// RFC 6238 附录 B 的 SHA-1 密钥 "12345678901234567890"，取 8 位验证码的后 6 位
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const RFC_VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

describe('TOTP', () => {
  it('base32 编解码往返一致', () => {
    const bytes = Buffer.from('12345678901234567890');
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(Buffer.from(base32Decode(RFC_SECRET))).toEqual(bytes);
    expect(Buffer.from(base32Decode('gezd gnbv-gy3t'))).toEqual(Buffer.from('1234567'));
  });

  it('与 RFC 6238 测试向量一致', () => {
    for (const [seconds, code] of RFC_VECTORS) expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(code);
  });

  it('接受前后各一个时间步的验证码，返回命中的时间步', () => {
    const now = 1111111111 * 1000;
    const step = Math.floor(1111111111 / 30);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now + 30_000), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now - 60_000), now)).toBeNull();
  });

  it('拒绝已用过的时间步（防重放）与格式不对的输入', () => {
    const now = 1111111111 * 1000;
    const step = Math.floor(1111111111 / 30);
    const code = totpCode(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, now, step - 1)).toBe(step);
    expect(verifyTotp(RFC_SECRET, ` ${code.slice(0, 3)} ${code.slice(3)} `, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, '', now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now)).toBeNull();
  });

  it('生成 160 位随机密钥与 otpauth 链接', () => {
    const a = generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateSecret()).not.toBe(a);
    const uri = new URL(otpauthUri('ops@example.com', a));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('secret')).toBe(a);
    expect(decodeURIComponent(uri.pathname)).toContain('ops@example.com');
  });
});
