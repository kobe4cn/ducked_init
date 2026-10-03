// app/.server/pipeline/lake-engine.ts —— 在当前进程里打开一个只挂载单个租户数据湖的 DuckDB（ADR-0001、0008）。
// 工作进程用它执行任务，开通租户时也用它初始化 catalog。这里不碰平台 PG 的连接串：拿到的只有本租户的凭据
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { attachSource, listTables, lockConfiguration, type MongoAccess, type SourceSpec, type SourceTable } from './source-engine';

/** 一个租户的数据湖：数据文件所在的存储前缀，以及用本租户数据库角色连接的 DuckLake catalog */
export interface LakeSpec {
  dataPath: string;
  catalogUrl: string;
  catalogSchema: string;
  /** 存储前缀在对象存储上时的访问凭据 */
  s3?: { endpoint: string; region: string; key: string; secret: string; urlStyle: string; useSsl: boolean };
}

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
  close(): void;
}

/** 错误信息会展示给租户成员或写入审计日志：DuckDB 的报错可能带出 catalog 连接串，抹掉其中本租户的凭据 */
export function redactLakeSecrets(message: string, lake: LakeSpec) {
  const secrets = [new URL(lake.catalogUrl).password, lake.s3?.secret, lake.s3?.key].filter((s): s is string => !!s);
  return secrets.reduce((m, s) => m.replaceAll(s, '***').replaceAll(encodeURIComponent(s), '***'), message);
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * 挂载租户数据湖（给了 source 时再只读挂载该数据源，ADR-0012）后锁住配置：只能读写本租户的存储前缀，不能再挂载其他库、读其他路径，也不能改回这些设置。
 * catalog 的数据库角色只能访问本租户的 schema，因此经 DuckLake 内部的 PG 连接也读不到其他租户与平台元数据。
 * 大批次、比对等超出内存上限时溢写到本次会话专用的本机临时目录（ADR-0010），关闭会话即删除。
 * 同一目录下另挂一个本机库 stage，暂存同步时从源端读到的行：落盘时压缩，不占溢写配额（ADR-0010）。
 * readOnly 时数据湖只读挂载（核对任务）：任何写入都会被 DuckDB 拒绝，本机库 stage 照常可写。
 * encrypted 只在首次挂载、建元数据表时给（ADR-0020）：DuckLake 把加密记进 catalog，之后的挂载不带它也照样加密写入；
 * 已建好的未加密 catalog 带上它会报错
 */
export async function openTenantLake(
  spec: LakeSpec, limits: EngineLimits, source?: SourceSpec,
  { readOnly = false, encrypted = false }: { readOnly?: boolean; encrypted?: boolean } = {},
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
    if (spec.s3) {
      const s = spec.s3;
      await con.run(`CREATE SECRET lake_s3 (TYPE s3, KEY_ID ${lit(s.key)}, SECRET ${lit(s.secret)}, REGION ${lit(s.region)},
          ENDPOINT ${lit(s.endpoint)}, URL_STYLE ${lit(s.urlStyle)}, USE_SSL ${s.useSsl}, SCOPE ${lit(spec.dataPath)})`);
    }
    await con.run(`ATTACH ${lit(`ducklake:postgres:${spec.catalogUrl}`)} AS lake
      (DATA_PATH ${lit(spec.dataPath)}, METADATA_SCHEMA ${lit(spec.catalogSchema)}${readOnly ? ', READ_ONLY' : ''}${encrypted ? ', ENCRYPTED' : ''})`);
    // 源端不带时区的时间一律按 UTC 解读，不随工作进程所在机器的时区变化
    await con.run(`USE lake; SET TimeZone = 'UTC'`);
    const attached = source ? await attachSource(con, source) : { allowed: [], mongo: undefined };
    await lockConfiguration(con, [spec.dataPath, spill, ...attached.allowed]);
    return {
      con,
      close,
      lake: { dataPath: spec.dataPath, metadata: `__ducklake_metadata_lake.${ident(spec.catalogSchema)}` },
      ...(source && { source: { mongo: attached.mongo, tables: () => listTables(con, source, attached.mongo) } }),
    };
  } catch (e) {
    close();
    throw e;
  }
}
