// test/http/i18n-source-page.test.ts —— 数据源详情页接入双语后的断言（#1036 + #1037，ADR-0060）：
// 英文界面（CRM_ENABLE_EN_LOCALE + crm_locale cookie）下两票负责的区域——#1036：页头与指标卡、标签页、连接与同步范围
// 设置、源表行的同步方式徽标与进湖状态、采集 / 同步状态、按钮与 action 回显；#1037：同步历史、列统计、水位线 /
// 业务主键 / 软删除、进湖覆盖范围、湖中数据标签页（核对摘要与明细）、源端注释明细、删除与源视图卡——没有汉字；
// 数据源类型、同步方式、核对状态与未进湖原因经 builtinName 显示英文，行数与日期按英文格式（~1,500、11/21/2026）。
// 例外仍是中国原文的数据值（fixture 的城市名）与 #1137 的 syncModeNote，按区域截取断言，不整页断言；meta 标题照惯例不翻。
// 中文界面下日期时间与数字仍和改造前的 zh-CN 格式一致（两票区域各有回归用例）。源名用 ASCII（数据值不翻，断言不用剔数据值）
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb } from '../../app/.server/db/client';
import { syncSource } from '../../app/.server/source-sync';
import { confirmWatermark, registerSource } from '../../app/.server/sources';
import { drain, memberOf, newTenant, selectAllTables } from '../pipeline/fixtures';
import { grantOnSource, pgSourceInput, READER } from '../pipeline/source-fixtures';
import { loginAs, resetDb, startApp, type TestApp } from './harness';

let app: TestApp;
beforeAll(async () => { app = await startApp(); });
afterAll(async () => { await app?.close(); await closeDb(); });
beforeEach(async () => { await resetDb(); app.outbox.length = 0; });
afterEach(() => vi.unstubAllEnvs());

/** 开通租户 acme，de@acme.com 登记 ASCII 名字的电商库（数据值不翻）、选入全部表并同步一次 */
async function syncedSource() {
  const tenantId = await newTenant('acme');
  const engineer = await memberOf(tenantId, 'de@acme.com', 'data_engineer');
  // 估算行数来自 pg_class.reltuples：seedPgSource 会重建 shop，ANALYZE 要放在它之后、登记之前，
  // 登记时的列表才能拿到 events 的 1500 行
  const input = await pgSourceInput(READER, 'shop-db');
  await grantOnSource('ANALYZE shop.events');
  const { id } = await registerSource(engineer, input);
  await selectAllTables(engineer, id);
  await drain();
  await confirmWatermark(engineer, id, 'customers', 'updated_at');
  await syncSource(engineer, id);
  await drain();
  return { tenantId, sourceId: id };
}

/** 只登记、不选表的数据源：所有列出的表都是「新表未选」，源表与同步历史为空 */
async function freshSource() {
  const tenantId = await newTenant('acme');
  const engineer = await memberOf(tenantId, 'de@acme.com', 'data_engineer');
  const input = await pgSourceInput(READER, 'shop-db');
  await grantOnSource('ANALYZE shop.events');
  const { id } = await registerSource(engineer, input);
  return { tenantId, sourceId: id };
}

/** 水合数据里的 script 会带中文词典键（键就是中文原文），语言切换选项的「中文」按母语名显示（ADR-0060），断言前都去掉 */
const stripScripts = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<form[^>]*action="\/locale"[\s\S]*?<\/form>/g, '');

/** 同步范围表单（intent=scope 的那个 form）：#1037 的子组件不在里面，整个表单都归本票 */
const scopeFormOf = (html: string) => {
  const start = html.lastIndexOf('<form', html.indexOf('value="scope"'));
  return html.slice(start, html.indexOf('</form>', start) + 8);
};

