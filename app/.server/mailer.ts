// app/.server/mailer.ts —— 发信接口。本期只有“输出到控制台”一种实现，供开发环境使用
export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void> }

const consoleMailer: Mailer = {
  async send({ to, subject, text }) {
    console.log(`\n======== 邮件（开发环境，仅输出到控制台）========\n收件人：${to}\n主题：${subject}\n\n${text}\n==============================================\n`);
  },
};

let override: Mailer | undefined;

/** 测试或后续真实发信实现通过它替换；传 undefined 恢复默认 */
export function setMailer(mailer: Mailer | undefined) { override = mailer; }

export function getMailer(): Mailer {
  if (override) return override;
  // 生产环境把登录链接打进日志等于泄露凭据：必须显式声明才允许
  if (process.env.NODE_ENV === 'production' && process.env.MAILER !== 'console') {
    throw new Error('生产环境未配置邮件发送（如确需输出到控制台，设置 MAILER=console）');
  }
  return consoleMailer;
}
