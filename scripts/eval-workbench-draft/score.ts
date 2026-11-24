// scripts/eval-workbench-draft/score.ts —— 工作台 SQL 起草评测的跑分（ADR-0043）：对一个黄金样例走与产品相同的目录文本、提示词与输出 Schema，
// 按工作台白名单校验（checkWorkbenchSql，只解析不执行），再看引用的表与必须含的片段命中几项。不读库、不写调用日志（用 callModel 而不是 chatJson）
import type { DuckDBConnection } from '@duckdb/node-api';
// 先加载助手工具再加载 workbench-ai：两者循环引用（tools 顶层用到 workbench-ai 的 MAX_CELL），直接从 workbench-ai 进入时 node 报 MAX_CELL 未初始化；产品里一直是先加载 tools
import '../../app/.server/assistant/tools';
import { callModel, LlmError, type LlmProvider } from '../../app/.server/llm';
import { lit } from '../../app/.server/pipeline/source-engine';
import { checkWorkbenchSql, WorkbenchSqlError } from '../../app/.server/pipeline/workbench-engine';
import { collectRefs } from '../../app/.server/pipeline/sql-refs';
import { catalogText, draftMessages, WORKBENCH_DRAFT_SCHEMA } from '../../app/.server/workbench-ai';
import { hashPrompt } from '../eval-shared/report';
import { WORKBENCH_CATALOG, type WorkbenchDraftCase } from './golden';

export interface CaseResult {
  name: string;
  /** 期望做不到的回答了做不到；或 SQL 过了白名单校验且期望的表与片段全中 */
  pass: boolean;
  /** 命中的期望表数加片段数 */
  hits: number;
  /** 期望表数加片段数（期望做不到的样例为 0） */
  items: number;
  /** 失败在哪一步：模型调用（含输出不合 Schema）、期望做不到却给了 SQL、回答做不到、白名单校验 */
  stage?: 'model' | 'sql' | 'unsupported' | 'check';
}

export interface Total { passRate: number; hitRate: number }

/** 提示词哈希：起草 SQL 的 system 消息（不含目录）加输出 Schema */
export const PROMPT_HASH = hashPrompt(draftMessages('', '')[0]!.content, WORKBENCH_DRAFT_SCHEMA);

const CATALOG_TEXT = catalogText(WORKBENCH_CATALOG, []).text;

/** 引用的表（不含 CTE），schema.table 小写 */
async function referencedTables(con: DuckDBConnection, sql: string): Promise<Set<string>> {
  const [{ j }] = (await con.runAndReadAll(`SELECT json_serialize_sql(${lit(sql)}) AS j`)).getRowObjectsJson() as { j: string }[];
  const tree = JSON.parse(j) as { statements?: unknown[] };
  return new Set(collectRefs(tree.statements ?? []).tables.filter(t => !t.cte).map(t => `${t.schema}.${t.table}`.toLowerCase()));
}

/** 跑一个样例。做不到的判断与产品一致：unsupported 去掉空白后非空就按做不到（同时给了 sql 也是） */
export async function runCase(c: WorkbenchDraftCase, provider: LlmProvider, con: DuckDBConnection): Promise<CaseResult> {
  const tables = c.expect.tables ?? [];
  const contains = c.expect.contains ?? [];
  const items = c.expect.unsupported ? 0 : tables.length + contains.length;
  let out: { sql?: string; unsupported?: string };
  try {
    out = await callModel<{ sql?: string; unsupported?: string }>(provider, draftMessages(c.request, CATALOG_TEXT), WORKBENCH_DRAFT_SCHEMA);
  } catch (e) {
    if (e instanceof LlmError) return { name: c.name, pass: false, hits: 0, items, stage: 'model' };
    throw e;
  }
  const unsupported = !!out.unsupported?.trim();
  if (c.expect.unsupported) return unsupported ? { name: c.name, pass: true, hits: 0, items } : { name: c.name, pass: false, hits: 0, items, stage: 'sql' };
  if (unsupported) return { name: c.name, pass: false, hits: 0, items, stage: 'unsupported' };
  let sql: string;
  try {
    sql = (await checkWorkbenchSql(con, out.sql!)).sql;
  } catch (e) {
    if (e instanceof WorkbenchSqlError) return { name: c.name, pass: false, hits: 0, items, stage: 'check' };
    throw e;
  }
  const refs = await referencedTables(con, sql);
  const lower = sql.toLowerCase();
  const hits = tables.filter(t => refs.has(t.toLowerCase())).length + contains.filter(s => lower.includes(s.toLowerCase())).length;
  return { name: c.name, pass: hits === items, hits, items };
}

/** 总体：通过率按例，命中率按项加权（命中总数 / 项数总数） */
export function summarize(results: CaseResult[]): Total {
  const hits = results.reduce((n, r) => n + r.hits, 0);
  const items = results.reduce((n, r) => n + r.items, 0);
  return { passRate: results.length ? results.filter(r => r.pass).length / results.length : 1, hitRate: items ? hits / items : 1 };
}
