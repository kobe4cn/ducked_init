// src/lib/mock-api.ts —— 模拟“会员积分 SaaS”的分页接口（数据来自 data/mock_saas.duckdb）
// 采用按主键游标分页（?after=<id>），而不是 OFFSET：千万级数据下 OFFSET 越往后越慢
import { createServer, Server } from 'node:http';
import { DuckDBInstance } from '@duckdb/node-api';
import { config } from './config';

export async function startMockApi(): Promise<Server> {
  const db = await DuckDBInstance.create('./data/mock_saas.duckdb', { access_mode: 'READ_ONLY' });
  const server = createServer(async (req, res) => {
    try {
      const con = await db.connect();          // 每个请求一个连接，并发请求可以并行执行
      const url = new URL(req.url!, 'http://x');
      const after = Number(url.searchParams.get('after') ?? 0);
      const until = Number(url.searchParams.get('until') ?? Number.MAX_SAFE_INTEGER);
      const size = Math.min(Number(url.searchParams.get('size') ?? config.apiPageSize), 50_000);
      const reader = await con.runAndReadAll(
        `SELECT customer_id::BIGINT AS customer_id, tier, points, strftime(updated_at, '%Y-%m-%d %H:%M:%S') AS updated_at
         FROM members WHERE customer_id > $after AND customer_id <= $until ORDER BY customer_id LIMIT $size`, { after, until, size });
      const data = reader.getRowObjectsJson() as any[];
      con.closeSync();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data, next_after: data.length === size ? Number(data[data.length - 1].customer_id) : null }));
    } catch (e) {
      res.statusCode = 500; res.end(String(e));
    }
  });
  await new Promise<void>(r => server.listen(config.apiPort, r));
  return server;
}

/** 查询总量与分页边界（真实 SaaS 通常提供 count 或 cursor 列表；这里为了并发拉取，直接按 ID 区间切片） */
export function idRanges(maxId: number, parts: number): [number, number][] {
  const step = Math.ceil(maxId / parts);
  return Array.from({ length: parts }, (_, i) => [i * step, Math.min((i + 1) * step, maxId)] as [number, number]);
}
