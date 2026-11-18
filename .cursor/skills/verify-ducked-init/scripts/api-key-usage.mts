// HTTP checks for platform.api_key_usage. Run only through api-key-usage.sh after launch.sh.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { closeDb } from '../../../../app/.server/db/client.ts';
import { tenantServingKey } from '../../../../app/.server/secrets.ts';

const BASE = process.env.BASE_URL ?? '';
const LOG = process.env.LOG_FILE ?? '';
const EV = process.env.EVIDENCE_DIR ?? '';
const RUN = process.env.RUN_ID ?? '';
const STATE = process.env.STATE_DIR ?? '';
const ROOT = new URL('../../../../', import.meta.url).pathname;
const SQL = `${ROOT}.cursor/skills/verify-ducked-init/scripts/sql.sh`;
const WRITE = `${ROOT}.cursor/skills/verify-ducked-init/scripts/sql-write.sh`;

if (!BASE || !LOG || !EV || !RUN || !STATE) {
  console.error('api-key-usage.mts: BASE_URL, LOG_FILE, EVIDENCE_DIR, RUN_ID, and STATE_DIR are required');
  process.exit(1);
}

const out = `${EV}/api-key-usage.log`;
mkdirSync(EV, { recursive: true });
writeFileSync(out, `base=${BASE} run=${RUN}\n`);

function log(line: string) {
  const text = line.endsWith('\n') ? line : `${line}\n`;
  appendFileSync(out, text);
  process.stdout.write(text);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function sh(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) throw new Error(`${cmd} failed ${r.status}: ${r.stderr || r.stdout}`);
  return (r.stdout ?? '').trim();
}

const q = (sql: string) => sh(SQL, [RUN, sql]);
const w = (sql: string) => sh(WRITE, [RUN, sql]);

type Jar = Map<string, string>;

async function http(method: string, path: string, opts: { jar?: Jar; token?: string; form?: Record<string, string>; json?: unknown } = {}) {
  const headers: Record<string, string> = { Accept: 'text/html,application/json' };
  if (opts.jar && opts.jar.size) headers.Cookie = [...opts.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(120_000) });
  if (opts.jar && typeof res.headers.getSetCookie === 'function') {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) opts.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  return { status: res.status, text: await res.text(), location: res.headers.get('location') };
}

function calls(slug: string, name: string, endpoint: string) {
  return q(`SELECT coalesce(sum(u.calls),0)::text FROM platform.api_key_usage u JOIN platform.api_keys k ON k.id=u.api_key_id JOIN platform.tenants t ON t.id=u.tenant_id WHERE t.slug='${slug}' AND k.name='${name}' AND u.endpoint='${endpoint}'`);
}

function rows(slug: string, name: string, endpoint: string) {
  return q(`SELECT count(*)::text FROM platform.api_key_usage u JOIN platform.api_keys k ON k.id=u.api_key_id JOIN platform.tenants t ON t.id=u.tenant_id WHERE t.slug='${slug}' AND k.name='${name}' AND u.endpoint='${endpoint}'`);
}

async function login(email: string) {
  const jar: Jar = new Map();
  const offset = readFileSync(LOG).byteLength;
  const posted = await http('POST', '/login', { jar, form: { email } });
  assert(posted.status === 200 && posted.text.includes('请查收邮件'), `login ${email} status=${posted.status}`);
  let token = '';
  for (let i = 0; i < 50 && !token; i++) {
    const chunk = readFileSync(LOG).subarray(offset).toString('utf8');
    const blocks = chunk.split('======== 邮件');
    for (let b = blocks.length - 1; b >= 0; b--) {
      if (!blocks[b].includes(`收件人：${email}`)) continue;
      const m = blocks[b].match(/\/auth\/verify\?token=([^\s]+)/);
      if (m) token = m[1];
    }
    if (!token) await new Promise(r => setTimeout(r, 200));
  }
  assert(token, `no magic link for ${email}`);
  const verified = await http('POST', `/auth/verify?token=${encodeURIComponent(token)}`, { jar });
  assert(verified.status === 302 && jar.has('crm_session'), `verify ${email} status=${verified.status}`);
  log(`LOGIN ${email} ok`);
  return jar;
}

async function createKey(jar: Jar, name: string) {
  const res = await http('POST', '/api-keys', { jar, form: { intent: 'create', name } });
  const m = res.text.match(/data-api-key[^>]*>([^<]+)</);
  assert(res.status === 200 && m, `create key ${name} status=${res.status}`);
  log(`KEY ${name} prefix=${m[1].trim().slice(0, 8)}`);
  return m[1].trim();
}

