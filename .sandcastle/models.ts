// Sandcastle 每个阶段用哪个模型：读 .sandcastle/models.json，按阶段挑档案、撞限额时换下一个，记录每次会话的 token 用量。
// 格式与规则见 docs/agents/sandcastle.md「模型配置」。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import * as sandcastle from "@ai-hero/sandcastle";

export const PHASES = ["prep", "implement", "review", "revise", "fix", "rebase"] as const;
export type Phase = (typeof PHASES)[number];

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

/** sandbox.run 与 sandcastle.run 的结果都满足它。 */
export interface AgentRun {
  readonly iterations: readonly sandcastle.IterationResult[];
  readonly completionSignal?: string;
  readonly stdout: string;
}

export interface Profile {
  readonly name: string;
  readonly model: string;
  readonly effort?: Effort;
  /** 只在这次会话的 claude 进程上生效；值是 `${VAR}` 的，在容器里从同名环境变量取（来自 .sandcastle/.env）。 */
  readonly env: Readonly<Record<string, string>>;
  /** 设了 ANTHROPIC_BASE_URL：请求发到别家，不走 Claude 订阅。 */
  readonly thirdParty: boolean;
  readonly limitPattern: RegExp;
  /** 别家报错里不带时区的重置时间按这个时区解析。 */
  readonly resetTimeZone?: string;
}

interface ModelsConfig {
  readonly profiles: ReadonlyMap<string, Profile>;
  readonly phases: Readonly<Record<Phase, readonly string[]>>;
}

const CONFIG_PATH = ".sandcastle/models.json";
const SANDCASTLE_ENV_PATH = ".sandcastle/.env";
const USAGE_LOG = ".sandcastle/logs/usage.jsonl";
const SECRET_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 脚本统一给容器设的上下文预算（CLAUDE.md「Context budget」），档案不能改。 */
const RESERVED_ENV = ["CLAUDE_CODE_AUTO_COMPACT_WINDOW"];
/** 别家档案里要清掉的 Claude 凭据：不能跟着请求发到别家的接口。 */
const CLAUDE_CREDENTIALS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

/** claude-code 撞订阅限额的报错，如「You've hit your 5-hour limit · resets 6:20am (UTC)」。 */
export const CLAUDE_LIMIT_PATTERN = /hit your .*?limit/i;
/** 认不出重置时间时跳过这个档案多久。 */
const UNKNOWN_RESET_SKIP_MS = 60 * 60_000;
const RESET_SLACK_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// 读配置
// ---------------------------------------------------------------------------

const fail = (message: string): never => {
  throw new Error(`${CONFIG_PATH}：${message}`);
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** sandcastle 只把 .sandcastle/.env 里列出的键带进容器（值取文件里的，空的取宿主机环境变量）。 */
function sandcastleEnvKeys(): Set<string> {
  if (!existsSync(SANDCASTLE_ENV_PATH)) return new Set();
  const vars = parseEnv(readFileSync(SANDCASTLE_ENV_PATH, "utf8"));
  return new Set(Object.keys(vars).filter((k) => vars[k] || process.env[k]));
}

function parseProfile(name: string, raw: unknown, warn: (m: string) => void): Profile & { readonly refs: readonly { where: string; variable: string }[] } {
  const at = `profiles.${name}`;
  if (!isRecord(raw)) return fail(`${at} 要是对象`);
  const harness = raw.harness ?? "claude-code";
  if (harness === "codex") fail(`${at}.harness 是 codex：还没实现，目前只支持 claude-code`);
  if (harness !== "claude-code") fail(`${at}.harness 只能是 claude-code`);
  if (typeof raw.model !== "string" || !raw.model) fail(`${at}.model 要是非空字符串`);
  if (raw.effort !== undefined && !EFFORTS.includes(raw.effort as Effort)) fail(`${at}.effort 只能是 ${EFFORTS.join(" / ")}`);
  if (raw.env !== undefined && !isRecord(raw.env)) fail(`${at}.env 要是对象`);

  const env: Record<string, string> = {};
  const refs: { where: string; variable: string }[] = [];
  for (const [key, value] of Object.entries(raw.env ?? {})) {
    if (!ENV_KEY.test(key)) fail(`${at}.env 的键 ${key} 不是合法的环境变量名`);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") fail(`${at}.env.${key} 要是字符串或数字`);
    if (RESERVED_ENV.includes(key)) {
      warn(`${at}.env.${key} 忽略：上下文预算由脚本统一设置`);
      continue;
    }
    if (CLAUDE_CREDENTIALS.includes(key)) fail(`${at}.env 不能设 ${key}`);
    const text = String(value);
    const ref = SECRET_REF.exec(text);
    if (ref) {
      refs.push({ where: `${at}.env.${key}`, variable: ref[1]! });
    } else if (text.includes("${")) {
      fail(`${at}.env.${key}：\${VAR} 只能单独作为整个值`);
    }
    env[key] = text;
  }

  const thirdParty = "ANTHROPIC_BASE_URL" in env;
  if (thirdParty && !env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    warn(`${at} 发到别家但没设 ANTHROPIC_DEFAULT_HAIKU_MODEL：Claude Code 的后台小任务和子 agent 会拿 Claude 的模型名去请求别家接口`);
  }
  if (raw.limitPattern !== undefined && typeof raw.limitPattern !== "string") fail(`${at}.limitPattern 要是正则字符串`);
  let limitPattern = CLAUDE_LIMIT_PATTERN;
  if (typeof raw.limitPattern === "string") {
    try {
      limitPattern = new RegExp(raw.limitPattern, "i");
    } catch (e) {
      fail(`${at}.limitPattern 不是合法的正则：${String(e)}`);
    }
  } else if (thirdParty) {
    warn(`${at} 发到别家但没设 limitPattern：撞了它的限额认不出来，只会当成普通报错`);
  }
  if (raw.resetTimeZone !== undefined) {
    if (typeof raw.resetTimeZone !== "string") fail(`${at}.resetTimeZone 要是时区名，如 Asia/Shanghai`);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: raw.resetTimeZone as string });
    } catch {
      fail(`${at}.resetTimeZone 不是合法的时区：${String(raw.resetTimeZone)}`);
    }
  }
  return {
    name,
    model: raw.model as string,
    effort: raw.effort as Effort | undefined,
    env,
    thirdParty,
    limitPattern,
    resetTimeZone: raw.resetTimeZone as string | undefined,
    refs,
  };
}

