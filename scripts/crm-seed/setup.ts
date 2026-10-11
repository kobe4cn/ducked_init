// scripts/crm-seed/setup.ts —— 冒烟用：不经界面，用界面背后的同一批领域函数把一个租户从零配到能出指标与标签（plan 的 T1–T4，跳过 K1 / K2 等故意出错的步骤），
// 跑完后用 verify.ts 核对。手工测试照 README 在界面上做，这个脚本只用来确认造数、映射与定义本身没有问题，以及记下规模档各步的耗时。
// 用法：node --env-file=.env --import tsx scripts/crm-seed/setup.ts --tenant crmlab-smoke [--step sources,mappings,definitions] [--set 10m]
//   另有两步不在默认里：sync（重新同步全部数据源，平台随后自动合并）、recompute（以今天为 asOf 重算全部指标与标签，#143 之前的临时办法）
//   租户不存在时创建（成员 admin@ / eng@ / an@<租户>.test），配额设成 16 线程 / 64 GB；已有的数据源、映射、定义按名字跳过。
//   调度器在本进程里跑（maxWorkers 4），不要同时开 pnpm dispatcher
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DuckDBInstance } from '@duckdb/node-api';
import { and, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { closeDb, getDb } from '../../app/.server/db/client';
import { tasks, tenants } from '../../app/.server/db/schema';
import { createCustomEntity, listCustomEntities, publishCustomEntity } from '../../app/.server/custom-entities';
import { createDefinition, getDefinition, publishDefinition } from '../../app/.server/dsl-definitions';
import { createMapping, mergeNow, publishMapping } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { type KeyCheckTaskParams, type KeyCheckTaskResult } from '../../app/.server/source-key-check';
import { syncSource } from '../../app/.server/source-sync';
import { createSourceView, listSourceViews, publishSourceView } from '../../app/.server/source-views';
import { confirmKey, confirmSoftDelete, confirmedTables, confirmWatermark, getSource, listSources, registerSource, setSyncScope, updateSource } from '../../app/.server/sources';
import { createTenant, tenantIdBySlug } from '../../app/.server/tenants';
import { duplicateKeyText } from '../../app/lib/sources';
import { memberOf } from '../../test/pipeline/fixtures';
import { ENTITIES } from './check-mappings';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: { tenant: { type: 'string' }, step: { type: 'string' }, set: { type: 'string', default: '' } } });
/** 数据集（seed.ts --set）：规模档的库、schema 加后缀，S3 前缀多一级 */
const SET = args.set!, SUFFIX = SET ? `_${SET}` : '';
const slug = args.tenant;
if (!slug) throw new Error('用法：setup.ts --tenant <租户> [--step sources,mappings,definitions,sync,recompute]');
const step = (name: string) => (!args.step ? ['sources', 'mappings', 'definitions'] : args.step.split(',')).includes(name);
const started = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - started) / 60000).toFixed(1).padStart(5)} 分] ${msg}`);
/** 跑空任务队列，返回耗时（秒） */
async function drain(what: string) {
  const t = Date.now();
  await createDispatcher({ maxWorkers: 4 }).runUntilIdle();
  // 外面若另开着 pnpm dispatcher，它领走的任务还在跑：等到本租户没有排队或运行中的任务
  for (;;) {
    const [{ n }] = await getDb().select({ n: count() }).from(tasks)
      .where(and(eq(tasks.tenantId, tenantId!), inArray(tasks.status, ['queued', 'running'])));
    if (!n) break;
    await new Promise(r => setTimeout(r, 2000));
    await createDispatcher({ maxWorkers: 4 }).runUntilIdle();
  }
  const failed = await getDb().select({ kind: tasks.kind, error: tasks.error }).from(tasks)
    .where(and(eq(tasks.tenantId, tenantId!), eq(tasks.status, 'failed'), gt(tasks.createdAt, new Date(t))));
  for (const f of failed) log(`  ✘ 任务 ${f.kind} 失败：${String(f.error).slice(0, 500)}`);
  log(`${what}：任务跑完，用时 ${((Date.now() - t) / 1000).toFixed(0)} 秒`);
}

/** 记下 since 之后提交的业务主键检查：每张表的结果与耗时，没通过的列出空值行数与重复键 */
async function logKeyChecks(since: Date) {
  const checks = await getDb().select().from(tasks)
    .where(and(eq(tasks.tenantId, tenantId!), eq(tasks.kind, 'source.keycheck'), gt(tasks.createdAt, since)))
    .orderBy(tasks.createdAt);
  for (const t of checks) {
    const { tableName, keyColumns } = t.params as unknown as KeyCheckTaskParams;
    const secs = t.startedAt && t.finishedAt ? `${((t.finishedAt.getTime() - t.startedAt.getTime()) / 1000).toFixed(0)} 秒` : '—';
    const result = t.result as KeyCheckTaskResult | null;
    if (result?.ok) { log(`${tableName} 业务主键 ${keyColumns.join('、')} 检查通过，用时 ${secs}`); continue; }
    const why = result
      ? `空值 ${result.nullRows} 行；${result.duplicates.map(d => duplicateKeyText(keyColumns, d)).join('；') || '没有重复'}`
      : `检查出错：${String(t.error).slice(0, 500)}`;
    log(`  ✘ ${tableName} 业务主键 ${keyColumns.join('、')} 检查不通过（用时 ${secs}），按整行全量比对：${why}`);
  }
}

// ---------- 租户与成员 ----------
let tenantId: string | null = await tenantIdBySlug(slug).catch(() => null);
if (!tenantId) {
  ({ tenant: { id: tenantId } } = await createTenant({ slug, name: `简衣 ${slug}`, adminEmail: `admin@${slug}.test` }));
  log(`创建了租户 ${slug}`);
}
await getDb().update(tenants).set({ threads: 16, memoryLimitMb: 65536, maxConcurrentTasks: 4 }).where(eq(tenants.id, tenantId!));
const admin = await memberOf(tenantId!, `admin@${slug}.test`, 'admin');
const eng = await memberOf(tenantId!, `eng@${slug}.test`, 'data_engineer');
const an = await memberOf(tenantId!, `an@${slug}.test`, 'analyst');

// ---------- T1 数据源 ----------
const creds = readFileSync(join(HERE, 'out', 'credentials.txt'), 'utf8');
const s3Key = /Access Key (\S+)/.exec(creds)![1]!, s3Secret = /Secret (\S+)/.exec(creds)![1]!;
const s3 = { endpoint: /端点 (\S+)/.exec(creds)![1]!, region: /区域 (\S+)/.exec(creds)![1]!, urlStyle: 'path', useSsl: 'false', keyId: s3Key, secret: s3Secret };
const PREFIX = `s3://crm-source/crm${SET ? `/${SET}` : ''}`;
const pg = (schema: string) => ({ kind: 'postgres', host: 'localhost', port: '5432', database: 'crm', schema: `${schema}${SUFFIX}`, user: 'crmlab_reader', password: 'crmlab-reader-secret' });
const SOURCES: Record<string, Record<string, string>> = {
  pos_mysql: { kind: 'mysql', host: 'localhost', port: '3306', database: `crm_pos${SUFFIX}`, user: 'crmlab_reader', password: 'crmlab-reader-secret' },
  mall_pg: pg('crm_mall'),
  loyalty_pg: pg('crm_loyalty'),
  tmall_s3: { kind: 's3', path: `${PREFIX}/tmall/`, format: 'parquet', ...s3 },
  douyin_s3: { kind: 's3', path: `${PREFIX}/douyin/`, format: 'csv', ...s3 },
  events_s3: { kind: 's3', path: `${PREFIX}/events/`, format: await eventsFormat(), ...s3 },
  activity_s3: { kind: 's3', path: `${PREFIX}/activity/`, format: 'csv', ...s3 },
  wecom_duckdb: { kind: 'duckdb', path: `${PREFIX}/wecom/wecom.duckdb`, ...s3 },
};
/** 埋点的格式跟着造数的规模走（与 seed.ts 的 EVENTS_FORMAT 相同：百万人以上是 Parquet），从真值里的人数判断 */
async function eventsFormat() {
  const con = await (await DuckDBInstance.create(join(HERE, 'out', SET, 'truth.duckdb'), { access_mode: 'READ_ONLY' })).connect();
  const [row] = (await con.runAndReadAll('SELECT persons FROM meta')).getRowObjectsJson() as { persons: number }[];
  con.closeSync();
  return Number(row!.persons) >= 1_000_000 ? 'parquet' : 'json';
}
/** 文件类的表没有主键：声明业务主键（全量比对按它找出变更与删除） */
const KEYS: Record<string, Record<string, string[]>> = {
  tmall_s3: { buyers: ['buyer_id'], trades: ['tid'] },
  douyin_s3: { dy_orders: ['订单编号'] },
  events_s3: { events: ['event_id'], users: ['user_id'] },
  activity_s3: { signups: ['报名编号'] },
  wecom_duckdb: { contacts: ['external_userid'], chats: ['chat_id'], mass_sends: ['send_id'] },
};
/** 水位线：优先这些列，否则取第一个候选 */
const PREFERRED_WATERMARK = /^(updated_at|update_time|modified_ms|更新时间)$/;

