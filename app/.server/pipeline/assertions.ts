// app/.server/pipeline/assertions.ts —— 内置断言（ADR-0026）：结果层任务计算前，对任务读到的标准实体检查数据质量。
// error 级的断言失败时任务失败、不登记快照（外部继续读上一版）；warn 级只记录。结果只有断言名、实体与不合格行数，不带行内容
import type { DuckDBConnection } from '@duckdb/node-api';
import { entityOf } from '../../lib/canonical-model';
import { lit } from './merge-engine';
import { PartialFailure } from './partial-failure';

export interface AssertionResult {
  name: string;
  level: 'error' | 'warn';
  entity: string;
  /** 不合格的行数 */
  failed: number;
  /** 检查了哪些字段 */
  detail?: string;
}

export const ASSERTION_LABELS: Record<string, string> = {
  primary_key_unique: '主键唯一',
  amount_non_negative: '金额非负',
};

/** 各实体的金额字段 */
const AMOUNT_FIELDS: Record<string, string[]> = {
  order: ['amount'],
  order_item: ['amount', 'unit_price'],
  product: ['price'],
};

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const rows = async <T>(con: DuckDBConnection, sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson() as T[];

/**
 * 判重的键：标准模型的主键。customer 不跨映射查独占（ADR-0024），按数据源判重；主键含指向 customer 的字段时同样按数据源判重。
 * 有 _key_space 列时也并进键。自定义实体在工作进程里不知道主键，不检查
 */
function uniqueKey(entity: string, columns: Set<string>) {
  const model = entityOf(entity);
  if (!model || !model.key.every(k => columns.has(k))) return undefined;
  const bySource = entity === 'customer' || model.key.some(k => model.fields.find(f => f.name === k)?.ref?.entity === 'customer');
  return [...model.key, ...(bySource && columns.has('_source') ? ['_source'] : []), ...(columns.has('_key_space') ? ['_key_space'] : [])];
}

/** 对这些实体里在标准层存在的表跑内置断言：主键唯一（主键为空的行不算重复）、金额非负 */
export async function runAssertions(con: DuckDBConnection, entities: readonly string[]): Promise<AssertionResult[]> {
  const columns = await rows<{ entity: string; name: string }>(con, `
    SELECT table_name AS entity, column_name AS name FROM information_schema.columns
    WHERE table_catalog = 'lake' AND table_schema = 'silver' AND table_name IN (${entities.map(lit).join(', ')})`);
  const results: AssertionResult[] = [];
  for (const entity of entities) {
    const present = new Set(columns.filter(c => c.entity === entity).map(c => c.name));
    if (!present.size) continue;
    const table = `silver.${ident(entity)}`;
    const key = uniqueKey(entity, present);
    if (key) {
      const modelKey = entityOf(entity)!.key;
      const [{ n }] = await rows<{ n: string }>(con, `
        SELECT coalesce(sum(n), 0) AS n FROM (
          SELECT count(*) AS n FROM ${table} WHERE ${modelKey.map(k => `${ident(k)} IS NOT NULL`).join(' AND ')}
          GROUP BY ${key.map(ident).join(', ')} HAVING count(*) > 1)`);
      results.push({ name: 'primary_key_unique', level: 'error', entity, failed: Number(n), detail: key.join(', ') });
    }
    const amounts = (AMOUNT_FIELDS[entity] ?? []).filter(f => present.has(f));
    if (amounts.length) {
      const [{ n }] = await rows<{ n: string }>(con, `SELECT count(*) AS n FROM ${table} WHERE ${amounts.map(f => `${ident(f)} < 0`).join(' OR ')}`);
      results.push({ name: 'amount_non_negative', level: 'error', entity, failed: Number(n), detail: amounts.join(', ') });
    }
  }
  return results;
}

/** 失败的 error 级断言 */
export const failedErrors = (results: readonly AssertionResult[]) => results.filter(r => r.level === 'error' && r.failed > 0);

/** 一条断言失败的摘要：断言名、实体与不合格行数 */
export const describeAssertion = (r: AssertionResult) => `${ASSERTION_LABELS[r.name] ?? r.name}（silver.${r.entity}，${r.failed} 行不合格）`;

/** 有 error 级断言失败时让任务失败（不写结果、不登记快照），结果里带全部断言 */
export function assertOrThrow(results: AssertionResult[]) {
  const failed = failedErrors(results);
  if (failed.length) throw new PartialFailure(`断言失败：${failed.map(describeAssertion).join('；')}`, { assertions: results });
}
