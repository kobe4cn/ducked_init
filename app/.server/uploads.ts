// app/.server/uploads.ts —— 文件上传数据源的文件（ADR-0037）：存在租户数据湖前缀的 _uploads/<上传目录 ID>/<表名>.csv。
// 登记时解码识别原编码（UTF-8 严格解码失败再按 GBK），统一转成 UTF-8 文本存湖，原编码记进审计。
// 只在平台进程里写与删：对象存储用平台账号，本地目录直接写文件（按 isS3 分派，同 lake-storage.ts）。
// 路径每次由当前数据湖前缀拼出，不存绝对 URI，迁移数据湖前缀后照样能读
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { lakeRow } from './lake';
import { deleteLakeFiles, isS3 } from './lake-storage';
import { platformS3 } from './s3-accounts';
import { putObject } from './s3-client';
import { lit, lockConfiguration, rows, uploadReader, type UploadReadOptions } from './pipeline/source-engine';
import { columnType, SourceError } from './source-config';

/** 上传的表名：会拼进文件路径与原始层表名，先校验再用，防路径穿越 */
export const UPLOAD_TABLE = /^[a-z][a-z0-9_]{0,62}$/;
export const UPLOAD_TABLE_RULE = '表名只能包含小写字母、数字与下划线，以字母开头，最长 63 个字符';

/** 上传目录 ID：登记前由服务端 randomUUID() 生成，存在 config.dir */
export const UPLOAD_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 数据湖前缀下的上传目录（以 / 结尾） */
export const uploadDirOf = (dataPath: string, dir: string) => `${dataPath}_uploads/${dir}/`;

/** 本租户当前数据湖前缀下的上传目录；未开通数据湖时抛 400 */
export async function uploadDirUri(tenantId: string, dir: string) {
  const lake = await lakeRow(tenantId);
  if (!lake) throw new SourceError('本租户还没有开通数据湖，不能上传文件');
  return uploadDirOf(lake.dataPath, dir);
}

/**
 * 文件内容解码（去掉 BOM）：默认先按 UTF-8 严格解码，失败再按 GBK（都转成 UTF-8 字符串，ADR-0037）；
 * 两种都失败抛 400。短的纯 ASCII 文件两种编码都合法，按 UTF-8 判定。给了 encoding 就只按那一种解码
 */
export function decodeUpload(bytes: Uint8Array, encoding?: 'utf-8' | 'gbk'): { text: string; encoding: 'utf-8' | 'gbk' } {
  const tryDecode = (enc: 'utf-8' | 'gbk') => {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  };
  for (const enc of encoding ? [encoding] : (['utf-8', 'gbk'] as const)) {
    const text = tryDecode(enc);
    if (text !== null) return { text, encoding: enc };
  }
  throw new SourceError('文件不是 UTF-8 或 GBK 编码，请另存为 UTF-8 后再上传');
}

/** 把一张表的 CSV 写进上传目录，已存在时覆盖 */
export async function storeUpload(tenantId: string, dir: string, table: string, text: string) {
  if (!UPLOAD_DIR.test(dir) || !UPLOAD_TABLE.test(table)) throw new SourceError('上传目录或表名不合法');
  const uri = `${await uploadDirUri(tenantId, dir)}${table}.csv`;
  if (isS3(uri)) {
    await putObject(platformS3(), uri, text);
  } else {
    await mkdir(dirname(uri), { recursive: true });
    await writeFile(uri, text);
  }
}

/** 删除整个上传目录（登记失败时清理，不留文件） */
export async function removeUpload(tenantId: string, dir: string) {
  if (!UPLOAD_DIR.test(dir)) return;
  await deleteLakeFiles(await uploadDirUri(tenantId, dir));
}

/** 一行 CSV 按分隔符数的字段个数（引号里的分隔符不算）：带 columns 读取选项登记时核对文件的列数用 */
export function csvFieldCount(line: string, delim: string): number {
  let count = 1;
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (c === delim && !quoted) count++;
  }
  return count;
}

