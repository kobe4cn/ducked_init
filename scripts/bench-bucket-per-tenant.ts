// scripts/bench-bucket-per-tenant.ts —— 「每租户一桶」规模实测（#682、#663）：在 S3 兼容对象存储上建 --buckets 个
// 「每租户一桶」（桶 lake-bench-<i> + 账号 lake-bench-<i> + 一条只放行本桶的策略），按 --checkpoints 记录：
// 建桶耗时、IAM 策略条数 / policies.json 字节数、IAM 写入后网关重载生效耗时（含写入期间已有租户的读延迟最大值）、
// 列桶与租户读写的 p50/p95、隔离抽查（A 租户读 / 写 / 列 B 租户的桶必须被拒）。结果 JSON 写 --out。
// 不读 S3_* 环境变量（沙箱注入的是宿主机的值），连接信息全部走命令行参数。用法（#682）：
//   node --import tsx scripts/bench-bucket-per-tenant.ts --backend seaweedfs --endpoint localhost:18333 \
//     --access-key crm --secret-key crm-secret --filer http://localhost:18888 --master localhost:19333 \
//     --buckets 1000 --out /tmp/bpt-seaweedfs.json
//   node --import tsx scripts/bench-bucket-per-tenant.ts --backend rustfs --endpoint 127.0.0.1:19000 \
//     --access-key crm --secret-key crm-secret --mc /tmp/rustfs/mc --buckets 1000 --out /tmp/bpt-rustfs.json
// RustFS 先试 AWS IAM API，不支持时自动改走 mc 的 MinIO 管理接口（记为发现）。
import { execFile as execFileCb } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { listObjects, signedFetch, xmlTag, xmlTags, type S3Creds } from '../app/.server/s3-client';

const execFile = promisify(execFileCb);

const { values } = parseArgs({
  options: {
    backend: { type: 'string' },            // seaweedfs | rustfs
    endpoint: { type: 'string' },           // host:port（无 scheme）
    'access-key': { type: 'string' },       // 平台账号
    'secret-key': { type: 'string' },
    region: { type: 'string', default: 'us-east-1' },
    buckets: { type: 'string', default: '1000' },
    checkpoints: { type: 'string', default: '100,500,1000' },
    filer: { type: 'string' },              // 仅 seaweedfs：读 /etc/iam/policies.json
    master: { type: 'string' },             // 仅 seaweedfs：读 /dir/status 的卷数（可选）
    mc: { type: 'string' },                 // 仅 rustfs：mc 二进制的路径（IAM API 不可用时走它）
    out: { type: 'string' },                // 结果 JSON 的路径（可选）
    keep: { type: 'boolean', default: false }, // 跳过清理，便于排查
    'max-minutes': { type: 'string', default: '30' }, // 建桶阶段的墙钟上限，超了就停在当前桶数
  },
});
const backend = values.backend!;
const endpoint = values.endpoint!;
const platform: S3Creds = {
  endpoint, region: values.region!, key: values['access-key']!, secret: values['secret-key']!, useSsl: false,
};
const bucketCount = Number(values.buckets);
const checkpoints = values.checkpoints!.split(',').map(Number).filter(n => n > 0 && n <= bucketCount);
const maxMs = Number(values['max-minutes']) * 60_000;
const POLICY_NAME = 'tenant-lake';          // 与产品一致的内联策略名（app/.server/s3-accounts.ts）
const mcPath = values.mc ?? '/tmp/rustfs/mc';
const mcUrl = endpoint.startsWith('http') ? endpoint : `http://${endpoint}`;
const ALIAS = 'bpt';

/** 只放行本桶、不带任何 Condition 的策略（#682：每桶一租户，不是按前缀） */
const policyFor = (bucket: string) => JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: [`arn:aws:s3:::${bucket}/*`] },
    { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: [`arn:aws:s3:::${bucket}`] },
  ],
});

