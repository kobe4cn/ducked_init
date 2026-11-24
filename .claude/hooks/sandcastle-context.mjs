// .claude/hooks/sandcastle-context.mjs —— Sandcastle 沙箱里的上下文预算守卫（docs/agents/sandcastle.md「上下文预算」）
// 只在 SANDCASTLE_PROFILE 有值时生效（编排脚本给容器里的 claude 设的），宿主机上的会话不受影响。
//
// PreToolUse(Read)：档案标了 SANDCASTLE_NO_IMAGES=1（主模型看不到图片，如 glm-5.3）时，主线程读图片一律拦下：
//   看不到还照样计 token，一张 1280×720 截图约 6–7 万，一下就能把会话撑过 150k。
//   看图交给 screenshot-checker 子代理（.claude/agents/screenshot-checker.md，model: haiku，glm 档案映射到能看图的 glm-5.3-flash），
//   每个子代理只许读一张图，自己的上下文也不过 150k。子代理里触发的 hook 输入带 agent_id / agent_type，主线程没有。
// PostToolUse(*)：从会话记录取最近一条 assistant 消息的上下文（输入 + 缓存写 + 缓存读），加上刚返回的工具结果估算，
//   到 SOFT 时要求收尾交接（implement 由下一个全新会话接着做，3 次会话做不完退回 prep 拆票），到 HARD 时要求立刻结束。
//   同一会话每多 STEP 才再提醒一次，避免每次工具调用都刷屏。
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';

export const SOFT = 100_000;
export const HARD = 130_000;
const STEP = 10_000;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** 会话记录尾部最近一条带 usage 的 assistant 消息的上下文大小；读不到返回 0。只读文件末尾，记录可能有几 MB。 */
export function lastContext(transcriptPath, tailBytes = 512 * 1024) {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  const size = statSync(transcriptPath).size;
  const len = Math.min(size, tailBytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(transcriptPath, 'r');
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue;
    try {
      const o = JSON.parse(lines[i]);
      const u = o.type === 'assistant' && o.message?.model !== '<synthetic>' ? o.message?.usage : undefined;
      if (u) return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    } catch {
      // 截断的第一行或损坏的行
    }
  }
  return 0;
}

/** 刚返回的工具结果大约多少 token：按 3 个字符 1 个 token 粗估（中文偏多时偏保守）。 */
// 改文件的工具：hook 收到的 tool_response 带整份原文件（originalFile）和补丁，模型实际只看到一句「已修改」，按 0 算。
//   不排除的话，改一下 test/CATALOG.md 这种大文件就会被估成 +60k，误报收尾（2026-11-24 #1268 实际 56k 时被报成 116k）。
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
export const resultTokens = (response, toolName) =>
  EDIT_TOOLS.has(toolName) ? 0 : Math.ceil(JSON.stringify(response ?? '').length / 3);

const k = (n) => `${Math.round(n / 1000)}k`;

export const CHECKER = 'screenshot-checker';

/** 返回要拦下的原因；不用拦返回 undefined。state 记每个看图子代理已经读过的图片。 */
export function checkRead(input, env, state = new Map()) {
  if (!env.SANDCASTLE_PROFILE || env.SANDCASTLE_NO_IMAGES !== '1') return undefined;
  const file = String(input.tool_input?.file_path ?? '');
  if (!IMAGE.test(file)) return undefined;
  if (input.agent_id && input.agent_type === CHECKER) {
    const key = `img:${input.agent_id}`;
    const seen = state.get(key);
    if (seen && seen !== file) return `Blocked: 每个 ${CHECKER} 只看一张图（已看过 ${seen}），一张约 7 万 token，两张就逼近 150k。只就这一张输出结论；别的截图由主会话另起一个 ${CHECKER}。`;
    state.set(key, file);
    return undefined;
  }
  return (
    `Blocked: 当前模型档案（${env.SANDCASTLE_PROFILE}）的主模型看不到图片，读 ${file} 不会有任何信息，却会占用约 7 万 token 上下文。` +
    `看截图用 Agent 工具起 subagent_type: "${CHECKER}"，一次一张，prompt 里给截图路径和要核对的点（Browser check 条目、docs/agents/ui.md 的相关约定）；几张截图可以在同一条消息里并行起几个。` +
    '它回文字结论，不占你的上下文。文字也能核对的（文案、结构、class、尺寸）先用 `playwright-cli snapshot` / `eval`。'
  );
}

/** 返回给 agent 的收尾要求；还没到预算返回 undefined。state 记这个会话上次在多大时提醒过。 */
export function checkBudget(input, env, state) {
  if (!env.SANDCASTLE_PROFILE || input.agent_id) return undefined; // 子代理的上下文另算，它的结论回到主线程时由 Agent 工具的 PostToolUse 计入
  const ctx = lastContext(input.transcript_path) + resultTokens(input.tool_response, input.tool_name);
  if (ctx < SOFT) return undefined;
  const last = state.get(input.session_id) ?? 0;
  if (last && ctx < last + STEP && !(ctx >= HARD && last < HARD)) return undefined;
  state.set(input.session_id, ctx);
  const phase = env.SANDCASTLE_PHASE ?? '';
  const impl =
    '收尾交接：把已经能通过测试的改动提交（提交信息写明完成了哪些验收标准）；在 issue 上留进度评论，写清已完成、未完成、下一步从哪个 file:line 接着做；然后结束会话，**不要输出 <promise>COMPLETE</promise>**。下一个全新会话会按这条评论接着做；3 次会话仍做不完，prep 会把剩下的拆成更小的票。';
  const other = '收尾：不再开始新的探索或改动，把手上这一项做完、提交，按提示词的要求输出结论；没来得及看的部分在输出里写明，交给下一轮。';
  // 没有阶段名（编排脚本还是旧进程，没传 SANDCASTLE_PHASE）时两种都给，由 agent 按自己的任务对号入座
  const handoff = phase === 'implement' ? impl : phase ? other : `若你在实现一张票（implement）——${impl}若是其他阶段（prep / review / revise / fix / rebase）——${other}`;
  const level = ctx >= HARD ? `已到 ${k(ctx)}，接近 150k 预算上限，立刻` : `已到约 ${k(ctx)}（预算 150k），现在`;
  return `上下文预算：本会话上下文${level}${handoff}之后只读必要的几行（grep -n / sed -n 小范围），不要再整读文件或跑输出很长的命令。`;
}

const STATE_FILE = '/tmp/sandcastle-context-hook.json';

function loadState() {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(STATE_FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(state)));
  } catch {
    // 记不下只会多提醒几次、子代理可能多看一张图
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (input.hook_event_name === 'PreToolUse') {
    const state = loadState();
    const reason = checkRead(input, process.env, state);
    saveState(state);
    if (reason) {
      console.error(reason);
      process.exit(2);
    }
  } else if (input.hook_event_name === 'PostToolUse') {
    const state = loadState();
    const reason = checkBudget(input, process.env, state);
    if (reason) {
      saveState(state);
      console.log(JSON.stringify({ decision: 'block', reason }));
    }
  }
}