function parseConfig(text: string, envKeys: Set<string>, warn: (m: string) => void): ModelsConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`不是合法的 JSON：${String(e)}`);
  }
  if (!isRecord(raw) || !isRecord(raw.profiles) || !isRecord(raw.phases)) return fail("要有 profiles 和 phases 两个对象");
  const profiles = new Map(Object.entries(raw.profiles).map(([name, p]) => [name, parseProfile(name, p, warn)]));
  for (const key of Object.keys(raw.phases)) {
    if (!PHASES.includes(key as Phase)) fail(`phases 里的 ${key} 不是阶段；阶段是 ${PHASES.join(" / ")}`);
  }
  const phases = {} as Record<Phase, string[]>;
  for (const phase of PHASES) {
    const list = raw.phases[phase];
    if (!Array.isArray(list) || list.length === 0 || !list.every((p) => typeof p === "string")) {
      fail(`phases.${phase} 要是非空的档案名列表`);
    }
    for (const name of list as string[]) if (!profiles.has(name)) fail(`phases.${phase} 里的档案 ${name} 不在 profiles 里`);
    phases[phase] = list as string[];
  }
  // 只查阶段用到的档案：没启用的档案（比如还没填密钥的别家）不挡运行。
  for (const name of new Set(Object.values(phases).flat())) {
    for (const { where, variable } of profiles.get(name)!.refs) {
      if (!envKeys.has(variable)) fail(`${where} 引用的 ${variable} 不在 ${SANDCASTLE_ENV_PATH} 里（或值为空）：sandcastle 只把那里列出的变量带进容器`);
    }
  }
  return { profiles, phases };
}

let config: ModelsConfig | undefined;

/**
 * 每轮开头调用。第一次读不成直接抛（运行起不来）；之后读不成就警告并沿用上一份，不打断正在跑的运行。
 */
export function reloadModels() {
  const warnings: string[] = [];
  try {
    const next = parseConfig(readFileSync(CONFIG_PATH, "utf8"), sandcastleEnvKeys(), (m) => warnings.push(m));
    for (const w of warnings) console.warn(`  ⚠ ${CONFIG_PATH}：${w}`);
    config = next;
    console.log(`模型：${PHASES.map((p) => `${p}=${next.phases[p].join("→")}`).join("  ")}`);
  } catch (e) {
    if (!config) throw e;
    console.warn(`  ⚠ ${String(e)}；沿用上一次读到的配置`);
  }
}

