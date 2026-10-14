// app/.server/serving-reader.ts —— 外部系统按消费者 ID 点查（ADR-0033「读」）：默认读本租户当前的服务库，指定快照时只读查湖里那一张快照表。
// API 节点每次请求查指针 serving_stores；进程内按租户缓存一个只读挂载了服务库的 DuckDB 实例。版本变了时先把新文件下载到本机临时目录
// （只是缓存，多节点下目录可能是空的），挂上后再替换缓存；下载期间的请求继续用旧版，旧实例等进行中的请求结束后关闭、删掉本地文件。
// 每个请求从头到尾只用一个版本，不会读到半新半旧。服务库与快照表里只有 consumer_id 与分值，没有明文（ADR-0005）。一律限定在给定租户内
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import type { ServingStoreSnapshot } from './db/schema';
import { lakeReady, lakeRow, lakeSpecOf } from './lake';
import { isS3 } from './lake-storage';
import { openTenantLake } from './pipeline/lake-engine';
import { ident, lit } from './pipeline/merge-engine';
import { dimsJson, SNAPSHOT_TABLE } from './pipeline/serving-engine';
import { getObject } from './s3-client';
import { tenantServingKey } from './secrets';
import { currentServingStore, type ServingStore } from './serving-store';
import { getSnapshot } from './snapshots';

/** 点查的响应 */
export interface ConsumerProfile {
  consumer_id: string;
  requested_id: string;
  /** 读的服务库版本；指定快照时为 null */
  serving_version: number | null;
  tags: Record<string, string>;
  metrics: Record<string, { dims: Record<string, unknown>; value: number | null }[]>;
  rfm: { segment: string; r: number; f: number; m: number; recency_days: number; frequency: number; monetary: string } | null;
  snapshots: ServingStoreSnapshot[];
}

/** 可以返回给外部系统的错误 */
export class ServingError extends Error {
  constructor(message: string, readonly status: 404 | 503) { super(message); }
}

/** 每个租户的服务库实例：数据都在本机文件里，内存只放查询用的缓冲 */
const SERVING_LIMITS = { memory_limit: '64MiB', threads: '1' };
/** 指定快照时查湖用的计算资源 */
const SNAPSHOT_LIMITS = { memoryLimitMb: 256, threads: 1 };
/** 消费者 ID 的长度上限，超过的一律当作查无此人 */
const MAX_ID_LENGTH = 256;

const notFound = () => new ServingError('没有这个消费者', 404);

interface Loaded {
  version: number;
  snapshots: ServingStoreSnapshot[];
  instance: DuckDBInstance;
  file: string;
  /** 正在用它的请求数 */
  active: number;
  /** 已被新版本替换：最后一个请求结束后关闭 */
  retired: boolean;
}

/** 各租户当前挂载着的服务库 */
const mounted = new Map<string, Loaded>();
/** 正在下载、挂载的版本：键为 <租户>:<版本>，同一版本只下载一次 */
const inflight = new Map<string, Promise<void>>();

const cacheFile = (tenantId: string, version: number) => join(tmpdir(), 'crm-serving', tenantId, `v${version}.duckdb`);

/** 把指针指向的文件放到本机缓存目录：先写到旁边的临时文件再改名 */
async function download(tenantId: string, store: ServingStore, file: string) {
  await mkdir(join(file, '..'), { recursive: true });
  const partial = `${file}.${process.pid}.${Date.now()}.part`;
  try {
    if (isS3(store.path)) {
      const lake = await lakeRow(tenantId);
      const s3 = lake && lakeSpecOf(lake).s3;
      if (!s3) throw new Error('本租户在对象存储上还没有账号');
      await pipeline(Readable.fromWeb(await getObject(s3, store.path) as import('node:stream/web').ReadableStream), createWriteStream(partial));
    } else {
      await copyFile(store.path, partial);
    }
    await rename(partial, file);
  } catch (e) {
    await rm(partial, { force: true });
    throw e;
  }
}

/** 只读挂载服务库文件（按 key 解密）并核对版本，锁住配置：之后不能再挂载别的库、读别的文件 */
export async function openServingFile(file: string, key: string, version: number) {
  const instance = await DuckDBInstance.create(':memory:', SERVING_LIMITS);
  const con = await instance.connect();
  try {
    await con.run(`ATTACH ${lit(file)} AS serving (READ_ONLY, ENCRYPTION_KEY ${lit(key)});
      SET enable_external_access = false; SET lock_configuration = true;`);
    const [meta] = await query<{ version: number }>(con, 'SELECT version FROM serving.meta');
    if (meta?.version !== version) throw new Error(`服务库文件的版本 ${meta?.version} 与指针 ${version} 不一致`);
    return instance;
  } catch (e) {
    instance.closeSync();
    throw e;
  } finally {
    con.closeSync();
  }
}

