// scripts/isolab/setup.ts —— 验收计划（docs/test-plans/acceptance-plan.md）的 C 租户 isolab：边界与运营用例的准备与核对。
// C 只有两个数据源：
//   mall_pg     —— 与 B（crmlab）同一上游、同一只读账号（库 crm、schema crm_mall、crmlab_reader），只映射 users → customer，用来比租户盐与统一消费者 ID（ISO-3）
//   scratch_pg  —— C 自己的一份消费者表（schema iso_scratch，账号 isolab_reader），可以随便改：删列、改密码、删数据源（SRC-3、SRC-10、GOV-4），不碰 B 的上游
// 用法：node --env-file=.env --import tsx scripts/isolab/setup.ts [--tenant isolab] [--step prepare,tenant,sources,mappings] [--with crmlab]
//   prepare   建 iso_scratch.members（从 crm_mall.users 取前 2000 人）与只读账号 isolab_reader；可重复跑（先删后建），要求 crm-seed 已造数
//   tenant    建租户（成员 admin@ / eng@ / an@ / view@<租户>.test），配额保持默认（ISO-8 要在页面上改小）
//   sources   登记两个数据源、选全部表、确认水位线 updated_at、首次同步
//   mappings  发布 mall_pg.users → customer（crm-seed 的同一份 YAML）与 scratch_pg.members → customer
//   compare   不在默认里：拿 C 与 --with 租户（默认 crmlab）的 mall_pg 消费者逐个比，期望同一个 customer_id 的手机哈希、统一消费者 ID 一个都不相同
//   调度器在本进程里跑（maxWorkers 2）；外面开着 pnpm dispatcher 也可以，会等本租户的任务跑完
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { and, count, eq, gt, inArray, isNull } from 'drizzle-orm';
import { closeDb, getDb } from '../../app/.server/db/client';
import { sources, tasks } from '../../app/.server/db/schema';
import { lakeReady, lakeRow, lakeSpecOf } from '../../app/.server/lake';
import { createMapping, listMappings, publishMapping } from '../../app/.server/mappings';
import { createDispatcher } from '../../app/.server/pipeline/dispatcher';
import { openTenantLake } from '../../app/.server/pipeline/lake-engine';
import { syncSource } from '../../app/.server/source-sync';
import { confirmedTables, confirmWatermark, getSource, listSources, registerSource, setSyncScope } from '../../app/.server/sources';
import { createTenant, tenantIdBySlug } from '../../app/.server/tenants';
import { memberOf } from '../../test/pipeline/fixtures';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: { tenant: { type: 'string', default: 'isolab' }, step: { type: 'string' }, with: { type: 'string', default: 'crmlab' } } });
const slug = args.tenant!;
const step = (name: string) => (!args.step ? ['prepare', 'tenant', 'sources', 'mappings'] : args.step.split(',')).includes(name);
const started = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - started) / 60000).toFixed(1).padStart(5)} 分] ${msg}`);

const PG_ADMIN = 'postgresql://crm:crm@localhost:5432/crm';
const SCRATCH = { schema: 'iso_scratch', user: 'isolab_reader', password: 'isolab-reader-secret' };
const SOURCES: Record<string, Record<string, string>> = {
  mall_pg: { kind: 'postgres', host: 'localhost', port: '5432', database: 'crm', schema: 'crm_mall', user: 'crmlab_reader', password: 'crmlab-reader-secret' },
  scratch_pg: { kind: 'postgres', host: 'localhost', port: '5432', database: 'crm', schema: SCRATCH.schema, user: SCRATCH.user, password: SCRATCH.password },
};
const MAPPINGS: [source: string, file: string][] = [
  ['mall_pg', join(HERE, '..', 'crm-seed', 'mappings', 'mall_pg.users.customer.yaml')],
  ['scratch_pg', join(HERE, 'mappings', 'scratch_pg.members.customer.yaml')],
];

// ---------- prepare：C 自己的上游 ----------
if (step('prepare')) {
  execFileSync('psql', [PG_ADMIN, '-q', '-v', 'ON_ERROR_STOP=1', '-c', `
    DROP SCHEMA IF EXISTS ${SCRATCH.schema} CASCADE;
    CREATE SCHEMA ${SCRATCH.schema};
    CREATE TABLE ${SCRATCH.schema}.members AS
      SELECT user_id AS member_id, nickname, mobile, email, city, registered_at, updated_at
        FROM crm_mall.users ORDER BY user_id LIMIT 2000;
    ALTER TABLE ${SCRATCH.schema}.members ADD PRIMARY KEY (member_id);
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SCRATCH.user}') THEN CREATE ROLE ${SCRATCH.user} LOGIN PASSWORD '${SCRATCH.password}';
      ELSE ALTER ROLE ${SCRATCH.user} LOGIN PASSWORD '${SCRATCH.password}'; END IF;
    END $$;
    GRANT CONNECT ON DATABASE crm TO ${SCRATCH.user};
    GRANT USAGE ON SCHEMA ${SCRATCH.schema} TO ${SCRATCH.user};
    GRANT SELECT ON ALL TABLES IN SCHEMA ${SCRATCH.schema} TO ${SCRATCH.user};`], { stdio: 'inherit' });
  log(`建好 ${SCRATCH.schema}.members（2000 行）与只读账号 ${SCRATCH.user} / ${SCRATCH.password}`);
}

// ---------- tenant：租户与成员 ----------
let tenantId: string | null = await tenantIdBySlug(slug).catch(() => null);
if (!tenantId && step('tenant')) {
  ({ tenant: { id: tenantId } } = await createTenant({ slug, name: `边界测试 ${slug}`, adminEmail: `admin@${slug}.test` }));
  log(`创建了租户 ${slug}`);
}
const needTenant = ['tenant', 'sources', 'mappings', 'compare'].some(step);
if (!tenantId && needTenant) throw new Error(`没有租户 ${slug}：先跑 --step tenant`);
const admin = tenantId ? await memberOf(tenantId, `admin@${slug}.test`, 'admin') : null;
const eng = tenantId ? await memberOf(tenantId, `eng@${slug}.test`, 'data_engineer') : null;
if (tenantId && step('tenant')) {
  await memberOf(tenantId, `an@${slug}.test`, 'analyst');
  await memberOf(tenantId, `view@${slug}.test`, 'viewer');
  log('成员：admin@ / eng@ / an@ / view@' + `${slug}.test`);
}

/** 跑空本租户的任务队列，列出失败的任务 */
async function drain(what: string) {
  const t = Date.now();
  await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
  for (;;) {
    const [{ n }] = await getDb().select({ n: count() }).from(tasks)
      .where(and(eq(tasks.tenantId, tenantId!), inArray(tasks.status, ['queued', 'running'])));
    if (!n) break;
    await new Promise(r => setTimeout(r, 2000));
    await createDispatcher({ maxWorkers: 2 }).runUntilIdle();
  }
  const failed = await getDb().select({ kind: tasks.kind, error: tasks.error }).from(tasks)
    .where(and(eq(tasks.tenantId, tenantId!), eq(tasks.status, 'failed'), gt(tasks.createdAt, new Date(t))));
  for (const f of failed) log(`  ✘ 任务 ${f.kind} 失败：${String(f.error).slice(0, 500)}`);
  log(`${what}：任务跑完，用时 ${((Date.now() - t) / 1000).toFixed(0)} 秒`);
}

// ---------- sources：登记、选表、水位线、首次同步 ----------
const sourceIds = new Map(eng ? (await listSources(eng)).map(s => [s.name, s.id]) : []);
if (step('sources')) {
  for (const [name, input] of Object.entries(SOURCES)) {
    if (sourceIds.has(name)) continue;
    const { id } = await registerSource(eng!, { name, ...input });
    sourceIds.set(name, id);
    const { listing } = await getSource(eng!, id);
    // mall_pg 只要 users：C 只用来比身份，不需要 B 的订单
    const pick = listing.filter(t => t.readable && !t.gone && (name !== 'mall_pg' || t.name === 'users')).map(t => t.name);
    await setSyncScope(eng!, id, { add: pick });
    log(`登记 ${name}，选了 ${pick.join('、')}`);
  }
  await drain('采集');
  for (const name of Object.keys(SOURCES)) {
    const id = sourceIds.get(name)!;
    for (const { table, watermark } of (await confirmedTables(tenantId!, id)).tables) {
      const c = table.watermarkCandidates.find(w => w.column === 'updated_at');
      if (!watermark && c) await confirmWatermark(eng!, id, table.name, c.column);
    }
    await syncSource(eng!, id);
  }
  await drain('首次同步');
}

// ---------- mappings：两个 customer 映射（eng 起草、admin 发布） ----------
if (step('mappings')) {
  const existing = new Set((await listMappings(eng!)).mappings.map(m => `${m.sourceId}:${m.entity}`));
  for (const [source, file] of MAPPINGS) {
    const id = sourceIds.get(source);
    if (!id) throw new Error(`没有数据源 ${source}：先跑 --step sources`);
    if (existing.has(`${id}:customer`)) continue;
    const mapping = await createMapping(eng!, id, readFileSync(file, 'utf8'));
    await publishMapping(admin!, mapping.id, 1);
    log(`发布映射 ${source} → customer`);
  }
  await drain('合并');
}

// ---------- compare：同一上游在两个租户里的哈希与统一消费者 ID ----------
type Row = { customer_id: string; phone: string | null; consumer_id: string | null };
async function mallCustomers(tenantSlug: string): Promise<Map<string, Row>> {
  const id = await tenantIdBySlug(tenantSlug);
  if (!id) throw new Error(`没有租户 ${tenantSlug}`);
  const lake = await lakeRow(id);
  if (!lake || !lakeReady(lake)) throw new Error(`${tenantSlug} 的数据湖没有初始化`);
  const [{ id: source } = { id: null }] = await getDb().select({ id: sources.id }).from(sources)
    .where(and(eq(sources.tenantId, id), eq(sources.name, 'mall_pg'), isNull(sources.deletedAt)));
  if (!source) throw new Error(`${tenantSlug} 没有数据源 mall_pg`);
  const session = await openTenantLake(lakeSpecOf(lake), { memoryLimitMb: 2048, threads: 2 }, undefined, { readOnly: true });
  try {
    const rows = (await session.con.runAndReadAll(`
      SELECT c.customer_id, c.phone, i.consumer_id FROM silver.customer c
        LEFT JOIN silver._identities i ON i._source = c._source AND i.customer_id = c.customer_id
       WHERE c._source = '${source}'`)).getRowObjectsJson() as Row[];
    return new Map(rows.map(r => [r.customer_id, r]));
  } finally { session.close(); }
}
if (step('compare')) {
  const [b, c] = [await mallCustomers(args.with!), await mallCustomers(slug)];
  let both = 0, samePhone = 0, phones = 0, sameConsumer = 0;
  for (const [k, rc] of c) {
    const rb = b.get(k);
    if (!rb) continue;
    both++;
    if (rb.phone && rc.phone) { phones++; if (rb.phone === rc.phone) samePhone++; }
    if (rb.consumer_id && rb.consumer_id === rc.consumer_id) sameConsumer++;
  }
  const mark = (ok: boolean) => (ok ? '✔' : '✘');
  console.log(`mall_pg 消费者：${args.with} ${b.size}，${slug} ${c.size}，两边都有 ${both}`);
  console.log(`${mark(both === c.size && both > 0)} ${slug} 的每条都能在 ${args.with} 找到同一 customer_id`);
  console.log(`${mark(samePhone === 0 && phones > 0)} 手机哈希相同 ${samePhone} / ${phones}（期望 0：租户盐不同）`);
  console.log(`${mark(sameConsumer === 0)} 统一消费者 ID 相同 ${sameConsumer} / ${both}（期望 0）`);
}
log('完成');
await closeDb();