async function buildServing(slug: string) {
  const tenantId = q(`SELECT id FROM platform.tenants WHERE slug='${slug}'`);
  const spaceId = q(`SELECT id FROM platform.spaces WHERE tenant_id='${tenantId}' AND is_default`);
  const sourceId = w(`INSERT INTO platform.sources (tenant_id, space_id, name, kind, config, credentials) VALUES ('${tenantId}', '${spaceId}', '会员', 'postgres', '{}'::jsonb, 'verify-not-a-secret') RETURNING id`);
  assert(/^[0-9a-f-]{36}$/.test(sourceId), `source id ${sourceId}`);
  const key = await tenantServingKey(tenantId);
  const file = `${STATE}/serving-${slug}.duckdb`;
  const instance = await DuckDBInstance.create(':memory:');
  const con = await instance.connect();
  const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
  const consumer = `c-${slug}`;
  await con.run(`ATTACH ${lit(file)} AS serving (ENCRYPTION_KEY ${lit(key)})`);
  await con.run(`CREATE TABLE serving.tags AS SELECT ${lit(consumer)}::VARCHAR AS consumer_id, 'tier'::VARCHAR AS tag, 'gold'::VARCHAR AS tag_value`);
  await con.run(`CREATE TABLE serving.metrics AS SELECT ${lit(consumer)}::VARCHAR AS consumer_id, 'spend'::VARCHAR AS metric, '{}'::JSON AS dims, 12.5::DOUBLE AS value`);
  await con.run(`CREATE TABLE serving.rfm AS SELECT ${lit(consumer)}::VARCHAR AS consumer_id, 'champions'::VARCHAR AS segment, 5::INTEGER AS r, 4::INTEGER AS f, 3::INTEGER AS m, 2::INTEGER AS recency_days, 7::BIGINT AS frequency, 99.50::DECIMAL(38,2) AS monetary`);
  await con.run(`CREATE TABLE serving.consumer_aliases AS SELECT NULL::VARCHAR AS retired_id, NULL::VARCHAR AS consumer_id WHERE false`);
  await con.run(`CREATE TABLE serving.consumer_sources AS SELECT ${lit(sourceId)}::VARCHAR AS source_id, 'cust-9'::VARCHAR AS customer_id, ${lit(consumer)}::VARCHAR AS consumer_id`);
  await con.run(`CREATE TABLE serving.meta AS SELECT 1::INTEGER AS version, now() AS built_at`);
  con.closeSync();
  instance.closeSync();
  w(`INSERT INTO platform.serving_stores (tenant_id, version, path, snapshots, built_at) VALUES ('${tenantId}', 1, '${file}', '[]'::jsonb, now())`);
  log(`SERVING ${slug} ${file}`);
  return consumer;
}

