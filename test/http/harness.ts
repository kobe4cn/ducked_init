// test/http/harness.ts —— HTTP 接缝：进程内启动 React Router 服务端（vite SSR），用 Request/Response 直接驱动；背后是测试用平台 PG
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createServer, type ViteDevServer } from 'vite';
import { createRequestHandler, type ServerBuild } from 'react-router';
import pg from 'pg';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import type { Mail } from '../../app/.server/mailer';
import { totpCode } from '../../app/.server/totp';

export type { Mail };

export interface TestApp {
  /** 发出的邮件（替换了默认的控制台邮件） */
  outbox: Mail[];
  /** 替换发信实现；传 undefined 恢复默认（开发环境：输出到控制台） */
  setMailer(mailer: { send(m: Mail): Promise<void> } | undefined): void;
  /** 重新把邮件收进 outbox */
  useTestMailer(): void;
  /** 等待后台任务（签发链接、发信）全部完成 */
  drain(): Promise<void>;
  client(): Client;
  close(): Promise<void>;
}

const ORIGIN = 'http://crm.test';

/** RFC 6265 §5.1.4 路径匹配：/ops 匹配 /ops 与 /ops/…，但不匹配 /ops.data */
const pathMatches = (requestPath: string, cookiePath: string) =>
  requestPath === cookiePath ||
  (requestPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'));

/** RFC 6265 §5.1.4 默认路径：请求路径去掉最后一段 */
const defaultPath = (requestPath: string) => {
  const i = requestPath.lastIndexOf('/');
  return i <= 0 ? '/' : requestPath.slice(0, i);
};

/** 带 cookie 的浏览器替身，不自动跟随重定向；像浏览器一样按 Path 决定是否携带 cookie */
export class Client {
  private cookies = new Map<string, { name: string; value: string; path: string }>();
  constructor(private handler: (req: Request) => Promise<Response>) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, ORIGIN);
    const headers = new Headers(init.headers);
    // 与浏览器一样：同名 cookie 可按不同 Path 并存，Path 更长的排在前面（RFC 6265 §5.4）
    const sent = [...this.cookies.values()].filter(c => pathMatches(url.pathname, c.path)).sort((x, y) => y.path.length - x.path.length);
    if (sent.length && !headers.has('Cookie')) headers.set('Cookie', sent.map(c => `${c.name}=${c.value}`).join('; '));
    const res = await this.handler(new Request(url, { ...init, headers }));
    for (const c of res.headers.getSetCookie()) this.store(c, url.pathname);
    return res;
  }

  /** 按 Set-Cookie 头保存（或删除）cookie；requestPath 用于推出缺省的 Path */
  store(setCookie: string, requestPath = '/') {
    const [pair, ...attrs] = setCookie.split(';');
    const [name, value] = [pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1).trim()];
    const expired = !value || attrs.some(a => /^\s*max-age=0\s*$/i.test(a) || /^\s*expires=Thu, 01 Jan 1970/i.test(a));
    const path = attrs.map(a => a.trim().match(/^path=(.*)$/i)?.[1]).find(p => p?.startsWith('/')) ?? defaultPath(requestPath);
    const key = `${name};${path}`;
    expired ? this.cookies.delete(key) : this.cookies.set(key, { name, value, path });
  }

  get(path: string, headers?: HeadersInit) { return this.request(path, { headers }); }

  /** 当前持有的某个 cookie 的值 */
  cookie(name: string) { return [...this.cookies.values()].find(c => c.name === name)?.value; }

  post(path: string, form: Record<string, string> = {}, headers?: HeadersInit) {
    return this.request(path, { method: 'POST', body: new URLSearchParams(form), headers });
  }
}

export async function startApp(): Promise<TestApp> {
  const vite: ViteDevServer = await createServer({
    configFile: 'vite.config.ts',
    // 用单独的缓存目录、不做浏览器端依赖预构建：否则会改写开发服务器正在用的 node_modules/.vite/deps，
    // 浏览器随后请求依赖时收到 504（Outdated Optimize Dep）
    cacheDir: 'node_modules/.vite-test',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null },
    appType: 'custom',
    logLevel: 'error',
  });
  const build = (await vite.ssrLoadModule('virtual:react-router/server-build')) as ServerBuild;
  const handler = createRequestHandler(build, 'development');
  const mailer = await vite.ssrLoadModule('/app/.server/mailer.ts');
  const db = await vite.ssrLoadModule('/app/.server/db/client.ts');
  const background = await vite.ssrLoadModule('/app/.server/background.ts');
  const outbox: Mail[] = [];
  const testMailer = { async send(m: Mail) { outbox.push(m); } };
  mailer.setMailer(testMailer);

  return {
    outbox,
    setMailer: m => mailer.setMailer(m),
    useTestMailer: () => mailer.setMailer(testMailer),
    drain: () => background.drain(),
    client: () => new Client(req => handler(req)),
    async close() {
      await background.drain();
      await db.closeDb();
      await vite.close();
    },
  };
}

