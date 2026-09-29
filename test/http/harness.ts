// test/http/harness.ts —— HTTP 接缝：进程内启动 React Router 服务端（vite SSR），用 Request/Response 直接驱动；背后是测试用平台 PG
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type ViteDevServer } from 'vite';
import { createRequestHandler, type ServerBuild } from 'react-router';
import pg from 'pg';
import type { Mail } from '../../app/.server/mailer';

export type { Mail };

export interface TestApp {
  /** 发出的邮件（替换了默认的控制台邮件） */
  outbox: Mail[];
  /** 恢复默认邮件实现（开发环境：输出到控制台） */
  useDefaultMailer(): Promise<void>;
  /** 重新把邮件收进 outbox */
  useTestMailer(): Promise<void>;
  client(): Client;
  close(): Promise<void>;
}

const ORIGIN = 'http://crm.test';

/** 带 cookie 的浏览器替身，不自动跟随重定向 */
export class Client {
  private cookies = new Map<string, string>();
  constructor(private handler: (req: Request) => Promise<Response>) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await this.handler(new Request(new URL(path, ORIGIN), { ...init, headers }));
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [name, value] = [pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1).trim()];
      const expired = !value || attrs.some(a => /^\s*max-age=0\s*$/i.test(a) || /^\s*expires=Thu, 01 Jan 1970/i.test(a));
      expired ? this.cookies.delete(name) : this.cookies.set(name, value);
    }
    return res;
  }

  get(path: string) { return this.request(path); }

  post(path: string, form: Record<string, string> = {}) {
    return this.request(path, { method: 'POST', body: new URLSearchParams(form) });
  }
}

export async function startApp(): Promise<TestApp> {
  const vite: ViteDevServer = await createServer({
    configFile: 'vite.config.ts',
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
  });
  const build = (await vite.ssrLoadModule('virtual:react-router/server-build')) as ServerBuild;
  const handler = createRequestHandler(build, 'development');
  const mailer = await vite.ssrLoadModule('/app/.server/mailer.ts');
  const db = await vite.ssrLoadModule('/app/.server/db/client.ts');
  const outbox: Mail[] = [];
  const testMailer = { async send(m: Mail) { outbox.push(m); } };
  mailer.setMailer(testMailer);

  return {
    outbox,
    async useDefaultMailer() { mailer.setMailer(undefined); },
    async useTestMailer() { mailer.setMailer(testMailer); },
    client: () => new Client(req => handler(req)),
    async close() {
      await db.closeDb();
      await vite.close();
    },
  };
}

/** 清空平台元数据，保证每个用例从空库开始 */
export async function resetDb() {
  const client = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
  await client.connect();
  await client.query('TRUNCATE platform.tenants, platform.spaces, platform.members, platform.magic_links, platform.sessions CASCADE');
  await client.end();
}

/** 以运营者身份执行命令行（与 npm run tenant:create 相同的入口） */
export async function runCli(script: string, args: string[]) {
  return promisify(execFile)(process.execPath, ['--import', 'tsx', script, ...args], {
    env: { ...process.env },
  }).then(r => ({ ...r, code: 0 }), (e: { stdout: string; stderr: string; code: number }) => e);
}

/** 从邮件正文里取出登录链接（路径 + 查询串） */
export function extractLink(mail: Mail): string {
  const m = mail.text.match(/https?:\/\/\S+\/auth\/verify\?token=[\w-]+/);
  if (!m) throw new Error(`邮件中没有登录链接：\n${mail.text}`);
  const u = new URL(m[0]);
  return u.pathname + u.search;
}
