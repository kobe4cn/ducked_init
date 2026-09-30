// app/.server/mailer.ts —— 发信接口与实现选择。业务代码只依赖 Mailer；实现由 MAILER 选择：
// resend（Resend 邮件服务，配置了 RESEND_API_KEY 时的默认值；开发环境下同时输出到控制台）、console（只输出到控制台）。
// 以后接入其他邮件服务：新增一个 Mailer 实现，在 createMailer 里登记一个 MAILER 取值
import { Resend } from 'resend';

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void> }

const consoleMailer: Mailer = {
  async send({ to, subject, text }) {
    console.log(`\n======== 邮件（开发环境，输出到控制台）========\n收件人：${to}\n主题：${subject}\n\n${text}\n==============================================\n`);
  },
};

/** 未验证发信域名时 Resend 只允许用 onboarding@resend.dev 发信，且只能发给 Resend 账号本人的邮箱 */
const DEFAULT_FROM = 'CRM 数据分析平台 <onboarding@resend.dev>';

export function resendMailer(apiKey: string, from: string): Mailer {
  const client = new Resend(apiKey);
  return {
    async send({ to, subject, text }) {
      // SDK 出错时不抛异常，而是返回 error，这里转成异常交给调用方记录
      const { error } = await client.emails.send({ from, to, subject, text });
      if (error) throw new Error(`Resend 发信失败（${error.name}）：${error.message}`);
    },
  };
}

/** 依次交给每个实现发送（先输出到控制台，发信失败时链接也已打印） */
function both(...mailers: Mailer[]): Mailer {
  return { async send(mail) { for (const m of mailers) await m.send(mail); } };
}

function createMailer(): Mailer {
  const kind = process.env.MAILER || (process.env.RESEND_API_KEY ? 'resend' : undefined);
  switch (kind) {
    case 'resend': {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) throw new Error('MAILER=resend 需要配置 RESEND_API_KEY');
      const resend = resendMailer(apiKey, process.env.MAIL_FROM || DEFAULT_FROM);
      // 开发环境同时输出到控制台，收不到信时也能拿到链接；生产环境不输出（链接即凭据）
      return process.env.NODE_ENV === 'production' ? resend : both(consoleMailer, resend);
    }
    case 'console':
      return consoleMailer;
    case undefined:
      // 生产环境把登录链接打进日志等于泄露凭据：必须显式声明才允许
      if (process.env.NODE_ENV === 'production') {
        throw new Error('生产环境未配置邮件发送：设置 RESEND_API_KEY（如确需输出到控制台，设置 MAILER=console）');
      }
      return consoleMailer;
    default:
      throw new Error(`不支持的 MAILER：${kind}（可选 resend、console）`);
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
