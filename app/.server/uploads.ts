// app/.server/uploads.ts —— 文件上传数据源的文件（ADR-0037）：存在租户数据湖前缀的 _uploads/<上传目录 ID>/<表名>.csv。
// 只在平台进程里写与删：对象存储用平台账号，本地目录直接写文件（按 isS3 分派，同 lake-storage.ts）。
// 路径每次由当前数据湖前缀拼出，不存绝对 URI，迁移数据湖前缀后照样能读
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { lakeRow } from './lake';
import { deleteLakeFiles, isS3 } from './lake-storage';
import { platformS3 } from './s3-accounts';
import { putObject } from './s3-client';
import { SourceError } from './source-config';

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

/** 文件内容按 UTF-8 解码（去掉 BOM）；不是 UTF-8 时抛 400 */
export function decodeUtf8(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SourceError('文件不是 UTF-8 编码，请另存为 UTF-8 后再上传');
  }
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
