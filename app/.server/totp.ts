// app/.server/totp.ts —— TOTP（RFC 6238：HMAC-SHA1、30 秒一步、6 位），供运营者第二因素使用
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';

const STEP_SECONDS = 30;
const DIGITS = 6;
/** 允许前后各一个时间步的时钟偏差 */
const DRIFT_STEPS = 1;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** 忽略大小写、空格、连字符与补位的 = */
export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`base32 中不允许的字符：${ch}`);
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** 160 位随机密钥（base32，32 个字符） */
export const generateSecret = () => base32Encode(randomBytes(20));

const stepOf = (nowMs: number) => Math.floor(nowMs / 1000 / STEP_SECONDS);

function codeForStep(key: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const n = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const totpCode = (secret: string, nowMs = Date.now()) => codeForStep(base32Decode(secret), stepOf(nowMs));

/**
 * 校验验证码，命中则返回所在的时间步，否则返回 null。
 * 传入上次成功使用的时间步时，不接受同一步或更早的验证码：一个验证码只能用一次。
 */
export function verifyTotp(secret: string, input: string, nowMs = Date.now(), lastUsedStep: number | null = null): number | null {
  const code = input.replace(/\s/g, '');
  if (!new RegExp(`^\\d{${DIGITS}}$`).test(code)) return null;
  const key = base32Decode(secret);
  const current = stepOf(nowMs);
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(codeForStep(key, step)), Buffer.from(code))) return step;
  }
  return null;
}

/** 认证器 App 识别的绑定链接（可生成二维码，也可手动输入其中的密钥） */
export function otpauthUri(email: string, secret: string, issuer = 'CRM 运营后台') {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

/** 绑定链接的二维码（PNG data URL），在服务端生成，密钥不经过任何第三方服务 */
export const otpauthQrDataUrl = (uri: string) => QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
