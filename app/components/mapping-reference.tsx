// app/components/mapping-reference.tsx —— 编写映射时放在编辑框旁的对照面板：源表各列的统计（类型、空值率、不同取值数、主键、水位线、常见取值），
// 目标实体的标准字段（类型、是否必填、标准枚举）、写法速查与白名单函数。按编辑框里的 YAML 标出已对应的字段与还没对应的必填字段；
// 点击列名、字段名、写法或函数插入到编辑框光标处。编辑区分「表单 / YAML」两个标签页，两边是同一份 YAML，始终由 YAML 框提交（ADR-0017）
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Check } from 'lucide-react';
import { entityOf, FIELD_TYPES } from '~/lib/canonical-model';
import { mappingOutline } from '~/lib/mapping-outline';
import { MappingEditor, type MappingEditorHandle } from '~/components/mapping-editor';
import { MappingForm, type FormFocus } from '~/components/mapping-form';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export interface ReferenceColumn { name: string; type: string; nullRate: number; distinct: number; top: { value: string; rows: number }[] | null }
export interface ReferenceTable { name: string; sampleRows: number; primaryKey: string[]; watermark: string | null; columns: ReferenceColumn[] }
/** 白名单函数（由 loader 从 mapping-expr 的 FUNCTIONS 传来） */
export interface ReferenceFunction { name: string; signature: string; label: string }

/** 写法速查：每种写法一行能直接复制的例子 */
const SNIPPETS = [
  { kind: 'field', label: '普通字段', text: 'customer_id: buyer_id' },
  { kind: 'expr', label: '表达式', text: 'amount: coalesce(pay_amount, pay_fen / 100)' },
  { kind: 'dictionary', label: '值字典', text: "status: { expr: order_status, dictionary: { 已支付: paid, '2': refunded } }" },
  { kind: 'otherwise', label: '兜底值（值字典没对应上的取值写成它，可写 null）', text: 'status: { expr: order_status, dictionary: { 已支付: paid }, otherwise: cancelled }' },
  { kind: 'extension', label: '扩展字段（写在 extensions 下）', text: 'x_coupon_code: { type: string, expr: coupon_code }' },
  { kind: 'dedupe', label: '去重键', text: 'dedupe: { key: [order_id], latest: updated_at }' },
];

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** 点击插入到编辑框光标处的名字或写法；text 是插入的文本（默认同显示的） */
const nameButton = (name: string, onInsert: (text: string) => void, text = name) => (
  <button type="button" className="text-left font-mono hover:underline" title="插入到编辑框光标处" onClick={() => onInsert(text)}>{name}</button>
);

const TABS = [{ id: 'form', label: '表单' }, { id: 'yaml', label: 'YAML' }] as const;

/**
 * 映射编辑区（表单 / YAML 标签页），旁边是对照面板；点击面板里的列名、字段名、写法或函数插入到 YAML 框光标处（在表单标签页时先切到 YAML）。
 * 默认打开表单；表单要脚本，hydrate 之前（及不支持脚本时）只有 YAML 框可用，照常提交。给出 value 时由外部控制内容；
 * 给出 focus 时表单定位到那个字段，把要加的源值作为待对应的行列进它的值对照表
 */
export function MappingEditorWithReference({ defaultValue, value, onValueChange, table, entity, functions, focus }: {
  defaultValue: string;
  value?: string;
  onValueChange?: (yaml: string) => void;
  table: ReferenceTable | null;
  entity: string;
  functions: ReferenceFunction[];
  focus?: FormFocus | null;
}) {
  const editor = useRef<MappingEditorHandle>(null);
  const [own, setOwn] = useState(defaultValue);
  const yaml = value ?? own;
  const setYaml = onValueChange ?? setOwn;
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [chosen, setTab] = useState<(typeof TABS)[number]['id']>('form');
  const tab = hydrated ? chosen : 'yaml';
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-2">
        <div role="tablist" className="flex gap-1">
          {TABS.map(t => (
            <Button
              key={t.id}
              type="button"
              role="tab"
              size="sm"
              variant={tab === t.id ? 'secondary' : 'ghost'}
              aria-selected={tab === t.id}
              data-editor-tab={t.id}
              disabled={!hydrated && t.id === 'form'}
              title={!hydrated && t.id === 'form' ? '表单需要浏览器脚本，加载完成前请用 YAML 编写' : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </Button>
          ))}
        </div>
        {tab === 'form' && (
          <MappingForm yaml={yaml} entity={entity} table={table} functions={functions} focus={focus} onChange={setYaml} onEditYaml={() => setTab('yaml')} />
        )}
        <MappingEditor ref={editor} defaultValue={defaultValue} value={yaml} onValueChange={setYaml} hidden={tab !== 'yaml'} />
      </div>
      <MappingReference
        table={table}
        entity={entity}
        functions={functions}
        yaml={yaml}
        onInsert={text => {
          // 先让 YAML 框显示出来，插入时才能聚焦、按光标位置插入
          flushSync(() => setTab('yaml'));
          editor.current?.insert(text);
        }}
      />
    </div>
  );
}

/**
 * 对照面板。必填字段是去重键：YAML 里 dedupe.key 声明的，没有声明时是实体的主键（与映射校验的规则一致，未对应时校验不通过）
 */
function MappingReference({ table, entity, functions, yaml, onInsert }: {
  /** 所选的源表；表不在同步范围内或还没采集时为 null */
  table: ReferenceTable | null;
  entity: string;
  functions: ReferenceFunction[];
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

      <div className="space-y-1">
        <div className="font-medium">写法速查：点击插入到光标处</div>
        <Table>
          <TableBody>
            {SNIPPETS.map(s => (
              <TableRow key={s.kind} data-reference-snippet={s.kind}>
                <TableCell className="text-muted-foreground">{s.label}</TableCell>
                <TableCell className="whitespace-normal">{nameButton(s.text, onInsert)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-1">
        <div className="font-medium">表达式可用的函数（白名单）</div>
        <Table>
          <TableBody>
            {functions.map(f => (
              <TableRow key={f.name} data-reference-function={f.name}>
                <TableCell>{nameButton(f.signature, onInsert, `${f.name}(`)}</TableCell>
                <TableCell className="whitespace-normal">{f.label}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
