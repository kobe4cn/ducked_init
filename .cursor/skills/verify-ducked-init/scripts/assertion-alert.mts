// Real dispatcher run: a negative CRM order (key A7), then the task error, console mail,
// and assertion.failed audit. Also a null _mapping (no「来源」) and a duplicate key (two mapping names).
// The shell wrapper sets the database URLs before this file is loaded.
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { listAuditLogs } from '../../../../app/.server/audit.ts';
import { closeDb, getDb } from '../../../../app/.server/db/client.ts';
import { auditLogs, tasks } from '../../../../app/.server/db/schema.ts';
import { migratePlatformDb } from '../../../../app/.server/db/migrate.ts';
import { listSnapshots } from '../../../../app/.server/snapshots.ts';
import { syncSource } from '../../../../app/.server/source-sync.ts';
import { publishedIdentitySources } from '../../../../test/pipeline/identity-fixtures.ts';
import { drain, mergeUnchecked, onLake, runTask } from '../../../../test/pipeline/fixtures.ts';
import { grantOnSource } from '../../../../test/pipeline/source-fixtures.ts';

const token = process.env.VERIFY_ASSERT_TOKEN!;
const platformDb = new URL(process.env.PLATFORM_DATABASE_URL!).pathname.slice(1);
const sourceDb = new URL(process.env.TEST_SOURCE_DATABASE_URL!).pathname.slice(1);
const origin = (process.env.APP_URL ?? '').replace(/\/+$/, '');
const evidenceDir = process.env.VERIFY_EVIDENCE_DIR ?? '/opt/cursor/artifacts/verify-ducked-init/assertion-alert';
const mails: string[] = [];
const origLog = console.log;
console.log = (...args: unknown[]) => {
  const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  if (line.includes('邮件（开发环境')) mails.push(line);
  origLog(...args);
};
const log = (m: string) => console.error(`[assertion-alert] ${m}`);

const dsl = {
  kind: 'metric', key: 'm', asOf: '2024-07-01',
  sql: 'SELECT consumer_id, 1 AS value FROM silver._identities',
  entities: ['order', 'customer'],
};

async function ensureDatabases() {
  const admin = new pg.Client({ connectionString: 'postgres://crm:crm@127.0.0.1:5432/postgres' });
  await admin.connect();
  try {
    for (const name of [platformDb, sourceDb]) {
      if (name === 'crm_platform' || name.startsWith('crm_platform_verify_')) throw new Error(`refusing database ${name}`);
      const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (!rowCount) await admin.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await admin.end();
  }
}

async function taskRow(id: string) {
  const [row] = await getDb().select({
    id: tasks.id, kind: tasks.kind, status: tasks.status, error: tasks.error, result: tasks.result,
  }).from(tasks).where(eq(tasks.id, id));
  return row!;
}

async function auditFor(tenantId: string, taskId: string) {
  const [row] = await getDb().select().from(auditLogs)
    .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, 'assertion.failed'), eq(auditLogs.targetId, taskId)));
  const page = (await listAuditLogs(tenantId)).find(a => a.action === '断言失败' && a.summary.includes(taskId));
  return { row, page };
}

const fails: string[] = [];
const check = (ok: boolean, message: string) => { if (!ok) fails.push(message); };

let tenantId: string | undefined;

