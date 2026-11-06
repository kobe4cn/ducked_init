// app/.server/catalog/plan.ts —— 分析计划的确定性校验（ADR-0050，#409，设计文档 9.1 / 9.2）：助手提交计划 JSON，
// 这里只吃传入的可见目录（catalogFor 已按角色裁剪：条目在目录里就等于已发布且有权限）与本次检索到的候选 id，
// 不读库、不信任 JSON 里的租户与操作者（出现也忽略）。校验分三层：结构（JSON Schema + 步骤业务检查）、
// 硬性（选中条目必须来自本次检索、在目录里，版本与语义哈希和当前一致）、口径（只对 reuse_result 选中的指标，
// 用户明确要求的单位 / 时间含义 / 窗口与口径声明比较）。可加性与平台能力检查在 ⑭，接入助手工具在 ⑮。
// 结果 status：invalid（结构或硬性不过、口径不相容）> unsupported（mode 是 unsupported）> needs_clarification
// （mode 是 clarify，或口径声明未知 / 需复核）> valid；mode 是 clarify / unsupported 时计划本身合法，
// 但对话的下一步是追问或说明做不到，所以 status 直接取这两种。request 里 unit / timeMeaning 写 unknown /
// not_applicable 不算明确要求，跳过该项比较。语义哈希读时现算，不写进条目、不存库（写进去会让 diffCatalog 判全部条目有改动）。
// 纯函数：同样的计划与目录每次结果相同
import { Ajv, type ValidateFunction } from 'ajv';
import { CLAIM_TYPES, claimTypeLabel, claimValueLabel, type ClaimType } from '../../lib/semantic-claims';
import { sha256 } from '../auth';
import { stableJson } from '../knowledge/basis';
import { describeSchemaError } from '../pipeline/mapping-spec';
import { claimsOf } from './ambiguity';
import { expand, type Catalog, type CatalogEntry, type MetricEntry } from './index';
import { stripEntryStats } from './versions';

export type PlanMode = 'reuse_result' | 'draft_definition' | 'draft_query' | 'clarify' | 'unsupported';
export const PLAN_MODES: readonly PlanMode[] = ['reuse_result', 'draft_definition', 'draft_query', 'clarify', 'unsupported'];

/** 选中的条目：指标、标签、模板必须带 version 且与目录一致；实体、字段没有版本（带了也忽略） */
export interface SelectedRef { id: string; version?: number; semanticHash: string }

/** 用户的要求；unit / timeMeaning 的取值限定在登记表（app/lib/semantic-claims.ts）里 */
export interface PlanRequest {
  asOf?: string;
  grain?: string;
  dimensions: string[];
  population?: string;
  unit?: (typeof CLAIM_TYPES.unit.values)[number]['value'];
  timeMeaning?: (typeof CLAIM_TYPES.time_meaning.values)[number]['value'];
  /** 用户明确要求的窗口天数 */
  windowDays?: number;
}

export interface PlanStep { id: string; action: string; inputs: string[] }
export interface PlanAssumption { text: string; evidenceId?: string; confirmed: boolean }

/** 计划结构（设计文档 9.1），另加 request.unit / windowDays 与 unsupported 模式的 reason */
export interface AnalysisPlan {
  schemaVersion: 1;
  mode: PlanMode;
  selected: SelectedRef[];
  request: PlanRequest;
  steps: PlanStep[];
  assumptions: PlanAssumption[];
  questions: string[];
  /** mode 为 unsupported 时必填：平台表达不了的原因与可行的下一步 */
  reason?: string;
}

export type PlanStatus = 'valid' | 'needs_clarification' | 'unsupported' | 'invalid';

/** 一条问题：path 是 JSON 路径（点分隔，如 selected.0.version），entryId 是涉及的目录条目，next 是建议的下一步 */
export interface PlanIssue { path: string; entryId?: string; message: string; next?: string }

/** 校验结果：结构合法时 plan 是原样解析回的计划，否则为 null */
export interface PlanCheck { status: PlanStatus; plan: AnalysisPlan | null; issues: PlanIssue[] }

/** 语义哈希：去掉统计后的条目（stripEntryStats）稳定 JSON 的 sha256 */
export const semanticHash = (e: CatalogEntry): string => sha256(stableJson(stripEntryStats(e)));

/** 登记表里某种口径声明的全部取值 */
const claimEnum = (t: ClaimType) => CLAIM_TYPES[t].values.map(v => v.value);

