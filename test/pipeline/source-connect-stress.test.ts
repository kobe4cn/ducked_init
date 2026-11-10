// test/pipeline/source-connect-stress.test.ts —— PG 源库建连压测（#627）：
// 完整测试（多 worker、并行沙箱）里 probe → ATTACH 建连偶发 connect_timeout 超时，#545 调到 30 秒仍超时，根因停在推断
// （SYN / 首包被 podman gvproxy 或端口发布丢掉，还是 PG 的 accept backlog 满了）。本用例并发 N 路走产品同一条路径
// openSource 挂载测试源库，同时对同一 host:port 做 N 路裸 TCP 建连作对照：裸 TCP 也慢 / 失败 → 网络转发层；
// 裸 TCP 快、openSource 慢 → PG 侧（accept backlog、认证）或 DuckDB 扩展加载。只统计与输出，失败是数据不是错误，
// 不设断言（结果总数除外）；结论写进 #627 的提交信息，修复另开票。默认跳过，CRM_TEST_CONNECT_STRESS=1 时才跑。
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EngineLimits } from '../../app/.server/pipeline/lake-engine';
import { openSource, sourceConnectTimeout, type SourceSpec } from '../../app/.server/pipeline/source-engine';
import { READER, seedPgSource } from './source-fixtures';

// 并发路数：默认 32，CRM_TEST_CONNECT_STRESS_N 可调（不是正整数时按默认）
const parsedN = Math.floor(Number(process.env.CRM_TEST_CONNECT_STRESS_N ?? 32));
const N = parsedN > 0 ? parsedN : 32;
// 压测 DuckDB 实例给小资源：建连路径本身用不了多少内存与线程
const limits: EngineLimits = { memoryLimitMb: 256, threads: 1 };

interface Attempt { ok: boolean; ms: number; error?: unknown }

/** 排序后的分位数（q ∈ (0,1]，取下取整的那个样本，够定位用） */
const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

/** 输出一组的汇总：样本数、p50 / p95 / max、失败数与前几条失败报错。经 process.stdout.write：
 * 本仓库的 vitest 不回显测试里的 console.log，而这些数字正是本用例的交付物 */
const say = (line: string) => process.stdout.write(line + '\n');
function report(label: string, host: string, ip: string, attempts: Attempt[]) {
  const sorted = attempts.filter(a => a.ok).map(a => a.ms).sort((a, b) => a - b);
  const sec = (ms: number) => (ms / 1000).toFixed(1) + 's';
  const head = `[source-connect-stress] ${label} host=${host} (${ip}) n=${attempts.length} connect_timeout=${sourceConnectTimeout()}s`;
  if (!sorted.length) return say(`${head} 成功=0 失败=${attempts.length}`);
  say(`${head} 成功=${sorted.length} p50=${sec(pct(sorted, 0.5))} p95=${sec(pct(sorted, 0.95))} max=${sec(sorted[sorted.length - 1])} 失败=${attempts.length - sorted.length}`);
  for (const { ms, error } of attempts.filter(a => !a.ok).slice(0, 3)) {
    say(`  失败(${sec(ms)}): ${String((error as Error | undefined)?.message ?? error).replaceAll('\n', ' ').slice(0, 300)}`);
  }
}

describe.skipIf(process.env.CRM_TEST_CONNECT_STRESS !== '1')('PG 源库建连压测（#627）', () => {
  let spec: Extract<SourceSpec, { kind: 'postgres' }>;
  let host: string;
  let port: number;
  let ip: string;

  beforeAll(async () => {
    const seeded = await seedPgSource(); // 重建 shop schema，确保账号与库就绪
    host = seeded.host;
    port = Number(seeded.port); // seedPgSource 返回的 port 是字符串
    spec = { kind: 'postgres', host, port, database: seeded.database, schema: seeded.schema, user: READER.user, password: READER.password };
    ip = (await lookup(host)).address; // 汇总里带上解析到的 IP，确认对照与产品路径打的是同一个地址
  });

  it('N 路并发 openSource 挂载（产品同一条路径）', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: N }, async (): Promise<Attempt> => {
      const start = performance.now();
      try {
        const session = await openSource(spec, limits); // 每路新开 :memory: DuckDB：INSTALL/LOAD postgres、建 SECRET、ATTACH（connect_timeout 生效处）
        const ms = performance.now() - start;
        session.close();
        return { ok: true, ms };
      } catch (error) {
        return { ok: false, ms: performance.now() - start, error };
      }
    }));
    const rows = attempts.map(r => (r.status === 'fulfilled' ? r.value : { ok: false, ms: NaN, error: r.reason }));
    expect(rows).toHaveLength(N); // 失败本身是数据：只核对总数，不让用例因失败变红
    report('openSource', host, ip, rows);
  }, 180_000);

  it('对照：同一 host:port 的 N 路裸 TCP 建连', async () => {
    const rows: Attempt[] = await Promise.all(Array.from({ length: N }, () => new Promise<Attempt>(resolve => {
      const start = performance.now();
      const socket = net.connect({ host, port });
      socket.setTimeout(60_000); // 与建连超时同量级：connect 事件即成功，60 秒没连上记失败
      socket.once('connect', () => { socket.destroy(); resolve({ ok: true, ms: performance.now() - start }); });
      socket.once('timeout', () => { socket.destroy(); resolve({ ok: false, ms: performance.now() - start, error: new Error('裸 TCP 60s 未连上') }); });
      socket.once('error', error => { socket.destroy(); resolve({ ok: false, ms: performance.now() - start, error }); });
    })));
    expect(rows).toHaveLength(N);
    report('裸 TCP', host, ip, rows);
  }, 180_000);
});
