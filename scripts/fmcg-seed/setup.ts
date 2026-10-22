// scripts/fmcg-seed/setup.ts —— 冒烟用：不经界面，用界面背后的同一批领域函数把一个租户从零配到能出指标与标签（plan 的 T1–T5），跑完后用 verify.ts 核对。
// 手工测试照 README 在界面上做，这个脚本只用来确认造数、映射与定义本身没有问题。故意出错再改正的步骤（K1 不写键空间、P04 不去占位号等）这里直接用最终的写法；
// 只有合并组是先发映射再建组：组员要先发布才能建组，所以同一批订单、商品的第二个映射第一次合并会按独占失败（日志里标为「预期」），建组后重建通过。
// 用法：node --env-file=.env --import tsx scripts/fmcg-seed/setup.ts --tenant fmcglab-smoke [--step sources,mappings,definitions] [--set 10m]
//   另有两步不在默认里：sync（重新同步全部数据源、合并，再重算指标与标签；第二轮造数之后用）、recompute（以今天为 asOf 重新计算全部指标与下游标签）
//   租户不存在时创建（成员 admin@ / eng@ / an@<租户>.test），配额设成 16 线程 / 64 GB / 并发 4；已有的数据源、映射、定义、合并组跳过。
//   调度器在本进程里跑（maxWorkers 4）；外面另开着 pnpm dispatcher 也行，会等本租户的任务都结束
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { and, count, eq, gt, inArray } from 'drizzle-orm';
import { closeDb, getDb } from '../../app/.server/db/client';
import { tasks, tenants } from '../../app/.server/db/schema';
import { createCustomEntity, listCustomEntities, publishCustomEntity } from '../../app/.server/custom-entities';
import { createDefinition, getDefinition, publishDefinition, recomputeDefinition } from '../../app/.server/dsl-definitions';
import { createMapping, mergeNow, publishMapping, saveDraft } from '../../app/.server/mappings';
import { listMergeGroups, publishMergeGroup, saveMergeGroupDraft, type MergeRule } from '../../app/.server/merge-groups';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { TEMPLATES } from '../../app/.server/pipeline/templates';
import { enqueueDueRefreshes } from '../../app/.server/refresh';
import { syncSource } from '../../app/.server/source-sync';
import { createSourceView, listSourceViews, publishSourceView } from '../../app/.server/source-views';
import { confirmKey, confirmedTables, confirmWatermark, getSource, listSources, registerSource, setSyncScope, updateSource } from '../../app/.server/sources';
import { recomputeTemplate } from '../../app/.server/templates';
import { createTenant, tenantIdBySlug } from '../../app/.server/tenants';
import { memberOf } from '../../test/pipeline/fixtures';
import { ENTITIES } from './check-mappings';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: { tenant: { type: 'string' }, step: { type: 'string' }, set: { type: 'string', default: '' } } });
const SET = args.set!, SUFFIX = SET ? `_${SET}` : '';
const slug = args.tenant;
if (!slug) throw new Error('用法：setup.ts --tenant <租户> [--step sources,mappings,definitions,sync,recompute]');
const step = (name: string) => (!args.step ? ['sources', 'mappings', 'definitions'] : args.step.split(',')).includes(name);
const started = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - started) / 60000).toFixed(1).padStart(5)} 分] ${msg}`);

/** 跑空任务队列（外面另开着调度器时等本租户没有排队或运行中的任务），列出这期间失败的任务 */
async function drain(what: string, expectedFailure?: (error: string) => boolean) {
  const t = Date.now();
  for (;;) {
    await createDispatcher({ maxWorkers: 4 }).runUntilIdle();
    const [{ n }] = await getDb().select({ n: count() }).from(tasks)
      .where(and(eq(tasks.tenantId, tenantId!), inArray(tasks.status, ['queued', 'running'])));
    if (!n) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  const failed = await getDb().select({ kind: tasks.kind, error: tasks.error }).from(tasks)
    .where(and(eq(tasks.tenantId, tenantId!), eq(tasks.status, 'failed'), gt(tasks.createdAt, new Date(t))));
  for (const f of failed) {
    const error = String(f.error);
    log(`  ${expectedFailure?.(error) ? '（预期）' : '✘'} 任务 ${f.kind} 失败：${error.slice(0, 300)}`);
  }
  log(`${what}：任务跑完，用时 ${((Date.now() - t) / 1000).toFixed(0)} 秒`);
}

// ---------- 租户与成员 ----------
let tenantId: string | null = await tenantIdBySlug(slug).catch(() => null);
if (!tenantId) {
  ({ tenant: { id: tenantId } } = await createTenant({ slug, name: `禾川乳业 ${slug}`, adminEmail: `admin@${slug}.test` }));
  log(`创建了租户 ${slug}`);
}
await getDb().update(tenants).set({ threads: 16, memoryLimitMb: 65536, maxConcurrentTasks: 4 }).where(eq(tenants.id, tenantId!));
const admin = await memberOf(tenantId!, `admin@${slug}.test`, 'admin');
const eng = await memberOf(tenantId!, `eng@${slug}.test`, 'data_engineer');
const an = await memberOf(tenantId!, `an@${slug}.test`, 'analyst');

// ---------- T1 数据源 ----------
const creds = readFileSync(join(HERE, 'out', 'credentials.txt'), 'utf8');
const s3 = { endpoint: /端点 (\S+)/.exec(creds)![1]!, region: /区域 (\S+)/.exec(creds)![1]!, urlStyle: 'path', useSsl: 'false',
  keyId: /Access Key (\S+)/.exec(creds)![1]!, secret: /Secret (\S+)/.exec(creds)![1]! };
const PREFIX = `s3://crm-source/fmcg${SET ? `/${SET}` : ''}`;
const USER = 'fmcglab_reader', PASSWORD = 'fmcglab-reader-secret';
const pg = (schema: string) => ({ kind: 'postgres', host: 'localhost', port: '5432', database: 'crm', schema: `${schema}${SUFFIX}`, user: USER, password: PASSWORD });
const my = (db: string) => ({ kind: 'mysql', host: 'localhost', port: '3306', database: `${db}${SUFFIX}`, user: USER, password: PASSWORD });
const file = (dir: string, format: string) => ({ kind: 's3', path: `${PREFIX}/${dir}/`, format, ...s3 });
const SOURCES: Record<string, Record<string, string>> = {
  member_pg: pg('fmcg_member'),
  mall_pg: pg('fmcg_mall'),
  scan_mysql: my('fmcg_scan'),
  station_mysql: my('fmcg_station'),
  erp_mysql: my('fmcg_erp'),
  oms_mongo: { kind: 'mongodb', host: 'localhost', port: '27017', database: `fmcg_oms${SUFFIX}`, authSource: 'admin', user: 'fmcglab_ro', password: 'fmcglab-ro-secret' },
  tmall_s3: file('tmall', 'parquet'),
  jd_s3: file('jd', 'csv'),
  douyin_s3: file('douyin', 'csv'),
  events_s3: file('events', SET ? 'parquet' : 'json'),
  activity_s3: file('activity', 'csv'),
  sellout_s3: file('sellout', 'csv'),
  wecom_duckdb: { kind: 'duckdb', path: `${PREFIX}/wecom/wecom.duckdb`, ...s3 },
};
/** 文件类的表没有主键：声明业务主键（全量比对按它找出变更与删除） */
const KEYS: Record<string, Record<string, string[]>> = {
  tmall_s3: { buyers: ['ouid'], trades: ['tid'], trade_items: ['oid'] },
  jd_s3: { jd_orders: ['订单号'], jd_items: ['订单号', '京东SKU'], sku_map: ['京东SKU'] },
  douyin_s3: { dy_orders: ['子订单编号'] },
  events_s3: { events: ['event_id'] },
  activity_s3: { signups: ['报名编号'] },
  sellout_s3: { ka_stores: ['门店编码'], sellout: ['周', '门店编码', '商家编码'] },
  wecom_duckdb: { contacts: ['external_userid'], groups: ['group_id'], group_members: ['group_id', 'external_userid'], mass_sends: ['send_id'] },
};
/** 水位线：按这个顺序优先，否则取第一个候选（扫码流水、积分流水、码表只追加，用 created_at） */
const PREFERRED_WATERMARK = ['updated_at', 'update_time', 'modified', 'modified_ms', '更新时间', 'created_at'];