const sourceIds = new Map((await listSources(eng)).map(s => [s.name, s.id]));
if (step('sources')) {
  for (const [name, input] of Object.entries(SOURCES)) {
    // 已登记的：按 credentials.txt 更新连接（seed.ts 换过 S3 密钥时）
    if (sourceIds.has(name)) { await updateSource(eng, sourceIds.get(name)!, { name, ...input }); continue; }
    const { id } = await registerSource(eng, { name, ...input });
    sourceIds.set(name, id);
    const { listing } = await getSource(eng, id);
    await setSyncScope(eng, id, { add: listing.filter(t => t.readable && !t.gone).map(t => t.name) });
    log(`登记 ${name}，选了 ${listing.length} 张表`);
  }
  await drain('采集');
  const keysFrom = new Date();
  for (const name of Object.keys(SOURCES)) {
    const id = sourceIds.get(name)!;
    const { tables } = await confirmedTables(tenantId!, id);
    for (const { table, watermark, key } of tables) {
      if (!watermark && table.watermarkCandidates.length) {
        const pick = table.watermarkCandidates.find(c => PREFERRED_WATERMARK.test(c.column)) ?? table.watermarkCandidates[0]!;
        await confirmWatermark(eng, id, table.name, pick.column);
        log(`${name}.${table.name} 水位线 ${pick.column}（${pick.kind}）`);
      }
      const k = KEYS[name]?.[table.name];
      // 声明只入队一次全表检查（source.keycheck），通过后才生效
      if (k && !key && !table.primaryKey?.length) {
        await confirmKey(eng, id, table.name, k).then(() => log(`${name}.${table.name} 业务主键 ${k.join('、')}：已提交全表检查`),
          (e: Error) => log(`  ✘ ${name}.${table.name} 声明业务主键失败：${e.message.split('\n')[0]}`));
      }
    }
    if (name === 'pos_mysql') await confirmSoftDelete(eng, id, 'sales', 'is_void');
  }
  // 等业务主键检查都结束再首次同步：没通过的表按整行全量比对
  await drain('业务主键检查');
  await logKeyChecks(keysFrom);
  for (const name of Object.keys(SOURCES)) await syncSource(eng, sourceIds.get(name)!);
  await drain('首次同步');
}

