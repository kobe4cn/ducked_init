// app/components/mapping-reference.tsx —— 编写映射时放在编辑框旁的对照面板：源表各列的统计（类型、空值率、不同取值数、主键、水位线、常见取值），
// 目标实体的标准字段（类型、是否必填、标准枚举）或自定义实体已发布登记的字段（类型、是否敏感、说明、主键）、写法速查与白名单函数。按编辑框里的 YAML 标出已对应的字段与还没对应的必填字段；
// 点击列名、字段名、写法或函数插入到编辑框光标处。编辑区分「表单 / YAML」两个标签页，两边是同一份 YAML，始终由 YAML 框提交（ADR-0017）；
// 给出校验接口时，输入停顿后实时校验，问题列在编辑区下方，点一条定位到 YAML 里那一处；表单标签页里改为按区块显示在对应字段旁，下方不逐项列出
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseDocument } from 'yaml';
import { flushSync } from 'react-dom';
import { Check } from 'lucide-react';
import { Link } from 'react-router';
import { type CustomEntityField, entityOf, FIELD_TYPES, isCustomEntity } from '~/lib/canonical-model';
import { formUnavailable } from '~/lib/mapping-form';
import { functionText } from '~/lib/mapping-functions-text';
import { mappingOutline } from '~/lib/mapping-outline';
import { builtinName, CANONICAL_NAMES, ENUM_LABELS } from '~/lib/builtin-names';
import { useLocale, useT, type T } from '~/lib/i18n';
import { formatNumber } from '~/lib/format';
import { LiveMappingIssues, MappingEditor, type MappingEditorHandle } from '~/components/mapping-editor';
import { MappingForm, type FormFocus } from '~/components/mapping-form';
import { useMappingValidation } from '~/components/use-mapping-validation';
import { Button } from '~/components/ui/button';
import { Badge } from '~/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export interface ReferenceColumn {
  name: string; type: string; nullRate: number; distinct: number; top: { value: string; rows: number }[] | null;
  /** 样本里过半取值符合的文本格式（如 email、mobile） */
  formats?: { format: string; share: number }[];
}
/** view 为真时是已发布的源视图：只有列名与类型，没有列统计。keySpaces 是同一数据源里各实体已发布映射声明的键空间（实体 → 键空间），
 * customerSources 是本租户有已发布 customer 映射的其他数据源，relationOrigins 是已登记关系的起点（实体 → 起点字段 → 终点实体） */
export interface ReferenceTable {
  name: string; view?: true; sampleRows: number; primaryKey: string[]; watermark: string | null; columns: ReferenceColumn[]; keySpaces: Record<string, string>;
  customerSources: { id: string; name: string }[];
  relationOrigins: Record<string, Record<string, string>>;
}
/** 自定义实体最新的已发布登记（由 loader 从 publishedCustomEntities 传来） */
export interface RegisteredEntityView { label: string; fields: CustomEntityField[]; primaryKey: string[] }
/** 白名单函数（由 loader 从 mapping-expr 的 FUNCTIONS 传来） */
export interface ReferenceFunction { name: string; signature: string; label: string }

/** 写法速查：每种写法一行能直接复制的例子 */
const SNIPPETS = [
  { kind: 'field', text: 'customer_id: buyer_id' },
  { kind: 'expr', text: 'amount: coalesce(pay_amount, pay_fen / 100)' },
  { kind: 'dictionary', text: "status: { expr: order_status, dictionary: { PAID: paid, '2': refunded } }" },
  { kind: 'otherwise', text: 'status: { expr: order_status, dictionary: { PAID: paid }, otherwise: cancelled }' },
  { kind: 'extension', text: 'x_coupon_code: { type: string, expr: coupon_code }' },
  { kind: 'dedupe', text: 'dedupe: { key: [order_id], latest: updated_at }' },
] as const;

/** 写法速查每行的名称：中文与 SNIPPETS 的 kind 对应，这里写成字面量 t('…') 才能与词典对账（照 api-keys.tsx 的 scopeLabel） */
const snippetLabel = (t: T, kind: (typeof SNIPPETS)[number]['kind']) => ({
  field: t('普通字段'),
  expr: t('表达式'),
  dictionary: t('值字典'),
  otherwise: t('兜底值（值字典没对应上的取值写成它，可写 null）'),
  extension: t('扩展字段（写在 extensions 下）'),
  dedupe: t('去重键'),
})[kind];

const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

/** 点击插入到编辑框光标处的名字或写法；text 是插入的文本（默认同显示的） */
const nameButton = (t: T, name: string, onInsert: (text: string) => void, text = name) => (
  <button type="button" className="text-left font-mono hover:underline" title={t('插入到编辑框光标处')} onClick={() => onInsert(text)}>{name}</button>
);

