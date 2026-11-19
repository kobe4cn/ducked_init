// app/.server/pipeline/lake-engine.ts —— 在当前进程里打开一个只挂载单个租户数据湖的 DuckDB（ADR-0001、0008）。
// 工作进程用它执行任务，开通租户时也用它初始化 catalog。这里不碰平台 PG 的连接串：拿到的只有本租户的凭据
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { copyFile, mkdir, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { putObject } from '../s3-client';
import { attachSource, listTables, lockConfiguration, type MongoAccess, type SourceSpec, type SourceTable } from './source-engine';

/** 一个租户的数据湖：数据文件所在的存储前缀，以及用本租户数据库角色连接的 DuckLake catalog */
export interface LakeSpec {
  dataPath: string;
  catalogUrl: string;
  catalogSchema: string;
  /** 存储前缀在对象存储上时的访问凭据 */
  s3?: { endpoint: string; region: string; key: string; secret: string; urlStyle: string; useSsl: boolean };
}

/** 服务库在存储前缀下的目录（ADR-0033），不是 DuckLake 登记的文件 */
export const SERVING_DIR = '_serving/';

/** 超出内存上限时溢写到本机临时目录，溢写量以内存上限的这个倍数为限 */
export const SPILL_RATIO = 10;

/** 按租户配额限制的计算资源 */
export interface EngineLimits { memoryLimitMb: number; threads: number }

export interface TenantLakeSession {
  /** 默认库已切到租户的数据湖（lake），表名不需要前缀 */
  con: DuckDBConnection;
  /** 同时挂载了数据源时（同步任务）：源端以 src 只读挂载 */
  source?: { mongo?: MongoAccess; tables(): Promise<SourceTable[]> };
  /** 数据湖的存储前缀，以及在会话里读取 DuckLake 元数据表的位置（如 ducklake_data_file 前面加上它） */
  lake: { dataPath: string; metadata: string };
  /**
   * 挂载了服务库时（生成服务库的任务，ADR-0033）：本机库 serving 的文件，以及把它落盘、DETACH 后上传到本租户存储前缀下 target 的函数
   * （对象存储用本租户的账号，本地湖先复制到旁边再改名）
   */
  serving?: { file: string; upload(target: string): Promise<void> };
  /** 同一实例上再开一个连接（默认库同样是 lake），与 con 共享内存与线程池，可以并发执行；由调用方 closeSync()，close() 不管 */
  connect(): Promise<DuckDBConnection>;
  close(): void;
}

/** 错误信息会展示给租户成员或写入审计日志：DuckDB 的报错可能带出 catalog 连接串，抹掉其中本租户的凭据 */
export function redactLakeSecrets(message: string, lake: LakeSpec) {
  const secrets = [new URL(lake.catalogUrl).password, lake.s3?.secret, lake.s3?.key].filter((s): s is string => !!s);
  return secrets.reduce((m, s) => m.replaceAll(s, '***').replaceAll(encodeURIComponent(s), '***'), message);
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** 湖 catalog（DuckLake 的 PostgreSQL）的建连超时秒数（LAKE_CONNECT_TIMEOUT_SECONDS）：设了才给 catalogUrl 拼 connect_timeout，
 *  不设（生产默认）不加参数、由网络栈决定，行为不变。正整数字符串才用，否则 undefined。
 *  沙箱经 podman 网关 ATTACH 建连偶发卡住 60 秒以上（工作台报「查询超过 60 秒」），libpq 一直等且 interrupt() 打断不了（#938，#545 / #627 同类） */
export function lakeConnectTimeout(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.LAKE_CONNECT_TIMEOUT_SECONDS;
  return /^\d+$/.test(raw ?? '') && Number(raw) > 0 ? Number(raw) : undefined;
}

/** 湖 catalog 建连超时（timeout expired）的重试次数（LAKE_CONNECT_RETRIES，默认 0）：照 #892 给源库 ATTACH 拍板的方案，
 *  只对建连超时重试，密码错、库不存在等其他错误不重试；生产默认不重试、行为不变 */
export function lakeConnectRetries(env: Record<string, string | undefined> = process.env): number {
  const raw = env.LAKE_CONNECT_RETRIES;
  return /^\d+$/.test(raw ?? '') ? Number(raw) : 0;
}

/**
 * 挂载租户数据湖（给了 source 时再只读挂载该数据源，ADR-0012）后锁住配置：只能读写本租户的存储前缀，不能再挂载其他库、读其他路径，也不能改回这些设置。
 * catalog 的数据库角色只能访问本租户的 schema，因此经 DuckLake 内部的 PG 连接也读不到其他租户与平台元数据。
 * 大批次、比对等超出内存上限时溢写到本次会话专用的本机临时目录（ADR-0010），关闭会话即删除。
 * 同一目录下另挂一个本机库 stage，暂存同步时从源端读到的行：落盘时压缩，不占溢写配额（ADR-0010）。
 * readOnly 时数据湖只读挂载（核对任务）：任何写入都会被 DuckDB 拒绝，本机库 stage 照常可写。
 * encrypted 只在首次挂载、建元数据表时给（ADR-0020）：DuckLake 把加密记进 catalog，之后的挂载不带它也照样加密写入；
 * 已建好的未加密 catalog 带上它会报错。
 * 给了 servingKey 时在同一目录下再挂一个按它加密的本机库 serving（生成服务库，ADR-0033）：锁定配置后不能再 ATTACH，所以在锁定之前挂上
 */
export async function openTenantLake(
  spec: LakeSpec, limits: EngineLimits, source?: SourceSpec,
  { readOnly = false, encrypted = false, servingKey }: { readOnly?: boolean; encrypted?: boolean; servingKey?: string } = {},
): Promise<TenantLakeSession> {
  const instance = await DuckDBInstance.create(':memory:', {
    memory_limit: `${limits.memoryLimitMb}MiB`,
    threads: String(limits.threads),
  });
  const con = await instance.connect();
  const spill = mkdtempSync(join(tmpdir(), 'duckdb-task-'));
  const close = () => { con.closeSync(); instance.closeSync(); rmSync(spill, { recursive: true, force: true }); };
  try {
    // httpfs 除了读写对象存储，还带来写加密文件所需的加密模块（ADR-0020），本地目录模式也要加载
    await con.run(`INSTALL ducklake; LOAD ducklake; INSTALL postgres; LOAD postgres; INSTALL httpfs; LOAD httpfs;
      SET temp_directory = ${lit(spill)}; SET max_temp_directory_size = '${limits.memoryLimitMb * SPILL_RATIO}MiB';
      ATTACH ${lit(join(spill, 'stage.duckdb'))} AS stage;`);
    const servingDb = join(spill, 'serving.duckdb');
    if (servingKey) await con.run(`ATTACH ${lit(servingDb)} AS serving (ENCRYPTION_KEY ${lit(servingKey)})`);
    if (spec.s3) {
      const s = spec.s3;
      await con.run(`CREATE SECRET lake_s3 (TYPE s3, KEY_ID ${lit(s.key)}, SECRET ${lit(s.secret)}, REGION ${lit(s.region)},
          ENDPOINT ${lit(s.endpoint)}, URL_STYLE ${lit(s.urlStyle)}, USE_SSL ${s.useSsl}, SCOPE ${lit(spec.dataPath)})`);
    }
    // catalog 的 ATTACH 单独跑、只在建连超时（timeout expired）时按 LAKE_CONNECT_RETRIES 重试（#938，照 #892 源库 ATTACH 的写法）：
    // 设了超时才把 connect_timeout 拼进 URL 的查询串（不改 spec.catalogUrl 本身：它进 IPC 传给工作进程、也用于脱敏），不设时 URL 原样、生产行为不变。
    // ATTACH 失败时 lake 没有注册，重试前不需要 DETACH；此时还在 lockConfiguration 之前（ADR-0008），可以再次 ATTACH。
    // 用完重试次数或密码错、库不存在等其他错误时抛最后一次的原错误，不包装（调用方会脱敏）
    const timeout = lakeConnectTimeout();
    let catalogUrl = spec.catalogUrl;
    if (timeout !== undefined) {
      const url = new URL(spec.catalogUrl);
      url.searchParams.set('connect_timeout', String(timeout));
      catalogUrl = url.href;
    }
    const attach = `ATTACH ${lit(`ducklake:postgres:${catalogUrl}`)} AS lake
      (DATA_PATH ${lit(spec.dataPath)}, METADATA_SCHEMA ${lit(spec.catalogSchema)}${readOnly ? ', READ_ONLY' : ''}${encrypted ? ', ENCRYPTED' : ''})`;
    const retries = lakeConnectRetries();
    for (let attempt = 0; ; attempt++) {
      try {
        await con.run(attach);
        break;
      } catch (e) {
        if (attempt >= retries || !(e as Error).message.includes('timeout expired')) throw e;
      }
    }
    // 源端不带时区的时间一律按 UTC 解读，不随工作进程所在机器的时区变化；GLOBAL 让之后 connect() 开的连接同样按 UTC
    await con.run(`USE lake; SET GLOBAL TimeZone = 'UTC'`);
    const attached = source ? await attachSource(con, source) : { allowed: [], mongo: undefined };
    await lockConfiguration(con, [spec.dataPath, spill, ...attached.allowed]);
    const connect = async () => {
      const extra = await instance.connect();
      try {
        await extra.run('USE lake');
      } catch (e) {
        extra.closeSync();
        throw e;
      }
      return extra;
    };
    return {
      con,
      connect,
      close,
      lake: { dataPath: spec.dataPath, metadata: `__ducklake_metadata_lake.${ident(spec.catalogSchema)}` },
      ...(servingKey && { serving: { file: servingDb, upload: async (target: string) => {
        await con.run('CHECKPOINT serving; DETACH serving');
        await uploadServing(spec, servingDb, target);
      } } }),
      ...(source && { source: { mongo: attached.mongo, tables: () => listTables(con, source, attached.mongo) } }),
    };
  } catch (e) {
    close();
    throw e;
  }
}

/** 把服务库文件放到本租户存储前缀下的 target：只能在 <dataPath>_serving/ 之下 */
async function uploadServing(spec: LakeSpec, file: string, target: string) {
  if (!target.startsWith(spec.dataPath + SERVING_DIR)) throw new Error(`服务库只能放在本租户存储前缀的 ${SERVING_DIR} 下：${target}`);
  if (spec.s3) {
    const { size } = await stat(file);
    await putObject(spec.s3, target, Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, size);
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file, `${target}.tmp`);
  await rename(`${target}.tmp`, target);
}