class IamError extends Error {
  constructor(action: string, readonly code: string, message: string) { super(`IAM ${action} 失败（${code}）：${message}`); }
}

/** 用平台账号调 AWS IAM API（表单 POST，Version=2010-05-08，写法照 app/.server/s3-accounts.ts 的 iam()） */
async function iam(action: string, params: Record<string, string>) {
  const body = new URLSearchParams({ Action: action, Version: '2010-05-08', ...params }).toString();
  const res = await signedFetch(platform, 'iam', {
    method: 'POST', path: '/',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body,
  });
  const xml = await res.text();
  if (!res.ok) throw new IamError(action, xmlTag(xml, 'Code') ?? String(res.status), xmlTag(xml, 'Message') ?? xml.slice(0, 200));
  return xml;
}

const ignoreIam = (code: string) => (e: unknown) => { if (!(e instanceof IamError && e.code === code)) throw e; };

/** mc 管理接口（MinIO 兼容）：IAM API 不可用时的账号通道 */
const mc = async (...args: string[]) => (await execFile(mcPath, [...args], { timeout: 60_000 })).stdout;

/** aws：CreateUser → PutUserPolicy → CreateAccessKey（与 app/.server/s3-accounts.ts 的 issueAccount 同一顺序）；
 *  mc：user add → policy create → policy attach。都给 user 返回可用凭据 */
async function issueAccount(user: string, bucket: string): Promise<{ key: string; secret: string }> {
  if (iamMode === 'aws') {
    await iam('CreateUser', { UserName: user }).catch(ignoreIam('EntityAlreadyExists'));
    for (const AccessKeyId of xmlTags(await iam('ListAccessKeys', { UserName: user }), 'AccessKeyId')) {
      await iam('DeleteAccessKey', { UserName: user, AccessKeyId });
    }
    await iam('PutUserPolicy', { UserName: user, PolicyName: POLICY_NAME, PolicyDocument: policyFor(bucket) });
    const xml = await iam('CreateAccessKey', { UserName: user });
    const key = xmlTag(xml, 'AccessKeyId');
    const secret = xmlTag(xml, 'SecretAccessKey');
    if (!key || !secret) throw new Error(`CreateAccessKey 响应里没有密钥：${xml.slice(0, 200)}`);
    return { key, secret };
  }
  const secret = randomBytes(24).toString('hex');   // MinIO 风格：账号名即 access key
  await mc('admin', 'user', 'add', ALIAS, user, secret);
  writeFileSync(policyFile, policyFor(bucket));
  await mc('admin', 'policy', 'create', ALIAS, user, policyFile);
  await mc('admin', 'policy', 'attach', ALIAS, user, '--user', user);
  return { key: user, secret };
}

/** 重载探测的一轮：先把账号与密钥建好（策略未写），再写策略，从写完返回起每 50ms 用新账号探一次读自己桶。
 *  aws 通道是 PutUserPolicy，mc 通道是 policy attach；返回首次成功距策略写完的毫秒数 */