describe('英文界面：数据源详情页（一）', () => {
  it('页头与指标卡、标签页没有汉字：返回链接、英文日期、类型走 builtinName、表数复数、核对状态', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await engineer.get(`/sources/${sourceId}`)).text());
    // 页头、指标卡与标签页：白色面板之前（meta 标题不翻，从 body 开始断言）。
    // 「删除数据源」按钮是 DeleteSource 组件（#1037），跳过它的 form 后再断言
    expect(html).toContain('lang="en"');
    const del = html.indexOf('value="delete"');
    const head = html.slice(html.indexOf('<body'), del) + html.slice(html.indexOf('</form>', del) + 8, html.indexOf('bg-white p-6'));
    expect(head).not.toMatch(/[一-鿿]/);
    expect(head).toContain('← Sources');
    expect(head).toMatch(/Registered on \d{1,2}\/\d{1,2}\/\d{4}/);
    expect(head).toContain('Test connection');
    expect(head).toContain('Relist tables and collect');
    // 指标卡：类型走 builtinName、同步表数与「共列出 N 张表」的 ICU 复数
    expect(head).toContain('>Type</div>');
    expect(head).toContain('PostgreSQL');
    expect(head).toContain('>Target</div>');
    expect(head).toContain('>Synced tables</div>');
    expect(head).toContain('4 tables listed');
    expect(head).toContain('>Verification status</div>');
    // 标签页
    expect(head).toContain('Overview');
    expect(head).toContain('Lake data');
    expect(head).toContain('Source views (0)');
  });

  it('连接与同步范围设置没有汉字：配置名、凭据说明、过滤与批量选择、估算行数与已选入（英文日期）', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await engineer.get(`/sources/${sourceId}`)).text());
    // 第一个 section（连接）到同步范围表单结束：这两个分区都归本票
    const end = html.indexOf('</form>', html.indexOf('value="scope"')) + 8;
    const connectAndScope = html.slice(html.indexOf('<section'), end);
    expect(connectAndScope).not.toMatch(/[一-鿿]/);
    expect(connectAndScope).toContain('Connection');
    expect(connectAndScope).toContain('Host</dt>');
    expect(connectAndScope).toContain('Username</dt>');
    expect(connectAndScope).toContain('Credentials');
    expect(connectAndScope).toContain('Stored encrypted; never shown');
    expect(connectAndScope).toContain('Sync scope');
    expect(connectAndScope).toContain('Filter by name');
    expect(connectAndScope).toContain('Select all filtered');
    expect(connectAndScope).toContain('Unselect filtered');
    expect(connectAndScope).toContain('Save sync scope');
    expect(connectAndScope).toContain('Table</th>');
    expect(connectAndScope).toContain('Estimated rows</th>');
    expect(connectAndScope).toContain('Status</th>');
    // 行：估算行数按英文千分位，已选入带选择人与英文日期
    expect(connectAndScope).toContain('data-listed="events"');
    expect(connectAndScope).toContain('~1,500');
    expect(connectAndScope).toMatch(/In scope \(de@acme\.com, \d{1,2}\/\d{1,2}\/\d{4}, [\d:]+ [AP]M\)/);
  });

  it('源表行的同步方式徽标与进湖状态、采集 / 同步状态走 builtinName：英文且属性值不变', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await engineer.get(`/sources/${sourceId}`)).text());
    // 采集状态（未采集 / 任务状态名）与同步状态：完整句式加 builtinName 的状态名
    expect(html).toContain('data-profile-status="succeeded">Collection: Succeeded');
    expect(html).toContain('data-sync-status="succeeded">Succeeded');
    // 同步方式徽标走 builtinName（data-sync-mode 的值不变），进湖状态在 data-in-lake 里是英文
    expect(html).toMatch(/data-table="customers"[^>]*data-sync-mode="watermark"/);
    expect(html).toContain('Watermark incremental');
    expect(html).toMatch(/data-table="events"[^>]*data-sync-mode="full_compare"/);
    expect(html).toContain('Full compare');
    expect(html).toContain('data-in-lake="true">In lake');
    // 同步分区的按钮与长句说明、源端注释分区的标题（明细是 #1037）
    expect(html).toContain('Sync now');
    expect(html).toContain('Latest: submitted at');
    expect(html).toContain('Source comments');
  });

  it('新登记的数据源：有 N 张新表未选（ICU 复数）、空态与「修改与轮换凭据」分区没有汉字', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await freshSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await engineer.get(`/sources/${sourceId}`)).text());
    const scopeForm = scopeFormOf(html);
    expect(scopeForm).not.toMatch(/[一-鿿]/);
    expect(scopeForm).toContain('data-new-tables="4"');
    expect(scopeForm).toContain('4 new tables not selected yet');
    expect(scopeForm).toContain('data-listed="events"');
    // 源表与同步分区的空态、未采集状态
    expect(html).toContain('data-profile-status="none">Collection: Not collected');
    expect(html).toContain('No collected tables in the sync scope yet');
    expect(html).toContain('No sync history yet');
    // 修改与轮换凭据是概览页最后一个分区：从这里到页面结尾没有汉字（SourceFields 在 #1038 已接入）
    const edit = html.slice(html.indexOf('Edit and rotate credentials'));
    expect(edit).not.toMatch(/[一-鿿]/);
    expect(edit).toContain('Validate and save');
  });

  it('action 的「测试连接」成功消息（有、没有不可读的表两条句式）与未知操作 400 是英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await freshSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const ok = await engineer.post(`/sources/${sourceId}`, { intent: 'test' });
    expect(ok.status).toBe(200);
    const okHtml = stripScripts(await ok.text());
    expect(okHtml).toContain('Test connection');
    expect(okHtml).toContain('Connected: 4 tables, account is read-only');
    // 撤掉 events 的 SELECT 后：带不可读表的那条句式（表名连接符走服务端词条「、」）
    await grantOnSource(`REVOKE SELECT ON shop.events FROM ${READER.user}`);
    const partial = await engineer.post(`/sources/${sourceId}`, { intent: 'test' });
    expect(partial.status).toBe(200);
    expect(stripScripts(await partial.text())).toContain('Connected: 3 tables, account is read-only; 1 table cannot be read and cannot be added to the sync scope: events');
    // 未知 intent：400
    const bad = await engineer.request(`/sources/${sourceId}`, { method: 'POST', body: new URLSearchParams({ intent: 'bogus' }) });
    expect(bad.status).toBe(400);
    expect(stripScripts(await bad.text())).toContain('Unknown operation');
  });
});

