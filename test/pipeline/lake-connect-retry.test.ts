// test/pipeline/lake-connect-retry.test.ts —— 湖 catalog（DuckLake 的 PostgreSQL）建连超时的重试（#938）：
// 完整测试里工作台保存 3 行 CTAS 报「查询超过 60 秒」，计时器内唯一走网络的一步是 openTenantLake 的
// ATTACH 'ducklake:postgres:<catalogUrl>'：它不带 connect_timeout 时 libpq 会一直等（interrupt() 打断不了建连），
// 沙箱经 podman 网关建连偶发卡住（#545、#627、#892 同一现象，#892 只修了源库 ATTACH）。
// 照 #892 拍板的方案：设了 LAKE_CONNECT_TIMEOUT_SECONDS 才给 catalogUrl 拼 connect_timeout（默认不设、不加参数，生产行为不变），
// ATTACH 报错含 timeout expired 时按 LAKE_CONNECT_RETRIES 重试（默认 0）。本地起一个接受连接但不回包的 TCP 服务当
// catalog 库：每次 ATTACH 都超时，用连接次数证明重试次数（1 + 重试数）。另附两个解析函数的纯函数用例（照 source-connect-timeout.test.ts）
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { lakeCatalogAttachUrl, lakeConnectRetries, lakeConnectTimeout, openTenantLake, type EngineLimits, type LakeSpec } from '../../app/.server/pipeline/lake-engine';

// 压测 DuckDB 实例给小资源（照 source-connect-retry.test.ts）：建连路径用不了多少内存与线程
const limits: EngineLimits = { memoryLimitMb: 256, threads: 1 };