// ---------- T2 映射（K2 的 oms 映射不发布） ----------
/** 已发布的映射文件记在 out/setup-<租户>.json，重跑时跳过（同一张表可能有几个同实体的映射，按表与实体认不出来） */
const STATE = join(HERE, 'out', `setup-${slug}.json`);
const published: string[] = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : [];
async function publishAll(files: string[]) {
  for (const file of files) {
    if (published.includes(file)) continue;
    const [source] = file.split('.');
    const mapping = await createMapping(eng, sourceIds.get(source!)!, readFileSync(join(HERE, 'mappings', file), 'utf8'));
    await publishMapping(admin, mapping.id, 1);
    published.push(file);
    writeFileSync(STATE, JSON.stringify(published, null, 2));
    log(`发布映射 ${file}`);
  }
}
if (step('mappings')) {
  // 源视图先发布（views/<数据源>.<视图>.sql）
  for (const file of readdirSync(join(HERE, 'views')).filter(f => f.endsWith('.sql')).sort()) {
    const [source, name] = file.split('.') as [string, string];
    const id = sourceIds.get(source)!;
    if ((await listSourceViews(eng, id)).views.some(v => v.name === name)) continue;
    const viewId = await createSourceView(eng, id, { name, sql: readFileSync(join(HERE, 'views', file), 'utf8') });
    await publishSourceView(admin, id, viewId, 1);
    log(`发布源视图 ${source}.${name}`);
  }
  const files = readdirSync(join(HERE, 'mappings')).filter(f => f.endsWith('.yaml') && !f.includes('.k2.')).sort();
  const custom = (f: string) => f.includes('.custom_');
  // 先发标准实体（订单在明细前），再登记自定义实体（关系要用到已发布映射里的字段类型），最后发自定义实体的映射
  const rank = (f: string) => (f.includes('.order.') ? 0 : f.includes('.order_item.') ? 2 : 1);
  await publishAll(files.filter(f => !custom(f)).sort((a, b) => rank(a) - rank(b)));
  await drain('标准实体合并');
  const registered = new Set((await listCustomEntities(eng)).map(e => e.name));
  const LABELS: Record<string, string> = { custom_region: '区域', custom_store: '门店', custom_guide: '导购' };
  for (const name of ['custom_region', 'custom_store', 'custom_guide']) {
    if (registered.has(name)) continue;
    const e = ENTITIES.get(name)!;
    const id = await createCustomEntity(eng, {
      name, label: LABELS[name]!, kind: 'dimension', primaryKey: [...e.primaryKey], relations: e.relations ? [...e.relations] : [],
      fields: e.fields.map(f => ({ ...f, description: '' })),
    });
    await publishCustomEntity(admin, id, 1);
    log(`登记并发布自定义实体 ${name}`);
  }
  await publishAll(files.filter(custom));
  await drain('自定义实体合并');
}

