// app/.server/catalog/vector-store-pgvector.ts —— pgvector 外部向量存储（ADR-0058）：租户自带 PostgreSQL + pgvector 扩展上实现 vector-store.ts 的 VectorStore。
// 与平台库完全分开（不 import getDb）：连接串来自租户配置（#848 起接入页面），本模块只按 url 缓存连接池；
// 外部表 catalog_embeddings 与平台表同构（向量列不带维度、另存 dimension、不建索引、只存哈希与向量不存文本），由 preparePgvector 幂等建好，
// 存储方法不建表——保存配置时先测连通并建表、失败不保存（ADR-0058：设置与实际可用保持一致）。
// 每条 SQL 都带 tenant_id（$1），但外部库的行不在平台删租户的级联里；方法连不上时让错误原样抛出，由检索调用方降级向量一路（vectorFallback）。
import pg from 'pg';
import type { VectorStore } from './vector-store';

/** pgvector 连接的最小接口：真实实现是 pg.Pool，测试替身（setPgvectorConnect 注入）只要实现 query */
export interface PgvectorClient {
  query<R extends pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** 按 url 缓存的连接池：外部库是租户自己的，建连超时和语句超时都收紧，查询卡住时不拖死检索 */
const pools = new Map<string, pg.Pool>();

let connectOverride: ((url: string) => PgvectorClient) | undefined;

/** 测试注入假的建连（替身只要实现 query）；传 undefined 恢复真实 pg.Pool（照 llm.ts 的 setLlmFetch） */
export function setPgvectorConnect(f: ((url: string) => PgvectorClient) | undefined) { connectOverride = f; }

const connect = (url: string): PgvectorClient => {
  if (connectOverride) return connectOverride(url);
  const cached = pools.get(url);
  if (cached) return cached;
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000, max: 2, options: '-c statement_timeout=5000' });
  pool.on('error', () => {}); // 空闲连接被外部库断开等后台错误没有要回调的调用方：吞掉，不然进程会崩
  pools.set(url, pool);
  return pool;
};

/** 测试收尾关掉缓存的连接池（vitest 收不掉空闲连接）；注入的替身不归它管。幂等 */
export async function closePgvectorPools() {
  await Promise.all([...pools.values()].map(pool => pool.end()));
  pools.clear();
}

/** 抹掉错误信息里的连接串与凭据：整串 url、密码原文、百分号编码的密码、用户名都换成 ***
 *  （照 source-engine.ts 的 redactSourceSecrets 的思路；那边吃 SourceSpec，这里吃连接串） */
function redactUrl(message: string, url: string): string {
  let username = '', password = '';
  try { ({ username, password } = new URL(url)); } catch { /* 连接串不合法：没有可提取的凭据，下面仍把整串抹掉 */ }
  return [url, password, encodeURIComponent(password), username]
    .filter(s => s !== '')
    .reduce((m, secret) => m.replaceAll(secret, '***'), message);
}

/** 连接外部库并准备好扩展与表：CREATE EXTENSION IF NOT EXISTS vector、建与平台表同构的 catalog_embeddings、select 1 兜底连通检查。
 *  永不抛错：连不上、没权限等都返回 ok:false，error 是一句中文加抹掉凭据的原因（保存配置时失败不保存） */
export async function preparePgvector(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const client = connect(url);
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query(`CREATE TABLE IF NOT EXISTS catalog_embeddings (
      tenant_id text NOT NULL,
      model_id text NOT NULL,
      text_hash text NOT NULL,
      dimension integer NOT NULL,
      embedding vector NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, model_id, text_hash)
    )`);
    await client.query('select 1');
    return { ok: true };
  } catch (e) {
    const reason = redactUrl(e instanceof Error ? e.message : String(e), url);
    return { ok: false, error: `准备 pgvector 向量库失败（装扩展、建表或连通检查没成）：${reason}` };
  }
}