async function main() {
  assert(q('SELECT count(*)::text FROM platform.api_key_usage') === '0', 'api_key_usage is not empty; use a fresh launch');
  assert(q(`SELECT count(*)::text FROM platform.serving_stores s JOIN platform.tenants t ON t.id=s.tenant_id WHERE t.slug='verify'`) === '0', 'verify already has a serving store');
  const utc = q(`SELECT (now() AT TIME ZONE 'UTC')::date::text`);

  const jar = await login('admin@verify.test');
  const key = await createKey(jar, '点查甲');
  const revoked = await createKey(jar, '待吊销');
  const revokeId = q(`SELECT k.id FROM platform.api_keys k JOIN platform.tenants t ON t.id=k.tenant_id WHERE t.slug='verify' AND k.name='待吊销' AND k.revoked_at IS NULL`);
  const revokedRes = await http('POST', '/api-keys', { jar, form: { intent: 'revoke', keyId: revokeId } });
  assert(revokedRes.status === 302, `revoke status=${revokedRes.status}`);
  assert(q(`SELECT (revoked_at IS NOT NULL)::text FROM platform.api_keys WHERE id='${revokeId}'`) === 't', 'key not revoked');

  const unauth = { error: '未授权：请在 Authorization 头里带上有效的 API Key（Bearer）' };
  for (const [label, token] of [['missing', undefined], ['wrong', 'not-a-real-key'], ['revoked', revoked]] as const) {
    const res = await http('GET', '/api/v1/consumers/c-verify', token ? { token } : {});
    assert(res.status === 401 && res.text.includes(unauth.error), `${label} status=${res.status} body=${res.text.slice(0, 180)}`);
    log(`HTTP ${label} 401`);
  }
  const noStore = await http('GET', '/api/v1/consumers/c-verify', { token: key });
  assert(noStore.status === 503, `expected 503 before serving, got ${noStore.status} ${noStore.text.slice(0, 180)}`);
  const noSource = await http('GET', `/api/v1/consumers/by-source/${encodeURIComponent('没有这个源')}/cust-9`, { token: key });
  assert(noSource.status === 404, `by-source missing source ${noSource.status}`);
  const snap = await http('GET', '/api/v1/consumers/c-verify?snapshot=00000000-0000-0000-0000-000000000000', { token: key });
  assert(snap.status === 404, `snapshot ${snap.status}`);
  const snapSource = await http('GET', `/api/v1/consumers/by-source/${encodeURIComponent('没有这个源')}/cust-9?snapshot=1`, { token: key });
  assert(snapSource.status === 400, `by-source snapshot ${snapSource.status} ${snapSource.text.slice(0, 180)}`);
  assert(q('SELECT count(*)::text FROM platform.api_key_usage') === '0', 'a non-success wrote a usage row');
  log('SKIP empty');

  const consumer = await buildServing('verify');
  const byId = `/api/v1/consumers/${consumer}`;
  const bySource = `/api/v1/consumers/by-source/${encodeURIComponent('会员')}/cust-9`;
  const ok1 = await http('GET', byId, { token: key });
  assert(ok1.status === 200 && ok1.text.includes(`"consumer_id":"${consumer}"`), `byId ${ok1.status}`);
  assert(calls('verify', '点查甲', 'consumers.byId') === '1', 'byId calls');
  assert(rows('verify', '点查甲', 'consumers.byId') === '1', 'byId rows');
  const day = q(`SELECT day::text FROM platform.api_key_usage u JOIN platform.api_keys k ON k.id=u.api_key_id WHERE k.name='点查甲'`);
  assert(day === utc, `day ${day} != ${utc}`);
  const src = await http('GET', bySource, { token: key });
  assert(src.status === 200 && src.text.includes('"requested_id":"cust-9"'), `bySource ${src.status} ${src.text.slice(0, 180)}`);
  assert(calls('verify', '点查甲', 'consumers.bySource') === '1', 'bySource calls');
  const ok2 = await http('GET', byId, { token: key });
  assert(ok2.status === 200, `byId repeat ${ok2.status}`);
  assert(calls('verify', '点查甲', 'consumers.byId') === '2', 'byId did not accumulate');
  assert(rows('verify', '点查甲', 'consumers.byId') === '1', 'byId opened a second row');
  const nobody = await http('GET', '/api/v1/consumers/nobody', { token: key });
  const missingCustomer = await http('GET', `/api/v1/consumers/by-source/${encodeURIComponent('会员')}/nobody`, { token: key });
  const snapKnown = await http('GET', `${byId}?snapshot=00000000-0000-0000-0000-000000000000`, { token: key });
  const snapKnownSource = await http('GET', `${bySource}?snapshot=1`, { token: key });
  assert(nobody.status === 404 && missingCustomer.status === 404 && snapKnown.status === 404 && snapKnownSource.status === 400, 'post-success skips');
  assert(calls('verify', '点查甲', 'consumers.byId') === '2' && calls('verify', '点查甲', 'consumers.bySource') === '1', 'skip changed the counter');
  log('SUCCESS accumulated');

  const lu1 = q(`SELECT last_used_at::text FROM platform.api_keys WHERE name='点查甲' AND revoked_at IS NULL`);
  const catalog = await http('GET', '/api/v1/catalog', { token: key });
  const catalog2 = await http('GET', '/api/v1/catalog', { token: key });
  const lu2 = q(`SELECT last_used_at::text FROM platform.api_keys WHERE name='点查甲' AND revoked_at IS NULL`);
  assert(catalog.status === 200 && catalog2.status === 200 && catalog.text.includes('"definitions"'), 'catalog');
  assert(lu1 === lu2, `last_used_at moved inside one minute (${lu1} -> ${lu2})`);
  w(`UPDATE platform.api_keys SET last_used_at = now() - interval '2 minutes' WHERE name='点查甲' AND revoked_at IS NULL`);
  const back = q(`SELECT last_used_at::text FROM platform.api_keys WHERE name='点查甲' AND revoked_at IS NULL`);
  const catalog3 = await http('GET', '/api/v1/catalog', { token: key });
  const advanced = q(`SELECT last_used_at::text FROM platform.api_keys WHERE name='点查甲' AND revoked_at IS NULL`);
  assert(catalog3.status === 200 && advanced !== back && advanced > back, `last_used_at did not advance (${back} -> ${advanced})`);
  const exp = await http('POST', '/api/v1/exports', { token: key, json: { conditions: [] } });
  const expGet = await http('GET', '/api/v1/exports/00000000-0000-0000-0000-000000000001', { token: key });
  assert(exp.status === 400 && expGet.status === 404, `export ${exp.status} ${expGet.status}`);
  assert(calls('verify', '点查甲', 'consumers.byId') === '2' && calls('verify', '点查甲', 'consumers.bySource') === '1', 'catalog or export wrote usage');
  log('ASIDE catalog export last_used_at');

  const created = spawnSync('pnpm', ['tenant:create', '--slug', 'usageb', '--name', '计数租户乙', '--admin-email', 'admin@usageb.test'], { cwd: ROOT, encoding: 'utf8' });
  assert(created.status === 0, `tenant create ${created.stderr || created.stdout}`);
  const jarB = await login('admin@usageb.test');
  const keyB = await createKey(jarB, '点查乙');
  const consumerB = await buildServing('usageb');
  const b = await http('GET', `/api/v1/consumers/${consumerB}`, { token: keyB });
  assert(b.status === 200, `tenant B ${b.status} ${b.text.slice(0, 180)}`);
  const mismatch = q(`SELECT count(*)::text FROM platform.api_key_usage u JOIN platform.api_keys k ON k.id=u.api_key_id WHERE u.tenant_id <> k.tenant_id`);
  const bOnA = q(`SELECT count(*)::text FROM platform.api_key_usage u JOIN platform.tenants t ON t.id=u.tenant_id JOIN platform.api_keys k ON k.id=u.api_key_id JOIN platform.tenants kt ON kt.id=k.tenant_id WHERE t.slug='verify' AND kt.slug<>'verify'`);
  assert(mismatch === '0' && bOnA === '0', `isolation mismatch=${mismatch} foreign=${bOnA}`);
  assert(calls('usageb', '点查乙', 'consumers.byId') === '1', 'tenant B calls');
  log('ISOLATION ok');

  w(`UPDATE platform.tenants SET suspended_at = now(), suspension_reason = 'verify pause' WHERE slug='usageb'`);
  const paused = await http('GET', `/api/v1/consumers/${consumerB}`, { token: keyB });
  assert(paused.status === 401, `paused ${paused.status}`);
  assert(calls('usageb', '点查乙', 'consumers.byId') === '1', 'paused tenant incremented');
  log('PAUSED 401');

  let trigger = false;
  try {
    w(`UPDATE platform.api_keys SET last_used_at = now() - interval '2 minutes' WHERE name='点查甲' AND revoked_at IS NULL`);
    const luBefore = q(`SELECT last_used_at::text FROM platform.api_keys WHERE name='点查甲' AND revoked_at IS NULL`);
    const before = calls('verify', '点查甲', 'consumers.byId');
    const logAt = readFileSync(LOG).byteLength;
    w(`CREATE OR REPLACE FUNCTION platform.verify_usage_fail() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'verify forced api_key_usage write failure'; END $fn$`);
    w(`CREATE TRIGGER verify_usage_fail BEFORE INSERT OR UPDATE ON platform.api_key_usage FOR EACH ROW EXECUTE FUNCTION platform.verify_usage_fail()`);
    trigger = true;
    const failed = await http('GET', byId, { token: key });
    const after = calls('verify', '点查甲', 'consumers.byId');
    const luAfter = q(`SELECT last_used_at::text FROM platform.api_keys WHERE name='点查甲' AND revoked_at IS NULL`);
    const chunk = readFileSync(LOG).subarray(logAt).toString('utf8');
    assert(failed.status === 200 && failed.text.includes(`"consumer_id":"${consumer}"`), `write-fail http ${failed.status}`);
    assert(after === before, `write-fail changed calls ${before} -> ${after}`);
    assert(chunk.includes('[api-usage]') && chunk.includes('verify forced api_key_usage write failure'), 'write-fail log missing');
    assert(luAfter !== luBefore, 'last_used_at rolled back with the usage write');
    log('WRITE_FAIL open');
  } finally {
    if (trigger) {
      w(`DROP TRIGGER IF EXISTS verify_usage_fail ON platform.api_key_usage`);
      w(`DROP FUNCTION IF EXISTS platform.verify_usage_fail()`);
    }
  }
  const recovered = await http('GET', byId, { token: key });
  assert(recovered.status === 200, `recover ${recovered.status}`);
  assert(calls('verify', '点查甲', 'consumers.byId') === '3', 'counter did not resume after the trigger was dropped');
  log('API KEY USAGE PASS');
  await closeDb();
}

main().catch(async e => {
  log(`API KEY USAGE FAIL ${e instanceof Error ? e.stack : e}`);
  try { await closeDb(); } catch { /* pool may be unopened */ }
  process.exit(1);
});
