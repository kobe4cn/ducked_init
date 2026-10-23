import { afterEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.fn();
const createTransport = vi.fn((_options: unknown) => ({ sendMail }));
vi.mock('nodemailer', () => ({ default: { createTransport: (options: unknown) => createTransport(options) } }));

const { smtpMailer } = await import('../app/.server/mailer');

const mail = { to: 'admin@acme.com', subject: '登录 CRM 数据分析平台', text: 'http://localhost:5173/auth/verify?token=abc' };
const config = { host: 'smtp.qq.com', user: 'crm@qq.com', pass: 'auth-code', from: 'CRM <crm@qq.com>' };

describe('SMTP 发信', () => {
  afterEach(() => { sendMail.mockReset(); createTransport.mockClear(); });

  it('用主机、端口与账号连接，把收件人、发件人、主题与正文交给 SMTP', async () => {
    sendMail.mockResolvedValue({ messageId: 'm-1' });
    await smtpMailer({ ...config, port: 465 }).send(mail);

    expect(createTransport).toHaveBeenCalledWith({ host: 'smtp.qq.com', port: 465, secure: true, auth: { user: 'crm@qq.com', pass: 'auth-code' } });
    expect(sendMail).toHaveBeenCalledWith({ from: 'CRM <crm@qq.com>', ...mail });
  });

  it('587 端口不直接走 SSL（STARTTLS）', () => {
    smtpMailer({ ...config, port: 587 });
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 587, secure: false }));
  });

  it('SMTP 返回错误时抛出异常', async () => {
    sendMail.mockRejectedValue(new Error('Invalid login: 535 Login fail'));
    await expect(smtpMailer({ ...config, port: 465 }).send(mail)).rejects.toThrow(/SMTP 发信失败：Invalid login: 535 Login fail/);
  });
});
