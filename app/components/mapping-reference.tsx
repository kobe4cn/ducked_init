// app/components/mapping-reference.tsx —— 编写映射时放在编辑框旁的对照面板：源表各列的统计（类型、空值率、不同取值数、主键、水位线、常见取值），
// 目标实体的标准字段（类型、是否必填、标准枚举）。按编辑框里的 YAML 标出已对应的字段与还没对应的必填字段；点击列名或字段名插入到编辑框光标处
import { useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { entityOf, FIELD_TYPES } from '~/lib/canonical-model';
import { mappingOutline } from '~/lib/mapping-outline';
import { MappingEditor, type MappingEditorHandle } from '~/components/mapping-editor';
import { Badge } from '~/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export interface ReferenceColumn { name: string; type: string; nullRate: number; distinct: number; top: { value: string; rows: number }[] | null }
export interface ReferenceTable { name: string; sampleRows: number; primaryKey: string[]; watermark: string | null; columns: ReferenceColumn[] }

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

const nameButton = (name: string, onInsert: (text: string) => void) => (
  <button type="button" className="font-mono hover:underline" title="插入到编辑框光标处" onClick={() => onInsert(name)}>{name}</button>
);

/** 映射 YAML 编辑框，旁边是对照面板；点击面板里的列名或字段名插入到编辑框光标处 */
export function MappingEditorWithReference({ defaultValue, table, entity }: { defaultValue: string; table: ReferenceTable | null; entity: string }) {
  const editor = useRef<MappingEditorHandle>(null);
  const [yaml, setYaml] = useState(defaultValue);
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <MappingEditor ref={editor} defaultValue={defaultValue} onValueChange={setYaml} />
      <MappingReference table={table} entity={entity} yaml={yaml} onInsert={text => editor.current?.insert(text)} />
    </div>
  );
}

/**
 * 对照面板。必填字段是去重键：YAML 里 dedupe.key 声明的，没有声明时是实体的主键（与映射校验的规则一致，未对应时校验不通过）
 */
function MappingReference({ table, entity, yaml, onInsert }: {
  /** 所选的源表；表不在同步范围内或还没采集时为 null */
  table: ReferenceTable | null;
  entity: string;
  yaml: string;
  onInsert: (text: string) => void;
}) {
  const target = entityOf(entity);
  const outline = mappingOutline(yaml);
  const mapped = outline.fields;
  const requiredFields = outline.dedupeKey ?? target?.key ?? [];
  return (
    <div className="max-h-[48rem] space-y-4 overflow-y-auto text-xs">
      {table ? (
        <div data-reference-table={table.name} className="space-y-1">
          <div className="font-medium">{`源表 ${table.name}（基于前 ${table.sampleRows.toLocaleString('zh-CN')} 行样本）`}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>列</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>空值率</TableHead>
                <TableHead>不同取值</TableHead>
                <TableHead>常见取值（样本行数）</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.columns.map(c => (
                <TableRow
                  key={c.name}
                  data-reference-column={c.name}
                  data-primary-key={table.primaryKey.includes(c.name) || undefined}
                  data-watermark={table.watermark === c.name || undefined}
                >
                  <TableCell className="space-x-1">
                    {nameButton(c.name, onInsert)}
                    {table.primaryKey.includes(c.name) && <Badge variant="secondary">主键</Badge>}
                    {table.watermark === c.name && <Badge variant="outline">水位线</Badge>}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">{c.type}</TableCell>
                  <TableCell>{pct(c.nullRate)}</TableCell>
                  <TableCell>{c.distinct.toLocaleString('zh-CN')}</TableCell>
                  <TableCell className="whitespace-normal">{c.top?.map(t => `${t.value}（${t.rows.toLocaleString('zh-CN')}）`).join('，') || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="text-muted-foreground">没有可对照的源表：表须在同步范围内、已采集。</div>
      )}

      {target ? (
        <div data-reference-entity={target.name} className="space-y-1">
          <div className="font-medium">{`${target.label}（${target.name}）的标准字段：已对应的打勾，去重键必填`}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>字段</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>说明</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {target.fields.map(f => {
                const required = requiredFields.includes(f.name);
                const missing = required && !mapped.has(f.name);
                return (
                  <TableRow
                    key={f.name}
                    data-reference-field={f.name}
                    data-mapped={mapped.has(f.name) || undefined}
                    data-missing-required={missing || undefined}
                    className={missing ? 'bg-destructive/10' : undefined}
                  >
                    <TableCell>{mapped.has(f.name) && <Check className="size-3.5" aria-label="已对应" />}</TableCell>
                    <TableCell className="space-x-1">
                      {nameButton(f.name, onInsert)}
                      {required && <Badge variant={missing ? 'destructive' : 'secondary'}>{missing ? '必填，未对应' : '必填'}</Badge>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{FIELD_TYPES[f.type].label}</TableCell>
                    <TableCell className="whitespace-normal">
                      {f.label}
                      {f.enum && <div className="text-muted-foreground">{`标准枚举：${f.enum.join('、')}`}</div>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="text-muted-foreground">{`${entity} 不是标准实体，没有标准字段可对照。`}</div>
      )}
    </div>
  );
}
