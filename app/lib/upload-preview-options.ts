// app/lib/upload-preview-options.ts —— 上传前预览（#727，ADR-0037）提交的读取选项 JSON：登记时的 hidden options 与「重新预览」共用。
// 结构性选项（编码 / 分隔符 / 表头 / 跳过行数）与上次预览的识别结果不同时不带 columns：列名与列数会变，交给服务端按新选项自动识别；
// 只改了列类型才带 columns（read_csv 要求列齐全、顺序与识别出的一致）

export interface PreviewResultLike {
  encoding: 'utf-8' | 'gbk';
  delim: string;
  header: boolean;
  skip: number;
  columns: { name: string; type: string }[];
}

export interface PreviewChoices {
  encoding: 'utf-8' | 'gbk';
  delim: string;
  header: boolean;
  /** 输入框里的原文 */
  skip: string;
  types: Record<string, string>;
}

/** 结构性选项是否与上次预览的识别结果不同（不同就要重新预览，列会变） */
export function structureChanged(result: PreviewResultLike, c: PreviewChoices): boolean {
  return c.encoding !== result.encoding || c.delim !== result.delim || c.header !== result.header || c.skip !== String(result.skip);
}

/** 选项 JSON（键是表名）；还没有预览结果时为空串，服务端照自动识别 */
export function uploadOptionsJson(table: string, result: PreviewResultLike | null, c: PreviewChoices): string {
  if (!result) return '';
  const skipNum = Number(c.skip);
  const skip = Number.isInteger(skipNum) && skipNum >= 0 && skipNum <= 1000 ? skipNum : result.skip;
  const columns = structureChanged(result, c)
    ? undefined
    : Object.fromEntries(result.columns.map(col => [col.name, c.types[col.name] ?? col.type]));
  return JSON.stringify({ [table]: { encoding: c.encoding, delim: c.delim, header: c.header, skip, ...(columns && { columns }) } });
}
