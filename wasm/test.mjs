// wasm/test.mjs —— 用无头 Chromium 打开看板页面，验证 DuckDB-Wasm 在浏览器里跑通（CI / 本地自测用）
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const server = spawn(process.execPath, ['serve.mjs'], { stdio: 'ignore', env: { ...process.env, PORT: '8787' } });
await new Promise(r => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const bytes = { total: 0, ranges: 0 };
page.on('response', r => { if (r.url().includes('/data/')) { bytes.ranges++; bytes.total += Number(r.headers()['content-length'] ?? 0); } });
await page.goto('http://localhost:8787/' + (process.env.QS ?? ''));
await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 60_000 });
console.log(await page.textContent('#log'));
console.log('首屏结果：', await page.evaluate(() => window.__rows?.slice(0, 3)));
await page.selectOption('#city', '上海');
await page.waitForFunction(() => document.querySelector('#timing').textContent.includes('ms'));
await page.waitForTimeout(500);
console.log('切换到上海：', await page.textContent('#timing'), JSON.stringify(await page.evaluate(() => window.__rows?.slice(0, 2))));
console.log(`数据文件请求 ${bytes.ranges} 次，共传输 ${(bytes.total / 1e6).toFixed(2)} MB`);
await page.screenshot({ path: 'screenshot.png', fullPage: true });
await browser.close();
server.kill();