/** 计划的 JSON Schema：clarify 必须有问题、unsupported 必须有原因 */
export const PLAN_SCHEMA = {
  type: 'object',
  required: ['schemaVersion', 'mode', 'selected', 'request', 'steps', 'assumptions', 'questions'],
  properties: {
    schemaVersion: { enum: [1] },
    mode: { enum: PLAN_MODES },
    selected: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'semanticHash'],
        properties: { id: { type: 'string', minLength: 1 }, version: { type: 'integer', minimum: 1 }, semanticHash: { type: 'string', minLength: 1 } },
      },
    },
    request: {
      type: 'object',
      required: ['dimensions'],
      properties: {
        asOf: { type: 'string', minLength: 1 },
        grain: { type: 'string', minLength: 1 },
        dimensions: { type: 'array', items: { type: 'string', minLength: 1 } },
        population: { type: 'string', minLength: 1 },
        unit: { enum: claimEnum('unit') },
        timeMeaning: { enum: claimEnum('time_meaning') },
        windowDays: { type: 'integer', minimum: 1 },
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'action', 'inputs'],
        properties: {
          id: { type: 'string', minLength: 1 },
          action: { type: 'string', minLength: 1 },
          inputs: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
      },
    },
    assumptions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['text', 'confirmed'],
        properties: { text: { type: 'string', minLength: 1 }, evidenceId: { type: 'string' }, confirmed: { type: 'boolean' } },
      },
    },
    questions: { type: 'array', items: { type: 'string', minLength: 1 } },
    reason: { type: 'string', minLength: 1 },
  },
  allOf: [
    { if: { properties: { mode: { const: 'clarify' } }, required: ['mode'] }, then: { required: ['questions'], properties: { questions: { minItems: 1 } } } },
    { if: { properties: { mode: { const: 'unsupported' } }, required: ['mode'] }, then: { required: ['reason'] } },
  ],
} as const;

const validateSchema: ValidateFunction = new Ajv({ allErrors: true, strict: false }).compile(PLAN_SCHEMA);

const SEVERITY: Record<PlanStatus, number> = { valid: 0, needs_clarification: 1, unsupported: 2, invalid: 3 };

/** 计划合法时对话的下一步：clarify 要追问，unsupported 说明做不到，其余模式校验过了就是 valid */
const modeStatus = (mode: PlanMode): PlanStatus => {
  if (mode === 'clarify') return 'needs_clarification';
  if (mode === 'unsupported') return 'unsupported';
  return 'valid';
};

/**
 * 校验一份分析计划。结构不合法时 plan 为 null；结构合法时原样解析回 plan，
 * 硬性与口径的问题（若有）照样列出，status 取最严重的
 */
