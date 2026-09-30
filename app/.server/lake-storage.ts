// app/.server/lake-storage.ts —— 存储前缀下的文件：列出、复制与删除，本地目录与对象存储一视同仁。
// 迁移、重置数据湖时使用，对象存储用平台账号访问（要读旧前缀、写新前缀），只在平台进程里使用
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { platformS3 } from './s3-accounts';
import { deleteObject, getObject, listObjects, putObject } from './s3-client';

export const isS3 = (path: string) => path.startsWith('s3://');

/** 存储前缀下的一个文件：相对前缀的路径（以 / 分隔）与字节数 */
export interface LakeFile { path: string; size: number }

/** 列出存储前缀（以 / 结尾）下的全部文件；本地目录不存在时为空 */
export async function listLakeFiles(prefix: string): Promise<LakeFile[]> {
  if (isS3(prefix)) return listObjects(platformS3(), prefix);
  const entries = await readdir(prefix, { recursive: true, withFileTypes: true }).catch(e => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  });
  return Promise.all(entries.filter(e => e.isFile()).map(async e => {
    const full = join(e.parentPath, e.name);
    return { path: relative(prefix, full).split(sep).join('/'), size: (await stat(full)).size };
  }));
}

/** 同时删除的对象数 */
const DELETE_CONCURRENCY = 8;

/** 删除存储前缀下的全部文件（本地目录连同目录本身），返回删除的文件数 */
export async function deleteLakeFiles(prefix: string) {
  const files = await listLakeFiles(prefix);
  if (!isS3(prefix)) {
    await rm(prefix, { recursive: true, force: true });
    return files.length;
  }
  const queue = [...files];
  await Promise.all(Array.from({ length: DELETE_CONCURRENCY }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) await deleteObject(platformS3(), prefix + f.path);
  }));
  return files.length;
}

/** 把 from 前缀下的一个文件复制到 to 前缀下的同一相对路径，已存在时覆盖 */
export async function copyLakeFile(from: string, to: string, file: LakeFile) {
  const source = isS3(from)
    ? Readable.fromWeb(await getObject(platformS3(), from + file.path) as import('node:stream/web').ReadableStream)
    : createReadStream(from + file.path);
  if (isS3(to)) {
    await putObject(platformS3(), to + file.path, Readable.toWeb(source) as ReadableStream<Uint8Array>, file.size);
  } else {
    await mkdir(dirname(to + file.path), { recursive: true });
    await pipeline(source, createWriteStream(to + file.path));
  }
}
