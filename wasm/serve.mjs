// wasm/serve.mjs —— 本地静态服务：页面、打包后的 app.js、DuckDB-Wasm 文件、Parquet 数据（支持 Range 请求）
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT ?? 8787);
const roots = [
  ['/duckdb/', 'node_modules/@duckdb/duckdb-wasm/dist/'],
  ['/data/', 'public/data/'],
  ['/', 'public/'],
];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm',
                '.parquet': 'application/octet-stream', '.map': 'application/json' };

createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [prefix, dir] = roots.find(([p]) => url.startsWith(p));
  const file = normalize(join(dir, url.slice(prefix.length) || 'index.html'));
  if (!existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const size = statSync(file).size;
  const headers = { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'accept-ranges': 'bytes' };
  const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
  if (range) {                                     // DuckDB-Wasm 按需读取 Parquet 的一部分
    const start = Number(range[1]), end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
