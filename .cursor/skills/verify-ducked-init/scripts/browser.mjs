#!/usr/bin/env node
// Drive the verification instance in one long-lived system Chrome.
// The first command starts a daemon (pid in $STATE_DIR/browser.pid). Later commands
// reconnect to it, so client-side pages such as "请查收邮件" survive between calls.
// magic-link only reads the server log and does not need Chrome.
//
//   node .cursor/skills/verify-ducked-init/scripts/browser.mjs goto /login
//   node .cursor/skills/verify-ducked-init/scripts/browser.mjs fill --label "工作邮箱" --value admin@verify.test
//   node .cursor/skills/verify-ducked-init/scripts/browser.mjs click --role button --name "发送登录链接"
//   node .cursor/skills/verify-ducked-init/scripts/browser.mjs wait-text "请查收邮件"
//   node .cursor/skills/verify-ducked-init/scripts/browser.mjs magic-link --email admin@verify.test --offset 0
//   node .cursor/skills/verify-ducked-init/scripts/browser.mjs click --role button --name "恢复默认" --confirm accept
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(scriptDir, '..');
const selfPath = fileURLToPath(import.meta.url);

function parseEnvFile(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq);
    let raw = line.slice(eq + 1);
    if (raw.startsWith("'")) raw = raw.slice(1, -1).replaceAll("'\\''", "'");
    env[key] = raw;
  }
  return env;
}

function stateDirFromEnv() {
  if (process.env.VERIFY_STATE_DIR) return resolve(process.env.VERIFY_STATE_DIR);
  const root = process.env.VERIFY_STATE_ROOT || '/tmp/verify-ducked-init';
  return resolve(root, 'current');
}