async function reloadRound(user: string, bucket: string): Promise<{ elapsed: number | null; creds: S3Creds }> {
  let creds: S3Creds;
  if (iamMode === 'aws') {
    await iam('CreateUser', { UserName: user }).catch(ignoreIam('EntityAlreadyExists'));
    const xml = await iam('CreateAccessKey', { UserName: user });
    const key = xmlTag(xml, 'AccessKeyId');
    const secret = xmlTag(xml, 'SecretAccessKey');
    if (!key || !secret) throw new Error(`CreateAccessKey 响应里没有密钥：${xml.slice(0, 200)}`);
    creds = { ...platform, key, secret };
    await iam('PutUserPolicy', { UserName: user, PolicyName: POLICY_NAME, PolicyDocument: policyFor(bucket) });
  } else {
    const secret = randomBytes(24).toString('hex');
    await mc('admin', 'user', 'add', ALIAS, user, secret);
    writeFileSync(policyFile, policyFor(bucket));
    await mc('admin', 'policy', 'create', ALIAS, user, policyFile);
    creds = { ...platform, key: user, secret };
    await mc('admin', 'policy', 'attach', ALIAS, user, '--user', user);
  }
  const t0 = performance.now();
  for (;;) {
    if (await s3(creds, { method: 'GET', path: `/${bucket}/probe` }) === 200) return { elapsed: performance.now() - t0, creds };
    if (performance.now() - t0 > 30_000) return { elapsed: null, creds };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function deleteAccount(user: string) {
  if (iamMode === 'aws') {
    // ADR-0008：先删密钥与策略再 DeleteUser，反过来会留删不掉的孤儿策略（#621）
    let keys: string | null = null;
    try { keys = await iam('ListAccessKeys', { UserName: user }); } catch (e) { ignoreIam('NoSuchEntity')(e); }
    if (keys) for (const AccessKeyId of xmlTags(keys, 'AccessKeyId')) await iam('DeleteAccessKey', { UserName: user, AccessKeyId });
    await iam('DeleteUserPolicy', { UserName: user, PolicyName: POLICY_NAME }).catch(ignoreIam('NoSuchEntity'));
    await iam('DeleteUser', { UserName: user }).catch(ignoreIam('NoSuchEntity'));
  } else {
    await mc('admin', 'policy', 'detach', ALIAS, user, '--user', user).catch(() => {});
    await mc('admin', 'policy', 'remove', ALIAS, user).catch(() => {});
    await mc('admin', 'user', 'remove', ALIAS, user).catch(() => {});
  }
}

interface Tenant { user: string; bucket: string; key: string; secret: string }

const tenantCreds = (t: Tenant): S3Creds => ({ ...platform, key: t.key, secret: t.secret });

const percentile = (sorted: number[], p: number) => sorted.length === 0 ? null
  : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
const stats = (times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? null };
};

const s3 = async (creds: S3Creds, req: Parameters<typeof signedFetch>[2]) => {
  const res = await signedFetch(creds, 's3', req);
  await res.arrayBuffer().catch(() => {});
  return res.status;
};

/** 同 s3，但状态非 2xx 就抛错（checkpoint 的准备步骤用它，写失败时立刻暴露而不是让探测白等） */
const s3Ok = async (what: string, creds: S3Creds, req: Parameters<typeof signedFetch>[2]) => {
  const status = await s3(creds, req);
  if (status < 200 || status >= 300) throw new Error(`${what} 返回 HTTP ${status}`);
  return status;
};

// ---------------- 结果 ----------------
const startedAt = new Date();
const result: {
  backend: string; endpoint: string; buckets: number; iamMode: string; iamProbe?: string;
  startedAt: string; finishedAt?: string; stoppedEarly?: string;
  buildMs: number[]; buildErrors: string[];
  checkpoints: Record<string, unknown>[];
  cleanup: { users: number; buckets: number; errors: string[] };
} = {
  backend, endpoint, buckets: bucketCount, iamMode: '', startedAt: startedAt.toISOString(),
  buildMs: [], buildErrors: [], checkpoints: [], cleanup: { users: 0, buckets: 0, errors: [] },
};

const policyDir = join(tmpdir(), 'bpt-policies');
mkdirSync(policyDir, { recursive: true });
const policyFile = join(policyDir, 'policy.json');

// ---------------- IAM 通道探测 ----------------
let iamMode: 'aws' | 'mc' = backend === 'seaweedfs' ? 'aws' : 'mc';
if (backend === 'rustfs') {
  try {
    await iam('ListUsers', {});
    iamMode = 'aws';
    console.log('RustFS 的 AWS IAM API 可用，走 IAM API');
  } catch (e) {
    iamMode = 'mc';
    result.iamProbe = e instanceof Error ? e.message : String(e);
    console.log(`RustFS 不兼容 AWS IAM API（${result.iamProbe}），改走 mc 管理接口`);
    await mc('alias', 'set', ALIAS, mcUrl, platform.key, platform.secret);
  }
}
result.iamMode = iamMode;

// ---------------- 建桶 + 建账号 ----------------
const tenants: Tenant[] = [];
const extras: Tenant[] = [];   // checkpoint 用的 reload 探测账号，结尾一并清理
const stopped = (reason: string) => { result.stoppedEarly ??= reason; console.log(`提前停止：${reason}`); };
const body1k = 'x'.repeat(1024);

for (let i = 1; i <= bucketCount && !result.stoppedEarly; i++) {
  if (performance.now() > maxMs) { stopped(`建桶阶段超过 ${values['max-minutes']} 分钟，只建到 ${i - 1} 个桶`); break; }
  const bucket = `lake-bench-${i}`;
  const user = `lake-bench-${i}`;
  try {
    const t0 = performance.now();
    const status = await s3(platform, { method: 'PUT', path: `/${bucket}` });
    if (status !== 200) throw new Error(`建桶 ${bucket} 返回 HTTP ${status}`);
    const { key, secret } = await issueAccount(user, bucket);
    result.buildMs.push(performance.now() - t0);
    tenants.push({ user, bucket, key, secret });
  } catch (e) {
    const msg = `第 ${i} 个（${user}）：${e instanceof Error ? e.message : e}`;
    result.buildErrors.push(msg);
    console.error(msg);
    if (result.buildErrors.length >= 3) { stopped(`累计建租户失败 ${result.buildErrors.length} 次：${msg}`); break; }
  }
  if (i % 50 === 0) {
    const last = result.buildMs.slice(-50);
    console.log(`已建 ${i}/${bucketCount} 桶，最近 50 个平均 ${stats(last).p50?.toFixed(0)} ms/个，累计 ${(performance.now() / 1000).toFixed(0)} s`);
  }
  if (checkpoints.includes(i)) await checkpoint(i);
}

// ---------------- checkpoint ----------------
function sample<T>(arr: T[], n: number) {
  const out: T[] = [];
  while (out.length < Math.min(n, arr.length)) {
    const pick = arr[Math.floor(Math.random() * arr.length)]!;
    if (!out.includes(pick)) out.push(pick);
  }
  return out;
}

async function checkpoint(at: number) {
  console.log(`\n===== checkpoint：${at} 个桶 =====`);
  const cp: Record<string, unknown> = { tenants: at };
  const built = stats(result.buildMs.slice(0, at));
  cp.buildCumulativeMs = Math.round(result.buildMs.slice(0, at).reduce((a, b) => a + b, 0));
  cp.buildPerTenant = built;

  // ① 策略条数与 policies.json 大小
  if (backend === 'seaweedfs') {
    try {
      const res = await fetch(`${values.filer}/etc/iam/policies.json`, { signal: AbortSignal.timeout(5000) });
      const text = res.ok ? await res.text() : null;
      const inline = text ? (JSON.parse(text) as { inlinePolicies?: object }).inlinePolicies : null;
      cp.inlinePolicies = inline ? Object.keys(inline).length : null;
      cp.policiesBytes = text ? Buffer.byteLength(text) : null;
    } catch (e) { cp.inlinePolicies = null; cp.policiesBytes = null; cp.policiesNote = e instanceof Error ? e.message : e; }
  } else if (iamMode === 'mc') {
    try {
      cp.inlinePolicies = (await mc('admin', 'policy', 'list', ALIAS)).split('\n').filter(l => l.trim()).length;
      cp.policiesBytes = null;   // RustFS 没有 policies.json，策略条数按 mc admin policy list 计（含内置策略）
    } catch (e) { cp.inlinePolicies = null; cp.policiesNote = e instanceof Error ? e.message : e; }
  }

  // ② IAM 写入后重载生效耗时：每轮一个全新账号写策略，从写完起每 50ms 探一次读自己桶；
  //    同时一个已有租户持续读自己的桶，记录 IAM 写入期间的最大延迟与任何一次被拒
  try {
    const probeBucket = `lake-bench-reload-${at}`;
    const watch = tenants[0]!;
    await s3Ok(`建桶 ${probeBucket}`, platform, { method: 'PUT', path: `/${probeBucket}` });
    await s3Ok(`写探测对象 ${probeBucket}/probe`, platform, { method: 'PUT', path: `/${probeBucket}/probe`, body: body1k });
    await s3Ok(`写观察对象 ${watch.bucket}/watch`, platform, { method: 'PUT', path: `/${watch.bucket}/watch`, body: body1k });
    let watching = true;
    const watchLatencies: number[] = [];
    const watchStatuses = new Map<number, number>();
    const watchLoop = (async () => {
      while (watching) {
        const t0 = performance.now();
        const status = await s3(tenantCreds(watch), { method: 'GET', path: `/${watch.bucket}/watch` }).catch(() => -1);
        watchLatencies.push(performance.now() - t0);
        watchStatuses.set(status, (watchStatuses.get(status) ?? 0) + 1);
      }
    })();
    const rounds: (number | null)[] = [];
    for (let r = 1; r <= 5; r++) {
      const user = `lake-bench-reload-${at}r${r}`;
      try {
        const { elapsed, creds } = await reloadRound(user, probeBucket);
        extras.push({ user, bucket: probeBucket, ...creds });
        rounds.push(elapsed);
      } catch (e) { rounds.push(null); result.buildErrors.push(`重载探测 ${user}：${e instanceof Error ? e.message : e}`); }
    }
    watching = false;
    await watchLoop;
    cp.reloadEffectiveMs = rounds;
    cp.reloadMedian = (() => { const ok = rounds.filter(r => r !== null).sort((a, b) => a! - b!); return percentile(ok as number[], 50); })();
    cp.watchDuringReload = { ...stats(watchLatencies), statuses: Object.fromEntries(watchStatuses) };
  } catch (e) {
    cp.reloadSkipped = e instanceof Error ? e.message : e;
    result.buildErrors.push(`checkpoint ${at} 的重载探测准备失败：${cp.reloadSkipped}`);
  }

  // ③ 延迟：平台账号列桶 20 次；随机 20 个租户各 put + get 一个 1KB 对象
  const listTimes: number[] = [];
  let bucketsSeen = -1;
  for (let n = 0; n < 20; n++) {
    const t0 = performance.now();
    const res = await signedFetch(platform, 's3', { method: 'GET', path: '/' });
    const xml = await res.text();
    bucketsSeen = xmlTags(xml, 'Name').length;
    listTimes.push(performance.now() - t0);
  }
  cp.listBuckets = { ...stats(listTimes), count: bucketsSeen };
  const putTimes: number[] = [];
  const getTimes: number[] = [];
  let rwBad = 0;
  for (const t of sample(tenants, 20)) {
    let t0 = performance.now();
    if (await s3(tenantCreds(t), { method: 'PUT', path: `/${t.bucket}/bench-1kb`, body: body1k }) !== 200) rwBad++;
    putTimes.push(performance.now() - t0);
    t0 = performance.now();
    if (await s3(tenantCreds(t), { method: 'GET', path: `/${t.bucket}/bench-1kb` }) !== 200) rwBad++;
    getTimes.push(performance.now() - t0);
  }
  cp.tenantPut = stats(putTimes);
  cp.tenantGet = stats(getTimes);
  cp.tenantRwBad = rwBad;

  // ④ 隔离抽查：A 的凭据读 / 写 / 列 B 的桶必须被拒（任何一次被放行就是否决项）
  const isolation: { a: string; b: string; read: number; write: number; list: number }[] = [];
  for (const a of sample(tenants, 5)) {
    const b = tenants.filter(t => t !== a)[Math.floor(Math.random() * (tenants.length - 1))]!;
    await s3Ok(`写隔离对象 ${b.bucket}/isolation`, platform, { method: 'PUT', path: `/${b.bucket}/isolation`, body: body1k });
    isolation.push({
      a: a.user, b: b.user,
      read: await s3(tenantCreds(a), { method: 'GET', path: `/${b.bucket}/isolation` }),
      write: await s3(tenantCreds(a), { method: 'PUT', path: `/${b.bucket}/evil`, body: 'x' }),
      list: await s3(tenantCreds(a), { method: 'GET', path: `/${b.bucket}`, query: { 'list-type': '2' } }),
    });
  }
  cp.isolation = isolation;

  // ⑤ 卷数（SeaweedFS）
  if (backend === 'seaweedfs' && values.master) {
    try {
      const topo = (await (await fetch(`http://${values.master}/dir/status`, { signal: AbortSignal.timeout(5000) })).json()) as any;
      let volumes = 0;
      for (const dc of topo.Topology?.DataCenters ?? []) for (const rack of dc.Racks ?? []) for (const node of rack.DataNodes ?? []) volumes += node.Volumes ?? 0;
      cp.volumes = { free: topo.Topology?.Free, max: topo.Topology?.Max, volumes };
    } catch (e) { cp.volumes = { note: e instanceof Error ? e.message : e }; }
  }
  result.checkpoints.push(cp);
  console.log(JSON.stringify(cp, (_k, v) => typeof v === 'number' ? Math.round(v * 10) / 10 : v));
}

// checkpoint 在建桶循环里到点即测；这里只补提前停止时缺的最后一个（不到任何 checkpoint 的也要测一次）
if (tenants.length > 0 && !checkpoints.includes(tenants.length)) await checkpoint(tenants.length);

// ---------------- 清理：删密钥 → 先删策略再删号（ADR-0008）→ 删对象 → 删桶 ----------------
/** 列桶，桶已不存在（404）时返回空列表而不是抛错：同一探测桶被多个账号共用、去重后只删一次，或上次运行删到一半 */
async function listObjectsOrGone(bucket: string) {
  try {
    return await listObjects(platform, `s3://${bucket}/`);
  } catch (e) {
    if (e instanceof Error && /HTTP 404/.test(e.message)) return [];
    throw e;
  }
}


if (values.keep) {
  console.log('\n--keep：跳过清理');
} else {
  console.log(`\n清理 ${tenants.length + extras.length} 个账号与桶…`);
  const doneBuckets = new Set<string>();   // checkpoint 的多个探测账号共用同一个探测桶，只删一次
  for (const t of [...tenants, ...extras]) {
    try { await deleteAccount(t.user); result.cleanup.users++; } catch (e) { result.cleanup.errors.push(`${t.user}：${e instanceof Error ? e.message : e}`); }
    if (doneBuckets.has(t.bucket)) continue;
    doneBuckets.add(t.bucket);
    try {
      for (const obj of await listObjectsOrGone(t.bucket)) {
        await s3(platform, { method: 'DELETE', path: `/${t.bucket}/${obj.path}` });
      }
      const status = await s3(platform, { method: 'DELETE', path: `/${t.bucket}` });
      if (status !== 204 && status !== 404) result.cleanup.errors.push(`删桶 ${t.bucket} 返回 HTTP ${status}`);
      result.cleanup.buckets++;
    } catch (e) { result.cleanup.errors.push(`${t.bucket}：${e instanceof Error ? e.message : e}`); }
  }
}

result.finishedAt = new Date().toISOString();console.log(`\n===== 结果（${backend}，${tenants.length} 个桶，墙钟 ${((Date.now() - startedAt.getTime()) / 60_000).toFixed(1)} 分钟）=====`);
console.log(`建租户失败 ${result.buildErrors.length} 次；清理失败 ${result.cleanup.errors.length} 次`);
if (values.out) {
  writeFileSync(values.out, JSON.stringify(result, null, 2));
  console.log(`JSON 已写 ${values.out}`);
}
if (result.buildErrors.length || result.cleanup.errors.length || result.stoppedEarly) process.exitCode = 1;
