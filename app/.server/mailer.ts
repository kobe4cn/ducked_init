// app/.server/mailer.ts —— 发信接口与实现选择。业务代码只依赖 Mailer；实现由 MAILER 选择：
// smtp（经 SMTP 发信，如 QQ 邮箱；配置了 MAIL_HOST 时的默认值；开发环境下同时输出到控制台）、console（只输出到控制台）。
// 以后接入其他邮件服务：新增一个 Mailer 实现，在 createMailer 里登记一个 MAILER 取值
import nodemailer from 'nodemailer';

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void> }

const consoleMailer: Mailer = {
  async send({ to, subject, text }) {
    console.log(`\n======== 邮件（开发环境，输出到控制台）========\n收件人：${to}\n主题：${subject}\n\n${text}\n==============================================\n`);
  },
};

export interface SmtpConfig { host: string; port: number; user: string; pass: string; from: string }

/** QQ 邮箱：smtp.qq.com，465 端口走 SSL、587 端口走 STARTTLS；密码是邮箱设置里生成的授权码，发件人须是登录的邮箱本身 */
export function smtpMailer({ host, port, user, pass, from }: SmtpConfig): Mailer {
  const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  return {
    async send({ to, subject, text }) {
      try {
        await transport.sendMail({ from, to, subject, text });
      } catch (e) {
        throw new Error(`SMTP 发信失败：${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    },
  };
}

function smtpConfigFromEnv(): SmtpConfig {
  const { MAIL_HOST: host, MAIL_PORT, MAIL_USER: user, MAIL_PASS: pass, MAIL_FROM } = process.env;
  if (!host || !user || !pass) throw new Error('MAILER=smtp 需要配置 MAIL_HOST、MAIL_USER、MAIL_PASS');
  const port = MAIL_PORT ? Number(MAIL_PORT) : 465;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`MAIL_PORT 不是合法端口：${MAIL_PORT}`);
  // 不填 MAIL_FROM 时用登录账号作发件人（QQ 邮箱不允许冒用其他地址）
  return { host, port, user, pass, from: MAIL_FROM || `CRM 数据分析平台 <${user}>` };
}

/** 依次交给每个实现发送（先输出到控制台，发信失败时链接也已打印） */
function both(...mailers: Mailer[]): Mailer {
  return { async send(mail) { for (const m of mailers) await m.send(mail); } };
}

function createMailer(): Mailer {
  const kind = process.env.MAILER || (process.env.MAIL_HOST ? 'smtp' : undefined);
  switch (kind) {
    case 'smtp': {
      const smtp = smtpMailer(smtpConfigFromEnv());
      // 开发环境同时输出到控制台，收不到信时也能拿到链接；生产环境不输出（链接即凭据）
      return process.env.NODE_ENV === 'production' ? smtp : both(consoleMailer, smtp);
    }
    case 'console':
      return consoleMailer;
    case undefined:
      // 生产环境把登录链接打进日志等于泄露凭据：必须显式声明才允许
      if (process.env.NODE_ENV === 'production') {
        throw new Error('生产环境未配置邮件发送：设置 MAIL_HOST、MAIL_USER、MAIL_PASS（如确需输出到控制台，设置 MAILER=console）');
      }
      return consoleMailer;
    default:
      throw new Error(`不支持的 MAILER：${kind}（可选 smtp、console）`);
  }
}

let override: Mailer | undefined;
let configured: Mailer | undefined;

/** 测试通过它替换发信实现；传 undefined 恢复按环境变量选择 */
export function setMailer(mailer: Mailer | undefined) { override = mailer; }

export function getMailer(): Mailer {
  if (override) return override;
  return (configured ??= createMailer());
}