function loadState(dir) {
  const file = join(dir, 'state.env');
  try {
    // Resolve the `current` symlink so the Chrome --user-data-dir matches the path cleanup.sh greps for.
    return { ...parseEnvFile(file), STATE_DIR: realpathSync(dir) };
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`);
    process.exit(1);
  }
}

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('bash', ['-lc', `command -v ${name}`], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  console.error('No Chrome or Chromium on PATH. Set CHROME_PATH to the browser executable.');
  process.exit(1);
}

function latestToken(text, email) {
  const parts = text.split('======== 邮件（开发环境，输出到控制台）========');
  for (let i = parts.length - 1; i >= 0; i--) {
    const block = parts[i];
    if (!block.includes(`收件人：${email}`)) continue;
    const match = block.match(/https?:\/\/[^\s]+\/auth\/verify\?token=[A-Za-z0-9_-]+/);
    if (match) return match[0];
  }
  return null;
}

function sleep(ms) {
  spawnSync('sleep', [String(ms / 1000)]);
}

if (process.argv[2] === '--daemon') {
  await runDaemon(process.argv[3]);
} else {
  await runClient();
}

async function runDaemon(dir) {
  const state = loadState(dir);
  const ensured = spawnSync('bash', [join(scriptDir, 'ensure-browser.sh')], { stdio: 'inherit' });
  if (ensured.status !== 0) process.exit(ensured.status ?? 1);
  const require = createRequire(join(skillDir, '.tools/package.json'));
  const { chromium } = require('playwright-core');
  const profile = join(state.STATE_DIR, 'chrome-profile');
  mkdirSync(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: chromePath(),
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = context.pages()[0] || await context.newPage();
  const sock = join(state.STATE_DIR, 'browser.sock');
  if (existsSync(sock)) unlinkSync(sock);
  const server = net.createServer(socket => {
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (!buf.includes('\n')) return;
      const line = buf.slice(0, buf.indexOf('\n'));
      handle(page, state, JSON.parse(line))
        .then(result => socket.end(JSON.stringify({ ok: true, ...result }) + '\n'))
        .catch(async error => {
          let text = '';
          try { text = (await page.locator('body').innerText()).slice(0, 800); } catch { /* closed */ }
          socket.end(JSON.stringify({
            ok: false,
            error: String(error?.stack || error),
            url: page.url(),
            text,
          }) + '\n');
        });
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(sock, resolveListen);
  });
  const shutdown = async () => {
    server.close();
    await context.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function handle(page, state, req) {
  const timeout = Number(req.timeout ?? 20000);
  page.setDefaultTimeout(timeout);
  const cmd = req.cmd;
  // --within 把 fill / click / select / value 限定在一个 CSS 选择器内部，用于区分页面里重名的控件（如多个「添加一行」）
  const scope = req.within ? page.locator(req.within) : page;
  if (cmd === 'goto') {
    const raw = req.positionals?.[0];
    if (!raw) throw new Error('goto requires a path or URL');
    const target = raw.startsWith('http') ? raw : new URL(raw, state.BASE_URL).toString();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
    return {};
  }
  if (cmd === 'fill') {
    if (!req.label || req.value === undefined) throw new Error('fill requires --label and --value');
    await scope.getByLabel(req.label, { exact: true }).fill(req.value);
    return {};
  }
  if (cmd === 'click') {
    if (!req.role || !req.name) throw new Error('click requires --role and --name');
    if (req.confirm != null && req.confirm !== 'accept' && req.confirm !== 'dismiss') {
      throw new Error('--confirm must be accept or dismiss');
    }
    let onDialog = null;
    if (req.confirm) {
      const decision = req.confirm;
      onDialog = async dialog => {
        if (decision === 'accept') await dialog.accept();
        else await dialog.dismiss();
      };
      page.once('dialog', onDialog);
    }
    try {
      await scope.getByRole(req.role, { name: req.name, exact: true }).click();
    } finally {
      if (onDialog) page.off('dialog', onDialog);
    }
    return {};
  }
  if (cmd === 'select') {
    if (!req.label || req.value === undefined) throw new Error('select requires --label and --value');
    await scope.getByLabel(req.label, { exact: true }).selectOption(req.value);
    return {};
  }
  if (cmd === 'set-hidden') {
    // 直接写隐藏字段的 DOM 值，绕过 React：手工构造构建器的 form 提交用。
    // 隐藏字段是受控的，下一次重渲染会把值覆盖回去，设完要立刻提交。
    if (!req.name || req.value === undefined) throw new Error('set-hidden requires --name and --value');
    await scope.locator(`input[type="hidden"][name="${req.name}"]`).first().evaluate((el, v) => { el.value = v; }, req.value);
    return {};
  }
  if (cmd === 'wait-text') {
    const text = req.positionals?.[0];
    if (!text) throw new Error('wait-text requires the text');
    await page.getByText(text, { exact: true }).first().waitFor({ state: 'visible', timeout });
    return {};
  }
  if (cmd === 'wait-url') {
    const pathname = req.positionals?.[0];
    if (!pathname) throw new Error('wait-url requires a pathname');
    await page.waitForURL(url => {
      const path = new URL(url).pathname.replace(/\/$/, '') || '/';
      const want = pathname.replace(/\/$/, '') || '/';
      return path === want;
    }, { timeout });
    return {};
  }
  if (cmd === 'wait-selector') {
    const selector = req.positionals?.[0];
    if (!selector) throw new Error('wait-selector requires a selector');
    await page.locator(selector).first().waitFor({ state: 'visible', timeout });
    return {};
  }
  if (cmd === 'screenshot') {
    if (!req.path) throw new Error('screenshot requires --path');
    mkdirSync(dirname(req.path), { recursive: true });
    await page.screenshot({ path: req.path, fullPage: true });
    return { stderr: req.path };
  }
  if (cmd === 'snapshot') {
    if (!req.path) throw new Error('snapshot requires --path');
    mkdirSync(dirname(req.path), { recursive: true });
    const snap = await page.locator('body').ariaSnapshot();
    writeFileSync(req.path, typeof snap === 'string' ? snap : JSON.stringify(snap, null, 2));
    return { stderr: req.path };
  }
  if (cmd === 'title') return { stdout: await page.title() };
  if (cmd === 'url') return { stdout: page.url() };
  if (cmd === 'text') {
    if (!req.selector) throw new Error('text requires --selector');
    return { stdout: await page.locator(req.selector).first().innerText() };
  }
  if (cmd === 'value') {
    if (!req.label) throw new Error('value requires --label');
    return { stdout: await scope.getByLabel(req.label, { exact: true }).inputValue() };
  }
  if (cmd === 'count') {
    if (!req.selector) throw new Error('count requires --selector');
    return { stdout: String(await page.locator(req.selector).count()) };
  }
  if (cmd === 'set-file') {
    // 文件选择框不能用 fill 写入。CSV 上传数据源的登记表单要用它。
    if (!req.selector || !req.path) throw new Error('set-file requires --selector and --path');
    await scope.locator(req.selector).setInputFiles(req.path);
    return {};
  }
  throw new Error(`unknown command ${cmd}`);
}

function usage() {
  console.error(`usage: browser.mjs <goto|fill|click|select|set-hidden|set-file|wait-text|wait-url|wait-selector|screenshot|snapshot|title|url|text|value|count|magic-link> [args]`);
  console.error('click accepts --confirm accept|dismiss for a window.confirm dialog');
}

async function runClient() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      label: { type: 'string' },
      role: { type: 'string' },
      name: { type: 'string' },
      value: { type: 'string' },
      path: { type: 'string' },
      email: { type: 'string' },
      state: { type: 'string' },
      offset: { type: 'string' },
      timeout: { type: 'string' },
      selector: { type: 'string' },
      within: { type: 'string' },
      confirm: { type: 'string' },
    },
  });
  const cmd = positionals[0];
  if (!cmd) {
    usage();
    process.exit(2);
  }
  const dir = values.state ? resolve(values.state) : stateDirFromEnv();
  const state = loadState(dir);
  if (cmd === 'magic-link') {
    if (!values.email) {
      console.error('magic-link requires --email');
      process.exit(2);
    }
    const offset = Number(values.offset ?? 0);
    const timeout = Number(values.timeout ?? 20000);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let text = '';
      try {
        const buf = readFileSync(state.LOG_FILE);
        text = buf.subarray(Math.min(offset, buf.length)).toString('utf8');
      } catch { text = ''; }
      const url = latestToken(text, values.email);
      if (url) {
        console.log(url);
        return;
      }
      sleep(250);
    }
    console.error(`no Magic Link for ${values.email} in ${state.LOG_FILE} after offset ${offset}`);
    process.exit(1);
  }
  await ensureDaemon(state);
  const response = await send(join(state.STATE_DIR, 'browser.sock'), {
    cmd,
    positionals: positionals.slice(1),
    label: values.label,
    role: values.role,
    name: values.name,
    value: values.value,
    path: values.path,
    selector: values.selector,
    within: values.within,
    confirm: values.confirm,
    timeout: values.timeout,
  });
  if (!response.ok) {
    console.error(response.error);
    if (response.url) console.error('url:', response.url);
    if (response.text) console.error(response.text);
    process.exit(1);
  }
  if (response.stdout !== undefined) console.log(response.stdout);
  if (response.stderr) console.error(response.stderr);
}

async function ensureDaemon(state) {
  const sock = join(state.STATE_DIR, 'browser.sock');
  const pidFile = join(state.STATE_DIR, 'browser.pid');
  if (await ping(sock)) return;
  if (existsSync(sock)) {
    try { unlinkSync(sock); } catch { /* daemon may still be binding */ }
  }
  const logFd = openSync(join(state.STATE_DIR, 'browser-daemon.log'), 'a');
  const child = spawn(process.execPath, [selfPath, '--daemon', state.STATE_DIR], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await ping(sock)) return;
    sleep(200);
  }
  console.error('browser daemon did not open ' + sock);
  process.exit(1);
}

function ping(sock) {
  return new Promise(resolvePing => {
    if (!existsSync(sock)) return resolvePing(false);
    const socket = net.connect(sock);
    const timer = setTimeout(() => { socket.destroy(); resolvePing(false); }, 1000);
    socket.on('connect', () => { clearTimeout(timer); socket.end(); resolvePing(true); });
    socket.on('error', () => { clearTimeout(timer); resolvePing(false); });
  });
}

function send(sock, payload) {
  return new Promise((resolveSend, reject) => {
    const socket = net.connect(sock);
    let buf = '';
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', chunk => { buf += chunk.toString('utf8'); });
    socket.on('end', () => {
      try { resolveSend(JSON.parse(buf)); }
      catch (e) { reject(e); }
    });
    socket.on('error', reject);
  });
}