const sourceIds = new Map((await listSources(eng)).map(s => [s.name, s.id]));
if (step('sources')) {
  for (const [name, input] of Object.entries(SOURCES)) {
    if (sourceIds.has(name)) { await updateSource(eng, sourceIds.get(name)!, { name, ...input }); continue; }
    const { id } = await registerSource(eng, { name, ...input });
    sourceIds.set(name, id);
    const { listing } = await getSource(eng, id);
    await setSyncScope(eng, id, { add: listing.filter(t => t.readable && !t.gone).map(t => t.name) });
    log(`登记 ${name}，选了 ${listing.length} 张表`);
  }
  await drain('采集');
  for (const name of Object.keys(SOURCES)) {
    const id = sourceIds.get(name)!;
    const { tables } = await confirmedTables(tenantId!, id);
    for (const { table, watermark, key } of tables) {
      if (!watermark && table.watermarkCandidates.length) {
        const pick = PREFERRED_WATERMARK.map(c => table.watermarkCandidates.find(x => x.column === c)).find(Boolean) ?? table.watermarkCandidates[0]!;
        await confirmWatermark(eng, id, table.name, pick.column);
        log(`${name}.${table.name} 水位线 ${pick.column}（${pick.kind}）`);
      }
      const k = KEYS[name]?.[table.name];
      if (k && !key && !table.primaryKey?.length) {
        await confirmKey(eng, id, table.name, k).then(() => log(`${name}.${table.name} 业务主键 ${k.join('、')}：已提交全表检查`),
          (e: Error) => log(`  ✘ ${name}.${table.name} 声明业务主键失败：${e.message.split('\n')[0]}`));
      }
    }
  }
  await drain('业务主键检查');
  for (const name of Object.keys(SOURCES)) await syncSource(eng, sourceIds.get(name)!);
  await drain('首次同步');
}

