// test/pipeline/source-connect-retry.test.ts —— PostgreSQL 源库建连超时的重试（#892）：
// 完整测试里 probe → ATTACH 建连偶发 connect_timeout 超时（#545、#627），#627 的对照里 TCP 与 PG 侧都正常，
// 人拍板按方案 A：attachSource 的 ATTACH 报错含 timeout expired 时按 SOURCE_CONNECT_RETRIES 重试（默认 0，行为不变）。
// 本地起一个接受连接但不回包的 TCP 服务当源库：每次 ATTACH 都超时，用连接次数证明重试次数（1 + 重试数）。
import net from 'node:net';
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EngineLimits } from '../../app/.server/pipeline/lake-engine';
import { openSource, type SourceSpec } from '../../app/.server/pipeline/source-engine';

// 压测 DuckDB 实例给小资源（照 source-connect-stress.test.ts）：建连路径用不了多少内存与线程
const limits: EngineLimits = { memoryLimitMb: 256, threads: 1 };

/** 假源库：接受 TCP 连接但不回包，只数连接次数；afterAll 统一销毁 socket 再关服务 */
const sockets = new Set<net.Socket>();
let connections = 0;
const server = net.createServer(socket => {
  connections += 1;
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
afterEach(() => { vi.unstubAllEnvs(); connections = 0; });

const spec = (): Extract<SourceSpec, { kind: 'postgres' }> => {
  const address = server.address() as net.AddressInfo;
  return {
    kind: 'postgres', host: address.address, port: address.port,
    database: 'crm', schema: 'public', user: 'reader', password: 'reader',
  };
};

describe('PostgreSQL 源库建连超时的重试', () => {
  it('ATTACH 超时按 SOURCE_CONNECT_RETRIES 重试：重试 2 次时连接 3 次', async () => {
    vi.stubEnv('SOURCE_CONNECT_TIMEOUT_SECONDS', '2');
    vi.stubEnv('SOURCE_CONNECT_RETRIES', '2');
    // host 用 127.0.0.1：localhost 可能解析出 ::1，libpq 会多连一次，计数就不准
    await expect(openSource(spec(), limits)).rejects.toThrow(/timeout expired/);
    expect(connections).toBe(3);
  });

  it('不重试（SOURCE_CONNECT_RETRIES=0）时只连接 1 次', async () => {
    vi.stubEnv('SOURCE_CONNECT_TIMEOUT_SECONDS', '2');
    vi.stubEnv('SOURCE_CONNECT_RETRIES', '0');
    await expect(openSource(spec(), limits)).rejects.toThrow(/timeout expired/);
    expect(connections).toBe(1);
  });
});