/** 编辑区标签页的名称（TABS 只留 id，label 按界面语言取译文） */
const TABS = ['form', 'yaml'] as const;
const tabLabel = (t: T, id: (typeof TABS)[number]) => ({ form: t('表单'), yaml: t('YAML') })[id];

/**
 * 映射编辑区（表单 / YAML 标签页），旁边是对照面板；点击面板里的列名、字段名、写法或函数插入到 YAML 框光标处（在表单标签页时先切到 YAML）。
 * 默认打开表单；表单要脚本，hydrate 之前（及不支持脚本时）只有 YAML 框可用，照常提交。给出 value 时由外部控制内容；
 * 给出 focus 时表单定位到那个字段，把要加的源值作为待对应的行列进它的值对照表。
 * 给出 validateAction 时实时校验（validateExtra 随 YAML 一起提交）；只读的版本不用这个组件，不会校验
 */
export function MappingEditorWithReference({ defaultValue, value, onValueChange, table, entity, registered, functions, focus, validateAction, validateExtra }: {
  defaultValue: string;
  value?: string;
  onValueChange?: (yaml: string) => void;
  table: ReferenceTable | null;
  entity: string;
  /** 本租户自定义实体的已发布登记，按名称索引 */
  registered?: Record<string, RegisteredEntityView>;
  functions: ReferenceFunction[];
  focus?: FormFocus | null;
  /** 实时校验的接口地址（新建页 /mappings、详情页 /mappings/:id） */
  validateAction?: string;
  /** 随 YAML 一起提交的字段（新建页的 sourceId），变了也重新校验 */
  validateExtra?: Record<string, string>;
}) {
  const editor = useRef<MappingEditorHandle>(null);
  const [own, setOwn] = useState(defaultValue);
  const yaml = value ?? own;
  const setYaml = onValueChange ?? setOwn;
  const validation = useMappingValidation(validateAction, yaml, validateExtra);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [chosen, setTab] = useState<(typeof TABS)[number]>('form');
  const tab = hydrated ? chosen : 'yaml';
  const t = useT();
  // 表单显示出来时问题已在各区块里，编辑区下方不再逐项列出
  const formShown = useMemo(() => tab === 'form' && !formUnavailable(parseDocument(yaml), entity), [tab, yaml, entity]);
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div className="space-y-2">
        <div role="tablist" className="flex gap-1">
          {TABS.map(id => (
            <Button
              key={id}
              type="button"
              role="tab"
              size="sm"
              variant={tab === id ? 'secondary' : 'ghost'}
              aria-selected={tab === id}
              data-editor-tab={id}
              disabled={!hydrated && id === 'form'}
              title={!hydrated && id === 'form' ? t('表单需要浏览器脚本，加载完成前请用 YAML 编写') : undefined}
              onClick={() => setTab(id)}
            >
              {tabLabel(t, id)}
            </Button>
          ))}
        </div>
        {tab === 'form' && (
          <MappingForm yaml={yaml} entity={entity} table={table} functions={functions} focus={focus} issues={validation.issues} onChange={setYaml} onEditYaml={() => setTab('yaml')} />
        )}
        <MappingEditor ref={editor} defaultValue={defaultValue} value={yaml} onValueChange={setYaml} hidden={tab !== 'yaml'} invalid={validation.issues.length > 0 || !!validation.error} />
        <LiveMappingIssues
          validation={validation}
          inForm={formShown}
          onJump={(line, col) => {
            // 在表单标签页时先切到 YAML，编辑框显示出来才能定位
            flushSync(() => setTab('yaml'));
            editor.current?.jump(line, col);
          }}
        />
      </div>
      <MappingReference
        table={table}
        entity={entity}
        registered={registered?.[entity] ?? null}
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
function MappingReference({ table, entity, registered, functions, yaml, onInsert }: {
  /** 所选的源表；表不在同步范围内或还没采集时为 null */
  table: ReferenceTable | null;
  entity: string;
  /** 所选自定义实体的已发布登记；不是自定义实体或没登记时为 null */
  registered: RegisteredEntityView | null;
  functions: ReferenceFunction[];
  yaml: string;
  onInsert: (text: string) => void;
}) {
  const target = entityOf(entity);
  const outline = mappingOutline(yaml);
  const mapped = outline.fields;
  const requiredFields = outline.dedupeKey ?? target?.key ?? [];
  const t = useT();
  const locale = useLocale();
  return (
    <div className="max-h-[48rem] space-y-4 overflow-y-auto text-xs">
      {table ? (
        <div data-reference-table={table.name} className="space-y-1">
          <div className="font-medium">{table.view
            ? t('源视图 {name}（只有列与类型，没有列统计）', { name: table.name })
            : t('源表 {name}（基于前 {rows, number} 行样本）', { name: table.name, rows: table.sampleRows })}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('列')}</TableHead>
                <TableHead>{t('类型')}</TableHead>
                <TableHead>{t('空值率')}</TableHead>
                <TableHead>{t('不同取值')}</TableHead>
                <TableHead>{t('常见取值（样本行数）')}</TableHead>
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
                    {nameButton(t, c.name, onInsert)}
                    {table.primaryKey.includes(c.name) && <Badge variant="secondary">{t('主键')}</Badge>}
                    {table.watermark === c.name && <Badge variant="outline">{t('水位线')}</Badge>}
                  </TableCell>
                  <TableCell className="font-mono text-muted-foreground">{c.type}</TableCell>
                  <TableCell>{table.view ? '—' : pct(c.nullRate)}</TableCell>
                  <TableCell>{table.view ? '—' : formatNumber(locale, c.distinct)}</TableCell>
                  <TableCell className="whitespace-normal">{c.top?.map(v => t('{value}（{rows}）', { value: v.value, rows: formatNumber(locale, v.rows) })).join(t('，')) || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="text-muted-foreground">{t('没有可对照的源表：表须在同步范围内、已采集。')}</div>
      )}

      {target ? (
        <div data-reference-entity={target.name} className="space-y-1">
          <div className="font-medium">{t('{entity}（{name}）的标准字段：已对应的打勾，去重键必填', { entity: builtinName(t, target.label, CANONICAL_NAMES), name: target.name })}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>{t('字段')}</TableHead>
                <TableHead>{t('类型')}</TableHead>
                <TableHead>{t('说明')}</TableHead>
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
                    <TableCell>{mapped.has(f.name) && <Check className="size-3.5" aria-label={t('已对应')} />}</TableCell>
                    <TableCell className="space-x-1">
                      {nameButton(t, f.name, onInsert)}
                      {required && <Badge variant={missing ? 'destructive' : 'secondary'}>{missing ? t('必填，未对应') : t('必填')}</Badge>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{builtinName(t, FIELD_TYPES[f.type].label, ENUM_LABELS)}</TableCell>
                    <TableCell className="whitespace-normal">
                      {builtinName(t, f.label, CANONICAL_NAMES)}
                      {f.enum && <div className="text-muted-foreground">{t('标准枚举：{values}', { values: f.enum.join(t('、')) })}</div>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : registered ? (
        <div data-reference-registered={entity} className="space-y-1">
          <div className="font-medium">{t('{label}（{entity}）已发布登记的字段：写在 extensions 下', { label: registered.label, entity })}</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('字段')}</TableHead>
                <TableHead>{t('类型')}</TableHead>
                <TableHead>{t('说明')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {registered.fields.map(f => (
                <TableRow key={f.name} data-reference-field={f.name} data-primary-key={registered.primaryKey.includes(f.name) || undefined}>
                  <TableCell className="space-x-1">
                    {nameButton(t, f.name, onInsert)}
                    {registered.primaryKey.includes(f.name) && <Badge variant="secondary">{t('主键')}</Badge>}
                    {f.sensitive && <Badge variant="outline">{t('敏感')}</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{builtinName(t, FIELD_TYPES[f.type].label, ENUM_LABELS)}</TableCell>
                  <TableCell className="whitespace-normal">{f.description || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : isCustomEntity(entity) ? (
        <div data-reference-unregistered={entity} className="text-muted-foreground">
          {t('{entity} 未登记：先到', { entity })}<Link to="/entities" className="underline">{t('自定义实体')}</Link>{t('登记并发布，才有字段可对照。')}
        </div>
      ) : (
        <div className="text-muted-foreground">{t('{entity} 不是标准实体，没有标准字段可对照。', { entity })}</div>
      )}

      <div className="space-y-1">
        <div className="font-medium">{t('写法速查：点击插入到光标处')}</div>
        <Table>
          <TableBody>
            {SNIPPETS.map(s => (
              <TableRow key={s.kind} data-reference-snippet={s.kind}>
                <TableCell className="text-muted-foreground">{snippetLabel(t, s.kind)}</TableCell>
                <TableCell className="whitespace-normal">{nameButton(t, s.text, onInsert)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-1">
        <div className="font-medium">{t('表达式可用的函数（白名单）')}</div>
        <Table>
          <TableBody>
            {functions.map(f => {
              const text = functionText(t, f);
              return (
                <TableRow key={f.name} data-reference-function={f.name}>
                  <TableCell>{nameButton(t, text.signature, onInsert, `${f.name}(`)}</TableCell>
                  <TableCell className="whitespace-normal">{text.label}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