// ---------------------------------------------------------------------------
// 档案 → agent provider
// ---------------------------------------------------------------------------

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * createSandbox 里的 sandbox.run 不用 agent provider 的 env（只用容器启动时的），所以档案的 env 加在命令前面：
 * `env -u … K=V claude …`，另加 SANDCASTLE_PROFILE（implementer 在进度评论里写明用的档案）。命令在容器里由 sh -c 执行，`${VAR}` 写成 "$VAR"，密钥不出现在宿主机的命令行里。
 */
export function agentFor(profile: Profile, env: Record<string, string>): sandcastle.AgentProvider {
  const base = sandcastle.claudeCode(profile.model, { env, ...(profile.effort ? { effort: profile.effort } : {}) });
  const assignments = Object.entries({ ...profile.env, SANDCASTLE_PROFILE: profile.name }).map(([k, v]) => {
    const ref = SECRET_REF.exec(v);
    return `${k}=${ref ? `"$${ref[1]}"` : shellQuote(v)}`;
  });
  const unset = profile.thirdParty ? CLAUDE_CREDENTIALS.map((k) => `-u ${k}`) : [];
  const prefix = `env ${[...unset, ...assignments].join(" ")} `;
  return {
    ...base,
    buildPrintCommand: (options) => {
      const cmd = base.buildPrintCommand(options);
      return { ...cmd, command: prefix + cmd.command };
    },
  };
}

// ---------------------------------------------------------------------------
// 按阶段挑档案；撞限额换下一个
// ---------------------------------------------------------------------------

/** 档案名 → 在这个时刻之前跳过它。所有并行的票共用：一张票撞了 opus 的限额，别的票也不再去撞。 */
const blockedUntil = new Map<string, number>();

/** 这个阶段的档案全都在等限额重置；untilAfterLimit 认它，等到 until 再从头跑。 */
export class AllProfilesLimited extends Error {
  constructor(readonly phase: Phase, readonly until: number) {
    super(`阶段 ${phase} 的档案都撞上了用量限额，最早 ${new Date(until).toLocaleString()} 恢复`);
  }
}

/** 某时刻在 timeZone 里比 UTC 快多少毫秒；timeZone 不合法时抛 RangeError。 */
function tzOffsetMs(at: number, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    }).formatToParts(at).map((p) => [p.type, Number(p.value)]),
  );
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
  return Math.round((wall - at) / 60_000) * 60_000;
}

/**
 * 报错里的重置时间；认不出返回 null。认两种：
 * - claude-code 的「resets 6:20am (UTC)」：下一次到这个钟点的时刻。只认钟点，带日期的（每周限额）可能算早，
 *   醒来再撞上会重新等，代价是多一次失败的调用。
 * - 别家常见的「2026-11-07 15:30:00」：按 timeZone 解析（不给就按宿主机时区）。
 */
export function limitResetAt(message: string, timeZone?: string, now = Date.now()): number | null {
  const clock = /resets\b.*?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(message);
  if (clock) {
    const hour = (Number(clock[1]) % 12) + (clock[3]!.toLowerCase() === "pm" ? 12 : 0);
    const minute = Number(clock[2] ?? 0);
    const zone = clock[4]!.trim();
    try {
      const today = new Date(now + tzOffsetMs(now, zone));
      for (let day = 0; day <= 1; day++) {
        const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, hour, minute);
        const at = wall - tzOffsetMs(wall, zone);
        if (at > now) return at;
      }
    } catch {
      return null;
    }
    return null;
  }
  const stamp = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(message);
  if (stamp) {
    const [y, mo, d, h, mi, s] = stamp.slice(1).map((v) => Number(v ?? 0));
    const wall = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
    const at = timeZone ? wall - tzOffsetMs(wall, timeZone) : new Date(y!, mo! - 1, d!, h!, mi!, s!).getTime();
    return at > now ? at : null;
  }
  return null;
}

/** 有的报错不抛出来，而是作为最后的输出、不带完成信号返回。 */
const limitText = (run: AgentRun, p: Profile) =>
  run.completionSignal === undefined && p.limitPattern.test(run.stdout.slice(-2000)) ? run.stdout.slice(-2000) : undefined;

/**
 * 用这个阶段第一个没在等限额的档案跑一次会话。撞上限额就记下重置时间（认不出跳过 1 小时）、换下一个；
 * 都在等时抛 AllProfilesLimited。其他错误照抛。
 */
