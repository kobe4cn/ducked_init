// app/.server/pipeline/lake-engine.ts —— 在当前进程里打开一个只挂载单个租户数据湖的 DuckDB（ADR-0001、0008）。
// 工作进程用它执行任务，开通租户时也用它初始化 catalog。这里不碰平台 PG 的连接串：拿到的只有本租户的凭据
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

/** 一个租户的数据湖：数据文件所在的存储前缀，以及用本租户数据库角色连接的 DuckLake catalog */
export interface LakeSpec {
  dataPath: string;
  catalogUrl: string;
  catalogSchema: string;
  /** 存储前缀在对象存储上时的访问凭据 */
  s3?: { endpoint: string; region: string; key: string; secret: string; urlStyle: string; useSsl: boolean };
}

/** 按租户配额限制的计算资源 */
export interface EngineLimits { memoryLimitMb: number; threads: number }

export interface TenantLakeSession {
  /** 默认库已切到租户的数据湖（lake），表名不需要前缀 */
  con: DuckDBConnection;
  close(): void;
}

/** 错误信息会展示给租户成员或写入审计日志：DuckDB 的报错可能带出 catalog 连接串，抹掉其中本租户的凭据 */
export function redactLakeSecrets(message: string, lake: LakeSpec) {
  const secrets = [new URL(lake.catalogUrl).password, lake.s3?.secret, lake.s3?.key].filter((s): s is string => !!s);
  return secrets.reduce((m, s) => m.replaceAll(s, '***').replaceAll(encodeURIComponent(s), '***'), message);
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * 挂载租户数据湖后锁住配置：只能读写本租户的存储前缀，不能再挂载其他库、读其他路径，也不能改回这些设置。
 * catalog 的数据库角色只能访问本租户的 schema，因此经 DuckLake 内部的 PG 连接也读不到其他租户与平台元数据
 */
export async function openTenantLake(spec: LakeSpec, limits: EngineLimits): Promise<TenantLakeSession> {
  const instance = await DuckDBInstance.create(':memory:', {
    memory_limit: `${limits.memoryLimitMb}MiB`,
    threads: String(limits.threads),
  });
  const con = await instance.connect();
  const close = () => { con.closeSync(); instance.closeSync(); };
  try {
    await con.run('INSTALL ducklake; LOAD ducklake; INSTALL postgres; LOAD postgres;');
    if (spec.s3) {
      const s = spec.s3;
      await con.run(`INSTALL httpfs; LOAD httpfs;
        CREATE SECRET lake_s3 (TYPE s3, KEY_ID ${lit(s.key)}, SECRET ${lit(s.secret)}, REGION ${lit(s.region)},
          ENDPOINT ${lit(s.endpoint)}, URL_STYLE ${lit(s.urlStyle)}, USE_SSL ${s.useSsl})`);
    }
    await con.run(`ATTACH ${lit(`ducklake:postgres:${spec.catalogUrl}`)} AS lake
      (DATA_PATH ${lit(spec.dataPath)}, METADATA_SCHEMA ${lit(spec.catalogSchema)})`);
    await con.run(`USE lake;
      SET allowed_directories = [${lit(spec.dataPath)}];
      SET enable_external_access = false;
      SET lock_configuration = true;`);
    return { con, close };
  } catch (e) {
    close();
    throw e;
  }
}
