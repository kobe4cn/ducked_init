// scripts/eval-mapping/report.ts —— 映射评测的结果文件（ADR-0035）：一次评测记成 { 模型、端点主机、提示词哈希、开始时间、各例与总体的准确率和改动数 }，
// 用来在换模型或改提示词前后对比两次。只记主机，不记 Key、完整 URL、请求与模型原文（纯函数）
import { createHash } from 'node:crypto';
import type { TableContext } from '../../app/.server/pipeline/llm-context';
import { MODEL_DRAFT_SCHEMA, modelDraftMessages } from '../../app/.server/pipeline/model-draft';
import type { CaseResult, FailStage, Score } from './score';

export interface ReportScore { accuracy: number; edits: number; stage?: FailStage }
export interface ReportCase extends ReportScore { name: string }

export interface EvalReport {
  model: string;
  /** 端点主机（含端口），不是完整 URL */
  host: string;
  promptHash: string;
  startedAt: string;
  cases: ReportCase[];
  total: { accuracy: number; edits: number };
}

const EMPTY_CONTEXT: TableContext = { table: '', rows: 0, primaryKey: [], keyCandidates: [], columns: [] };

/** 提示词哈希：映射草稿的 system 消息加输出 Schema 的 sha256 前 12 位；改了提示词或 Schema 就变 */
export function promptHash(schema: object = MODEL_DRAFT_SCHEMA): string {
  const system = modelDraftMessages(EMPTY_CONTEXT, '', '').find(m => m.role === 'system')?.content ?? '';
  return createHash('sha256').update(system).update(JSON.stringify(schema)).digest('hex').slice(0, 12);
}

export function toReport(results: CaseResult[], total: Score, meta: { model: string; baseUrl: string; startedAt: Date }): EvalReport {
  return {
    model: meta.model,
    host: new URL(meta.baseUrl).host,
    promptHash: promptHash(),
    startedAt: meta.startedAt.toISOString(),
    cases: results.map(r => ({ name: r.name, accuracy: r.accuracy, edits: r.edits, ...(r.failed ? { stage: r.failed.stage } : {}) })),
    total: { accuracy: total.accuracy, edits: total.edits },
  };
}

/** 结果文件名：<时间戳>-<模型>.json，时间戳去掉冒号与点，模型名里的路径分隔符换成 _ */
export function reportFileName(report: EvalReport): string {
  return `${report.startedAt.replace(/[:.]/g, '-')}-${report.model.replace(/[/\\]/g, '_')}.json`;
}

/** 一次评测是在什么条件下跑的 */
export type ReportMeta = Pick<EvalReport, 'model' | 'host' | 'promptHash' | 'startedAt'>;

export interface ScoreDelta { a: ReportScore; b: ReportScore; delta: { accuracy: number; edits: number } }

export interface Comparison {
  a: ReportMeta;
  b: ReportMeta;
  same: { model: boolean; host: boolean; promptHash: boolean };
  /** 两次都有的样例，按 a 的顺序；差值是 b − a */
  cases: (ScoreDelta & { name: string })[];
  total: ScoreDelta;
  onlyA: ReportCase[];
  onlyB: ReportCase[];
}

const metaOf = (r: EvalReport): ReportMeta => ({ model: r.model, host: r.host, promptHash: r.promptHash, startedAt: r.startedAt });
const score = ({ name: _, ...s }: ReportCase): ReportScore => s;
const delta = (a: ReportScore, b: ReportScore): ScoreDelta => ({ a, b, delta: { accuracy: b.accuracy - a.accuracy, edits: b.edits - a.edits } });

export function compareReports(a: EvalReport, b: EvalReport): Comparison {
  const inB = new Map(b.cases.map(c => [c.name, c]));
  const inA = new Set(a.cases.map(c => c.name));
  return {
    a: metaOf(a),
    b: metaOf(b),
    same: { model: a.model === b.model, host: a.host === b.host, promptHash: a.promptHash === b.promptHash },
    cases: a.cases.filter(c => inB.has(c.name)).map(c => ({ name: c.name, ...delta(score(c), score(inB.get(c.name)!)) })),
    total: delta(a.total, b.total),
    onlyA: a.cases.filter(c => !inB.has(c.name)),
    onlyB: b.cases.filter(c => !inA.has(c.name)),
  };
}
