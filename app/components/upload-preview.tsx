// app/components/upload-preview.tsx —— 文件上传数据源的上传前预览（ADR-0037）：点「预览」用 fetcher 提交 intent=preview，不跳转、已选的文件不丢；
// 显示识别出的编码、分隔符、表头行、每列类型与前 20 行，成员可改选项再预览。确认登记时把确认过的选项经 hidden options 随表单提交；
// 换文件或改表名后预览结果作废（选项 JSON 的键必须是表名），hidden 回到空串、登记照自动识别
import { useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import { CircleAlert, Eye } from 'lucide-react';
import type { UploadPreview as UploadPreviewData } from '~/.server/uploads';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

/** 与服务端的 UPLOAD_TABLE 一致（app/.server/uploads.ts）：表名拼进文件路径，客户端先挡一道 */
const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const DELIMS = [',', ';', '\t', '|'];
/** 列类型的下拉选项：白名单（source-config.ts）；预览识别出 DECIMAL(p,s) 时另加进那一列 */
const COLUMN_TYPES = ['VARCHAR', 'BIGINT', 'DOUBLE', 'BOOLEAN', 'DATE', 'TIMESTAMP'];

interface PreviewActionData { preview?: UploadPreviewData; previewError?: string }

export function UploadPreview() {
  const fetcher = useFetcher<PreviewActionData>();
  const [result, setResult] = useState<UploadPreviewData | null>(null);
  const [encoding, setEncoding] = useState<'utf-8' | 'gbk'>('utf-8');
  const [delim, setDelim] = useState(',');
  const [header, setHeader] = useState(true);
  const [skip, setSkip] = useState('0');
  const [types, setTypes] = useState<Record<string, string>>({});
  const [table, setTable] = useState('');
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // 预览结果回来后填进受控 state；之后的改动都对着这份结果比（要不要「重新预览」）
  useEffect(() => {
    const p = fetcher.data?.preview;
    if (!p) return;
    setResult(p);
    setEncoding(p.encoding);
    setDelim(p.delim);
    setHeader(p.header);
    setSkip(String(p.skip));
    setTypes(Object.fromEntries(p.columns.map(c => [c.name, c.type])));
  }, [fetcher.data]);

  // 表名与文件由 SourceFields 渲染（本组件外）：监听它们的改动，改了就作废预览结果
  useEffect(() => {
    const form = buttonRef.current?.form;
    const tableEl = form?.elements.namedItem('table') as HTMLInputElement | null;
    const fileEl = form?.elements.namedItem('file') as HTMLInputElement | null;
    if (!tableEl) return;
    const onTable = () => { setTable(tableEl.value.trim()); setResult(null); };
    const onFile = () => setResult(null);
    setTable(tableEl.value.trim());
    tableEl.addEventListener('input', onTable);
    fileEl?.addEventListener('change', onFile);
    return () => {
      tableEl.removeEventListener('input', onTable);
      fileEl?.removeEventListener('change', onFile);
    };
  }, []);

  const structuralChanged = result !== null && (encoding !== result.encoding || delim !== result.delim || header !== result.header || skip !== String(result.skip));
  const typeChanged = result !== null && result.columns.some(c => types[c.name] !== c.type);

  // 改编码 / 分隔符 / 表头 / 跳过行数会改变识别出的列：清掉列类型的改动，下一次预览重新识别
  const changeStructure = (patch: { encoding?: 'utf-8' | 'gbk'; delim?: string; header?: boolean; skip?: string }) => {
    if (patch.encoding !== undefined) setEncoding(patch.encoding);
    if (patch.delim !== undefined) setDelim(patch.delim);
    if (patch.header !== undefined) setHeader(patch.header);
    if (patch.skip !== undefined) setSkip(patch.skip);
    if (result) setTypes(Object.fromEntries(result.columns.map(c => [c.name, c.type])));
  };

  const skipNum = Number(skip);
  const optionsJson = !result
    ? ''
    : JSON.stringify({
      [table]: {
        encoding,
        delim,
        header,
        skip: Number.isInteger(skipNum) && skipNum >= 0 && skipNum <= 1000 ? skipNum : result.skip,
        // read_csv 的 columns 要求列齐全、顺序与识别出的一致（ADR-0037）
        columns: Object.fromEntries(result.columns.map(c => [c.name, types[c.name] ?? c.type])),
      },
    });

  const preview = (button: HTMLButtonElement) => {
    const fd = new FormData(button.form!);
    fd.set('intent', 'preview');
    if (result) {
      // 结构性选项变了就不带 columns：列会变，按新分隔符 / 表头重新识别；只改了列类型才带上
      const columns = structuralChanged ? undefined : Object.fromEntries(result.columns.map(c => [c.name, types[c.name] ?? c.type]));
      fd.set('options', JSON.stringify({ [String(fd.get('table') ?? '').trim()]: { encoding, delim, header, skip: skipNum, ...(columns && { columns }) } }));
    } else {
      fd.set('options', '');
    }
    void fetcher.submit(fd, { method: 'post', action: '/sources', encType: 'multipart/form-data' });
  };

  const tableOk = TABLE_NAME.test(table);
  const busy = fetcher.state !== 'idle';
  return (
    <div className="rounded-2xl border bg-white p-6 shadow-sm" data-upload-preview>
      <input type="hidden" name="options" value={optionsJson} />
      <div className="flex items-center gap-3">
        <Button ref={buttonRef} type="button" variant="outline" onClick={e => preview(e.currentTarget)} disabled={busy || !tableOk}>
          <Eye data-preview-button />{result && (structuralChanged || typeChanged) ? '重新预览' : '预览'}
        </Button>
        {!tableOk && <span className="text-sm text-slate-400">先填表名</span>}
        {busy && <span className="text-sm text-slate-500">正在读取…</span>}
      </div>
      <FieldDescription>预览不保存文件；确认登记时按这里确认的选项读取。</FieldDescription>

      {fetcher.data?.previewError && (
        <Alert variant="destructive" role="alert" className="mt-4">
          <CircleAlert />
          <AlertTitle>预览失败</AlertTitle>
          <AlertDescription>{fetcher.data.previewError}</AlertDescription>
        </Alert>
      )}

      {result && (
        <>
          <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Field>
              <FieldLabel htmlFor="preview-encoding">编码</FieldLabel>
              <NativeSelect id="preview-encoding" value={encoding} onChange={e => changeStructure({ encoding: e.target.value as 'utf-8' | 'gbk' })}>
                <NativeSelectOption value="utf-8">UTF-8</NativeSelectOption>
                <NativeSelectOption value="gbk">GBK</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="preview-delim">分隔符</FieldLabel>
              <NativeSelect id="preview-delim" value={delim} onChange={e => changeStructure({ delim: e.target.value })}>
                {DELIMS.map(d => <NativeSelectOption key={d} value={d}>{d === '\t' ? 'Tab' : d}</NativeSelectOption>)}
              </NativeSelect>
            </Field>
            <Field orientation="horizontal" className="mt-7">
              <input type="checkbox" id="preview-header" className="size-4" checked={header} onChange={e => changeStructure({ header: e.target.checked })} />
              <FieldLabel htmlFor="preview-header">第一行是表头</FieldLabel>
            </Field>
            <Field>
              <FieldLabel htmlFor="preview-skip">表头前跳过的行数</FieldLabel>
              <Input id="preview-skip" type="number" min={0} max={1000} value={skip} onChange={e => changeStructure({ skip: e.target.value })} />
            </Field>
          </div>

          <div className="mt-4">
            <div className="mb-2 text-sm font-medium">列类型</div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {result.columns.map(c => (
                <div key={c.name} className="grid grid-cols-[1fr_10rem] items-center gap-2">
                  <span className="truncate font-mono text-xs" title={c.name}>{c.name}</span>
                  <NativeSelect
                    aria-label={`${c.name} 的类型`}
                    value={types[c.name] ?? c.type}
                    onChange={e => setTypes({ ...types, [c.name]: e.target.value })}
                  >
                    {(COLUMN_TYPES.includes(c.type) ? COLUMN_TYPES : [...COLUMN_TYPES, c.type]).map(t => (
                      <NativeSelectOption key={t} value={t}>{t}</NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4">
            <div className="mb-2 text-sm font-medium">前 {result.rows.length} 行（最多 20 行）</div>
            <div className="overflow-x-auto rounded-2xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {result.columns.map(c => <TableHead key={c.name} className="whitespace-nowrap">{c.name}</TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row, i) => (
                    <TableRow key={i}>
                      {row.map((v, j) => <TableCell key={j} className="whitespace-nowrap font-mono text-xs">{v ?? <span className="text-slate-300">空</span>}</TableCell>)}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