/** pgvector 读出来的向量是文本 '[1,2,…]'；parse 回数字数组，形状不对（外部库是租户自己管的）就报错 */
const parseVector = (text: string): number[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(x => typeof x === 'number')) throw new Error(`外部向量库里的 embedding 不是数字数组：${text}`);
  return parsed;
};

/** pgvector 外部向量存储：一个实例管一个租户（tenantId 进每条 SQL 的 $1）、一个外部库（url，表已由 preparePgvector 建好） */
export function pgvectorStore(tenantId: string, url: string): VectorStore {
  const q = async <R extends pg.QueryResultRow>(sql: string, params: unknown[]) =>
    (await connect(url).query<R>(sql, params)).rows;
  const read = async (model: string, hashes: string[]): Promise<Map<string, number[]>> => {
    if (!hashes.length) return new Map();
    const rows = await q<{ text_hash: string; embedding: string }>(
      'SELECT text_hash, embedding FROM catalog_embeddings WHERE tenant_id = $1 AND model_id = $2 AND text_hash = ANY($3)',
      [tenantId, model, hashes]);
    return new Map(rows.map(r => [r.text_hash, parseVector(r.embedding)]));
  };
  return {
    async upsert(model, rows) {
      if (!rows.length) return;
      const params: unknown[] = [tenantId];
      const tuples = rows.map((r, i) => {
        params.push(model, r.textHash, r.vector.length, JSON.stringify(r.vector)); // JSON 数组文本就是 pgvector 的字面量
        const b = 2 + i * 4;
        return `($1, $${b}, $${b + 1}, $${b + 2}, $${b + 3}::vector)`;
      });
      await q(`INSERT INTO catalog_embeddings (tenant_id, model_id, text_hash, dimension, embedding) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, params);
    },
    async hashes(model) {
      const rows = await q<{ text_hash: string }>(
        'SELECT text_hash FROM catalog_embeddings WHERE tenant_id = $1 AND model_id = $2', [tenantId, model]);
      return new Set(rows.map(r => r.text_hash));
    },
    read,
    async deleteOtherModels(model) {
      await q('DELETE FROM catalog_embeddings WHERE tenant_id = $1 AND model_id <> $2', [tenantId, model]);
    },
    async deleteMissing(model, keep) {
      // keep 为空时 <> ALL($3) 对空数组恒真（PG 语义），正好等于删掉当前模型全部行，与平台实现一致
      await q('DELETE FROM catalog_embeddings WHERE tenant_id = $1 AND model_id = $2 AND text_hash <> ALL($3)', [tenantId, model, keep]);
    },
    async topN(model, queryVec, hashes, limit) {
      const unique = [...new Set(hashes)]; // 重复哈希只算一条（与平台实现一致）
      if (!unique.length) return [];
      // CASE 挡掉维度不同的行（换模型后混进来的旧缓存）：cosine() 对维度不同返回 0，pgvector 的 <=> 会直接报错。
      // 零向量的余弦距离是 NaN，而 PG 里 NaN 比任何数都大、DESC 排序会排到最前，排序时按 0 算才与 cosine() 的顺序一致；取回后再把 NaN 归 0
      const rows = await q<{ text_hash: string; similarity: number }>(
        `SELECT text_hash, similarity FROM (
           SELECT text_hash, CASE WHEN dimension = $4 THEN 1 - (embedding <=> $5::vector) ELSE 0 END AS similarity
           FROM catalog_embeddings WHERE tenant_id = $1 AND model_id = $2 AND text_hash = ANY($3)
         ) scored
         ORDER BY CASE WHEN scored.similarity::text = 'NaN' THEN 0 ELSE scored.similarity END DESC, scored.text_hash COLLATE "C" ASC
         LIMIT $6`,
        [tenantId, model, unique, queryVec.length, JSON.stringify(queryVec), limit]);
      return rows.map(r => ({ textHash: r.text_hash, similarity: Number.isNaN(r.similarity) ? 0 : r.similarity }));
    },
    async clear() {
      await q('DELETE FROM catalog_embeddings WHERE tenant_id = $1', [tenantId]);
    },
  };
}