/** 假 catalog 库：接受 TCP 连接但不回包，只数连接次数；afterAll 统一销毁 socket 再关服务 */
const sockets = new Set<net.Socket>();
let connections = 0;
const server = net.createServer(socket => {
  connections += 1;
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

/** 假 catalog 库：接受连接后立刻断开，libpq 报 server closed the connection unexpectedly 一类的错（不含 timeout expired） */
let closedConnections = 0;
const closingServer = net.createServer(socket => {
  closedConnections += 1;
  socket.destroy();
});

/** 湖的存储前缀用本地临时目录（不开对象存储） */
let dataPath = '';
beforeAll(async () => {
  dataPath = mkdtempSync(join(tmpdir(), 'lake-connect-retry-'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => closingServer.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await new Promise<void>(resolve => closingServer.close(() => resolve()));
  rmSync(dataPath, { recursive: true, force: true });
});
afterEach(() => { vi.unstubAllEnvs(); connections = 0; closedConnections = 0; });

const spec = (target: net.Server = server): LakeSpec => {
  const address = target.address() as net.AddressInfo;
  return {
    dataPath,
    // host 用 127.0.0.1：localhost 可能解析出 ::1，libpq 会多连一次，计数就不准
    catalogUrl: `postgres://reader:reader@${address.address}:${address.port}/crm`,
    catalogSchema: 'lake',
  };
};

describe('湖 catalog 建连超时的重试', () => {
  it('ATTACH 超时按 LAKE_CONNECT_RETRIES 重试：重试 2 次时连接 3 次', async () => {
    vi.stubEnv('LAKE_CONNECT_TIMEOUT_SECONDS', '2');
    vi.stubEnv('LAKE_CONNECT_RETRIES', '2');
    await expect(openTenantLake(spec(), limits)).rejects.toThrow(/timeout expired/);
    expect(connections).toBe(3);
  });

  it('不重试（LAKE_CONNECT_RETRIES=0）时只连接 1 次', async () => {
    vi.stubEnv('LAKE_CONNECT_TIMEOUT_SECONDS', '2');
    vi.stubEnv('LAKE_CONNECT_RETRIES', '0');
    await expect(openTenantLake(spec(), limits)).rejects.toThrow(/timeout expired/);
    expect(connections).toBe(1);
  });

  it('其他错误（连上即被断开）立刻抛出、不重试：重试 2 次时的连接次数与重试 0 次相同', async () => {
    vi.stubEnv('LAKE_CONNECT_TIMEOUT_SECONDS', '2');
    // 基准：不重试时的连接次数（DuckLake 一次 ATTACH 可能开多条 catalog 连接，不硬写 1）
    vi.stubEnv('LAKE_CONNECT_RETRIES', '0');
    const baseline = await openTenantLake(spec(closingServer), limits).then(
      () => { throw new Error('openTenantLake 应当失败'); },
      (e: Error) => { expect(e.message).not.toMatch(/timeout expired/); return closedConnections; },
    );
    expect(baseline).toBeGreaterThan(0);

    closedConnections = 0;
    vi.stubEnv('LAKE_CONNECT_RETRIES', '2');
    const error = await openTenantLake(spec(closingServer), limits).then(() => null, (e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toMatch(/timeout expired/);
    expect(closedConnections).toBe(baseline);
  });
});

describe('湖 catalog 建连超时秒数与重试次数的解析', () => {
  it('超时不设或为空时返回 undefined（不加 connect_timeout，生产行为不变）', () => {
    expect(lakeConnectTimeout({})).toBeUndefined();
    expect(lakeConnectTimeout({ LAKE_CONNECT_TIMEOUT_SECONDS: '' })).toBeUndefined();
  });

  it('超时是正整数字符串时按设置的值', () => {
    expect(lakeConnectTimeout({ LAKE_CONNECT_TIMEOUT_SECONDS: '15' })).toBe(15);
  });

  it('超时不是正整数（非数字、0、负数、小数）时返回 undefined', () => {
    expect(lakeConnectTimeout({ LAKE_CONNECT_TIMEOUT_SECONDS: 'abc' })).toBeUndefined();
    expect(lakeConnectTimeout({ LAKE_CONNECT_TIMEOUT_SECONDS: '0' })).toBeUndefined();
    expect(lakeConnectTimeout({ LAKE_CONNECT_TIMEOUT_SECONDS: '-5' })).toBeUndefined();
    expect(lakeConnectTimeout({ LAKE_CONNECT_TIMEOUT_SECONDS: '2.5' })).toBeUndefined();
  });

  it('重试次数不设或为空时用默认 0', () => {
    expect(lakeConnectRetries({})).toBe(0);
    expect(lakeConnectRetries({ LAKE_CONNECT_RETRIES: '' })).toBe(0);
  });

  it('重试次数是非负整数字符串时按设置的值', () => {
    expect(lakeConnectRetries({ LAKE_CONNECT_RETRIES: '0' })).toBe(0);
    expect(lakeConnectRetries({ LAKE_CONNECT_RETRIES: '2' })).toBe(2);
  });

  it('重试次数不是非负整数（非数字、负数、小数）时回到默认 0', () => {
    expect(lakeConnectRetries({ LAKE_CONNECT_RETRIES: 'abc' })).toBe(0);
    expect(lakeConnectRetries({ LAKE_CONNECT_RETRIES: '-1' })).toBe(0);
    expect(lakeConnectRetries({ LAKE_CONNECT_RETRIES: '1.5' })).toBe(0);
  });
});

describe('湖 catalog ATTACH 用的 URL（拼 connect_timeout）', () => {
  it('已有查询参数原样保留（%20 不变成 +），末尾追加 &connect_timeout', () => {
    const url = 'postgres://u:p@127.0.0.1:5432/db?options=-c%20search_path%3Dx';
    const out = lakeCatalogAttachUrl(url, 15);
    expect(out).toContain('options=-c%20search_path%3Dx');
    expect(out).toBe(`${url}&connect_timeout=15`);
  });

  it('没有查询串时追加 ?connect_timeout', () => {
    expect(lakeCatalogAttachUrl('postgres://u:p@127.0.0.1:5432/db', 15)).toBe('postgres://u:p@127.0.0.1:5432/db?connect_timeout=15');
  });

  it('超时为 undefined 时 URL 原样返回', () => {
    const url = 'postgres://u:p@127.0.0.1:5432/db?options=-c%20search_path%3Dx';
    expect(lakeCatalogAttachUrl(url, undefined)).toBe(url);
  });
});