/** 清空平台元数据与租户数据湖（catalog schema、数据库角色、存储前缀），保证每个用例从空库开始 */
export async function resetDb() {
  const client = new pg.Client({ connectionString: process.env.PLATFORM_DATABASE_URL });
  await client.connect();
  const { rows } = await client.query<{ catalog_schema: string; db_role: string }>('SELECT catalog_schema, db_role FROM platform.tenant_lakes');
  for (const r of rows) await client.query(`DROP SCHEMA IF EXISTS "${r.catalog_schema}" CASCADE; DROP ROLE IF EXISTS "${r.db_role}"`);
  await client.query('TRUNCATE platform.tenants, platform.spaces, platform.members, platform.magic_links, platform.sessions, platform.magic_link_requests, platform.audit_logs, platform.operators, platform.operator_magic_links, platform.operator_sessions, platform.tenant_lakes, platform.tasks CASCADE');
  await client.end();
  // 对象存储上的数据不清：租户 ID 每次不同，前缀不会重叠
  if (!process.env.PLATFORM_LAKE_URI!.startsWith('s3://')) await rm(process.env.PLATFORM_LAKE_URI!, { recursive: true, force: true });
}

/** 以运营者身份执行命令行（与 npm run tenant:create 相同的入口） */
export async function runCli(script: string, args: string[]) {
  return promisify(execFile)(process.execPath, ['--import', 'tsx', script, ...args], {
    env: { ...process.env },
  }).then(r => ({ ...r, code: 0 }), (e: { stdout: string; stderr: string; code: number }) => e);
}

/** 以运营者身份开通租户（与 npm run tenant:create 相同的入口） */
export const createTenant = (slug: string, name: string, adminEmail: string) =>
  runCli('scripts/create-tenant.ts', ['--slug', slug, '--name', name, '--admin-email', adminEmail]);

/** 以服务器上的运营命令创建运营者（npm run operator:create） */
export const createOperator = (email: string) => runCli('scripts/create-operator.ts', ['--email', email]);

/** 以服务器上的运营命令重置运营者的 TOTP（npm run operator:reset-totp） */
export const resetOperatorTotp = (email: string) => runCli('scripts/reset-operator-totp.ts', ['--email', email]);

/** 从邮件正文里取出运营后台的登录链接（路径 + 查询串） */
export function extractOpsLink(mail: Mail): string {
  const m = mail.text.match(/https?:\/\/\S+\/ops\/auth\/verify\?token=[\w-]+/);
  if (!m) throw new Error(`邮件中没有运营后台登录链接：\n${mail.text}`);
  const u = new URL(m[0]);
  return u.pathname + u.search;
}

/** 运营者：申请 Magic Link → 确认登录，停在 TOTP 验证页之前 */
export async function opsMagicLogin(app: TestApp, email: string): Promise<Client> {
  const browser = app.client();
  await browser.post('/ops/login', { email });
  await app.drain();
  const mail = app.outbox.filter(m => m.to === email && /\/ops\/auth\/verify\?token=/.test(m.text)).at(-1);
  if (!mail) throw new Error(`没有发给 ${email} 的运营后台登录邮件`);
  const res = await browser.post(extractOpsLink(mail), {});
  if (res.headers.get('Location') !== '/ops/totp') throw new Error(`${email} 运营后台登录失败：${res.status}`);
  return browser;
}

/** 首次登录时 TOTP 绑定页上展示的密钥 */
export async function totpSecretOn(browser: Client): Promise<string> {
  const html = await (await browser.get('/ops/totp')).text();
  const m = html.match(/data-totp-secret="([A-Z2-7]+)"/);
  if (!m) throw new Error('TOTP 页面没有展示密钥');
  return m[1];
}

/** 像认证器 App 一样扫描 TOTP 页面上的二维码，返回其中编码的内容；页面没有二维码时返回 null */
export async function scanTotpQrOn(browser: Client): Promise<string | null> {
  const html = await (await browser.get('/ops/totp')).text();
  const img = html.match(/<img[^>]*data-totp-qr[^>]*>/)?.[0];
  const m = img?.match(/src="data:image\/png;base64,([^"]+)"/);
  if (!m) return null;
  const png = PNG.sync.read(Buffer.from(m[1], 'base64'));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  if (!decoded) throw new Error('TOTP 二维码无法识别');
  return decoded.data;
}

/** 运营者完整登录（Magic Link + 首次绑定 TOTP），返回已登录的浏览器与 TOTP 密钥 */
export async function loginAsOperator(app: TestApp, email: string): Promise<{ browser: Client; secret: string }> {
  const browser = await opsMagicLogin(app, email);
  const secret = await totpSecretOn(browser);
  const res = await browser.post('/ops/totp', { code: totpCode(secret) });
  if (res.headers.get('Location') !== '/ops') throw new Error(`${email} TOTP 验证失败：${res.status}`);
  return { browser, secret };
}

/** 申请 Magic Link → 打开链接 → 确认登录，返回已登录的浏览器 */
export async function loginAs(app: TestApp, email: string): Promise<Client> {
  const browser = app.client();
  await browser.post('/login', { email });
  await app.drain();
  const mail = app.outbox.filter(m => m.to === email && /\/auth\/verify\?token=/.test(m.text)).at(-1);
  if (!mail) throw new Error(`没有发给 ${email} 的登录邮件`);
  const res = await browser.post(extractLink(mail), {});
  if (res.status !== 302) throw new Error(`${email} 登录失败：${res.status}`);
  return browser;
}

/** 从邮件正文里取出登录链接（路径 + 查询串） */
export function extractLink(mail: Mail): string {
  const m = mail.text.match(/https?:\/\/\S+\/auth\/verify\?token=[\w-]+/);
  if (!m) throw new Error(`邮件中没有登录链接：\n${mail.text}`);
  const u = new URL(m[0]);
  return u.pathname + u.search;
}
