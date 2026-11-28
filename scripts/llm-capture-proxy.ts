// scripts/llm-capture-proxy.ts —— 用法：node --import tsx scripts/llm-capture-proxy.ts --upstream <真实端点，如 https://…/compatible-mode/v1> [--port 8788] [--out /tmp/llm-capture]
// 验收 S6 用的本地记录代理（AI-P3）：把模型服务端点（LLM_BASE_URL / LLM_EMBEDDING_BASE_URL 或租户「模型服务」页的端点）指向 http://127.0.0.1:<port>，
// 代理把请求原样转发到 upstream + 原路径（/chat/completions、/embeddings、/models），并把每次的请求体与返回体逐行追加到 <out>/calls.jsonl，
// 用来确认真正发给模型的内容（AI-S1–S3、AI-S7、AI-S8、AI-D4）。不记 Authorization 等请求头，Key 只经手不落盘。
// 故障注入（AI-F3）：<out>/mode 文件内容决定怎么回 /chat/completions，每次请求现读——
//   pass（默认，文件不存在也是）原样转发；nonjson 不转发，回一个 content 不是 JSON 的正常 completion；badschema 回 content 为 {"unexpected":true}。
// /embeddings 只认 embedfail（AI-F5）：不转发、回 401；其他 mode 与其他路径原样转发。只监听 127.0.0.1。
// --embed-batch N（可选；平台补算自 #1171 起按 embedBatchSize() 分批，这里只给 pnpm eval:requirements 的开关对比绕过 #1322 的写死 64 条）：/embeddings 的 input 多于 N 条时拆成每批 N 条依次转发、合并 data（index 顺延）与 usage，
// 记录里的 split 字段标明拆成了几批；不传时原样转发
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  upstream: { type: 'string' }, port: { type: 'string', default: '8788' }, out: { type: 'string', default: '/tmp/llm-capture' },
  'embed-batch': { type: 'string' },
} });
const embedBatch = values['embed-batch'] ? Number(values['embed-batch']) : 0;
if (!values.upstream) throw new Error('缺 --upstream');
const upstream = values.upstream.replace(/\/+$/, '');
const out = values.out!;
mkdirSync(out, { recursive: true });
const log = join(out, 'calls.jsonl');

const mode = () => { try { return readFileSync(join(out, 'mode'), 'utf8').trim() || 'pass'; } catch { return 'pass'; } };
const parse = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

/** 不转发时伪造的一次 completion：content 是给定文本 */
const fake = (model: unknown, content: string) => JSON.stringify({
  id: 'capture-fake', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
});

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const reqText = Buffer.concat(chunks).toString('utf8');
  const path = req.url ?? '/';
  const started = Date.now();
  const current = mode();
  const m = path.endsWith('/chat/completions') ? (current === 'embedfail' ? 'pass' : current)
    : path.endsWith('/embeddings') && current === 'embedfail' ? current : 'pass';
  let status: number;
  let resText: string;
  let contentType = 'application/json';
  if (m === 'embedfail') {
    status = 401;
    resText = JSON.stringify({ error: { message: 'capture proxy: injected embedding failure (AI-F5)', code: 'invalid_api_key' } });
  } else if (m === 'nonjson' || m === 'badschema') {
    status = 200;
    const model = (parse(reqText) as { model?: unknown })?.model;
    resText = fake(model, m === 'nonjson' ? '好的，我来帮你分析一下这个问题。' : '{"unexpected":true}');
  } else {
    const headers: Record<string, string> = {};
    for (const h of ['authorization', 'content-type', 'accept']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    try {
      const body = parse(reqText) as { input?: unknown };
      if (embedBatch > 0 && path.endsWith('/embeddings') && Array.isArray(body?.input) && body.input.length > embedBatch) {
        // 拆批：任何一批失败就原样回那一批的状态与返回体
        const input = body.input as unknown[];
        const data: { index: number }[] = [];
        const usage = { prompt_tokens: 0, total_tokens: 0 };
        let merged: Record<string, unknown> = {};
        status = 200;
        resText = '';
        for (let i = 0; i < input.length; i += embedBatch) {
          const r = await fetch(upstream + path, { method: 'POST', headers, body: JSON.stringify({ ...body, input: input.slice(i, i + embedBatch) }) });
          const text = await r.text();
          if (!r.ok) { status = r.status; resText = text; break; }
          const j = JSON.parse(text) as { data: { index: number }[]; usage?: typeof usage };
          merged = j;
          for (const d of j.data) data.push({ ...d, index: d.index + i });
          usage.prompt_tokens += j.usage?.prompt_tokens ?? 0;
          usage.total_tokens += j.usage?.total_tokens ?? 0;
        }
        if (status === 200) resText = JSON.stringify({ ...merged, data, usage, split: Math.ceil(input.length / embedBatch) });
      } else {
        const r = await fetch(upstream + path, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : reqText });
        status = r.status;
        contentType = r.headers.get('content-type') ?? contentType;
        resText = await r.text();
      }
    } catch (e) {
      status = 502;
      resText = JSON.stringify({ error: { message: `capture proxy: ${(e as Error).message}` } });
    }
  }
  appendFileSync(log, `${JSON.stringify({ at: new Date(started).toISOString(), ms: Date.now() - started, method: req.method, path, mode: m, status, request: parse(reqText), response: parse(resText) })}\n`);
  res.writeHead(status, { 'content-type': contentType });
  res.end(resText);
}).listen(Number(values.port), '127.0.0.1', () => console.log(`capture proxy :${values.port} → ${new URL(upstream).host}，记录写到 ${log}`));