try {
  log(`platform ${platformDb}`);
  await ensureDatabases();
  await migratePlatformDb();
  const fixture = await publishedIdentitySources({ orders: true, slug: 'acme' });
  tenantId = fixture.acme;
  await grantOnSource(`INSERT INTO crm.orders VALUES
    ('A7', 1, 'paid', -10, '2024-06-29 10:00', '2024-06-29 10:00', now()),
    ('A8', NULL, 'paid', 10, '2024-06-29 10:00', '2024-06-29 10:00', now()),
    ('A9', NULL, 'paid', 10, '2024-06-29 10:00', '2024-06-29 10:00', now())`);
  await syncSource(fixture.author, fixture.sources.crm);
  await drain();

  const before = (await listSnapshots(fixture.acme)).length;
  const single = (await runTask(fixture.acme, 'gold.dsl', dsl))!;
  const singleRow = await taskRow(single.id);
  const after = (await listSnapshots(fixture.acme)).length;
  const singleLink = `${origin}/quality?task=${single.id}`;
  const singleAudit = await auditFor(fixture.acme, single.id);
  const singleMail = mails.find(m => m.includes(single.id)) ?? '';
  const singleRuns = await onLake<{ assertions: string }>(fixture.acme, `
    SELECT assertions::VARCHAR AS assertions FROM silver._assertion_runs WHERE task_id = '${single.id}' AND entity = 'order'`);
  const quarantine = await onLake<{ key: string }>(fixture.acme, `
    SELECT "key" FROM silver._quarantine WHERE task_id = '${single.id}' AND assertion = 'amount_non_negative'`);
  const warn = ((singleRow.result as { assertions?: { name: string; mappings?: string[] }[] }).assertions ?? [])
    .find(a => a.name === 'order_customer_link');

  check(singleRow.status === 'failed', `single status ${singleRow.status}`);
  check(singleRow.error === `断言失败：金额非负（silver.order，1 行不合格），来源：CRM · orders → order。查看样本：${singleLink}`, `single error ${singleRow.error}`);
  check(after === before, `snapshot count ${before} -> ${after}`);
  check(singleMail.includes('来源：CRM · orders → order') && singleMail.includes(singleLink), 'single mail missing mapping or link');
  check(!singleMail.includes('A7') && !singleMail.includes('-10'), 'single mail leaked a key or amount');
  check(!singleRow.error!.includes('A7'), 'single error leaked A7');
  const singleDetail = singleAudit.row?.detail as { mappings?: string[]; link?: string } | undefined;
  check(JSON.stringify(singleDetail?.mappings) === JSON.stringify(['CRM · orders → order']), `single mappings ${JSON.stringify(singleDetail?.mappings)}`);
  check(singleDetail?.link === singleLink, `single link ${singleDetail?.link}`);
  check(singleAudit.page?.summary.endsWith(`，样本：${singleLink}`) === true, `single audit summary ${singleAudit.page?.summary}`);
  check(singleAudit.row?.actorType === 'system', `single actor ${singleAudit.row?.actorType}`);
  check(!JSON.stringify(singleDetail).includes('A7'), 'single audit detail leaked A7');
  check(quarantine.some(q => q.key === 'A7'), 'quarantine did not keep key A7');
  check(!(singleRuns[0]?.assertions ?? '').includes('"mappings"'), 'assertion run JSON included mapping ids');
  log(`NOTE warn mappings on result: ${JSON.stringify(warn?.mappings ?? null)} (not a failure if present)`);

  await onLake(fixture.acme, `UPDATE silver."order" SET "_mapping" = NULL WHERE order_id = 'A7'`);
  const bare = (await runTask(fixture.acme, 'gold.dsl', dsl))!;
  const bareRow = await taskRow(bare.id);
  const bareLink = `${origin}/quality?task=${bare.id}`;
  const bareAudit = await auditFor(fixture.acme, bare.id);
  const bareMail = mails.find(m => m.includes(bare.id)) ?? '';
  check(bareRow.error === `断言失败：金额非负（silver.order，1 行不合格）。查看样本：${bareLink}`, `bare error ${bareRow.error}`);
  check(!bareRow.error!.includes('来源'), 'bare error still has 来源');
  check(!bareMail.includes('来源') && bareMail.includes(bareLink) && !bareMail.includes('A7'), 'bare mail');
  const bareDetail = bareAudit.row?.detail as { mappings?: unknown[] } | undefined;
  check(Array.isArray(bareDetail?.mappings) && bareDetail.mappings.length === 0, `bare mappings ${JSON.stringify(bareDetail?.mappings)}`);

  await grantOnSource(`INSERT INTO crm.orders VALUES ('1', 1, 'paid', 10, '2024-06-29 10:00', '2024-06-29 10:00', now())`);
  await syncSource(fixture.author, fixture.sources.crm);
  await drain();
  const merged = await mergeUnchecked(fixture.acme, [fixture.orderMappings!.crm]);
  check(merged?.status === 'succeeded', `mergeUnchecked ${merged?.status} ${merged?.error}`);
  const dup = (await runTask(fixture.acme, 'gold.rfm', { asOf: '2024-07-01' }))!;
  const dupRow = await taskRow(dup.id);
  const dupLink = `${origin}/quality?task=${dup.id}`;
  const dupAudit = await auditFor(fixture.acme, dup.id);
  const dupMail = mails.find(m => m.includes(dup.id)) ?? '';
  const dupDetail = dupAudit.row?.detail as { mappings?: string[]; summaries?: string[] } | undefined;
  check(dupRow.status === 'failed', `dup status ${dupRow.status}`);
  check(dupRow.error!.endsWith(dupLink), `dup error does not end with the link: ${dupRow.error}`);
  check(dupRow.error!.includes('主键唯一（silver.order，2 行不合格），来源：'), `dup error missing pk source clause: ${dupRow.error}`);
  for (const name of ['CRM · orders → order', '会员 · orders → order']) {
    check(dupRow.error!.includes(name), `dup error missing ${name}`);
    check(dupMail.includes(name), `dup mail missing ${name}`);
    check((dupDetail?.mappings ?? []).includes(name), `dup detail.mappings missing ${name}`);
  }
  check((dupDetail?.summaries ?? []).some(s => s.startsWith('金额非负') && !s.includes('来源')), 'nulled amount summary still has 来源');
  check(dupAudit.page?.summary.endsWith(`，样本：${dupLink}`) === true, `dup audit summary ${dupAudit.page?.summary}`);
  check(!dupRow.error!.includes('A7') && !dupMail.includes('A7') && !JSON.stringify(dupDetail).includes('A7'), 'dup surfaces leaked A7');

  const report = { token, tenantId, fails, single: singleRow.error, bare: bareRow.error, dup: dupRow.error };
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/assertion-alert.json`, JSON.stringify(report, null, 2));
  if (fails.length) {
    log(`FAIL\n${fails.join('\n')}`);
    process.exitCode = 1;
  } else {
    log('PASS');
  }
} catch (e) {
  fails.push(e instanceof Error ? e.stack ?? e.message : String(e));
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(`${evidenceDir}/assertion-alert.json`, JSON.stringify({ token, tenantId, fails }, null, 2));
  log(`FATAL ${fails.at(-1)}`);
  process.exitCode = 1;
} finally {
  await closeDb().catch(() => {});
  const admin = new pg.Client({ connectionString: 'postgres://crm:crm@127.0.0.1:5432/postgres' });
  await admin.connect();
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND pid <> pg_backend_pid()`, [[platformDb, sourceDb]]);
    for (const name of [platformDb, sourceDb]) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    if (tenantId) {
      const role = `lake_${tenantId.replace(/-/g, '')}`;
      await admin.query(`DROP ROLE IF EXISTS "${role}_ro"`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    }
  } finally {
    await admin.end();
  }
}