// ---------- T2–T4 源视图、映射、合并组、自定义实体 ----------
/**
 * 已发布的映射文件 → 映射 ID 与发布时的内容，记在 out/setup-<租户>.json（同一张表可能有几个映射，按表与实体认不出来）：
 * 重跑时内容没变的跳过，改过的起草并发布新的一版
 */
const STATE = join(HERE, 'out', `setup-${slug}.json`);
const published: Record<string, { id: string; yaml: string }> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
async function publishAll(files: string[]) {
  for (const f of files) {
    const yaml = readFileSync(join(HERE, 'mappings', f), 'utf8');
    const done = published[f];
    if (done?.yaml === yaml) continue;
    if (done) {
      const version = await saveDraft(eng, done.id, yaml);
      await publishMapping(admin, done.id, version);
      published[f] = { id: done.id, yaml };
      log(`发布映射 ${f} 第 ${version} 版`);
    } else {
      const mapping = await createMapping(eng, sourceIds.get(f.split('.')[0]!)!, yaml);
      await publishMapping(admin, mapping.id, 1);
      published[f] = { id: mapping.id, yaml };
      log(`发布映射 ${f}`);
    }
    writeFileSync(STATE, JSON.stringify(published, null, 2));
  }
}
/** 合并组（ADR-0032）：组员按优先级排列，eng 起草、admin 发布 */
const GROUPS: { entity: string; members: string[]; rule: MergeRule }[] = [
  {
    entity: 'order', rule: { kind: 'latest', field: 'updated_at' },
    members: ['tmall_s3.trades.order.yaml', 'jd_s3.jd_orders.order.yaml', 'douyin_s3.dy_orders.order.yaml',
      'oms_mongo.oms_tmall.order.yaml', 'oms_mongo.oms_jd.order.yaml', 'oms_mongo.oms_douyin.order.yaml'],
  },
  { entity: 'product', rule: { kind: 'coalesce' }, members: ['erp_mysql.products.product.yaml', 'scan_mysql.sku_points.product.yaml'] },
];
/** 一次合并运行时发布的映射不会再入队合并（等定时检查补上）：一批发完后「立即合并」全部已发布映射，补上漏掉的 */
async function mergeAll() {
  await mergeNow(eng);
  await drain('立即合并');
}
/** 指标与标签按定时刷新的规则重算（ADR-0028：依赖的实体在上次计算之后有合并改了数据） */
async function refresh() {
  await enqueueDueRefreshes();
  await drain('定时刷新');
}
/** 定时刷新每个定义每天最多一张快照（ADR-0028）：同一天里数据又变了，用定义页的「重新计算」（指标连同下游标签；平台自动启用的分析模板也算一遍） */
async function recompute() {
  for (const id of Object.keys(TEMPLATES)) await recomputeTemplate(admin, id).catch((e: Error) => log(`  （跳过）模板 ${id}：${e.message}`));
  for (const f of readdirSync(join(HERE, 'definitions', 'metric')).filter(x => x.endsWith('.yaml')).sort()) {
    const key = f.replace(/\.yaml$/, '');
    // 几个指标共用一个下游标签（如 scan_no_buy）时，前一个指标带着它入队了，后一个要等它算完
    await recomputeDefinition(eng, 'metric', key).catch(async () => {
      await drain(`等 ${key} 的下游标签算完`);
      await recomputeDefinition(eng, 'metric', key).catch((e: Error) => log(`  ✘ 重新计算 ${key}：${e.message}`));
    });
  }
  await drain('重新计算');
}
/** 同一批对象的第二个映射在建组之前合并会被独占挡住 */
const exclusive = (error: string) => /已被|占用|独占|冲突/.test(error);
if (step('mappings')) {
  for (const f of readdirSync(join(HERE, 'views')).filter(x => x.endsWith('.sql')).sort()) {
    const [source, name] = f.split('.') as [string, string];
    const id = sourceIds.get(source)!;
    if ((await listSourceViews(eng, id)).views.some(v => v.name === name)) continue;
    const viewId = await createSourceView(eng, id, { name, sql: readFileSync(join(HERE, 'views', f), 'utf8') });
    await publishSourceView(admin, id, viewId, 1);
    log(`发布源视图 ${source}.${name}`);
  }
  const files = readdirSync(join(HERE, 'mappings')).filter(f => f.endsWith('.yaml')).sort();
  const custom = (f: string) => f.split('.')[2]!.startsWith('custom_');
  // 消费者最先（订单、事件、周期购跨源引用会员中心与各平台的消费者），订单在明细前，自定义实体最后（关系要用到已发布映射里的字段类型）
  const ORDER = ['customer', 'order', '', 'order_item'];
  const rank = (f: string) => { const i = ORDER.indexOf(f.split('.')[2]!); return i < 0 ? ORDER.indexOf('') : i; };
  await publishAll(files.filter(f => !custom(f)).sort((a, b) => rank(a) - rank(b)));
  // 合并在运行时不能发布合并组：先跑完这一批合并
  await drain('标准实体合并', exclusive);
  const groups = new Map((await listMergeGroups(eng)).map(g => [g.entity, g]));
  for (const g of GROUPS) {
    if (groups.get(g.entity)?.versions.some(v => v.status === 'published')) continue;
    const version = await saveMergeGroupDraft(eng, g.entity, { members: g.members.map(f => published[f]!.id), rule: g.rule });
    await publishMergeGroup(admin, g.entity, version);
    log(`发布合并组 ${g.entity}（${g.rule.kind}）：${g.members.join('、')}`);
  }
  await drain('合并组重建');
  await mergeAll();
  const registered = new Set((await listCustomEntities(eng)).map(e => e.name));
  for (const [name, e] of ENTITIES) {
    if (registered.has(name)) continue;
    const id = await createCustomEntity(eng, {
      name, label: e.label, kind: e.kind, primaryKey: [...e.primaryKey], relations: e.relations ? [...e.relations] : [],
      fields: e.fields.map(f => ({ ...f, description: '' })),
    });
    await publishCustomEntity(admin, id, 1);
    log(`登记并发布自定义实体 ${name}`);
  }
  await publishAll(files.filter(custom));
  await drain('自定义实体合并');
  await mergeAll();
}

