// scripts/eval-mapping/report.ts —— 映射评测的结果文件（ADR-0035）：一次评测记成 { 模型、端点主机、提示词哈希、开始时间、各例与总体的准确率和改动数 }，
// 总体另带整份通过 / 部分采用 / 失败的样例数，部分采用的样例带去掉项的路径；提示词哈希按带固定目录的 system 消息算（ADR-0041）。
// 用来在换模型或改提示词前后对比两次；旧结果文件没有这几个计数，对比时照常算准确率与改动。只记主机，不记 Key、完整 URL、请求与模型原文；
// 失败于映射校验时带脱敏后的问题清单（路径 + 消息，不含样本原文）（纯函数）
import { createHash } from 'node:crypto';
import type { Catalog } from '../../app/.server/catalog';
import type { TableContext } from '../../app/.server/pipeline/llm-context';
import { MODEL_DRAFT_SCHEMA, modelDraftMessages } from '../../app/.server/pipeline/model-draft';
import { CATALOG } from './golden';
import type { CaseCounts, CaseResult, FailStage, Problem, Score } from './score';

export interface ReportScore { accuracy: number; edits: number; stage?: FailStage }
/** dropped：部分采用时去掉的项的路径（如 fields.x），不含样本值 */
export interface ReportCase extends ReportScore { name: string; problems?: Problem[]; dropped?: string[] }

export interface EvalReport {
  model: string;
  /** 端点主机（含端口），不是完整 URL */
  host: string;
  promptHash: string;
  startedAt: string;
  cases: ReportCase[];
  /** full / partial / failed 是样例数；旧结果文件没有 */
  total: { accuracy: number; edits: number } & Partial<CaseCounts>;
}

const EMPTY_CONTEXT: TableContext = { table: '', rows: 0, primaryKey: [], keyCandidates: [], columns: [] };

/**
 * 提示词哈希：映射草稿两个版本的 system 消息（先非 customer 后 customer，#1321）加输出 Schema 的 sha256 前 12 位；任一版提示词或 Schema 改了就变。
 * 默认按带固定目录（与评测发给模型的相同）算；带目录的 system 消息与目录内容无关，所以哈希只区分带不带目录。catalog 传 null 算不带目录的
 */
export function promptHash(schema: object = MODEL_DRAFT_SCHEMA, catalog: Catalog | null = CATALOG): string {
  const hash = createHash('sha256');
  for (const entity of ['', 'customer']) {
    hash.update(modelDraftMessages(EMPTY_CONTEXT, entity, '', catalog ?? undefined).find(m => m.role === 'system')?.content ?? '');
  }
  return hash.update(JSON.stringify(schema)).digest('hex').slice(0, 12);
}

export function toReport(results: CaseResult[], total: Score & CaseCounts, meta: { model: string; baseUrl: string; startedAt: Date }): EvalReport {
  return {
    model: meta.model,
    host: new URL(meta.baseUrl).host,
    promptHash: promptHash(),
    startedAt: meta.startedAt.toISOString(),
    cases: results.map(r => ({
      name: r.name, accuracy: r.accuracy, edits: r.edits,
      ...(r.failed && { stage: r.failed.stage }),
      ...(r.failed?.stage === 'mapping' && r.failed.problems && { problems: r.failed.problems }),
      ...(r.partial && r.dropped && { dropped: r.dropped }),
    })),
    total: { accuracy: total.accuracy, edits: total.edits, full: total.full, partial: total.partial, failed: total.failed },
  };
}

/** 结果文件名：<时间戳>-<模型>.json，时间戳去掉冒号与点，模型名里的路径分隔符换成 _ */
export function reportFileName(report: Pick<EvalReport, 'startedAt' | 'model'>): string {
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
  /** 两次的整份通过 / 部分采用 / 失败样例数；任一边是旧结果文件（没有计数）时不带 */
  counts?: { a: CaseCounts; b: CaseCounts };
}

const metaOf = (r: EvalReport): ReportMeta => ({ model: r.model, host: r.host, promptHash: r.promptHash, startedAt: r.startedAt });
const score = ({ name: _, problems: __, dropped: ___, ...s }: ReportCase): ReportScore => s;
const totalScore = ({ accuracy, edits }: EvalReport['total']): ReportScore => ({ accuracy, edits });
const countsOf = ({ full, partial, failed }: EvalReport['total']): CaseCounts | null =>
  full === undefined || partial === undefined || failed === undefined ? null : { full, partial, failed };
const delta = (a: ReportScore, b: ReportScore): ScoreDelta => ({ a, b, delta: { accuracy: b.accuracy - a.accuracy, edits: b.edits - a.edits } });

export function compareReports(a: EvalReport, b: EvalReport): Comparison {
  const ca = countsOf(a.total);
  const cb = countsOf(b.total);
  const inB = new Map(b.cases.map(c => [c.name, c]));
  const inA = new Set(a.cases.map(c => c.name));
  return {
    a: metaOf(a),
    b: metaOf(b),
    same: { model: a.model === b.model, host: a.host === b.host, promptHash: a.promptHash === b.promptHash },
    cases: a.cases.filter(c => inB.has(c.name)).map(c => ({ name: c.name, ...delta(score(c), score(inB.get(c.name)!)) })),
    total: delta(totalScore(a.total), totalScore(b.total)),
    onlyA: a.cases.filter(c => !inB.has(c.name)),
    onlyB: b.cases.filter(c => !inA.has(c.name)),
    ...(ca && cb && { counts: { a: ca, b: cb } }),
  };
}