describe('英文界面：数据源详情页（二）', () => {
  it('概览页子组件没有汉字：同步历史、列统计、水位线、主键与软删除、进湖覆盖范围', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const html = stripScripts(await (await engineer.get(`/sources/${sourceId}`)).text());
    // 进湖覆盖范围（LakeCoverage）：notInLake 原因走 builtinName
    expect(html).toMatch(/data-lake-coverage[^>]*>[^<]*In lake \d+, not in lake \d+[^<]*</);
    expect(html.match(/data-lake-coverage[^>]*>([^<]*)</)![1]).not.toMatch(/[一-鿿]/);
    // 同步历史：从第一个 data-sync-table 到「修改与轮换凭据」之间的整个同步分区（syncModeNote 在源表分区，不在这里）
    const history = html.slice(html.indexOf('data-sync-table='), html.indexOf('Edit and rotate credentials'));
    expect(history).not.toMatch(/[一-鿿]/);
    expect(history).toContain('Batch</th>');
    expect(history).toContain('Mode</th>');
    expect(history).toContain('Rows</th>');
    expect(history).toContain('Started at</th>');
    // 首次同步是全表读取批次，行数带英文千分位，日期是英文格式
    expect(history).toMatch(/data-batch-mode="full"/);
    expect(history).toContain('Full read');
    expect(history).toContain('1,500 (1,500 inserted, 0 updated, 0 deleted)');
    expect(history).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}, [\d:]+ [AP]M/);
    // 列统计：摘要（列数 ICU 复数、样本行数千分位）与表头
    expect(html).toMatch(/Column stats \(\d+ columns, from the first 1,500 rows sampled\)/);
    // 「常见取值」列是数据值（fixture 的城市名是汉字），断言前去掉 data-top 单元格
    const stats = html
      .slice(html.lastIndexOf('<details', html.indexOf('data-column=')), html.indexOf('</details>', html.indexOf('data-column=')))
      .replace(/<td[^>]*data-top="true">[\s\S]*?<\/td>/g, '');
    expect(stats).toContain('Column</th>');
    expect(stats).toContain('Null rate</th>');
    expect(stats).toContain('Cardinality</th>');
    expect(stats).toContain('Format patterns</th>');
    expect(stats).not.toMatch(/[一-鿿]/);
    // 水位线候选（customers 的 updated_at 已确认）与自增主键候选的类别名
    expect(html).toMatch(/data-candidate="updated_at"[^>]*>\s*<span class="font-mono">updated_at<\/span>/);
    expect(html).toContain('Updated At: ');
    expect(html).toContain('Auto-increment primary key: ');
    expect(html).toContain('Confirmed (de@acme.com)');
    // 主键：customers 有源端主键；events 没有主键的整行比对说明与声明入口
    expect(html).toContain('Primary key: customer_id');
    const noKey = html.slice(html.indexOf('data-no-key'), html.indexOf('</div>', html.indexOf('data-no-key')));
    expect(noKey).not.toMatch(/[一-鿿]/);
    expect(html).toContain('Declare a key');
    expect(html).toContain('unique in sample');
    // 业务主键声明的检查按钮（软删除字段 fixture 里没有候选，由中文回归覆盖）
    expect(html).toContain('Check on the whole source table and confirm');
  });

  it('湖中数据标签页：核对摘要、核对明细、覆盖原因与表头是英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    // 触发一次核对并等它跑完（照 sources.test.ts 的 drain 套路）
    const triggered = await engineer.post(`/sources/${sourceId}?tab=lake`, { intent: 'verify' });
    expect(triggered.status).toBe(302);
    await drain();
    const html = stripScripts(await (await engineer.get(`/sources/${sourceId}?tab=lake`)).text());
    // 核对状态（任务状态名走 builtinName）与摘要（差异 0；未进湖的原因也走 builtinName）
    expect(html).toContain('data-verify-status="succeeded">Verification: Succeeded');
    expect(html.match(/data-verify-summary[^>]*>([^<]*)</)![1]).toMatch(/^At the source 4 tables: /);
    expect(html.match(/data-verify-summary[^>]*>([^<]*)</)![1]).not.toMatch(/[一-鿿]/);
    // 表头与每行：覆盖走 builtinName（data-coverage 的值不变）
    expect(html).toContain('Coverage</th>');
    expect(html).toContain('Source rows</th>');
    expect(html).toMatch(/data-verify-table="events"[^>]*data-coverage="in_lake"[\s\S]*?In lake[\s\S]*?data-check="files" data-ok="true"/);
    // 核对明细（VerifyDetail 的「明细」与位置、文件句式）与核对按钮
    expect(html).toContain('>Details</summary>');
    expect(html).toContain('Bronze layer: ');
    expect(html).toContain('Storage prefix: ');
    expect(html).toContain('>Verify</button>');
    // 湖中数据分区整体（长句说明、状态、表格与明细）：从状态徽标到核对表结束没有汉字
    const section = html.slice(html.indexOf('data-verify-status'), html.indexOf('</table>', html.indexOf('data-verify-table')) + 8);
    expect(section).not.toMatch(/[一-鿿]/);
  });

  it('源端注释：COMMENT ON 后重新采集，注释区块的表头与（表注释）是英文', async () => {
    vi.stubEnv('CRM_ENABLE_EN_LOCALE', '1');
    const { sourceId } = await syncedSource();
    await grantOnSource(`COMMENT ON TABLE shop.orders IS 'orders table'; COMMENT ON COLUMN shop.orders.amount IS 'amount'`);
    const engineer = await loginAs(app, 'de@acme.com');
    engineer.store('crm_locale=en; Path=/');
    const refreshed = await engineer.post(`/sources/${sourceId}`, { intent: 'refresh' });
    expect(refreshed.status).toBe(302);
    await drain();
    const html = stripScripts(await (await engineer.get(`/sources/${sourceId}`)).text());
    // 注释分组从「源端注释」标题到同步分区之前；注释原文（orders table、amount）是数据值
    const comments = html.slice(html.indexOf('Source comments'), html.indexOf('data-sync-table='));
    expect(comments).toContain('Column</th>');
    expect(comments).toContain('Text</th>');
    expect(comments).toContain('Version</th>');
    expect(comments).toContain('Collected at</th>');
    expect(comments).toContain('(table comment)');
    expect(comments).not.toMatch(/[一-鿿]/);
    expect(comments).toMatch(/v1</);
    expect(comments).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}, [\d:]+ [AP]M/);
  });
});