/** 上传预览（ADR-0037）：识别出的编码、分隔符、表头行与每列类型，以及按这些选项读出的前 20 行（值都是字符串，空值是 null） */
export interface UploadPreview {
  encoding: 'utf-8' | 'gbk';
  delim: string;
  header: boolean;
  skip: number;
  columns: { name: string; type: string }[];
  rows: (string | null)[][];
}

/**
 * 上传前预览（ADR-0037）：把（可能已转码的）文件写进本机临时目录，用进程内 DuckDB 识别分隔符、表头行与列类型，
 * 返回前 20 行。不建数据源、不写湖、不保存状态；临时目录在 finally 里删掉。
 * 成员给的选项（delim / header / skip / columns）优先，没给的用 sniff_csv 识别的结果，与 read_csv 自动识别一致；
 * 列名与列类型取 DESCRIBE 读出的（不用 sniff 的 Columns），这样和同步时 read_csv 实际读出的一致。
 * DuckDB 只放行临时目录（lockConfiguration），选项都经转义，拼不出读其他文件的 SQL
 */
export async function previewUpload(bytes: Uint8Array, table: string, opts?: UploadReadOptions): Promise<UploadPreview> {
  if (!UPLOAD_TABLE.test(table)) throw new SourceError(UPLOAD_TABLE_RULE);
  const { text, encoding } = decodeUpload(bytes, opts?.encoding);
  // 写文件要在 lock 之前（lock 后只能读临时目录）
  const dir = await mkdtemp(join(tmpdir(), 'crm-preview-'));
  const file = join(dir, `${table}.csv`);
  await writeFile(file, text, 'utf8');
  // 读取选项去掉 encoding（临时文件已是 UTF-8）；空选项时 uploadReader 照自动识别读（与 undefined 等价）
  const { encoding: _ignored, ...read } = opts ?? {};
  const instance = await DuckDBInstance.create(':memory:', { threads: '1', memory_limit: '256MB' });
  const con = await instance.connect();
  try {
    await lockConfiguration(con, [`${dir}/`]);
    // 成员给的 delim / header / skip 也传给 sniff_csv：没给的按识别结果
    const sniffParams: string[] = [];
    if (opts?.delim !== undefined) sniffParams.push(`delim=${lit(opts.delim)}`);
    if (opts?.header !== undefined) sniffParams.push(`header=${opts.header ? 'true' : 'false'}`);
    if (opts?.skip !== undefined) sniffParams.push(`skip=${opts.skip}`);
    const [sniffed] = await rows<{ Delimiter: string; HasHeader: boolean; SkipRows: number }>(con,
      `SELECT Delimiter, HasHeader, SkipRows FROM sniff_csv(${lit(file)}${sniffParams.length ? `, ${sniffParams.join(', ')}` : ''})`);
    const from = uploadReader(file, read);
    const described = await rows<{ column_name: string; column_type: string }>(con, `DESCRIBE SELECT * FROM ${from}`);
    // 不在白名单里的类型（如 TIME）按 VARCHAR 返回：options 只收白名单类型
    const columns = described.map(c => ({ name: c.column_name, type: columnType(c.column_type) ?? 'VARCHAR' }));
    const dataRows = await rows<Record<string, unknown>>(con, `SELECT * FROM ${from} LIMIT 20`);
    const previewRows = dataRows.map(r => columns.map(({ name }) => {
      const v = r[name];
      return v === null || v === undefined ? null : String(v);
    }));
    return { encoding, delim: opts?.delim ?? sniffed.Delimiter, header: opts?.header ?? sniffed.HasHeader, skip: opts?.skip ?? sniffed.SkipRows, columns, rows: previewRows };
  } catch (e) {
    // DuckDB 的报错带临时文件的绝对路径，不能暴露出去
    throw new SourceError(`预览读不了这份文件：${(e as Error).message.split(file).join(`<${table}.csv>`).split(dir).join('<临时目录>')}`, 400);
  } finally {
    con.closeSync();
    instance.closeSync();
    await rm(dir, { recursive: true, force: true });
  }
}