export async function runWithProfile<T extends AgentRun>(
  phase: Phase,
  what: string,
  fn: (profile: Profile) => Promise<T>,
): Promise<{ run: T; profile: Profile }> {
  if (!config) throw new Error("先调用 reloadModels()");
  for (;;) {
    const now = Date.now();
    const names = config.phases[phase];
    const name = names.find((n) => (blockedUntil.get(n) ?? 0) <= now);
    if (name === undefined) throw new AllProfilesLimited(phase, Math.min(...names.map((n) => blockedUntil.get(n)!)));
    const profile = config.profiles.get(name)!;
    let message: string | undefined;
    try {
      const run = await fn(profile);
      message = limitText(run, profile);
      if (message === undefined) return { run, profile };
    } catch (e) {
      message = String(e);
      if (!profile.limitPattern.test(message)) throw e;
    }
    const resetAt = limitResetAt(message, profile.resetTimeZone);
    const until = resetAt === null ? now + UNKNOWN_RESET_SKIP_MS : resetAt + RESET_SLACK_MS;
    blockedUntil.set(name, until);
    const why = resetAt === null ? `认不出重置时间（${message.slice(-200).trim()}），` : "";
    console.log(`  ⏸ ${what} 的档案 ${name} 撞上用量限额，${why}${new Date(until).toLocaleString()} 前跳过它`);
  }
}

// ---------------------------------------------------------------------------
// 用量记录
// ---------------------------------------------------------------------------

export interface UsageRecord {
  readonly at: string;
  readonly issue: string;
  readonly phase: Phase;
  readonly run: string;
  readonly profile: string;
  readonly model: string;
  readonly sessions: number;
  readonly input: number;
  readonly cacheCreation: number;
  readonly cacheRead: number;
  readonly output: number;
}

/**
 * 一次会话的 token 总数：把会话 JSONL 里每条 assistant 消息的 usage 加起来（同一条消息分多行写、usage 重复，按 id 去重取最后一行）。
 * IterationResult.usage 只是最后一条消息的快照，不能当总数用；没有会话文件时退回用它。
 */
function sessionTotals(it: sandcastle.IterationResult) {
  const zero = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };
  if (it.sessionFilePath && existsSync(it.sessionFilePath)) {
    const byId = new Map<string, Record<string, number>>();
    for (const line of readFileSync(it.sessionFilePath, "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "assistant" && obj.message?.usage) byId.set(obj.message.id ?? `#${byId.size}`, obj.message.usage);
      } catch {
        // 半行或损坏的行跳过
      }
    }
    const sum = { ...zero };
    for (const u of byId.values()) {
      sum.input += u.input_tokens ?? 0;
      sum.cacheCreation += u.cache_creation_input_tokens ?? 0;
      sum.cacheRead += u.cache_read_input_tokens ?? 0;
      sum.output += u.output_tokens ?? 0;
    }
    return sum;
  }
  const u = it.usage;
  return u ? { input: u.inputTokens, cacheCreation: u.cacheCreationInputTokens, cacheRead: u.cacheReadInputTokens, output: u.outputTokens } : zero;
}

/** 记一次 run 的用量：追加到 .sandcastle/logs/usage.jsonl 并返回，调用方收集起来写进 PR。写不进只警告。 */
export function recordUsage(issue: string, phase: Phase, run: AgentRun, name: string, profile: Profile): UsageRecord {
  const totals = run.iterations.map(sessionTotals).reduce(
    (a, b) => ({ input: a.input + b.input, cacheCreation: a.cacheCreation + b.cacheCreation, cacheRead: a.cacheRead + b.cacheRead, output: a.output + b.output }),
    { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 },
  );
  const record: UsageRecord = {
    at: new Date().toISOString(), issue, phase, run: name, profile: profile.name, model: profile.model,
    sessions: run.iterations.length, ...totals,
  };
  try {
    mkdirSync(".sandcastle/logs", { recursive: true });
    appendFileSync(USAGE_LOG, `${JSON.stringify(record)}\n`);
  } catch (e) {
    console.warn(`  ⚠ 用量没写进 ${USAGE_LOG}：${String(e)}`);
  }
  return record;
}

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;

/** PR 正文里的用量表：每次 run 一行，只记 token 数（别家档案的「费用」是按 Claude 单价算的，没有意义）。 */
export function usageTable(records: readonly UsageRecord[]): string {
  if (records.length === 0) return "（没有记录到用量）";
  const rows = records.map((r) => `| ${r.run} | ${r.profile}（${r.model}） | ${r.sessions} | ${k(r.input)} | ${k(r.cacheCreation)} | ${k(r.cacheRead)} | ${k(r.output)} |`);
  return ["| 会话 | 档案 | 次数 | 输入 | 缓存写 | 缓存读 | 输出 |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
}