describe('中文界面输出与改造前一致', () => {
  it('页头登记时间、估算行数、共列出表数与已选入仍是 zh-CN 格式（2026/11/21 10:30:00、约 1,500）', async () => {
    const { sourceId } = await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    const html = await (await engineer.get(`/sources/${sourceId}`)).text();
    expect(html).toMatch(/登记于 \d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}/);
    expect(html).toContain('约 1,500');
    // 源表行的行数（events 采集到 1500 行）也按 zh-CN 千分位
    expect(html).toContain('>1,500</td>');
    expect(html).toContain('共列出 4 张表');
    expect(html).toContain('采集成功');
    expect(html).toMatch(/已选入（de@acme\.com，\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}）/);
  });

  it('子组件的中文句式与 zh-CN 数字 / 日期格式不变（#1037 的区域）：同步历史、列统计、覆盖范围、水位线与主键', async () => {
    const { sourceId } = await syncedSource();
    const engineer = await loginAs(app, 'de@acme.com');
    const html = await (await engineer.get(`/sources/${sourceId}`)).text();
    // 同步历史：行数千分位、增删改句式、zh-CN 日期时间
    expect(html).toContain('1,500（新增 1,500，更新 0，删除 0）');
    expect(html).toMatch(/data-batch-mode="full"/);
    expect(html).toContain('全表读取');
    expect(html).toMatch(/<td[^>]*>\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}<\/td>/);
    // 列统计摘要（events 采样到 1500 行）：列数与千分位
    expect(html).toMatch(/列统计（\d+ 列，基于前 1,500 行样本）/);
    // 进湖覆盖范围与水位线已确认、主键句式
    expect(html).toMatch(/已进湖 \d 张，未进湖 \d 张/);
    expect(html).toContain('已确认（de@acme.com）');
    expect(html).toContain('主键：customer_id');
    // events 没有主键：整行比对的中文说明还在
    expect(html).toContain('没有主键：按整行比对，完全相同的重复行按出现次数计，修改记为一删一增');
  });
});