// ---------- T3 / T4 指标与标签 ----------
if (step('definitions')) {
  for (const kind of ['metric', 'tag']) {
    for (const file of readdirSync(join(HERE, 'definitions', kind)).filter(f => f.endsWith('.yaml')).sort()) {
      const key = file.replace(/\.yaml$/, '');
      if (await getDefinition(an, kind, key).then(() => true, () => false)) continue;
      await createDefinition(an, kind, key, readFileSync(join(HERE, 'definitions', kind, file), 'utf8'));
      await publishDefinition(admin, kind, key, 1);
      log(`发布${kind === 'metric' ? '指标' : '标签'} ${key}`);
    }
    await drain(kind === 'metric' ? '指标计算' : '标签计算');
  }
}
// ---------- 重新同步（数据源的数据变了，或数据湖被 lake:reset 清空后；同步完平台自动合并） ----------
if (step('sync')) {
  for (const [name, input] of Object.entries(SOURCES)) await updateSource(eng, sourceIds.get(name)!, { name, ...input });
  for (const name of Object.keys(SOURCES)) await syncSource(eng, sourceIds.get(name)!);
  await drain('同步与合并');
  // 一次合并运行时结束的同步不会再入队合并（等定时检查补上）：这里直接「立即合并」全部已发布映射
  await mergeNow(eng);
  await drain('立即合并');
}

// ---------- 重算指标与标签：标准层变了以后，结果层不会自己更新（#143），按各定义最近一次计算的参数、以今天为 asOf 再入队一次 ----------
if (step('recompute')) {
  const last = await getDb().selectDistinctOn([sql`${tasks.params}->>'kind'`, sql`${tasks.params}->>'key'`], { params: tasks.params }).from(tasks)
    .where(and(eq(tasks.tenantId, tenantId!), eq(tasks.kind, 'gold.dsl')))
    .orderBy(sql`${tasks.params}->>'kind'`, sql`${tasks.params}->>'key'`, desc(tasks.createdAt));
  const asOf = new Date().toISOString().slice(0, 10);
  for (const { params } of last) await getDb().insert(tasks).values({ tenantId: tenantId!, kind: 'gold.dsl', params: { ...params, asOf } });
  log(`重新入队 ${last.length} 个指标与标签（asOf ${asOf}）`);
  await drain('指标与标签计算');
}
log(`完成。核对：node --env-file=.env --import tsx scripts/crm-seed/verify.ts ${slug}`);
await closeDb();