// ---------- T5 指标与标签 ----------
if (step('definitions')) {
  for (const kind of ['metric', 'tag']) {
    for (const f of readdirSync(join(HERE, 'definitions', kind)).filter(x => x.endsWith('.yaml')).sort()) {
      const key = f.replace(/\.yaml$/, '');
      if (await getDefinition(an, kind, key).then(() => true, () => false)) continue;
      await createDefinition(an, kind, key, readFileSync(join(HERE, 'definitions', kind, f), 'utf8'));
      await publishDefinition(eng, kind, key, 1);
      log(`发布${kind === 'metric' ? '指标' : '标签'} ${key}`);
    }
    await drain(kind === 'metric' ? '指标计算' : '标签计算');
  }
  await refresh();
}

// ---------- 重新同步（第二轮造数之后，或数据湖被 lake:reset 清空后；同步完平台自动合并，定时刷新随后重算指标与标签） ----------
if (step('sync')) {
  for (const [name, input] of Object.entries(SOURCES)) await updateSource(eng, sourceIds.get(name)!, { name, ...input });
  for (const name of Object.keys(SOURCES)) await syncSource(eng, sourceIds.get(name)!);
  await drain('同步与合并');
  await mergeAll();
  await refresh();
  await recompute();
}
if (step('recompute')) await recompute();
log(`完成。核对：node --env-file=.env --import tsx scripts/fmcg-seed/verify.ts ${slug}`);
await closeDb();
