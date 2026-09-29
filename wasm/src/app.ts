// wasm/src/app.ts —— 浏览器里的 DuckDB：直接查询服务端导出的 Parquet，筛选、聚合都在用户浏览器完成
import * as duckdb from '@duckdb/duckdb-wasm';

const $ = (id: string) => document.getElementById(id)!;
const log = (msg: string) => { $('log').textContent += msg + '\n'; };

// 1) 选择适合当前浏览器的 wasm 包（本地部署：文件与页面同源；也可改成 jsDelivr 等 CDN）
const bundles: duckdb.DuckDBBundles = {
  mvp: { mainModule: '/duckdb/duckdb-mvp.wasm', mainWorker: '/duckdb/duckdb-browser-mvp.worker.js' },
  eh:  { mainModule: '/duckdb/duckdb-eh.wasm',  mainWorker: '/duckdb/duckdb-browser-eh.worker.js' },
};

async function main() {
  const t0 = performance.now();
  const bundle = await duckdb.selectBundle(bundles);
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const con = await db.connect();
  log(`DuckDB-Wasm 启动 ${(performance.now() - t0).toFixed(0)} ms，版本 ${await db.getVersion()}`);

  // 内网部署：parquet 等扩展默认从 extensions.duckdb.org 下载，可改为自己托管的地址
  const extRepo = new URLSearchParams(location.search).get('ext_repo');
  if (extRepo) await con.query(`SET custom_extension_repository = '${extRepo}'`);

  // 2) 把 Parquet 注册为虚拟文件：按需用 HTTP Range 请求读取，不必整个下载
  //    ?file=customers_web.csv 可改读 CSV（CSV 为内置格式，不依赖扩展）
  const file = new URLSearchParams(location.search).get('file') ?? 'customers_web.parquet';
  const src = `customers.${file.split('.').pop()}`;
  await db.registerFileURL(src, `${location.origin}/data/${file}`, duckdb.DuckDBDataProtocol.HTTP, false);
  const t1 = performance.now();
  const n = await con.query(`SELECT count(*)::INT AS n FROM '${src}'`);
  log(`读取 ${file} 并计数：${n.toArray()[0].n.toLocaleString()} 位客户，${(performance.now() - t1).toFixed(0)} ms`);

  const cities = (await con.query(`SELECT DISTINCT city FROM '${src}' ORDER BY 1`)).toArray().map(r => r.city as string);
  const sel = $('city') as HTMLSelectElement;
  sel.innerHTML = ['全部', ...cities].map(c => `<option>${c}</option>`).join('');

  // 3) 交互查询：切换城市，浏览器内重新聚合
  const render = async () => {
    const city = sel.value;
    const stmt = await con.prepare(`
      SELECT segment AS 人群, count(*)::INT AS 客户数, round(avg(gmv))::INT AS 平均消费, round(avg(loyalty), 1) AS 平均忠诚度
      FROM '${src}' WHERE ? = '全部' OR city = ?
      GROUP BY ALL ORDER BY 客户数 DESC`);
    const t = performance.now();
    const rows = (await stmt.query(city, city)).toArray();
    const ms = performance.now() - t;
    await stmt.close();
    $('result').innerHTML = `<tr><th>人群</th><th>客户数</th><th>平均消费</th><th>平均忠诚度</th></tr>` +
      rows.map(r => `<tr><td>${r['人群']}</td><td>${r['客户数'].toLocaleString()}</td><td>${r['平均消费'].toLocaleString()}</td><td>${r['平均忠诚度']}</td></tr>`).join('');
    $('timing').textContent = `浏览器内聚合 ${ms.toFixed(0)} ms`;
    (window as any).__lastQueryMs = ms;
    (window as any).__rows = rows;
  };
  sel.onchange = render;
  await render();
  (window as any).__ready = true;
}
main().catch(e => { log('出错：' + e); (window as any).__error = String(e); });
