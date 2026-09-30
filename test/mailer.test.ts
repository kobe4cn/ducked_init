import { afterEach, describe, expect, it, vi } from 'vitest';
import { resendMailer } from '../app/.server/mailer';

const mail = { to: 'admin@acme.com', subject: '登录 CRM 数据分析平台', text: 'http://localhost:5173/auth/verify?token=abc' };

describe('Resend 发信', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('把收件人、发件人、主题与正文交给 Resend API', async () => {
    const fetch = vi.fn(async () => Response.json({ id: 'email-1' }));
    vi.stubGlobal('fetch', fetch);
    await resendMailer('re_test', 'CRM <noreply@example.com>').send(mail);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer re_test');
    expect(JSON.parse(init.body as string)).toMatchObject({ from: 'CRM <noreply@example.com>', ...mail });
  });

  it('Resend 返回错误时抛出异常', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({ name: 'validation_error', message: 'The from address is not verified', statusCode: 403 }, { status: 403 })));
    await expect(resendMailer('re_test', 'CRM <noreply@example.com>').send(mail))
      .rejects.toThrow(/Resend 发信失败（validation_error）：The from address is not verified/);
  });
});