function close(entry: Loaded) {
  entry.instance.closeSync();
  void rm(entry.file, { force: true });
}

/** 下载并挂载指针指向的版本，比缓存里的新时替换缓存（旧的没有请求在用时立即关闭）；同一租户同一版本只做一次 */
function fetchAndMount(tenantId: string, store: ServingStore) {
  const key = `${tenantId}:${store.version}`;
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const file = cacheFile(tenantId, store.version);
      await download(tenantId, store, file);
      const instance = await openServingFile(file, await tenantServingKey(tenantId), store.version).catch(async e => { await rm(file, { force: true }); throw e; });
      const entry: Loaded = { version: store.version, snapshots: store.snapshots, instance, file, active: 0, retired: false };
      const previous = mounted.get(tenantId);
      if (previous && previous.version >= entry.version) return close(entry);
      mounted.set(tenantId, entry);
      if (previous) {
        previous.retired = true;
        if (!previous.active) close(previous);
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/**
 * 取本租户当前可用的服务库并占用它，用完必须 release：缓存不比指针旧时直接用；
 * 缓存是旧版时后台下载新版、这次先用旧版；还没有缓存时等下载完。还没有任何版本、或下载失败又没有旧版可用时 503
 */
async function acquire(tenantId: string): Promise<Loaded> {
  const store = await currentServingStore(tenantId);
  if (!store) throw new ServingError('本租户还没有服务库，请稍后再试', 503);
  const cached = mounted.get(tenantId);
  // 只追更新的版本：请求读到的指针可能比别的请求已经挂上的旧
  if (!cached || store.version > cached.version) {
    const pending = fetchAndMount(tenantId, store);
    if (cached) pending.catch(e => console.error(`服务库 v${store.version} 下载失败（租户 ${tenantId}），继续用 v${cached.version}：`, e));
    else {
      try {
        await pending;
      } catch (e) {
        console.error(`服务库 v${store.version} 下载失败（租户 ${tenantId}）：`, e);
        throw new ServingError('本租户的服务库暂时不可用，请稍后再试', 503);
      }
    }
  }
  // await 之后同步取、同步占用：中间不会被别的请求换掉或关闭
  const entry = mounted.get(tenantId);
  if (!entry) throw new ServingError('本租户的服务库暂时不可用，请稍后再试', 503);
  entry.active++;
  return entry;
}

function release(entry: Loaded) {
  entry.active--;
  if (entry.retired && !entry.active) close(entry);
}

async function query<T>(con: DuckDBConnection, sql: string, values?: DuckDBValue[]) {
  return (await con.runAndReadAll(sql, values)).getRowObjectsJson() as T[];
}

type RfmRow = { segment: string; r: number; f: number; m: number; recency_days: number; frequency: string; monetary: string };
const RFM_COLUMNS = 'segment, r, f, m, recency_days, frequency, monetary::VARCHAR AS monetary';

/** 把查到的行拼成响应里的 tags、metrics、rfm；三样都没有时为 null（查无此人） */
function profileOf(
  tags: { tag: string; tag_value: string }[], metrics: { metric: string; dims: string; value: number | null }[], rfm: RfmRow[],
) {
  if (!tags.length && !metrics.length && !rfm.length) return null;
  const byMetric: ConsumerProfile['metrics'] = {};
  for (const m of metrics) (byMetric[m.metric] ??= []).push({ dims: JSON.parse(m.dims), value: m.value === null ? null : Number(m.value) });
  const [r] = rfm;
  return {
    tags: Object.fromEntries(tags.map(t => [t.tag, t.tag_value])),
    metrics: byMetric,
    rfm: r ? { ...r, r: Number(r.r), f: Number(r.f), m: Number(r.m), recency_days: Number(r.recency_days), frequency: Number(r.frequency) } : null,
  };
}

/** 在挂载了服务库（serving）的连接上点查一个消费者：退役的旧 ID 先换成现在的 ID（consumer_aliases）；查无此人时为 null */
export async function readServing(con: DuckDBConnection, requestedId: string) {
  const [alias] = await query<{ consumer_id: string }>(con, 'SELECT consumer_id FROM serving.consumer_aliases WHERE retired_id = $1', [requestedId]);
  const id = alias?.consumer_id ?? requestedId;
  const profile = profileOf(
    await query(con, 'SELECT tag, tag_value FROM serving.tags WHERE consumer_id = $1 ORDER BY tag', [id]),
    await query(con, 'SELECT metric, dims::VARCHAR AS dims, value FROM serving.metrics WHERE consumer_id = $1 ORDER BY metric, dims::VARCHAR', [id]),
    await query(con, `SELECT ${RFM_COLUMNS} FROM serving.rfm WHERE consumer_id = $1`, [id]),
  );
  return profile && { consumer_id: id, ...profile };
}

/**
 * 从本租户当前的服务库点查一个消费者的标签、指标与 RFM：退役的旧 ID 先换成现在的 ID（consumer_aliases）。
 * 没有这个人时 404，还没有服务库时 503
 */
export async function lookupConsumer(tenantId: string, requestedId: string): Promise<ConsumerProfile> {
  if (!requestedId || requestedId.length > MAX_ID_LENGTH) throw notFound();
  const entry = await acquire(tenantId);
  const con = await entry.instance.connect().catch(e => { release(entry); throw e; });
  try {
    const found = await readServing(con, requestedId);
    if (!found) throw notFound();
    const { consumer_id, ...profile } = found;
    return { consumer_id, requested_id: requestedId, serving_version: entry.version, ...profile, snapshots: entry.snapshots };
  } finally {
    con.closeSync();
    release(entry);
  }
}

/**
 * 只读查湖里本租户的一张快照表，返回这个消费者在其中的结果（其余部分为空）。快照不存在、属于别的租户或已过期时 404；
 * ID 照快照表里记的查，不换成现在的 ID（旧快照记的就是当时的 ID）
 */
export async function lookupSnapshot(tenantId: string, snapshotId: string, requestedId: string): Promise<ConsumerProfile> {
  const snapshot = await getSnapshot(tenantId, snapshotId);
  if (!snapshot || snapshot.expiredAt || snapshot.expiresAt <= new Date()) throw new ServingError('快照不存在或已过期', 404);
  if (!requestedId || requestedId.length > MAX_ID_LENGTH) throw notFound();
  const kind = SNAPSHOT_TABLE.exec(snapshot.table)?.[1];
  if (kind !== snapshot.template.split(':', 1)[0]) throw new ServingError('快照不存在或已过期', 404);
  const lake = await lakeRow(tenantId);
  if (!lake || !lakeReady(lake)) throw new ServingError('本租户的数据湖还没有初始化', 503);

  const name = snapshot.table.slice('gold.'.length);
  const table = `gold.${ident(name)}`;
  const session = await openTenantLake(lakeSpecOf(lake), SNAPSHOT_LIMITS, undefined, { readOnly: true });
  try {
    const { con } = session;
    const select = async <T>(columns: string, order = '') => query<T>(con, `SELECT ${columns} FROM ${table} WHERE consumer_id = $1 ${order}`, [requestedId]);
    let profile: ReturnType<typeof profileOf> = null;
    if (kind === 'rfm') profile = profileOf([], [], await select<RfmRow>(RFM_COLUMNS));
    else if (kind === 'tag') profile = profileOf(await select('tag_key::VARCHAR AS tag, tag_value::VARCHAR AS tag_value', 'ORDER BY tag'), [], []);
    else {
      // 维度列与服务库同样拼成 dims：快照表里除 consumer_id 与 value 以外的列
      const dims = (await query<{ column: string }>(con, `SELECT column_name AS "column" FROM information_schema.columns
        WHERE table_catalog = 'lake' AND table_schema = 'gold' AND table_name = $1 ORDER BY ordinal_position`, [name]))
        .map(c => c.column).filter(c => c !== 'consumer_id' && c !== 'value');
      const metric = lit(snapshot.template.slice('metric:'.length));
      profile = profileOf([], await select(`${metric} AS metric, ${dimsJson(dims)}::VARCHAR AS dims, value::DOUBLE AS value`, 'ORDER BY dims'), []);
    }
    if (!profile) throw notFound();
    return {
      consumer_id: requestedId, requested_id: requestedId, serving_version: null, ...profile,
      snapshots: [{
        id: snapshot.id, template: snapshot.template, definitionVersion: snapshot.definitionVersion,
        createdAt: snapshot.createdAt.toISOString(), incomplete: !!snapshot.incomplete,
      }],
    };
  } finally {
    session.close();
  }
}