export function validatePlan(input: unknown, ctx: { catalog: Catalog; retrieved: ReadonlySet<string> }): PlanCheck {
  const issues: PlanIssue[] = [];
  if (!validateSchema(input)) {
    const seen = new Set<string>();
    for (const e of validateSchema.errors ?? []) {
      const d = describeSchemaError(e);
      if (!d) continue;
      const issue = { path: d.path.join('.'), message: d.message };
      if (seen.has(`${issue.path}\n${issue.message}`)) continue;
      seen.add(`${issue.path}\n${issue.message}`);
      issues.push(issue);
    }
    return { status: 'invalid', plan: null, issues };
  }
  const plan = input as AnalysisPlan;

  // 步骤业务检查：id 不重复；inputs 只能引用前面出现的步骤或 selected 里的条目——引用自己或后面的步骤就是成环
  const entryIds = new Set(plan.selected.map(s => s.id));
  const stepAt = new Map<string, number>();
  const structural = (path: string, message: string) => issues.push({ path, message });
  for (const [i, step] of plan.steps.entries()) {
    if (stepAt.has(step.id)) structural(`steps.${i}.id`, `步骤 id 重复：${step.id} 已在第 ${stepAt.get(step.id)} 步出现过`);
    else stepAt.set(step.id, i);
  }
  for (const [i, step] of plan.steps.entries()) {
    for (const [j, dep] of step.inputs.entries()) {
      const at = stepAt.get(dep);
      if (at === undefined && !entryIds.has(dep)) structural(`steps.${i}.inputs.${j}`, `inputs 引用了不存在的步骤或条目：${dep}`);
      else if (at !== undefined && at >= i) {
        structural(`steps.${i}.inputs.${j}`, at === i
          ? `inputs 不能引用步骤自己（${dep}），会成环`
          : `inputs 引用了第 ${at} 步才定义的步骤 ${dep}，会成环；只能引用前面出现的步骤或 selected 里的条目`);
      }
    }
  }
  if (issues.length) return { status: 'invalid', plan: null, issues };

  // 硬性检查：引用的条目必须来自本次检索、在可见目录里，版本与语义哈希与当前一致
  const KIND_LABEL: Record<string, string> = { metric: '指标', tag: '标签', template: '模板' };
  let status = modeStatus(plan.mode);
  const raise = (s: PlanStatus) => { if (SEVERITY[s] > SEVERITY[status]) status = s; };
  for (const [i, s] of plan.selected.entries()) {
    const e = expand(ctx.catalog, s.id);
    if (!ctx.retrieved.has(s.id)) {
      issues.push({ path: `selected.${i}.id`, entryId: s.id, message: '选中的条目不在本次检索结果里' });
      raise('invalid');
    }
    if (!e) {
      issues.push({ path: `selected.${i}.id`, entryId: s.id, message: '选中的条目不在可见目录里（无权限、未发布或已停用）' });
      raise('invalid');
      continue;
    }
    if (e.kind === 'metric' || e.kind === 'tag' || e.kind === 'template') {
      if (s.version === undefined) {
        issues.push({ path: `selected.${i}.version`, entryId: s.id, message: `${KIND_LABEL[e.kind]}必须带 version` });
        raise('invalid');
      } else if (s.version !== e.version) {
        issues.push({ path: `selected.${i}.version`, entryId: s.id, message: `版本不一致：计划里是 v${s.version}，目录里是 v${e.version}` });
        raise('invalid');
      }
    }
    if (s.semanticHash !== semanticHash(e)) {
      issues.push({ path: `selected.${i}.semanticHash`, entryId: s.id, message: '语义哈希与当前目录不一致（条目内容变了）' });
      raise('invalid');
    }
  }

  // 口径检查：只对 reuse_result 选中的指标；request 没提的口径不检查
  const NEXT_DRAFT = '改选口径匹配的定义，或改为 draft_definition 起草新定义';
  const REQUEST_FIELD: Record<'unit' | 'time_meaning', 'unit' | 'timeMeaning'> = { unit: 'unit', time_meaning: 'timeMeaning' };
  const checkClaim = (type: 'unit' | 'time_meaning', asked: string | undefined, e: MetricEntry) => {
    if (asked === undefined || asked === 'unknown' || asked === 'not_applicable') return;
    const label = claimTypeLabel(type);
    const declared = claimsOf(e).get(type) ?? 'unknown';
    if (declared === 'unknown') {
      const member = e.knowledge?.claims?.find(c => c.type === type);
      let why: string;
      if (member?.needsReview) why = member.previous ? `需复核（原为「${claimValueLabel(type, member.previous)}」，依据已变）` : '需复核（依据已变）';
      else if (member) why = '成员声明为未知';
      else why = '未声明';
      issues.push({ path: `request.${REQUEST_FIELD[type]}`, entryId: e.id, message: `定义的「${label}」口径未知：${why}`, next: `先追问成员确认${label}口径` });
      raise('needs_clarification');
      return;
    }
    if (declared !== asked) {
      issues.push({
        path: `request.${REQUEST_FIELD[type]}`,
        entryId: e.id,
        message: `${label}口径不相容：要求「${claimValueLabel(type, asked)}」，定义声明「${claimValueLabel(type, declared)}」`,
        next: NEXT_DRAFT,
      });
      raise('invalid');
    }
  };
  if (plan.mode === 'reuse_result') {
    for (const s of plan.selected) {
      const e = expand(ctx.catalog, s.id);
      if (e?.kind !== 'metric') continue;
      checkClaim('unit', plan.request.unit, e);
      checkClaim('time_meaning', plan.request.timeMeaning, e);
      if (plan.request.windowDays !== undefined) {
        const days = e.window?.days;
        let message: string;
        if (days === undefined) message = `要求近 ${plan.request.windowDays} 天，定义没有时间窗口`;
        else if (days !== plan.request.windowDays) message = `要求近 ${plan.request.windowDays} 天，定义的窗口是 ${days} 天`;
        else continue;
        issues.push({ path: 'request.windowDays', entryId: e.id, message, next: NEXT_DRAFT });
        raise('invalid');
      }
    }
  }

  return { status, plan, issues };
}
