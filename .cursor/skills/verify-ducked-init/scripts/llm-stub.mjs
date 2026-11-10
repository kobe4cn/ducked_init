#!/usr/bin/env node
// Local OpenAI-compatible chat stub for verify-ducked-init. Fake keys only.
// Writes one JSON line per POST: path, model, and the last four characters of the bearer token.
//
//   node scripts/llm-stub.mjs --port 0 --log /tmp/llm-stub.jsonl --origin-file /tmp/llm-stub.origin
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '0' },
    log: { type: 'string' },
    'origin-file': { type: 'string' },
  },
});

if (!values.log || !values['origin-file']) {
  console.error('usage: llm-stub.mjs --log <file> --origin-file <file> [--port N]');
  process.exit(2);
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user' && typeof messages[i].content === 'string') return messages[i].content;
  }
  return '';
}

function replyFor(body) {
  if (body?.response_format?.type === 'json_object') {
    return { content: '{"ok":true}' };
  }
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const ping = tools.some(tool => (tool?.function?.name ?? tool?.name) === 'ping');
  if (ping) {
    return {
      content: null,
      tool_calls: [{ id: 'call_ping', type: 'function', function: { name: 'ping', arguments: '{}' } }],
    };
  }
  return { content: `验收回复：${lastUserText(body)}` };
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      body = {};
    }
    const header = String(req.headers.authorization ?? '');
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    appendFileSync(values.log, `${JSON.stringify({
      path: req.url ?? '',
      model: typeof body.model === 'string' ? body.model : null,
      authLast4: token.slice(-4),
      tools: Array.isArray(body.tools),
      json: body?.response_format?.type === 'json_object',
    })}\n`);
    const payload = {
      choices: [{ message: replyFor(body) }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0) {
  console.error(`bad --port ${values.port}`);
  process.exit(2);
}

writeFileSync(values.log, '');
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  writeFileSync(values['origin-file'], `${origin}\n`);
  console.log(`STUB origin=${origin}`);
});
