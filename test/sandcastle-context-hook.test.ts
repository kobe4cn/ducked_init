// .claude/hooks/sandcastle-context.mjs：Sandcastle 沙箱里的上下文预算守卫（主模型看不到图时读图交给 screenshot-checker、到预算要求收尾交接）
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error 钩子是 .mjs，没有类型声明
import { HARD, SOFT, checkBudget, checkRead, lastContext } from '../.claude/hooks/sandcastle-context.mjs';

const HOOK = join(__dirname, '../.claude/hooks/sandcastle-context.mjs');
const dir = mkdtempSync(join(tmpdir(), 'ctx-hook-'));

/** 写一份会话记录：每个数是一条 assistant 消息的上下文（全记在 cache_read 上），可混入合成消息。 */
function transcript(name: string, contexts: number[], extra: object[] = []) {
  const lines = contexts.map((n, i) =>
    JSON.stringify({ type: 'assistant', message: { id: `m${i}`, model: 'glm-5.3', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: n } } }),
  );
  for (const e of extra) lines.push(JSON.stringify(e));
  const p = join(dir, `${name}.jsonl`);
  writeFileSync(p, `${lines.join('\n')}\n`);
  return p;
}

const env = { SANDCASTLE_PROFILE: 'glm', SANDCASTLE_PHASE: 'implement' };

describe('checkRead：看不到图片的档案不读图片', () => {
  const read = (file_path: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path } });

  it('档案标了 SANDCASTLE_NO_IMAGES=1 时主线程读 png / jpg 被拦，提示交给 screenshot-checker', () => {
    const reason = checkRead(read('/w/.browser-check/01-a.png'), { ...env, SANDCASTLE_NO_IMAGES: '1' });
    expect(reason).toContain('看不到图片');
    expect(reason).toContain('screenshot-checker');
    expect(checkRead(read('/w/x.JPG'), { ...env, SANDCASTLE_NO_IMAGES: '1' })).toBeDefined();
  });

  it('非图片、档案没标、宿主机会话（没有 SANDCASTLE_PROFILE）都放行', () => {
    expect(checkRead(read('/w/app/x.ts'), { ...env, SANDCASTLE_NO_IMAGES: '1' })).toBeUndefined();
    expect(checkRead(read('/w/a.png'), env)).toBeUndefined();
    expect(checkRead(read('/w/a.png'), { SANDCASTLE_NO_IMAGES: '1' })).toBeUndefined();
  });

  it('screenshot-checker 子代理放行一张图，第二张拦下；别的子代理照样拦', () => {
    const noImg = { ...env, SANDCASTLE_NO_IMAGES: '1' };
    const state = new Map();
    const sub = (file: string, agent_type = 'screenshot-checker', agent_id = 'a1') => ({ ...read(file), agent_id, agent_type });
    expect(checkRead(sub('/w/1.png'), noImg, state)).toBeUndefined();
    expect(checkRead(sub('/w/1.png'), noImg, state)).toBeUndefined();
    expect(checkRead(sub('/w/2.png'), noImg, state)).toContain('只看一张图');
    expect(checkRead(sub('/w/2.png', 'screenshot-checker', 'a2'), noImg, state)).toBeUndefined();
    expect(checkRead(sub('/w/3.png', 'general-purpose', 'a3'), noImg, state)).toContain('看不到图片');
  });
});

describe('checkBudget：上下文到预算时要求收尾', () => {
  const post = (transcript_path: string, tool_response: unknown = 'ok', session_id = 's1') => ({ hook_event_name: 'PostToolUse', session_id, transcript_path, tool_response });

  it('lastContext 取最后一条非合成 assistant 消息的输入 + 缓存写 + 缓存读', () => {
    const p = transcript('last', [40_000, 90_000], [{ type: 'assistant', message: { id: 'x', model: '<synthetic>', usage: { input_tokens: 0, cache_read_input_tokens: 0 } } }]);
    expect(lastContext(p)).toBe(90_000);
    expect(lastContext(join(dir, 'missing.jsonl'))).toBe(0);
  });

  it('不到 SOFT 不提醒；加上刚返回的大结果越过 SOFT 就提醒，implement 要求交接且不输出 COMPLETE', () => {
    const p = transcript('soft', [SOFT - 10_000]);
    expect(checkBudget(post(p), env, new Map())).toBeUndefined();
    const reason = checkBudget(post(p, 'x'.repeat(40_000)), env, new Map());
    expect(reason).toContain('进度评论');
    expect(reason).toContain('不要输出 <promise>COMPLETE</promise>');
  });

  it('同一会话每多 10k 才再提醒；越过 HARD 时一定提醒并要求立刻结束', () => {
    const state = new Map();
    expect(checkBudget(post(transcript('a', [SOFT + 1_000])), env, state)).toBeDefined();
    expect(checkBudget(post(transcript('b', [SOFT + 5_000])), env, state)).toBeUndefined();
    expect(checkBudget(post(transcript('c', [SOFT + 12_000])), env, state)).toBeDefined();
    expect(checkBudget(post(transcript('d', [HARD + 1_000])), env, state)).toContain('立刻');
    expect(checkBudget(post(transcript('e', [HARD + 1_000]), 'ok', 's2'), env, state)).toBeDefined();
  });

  it('非 implement 阶段要求按提示词输出结论；宿主机会话不管', () => {
    const p = transcript('other', [SOFT + 1_000]);
    expect(checkBudget(post(p), { ...env, SANDCASTLE_PHASE: 'review' }, new Map())).toContain('输出结论');
    expect(checkBudget(post(p), {}, new Map())).toBeUndefined();
  });

  it('没有阶段名时 implement 与其他阶段的收尾要求都给', () => {
    const reason = checkBudget(post(transcript('nophase', [SOFT + 1_000])), { SANDCASTLE_PROFILE: 'glm' }, new Map());
    expect(reason).toContain('进度评论');
    expect(reason).toContain('输出结论');
  });

  it('子代理里的工具调用不提醒（上下文另算）', () => {
    expect(checkBudget({ ...post(transcript('sub', [HARD + 1_000])), agent_id: 'a1' }, env, new Map())).toBeUndefined();
  });
});

describe('作为 hook 运行', () => {
  const run = (input: object, extraEnv: Record<string, string>) =>
    spawnSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { PATH: process.env.PATH, ...extraEnv } });

  it('PreToolUse 拦图片时退出码 2、原因写在 stderr', () => {
    const r = run({ hook_event_name: 'PreToolUse', tool_input: { file_path: '/w/a.png' } }, { ...env, SANDCASTLE_NO_IMAGES: '1' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('看不到图片');
  });

  it('PostToolUse 到预算时输出 decision: block；没到时什么都不输出', () => {
    const over = run({ hook_event_name: 'PostToolUse', session_id: `run-${Date.now()}`, transcript_path: transcript('run', [HARD]), tool_response: 'ok' }, env);
    expect(over.status).toBe(0);
    expect(JSON.parse(over.stdout)).toMatchObject({ decision: 'block' });
    const under = run({ hook_event_name: 'PostToolUse', session_id: 'u', transcript_path: transcript('u', [10_000]), tool_response: 'ok' }, env);
    expect(under.stdout).toBe('');
  });
});
