// app/components/mapping-form.tsx —— 映射编辑区的「表单」标签页：按目标实体列出全部标准字段（类型、说明、是否必填），每个字段选源列
// （带列类型与常见取值）与一种常用转换，或写自定义表达式（可插入白名单函数）；枚举字段另有「源值 → 标准值」的值对照与兜底。
// 表单不存数据，每次修改都由 writeField 写回同一份 YAML（ADR-0017）；表单不认识的写法只读显示原表达式。
// 选到一半（还没选源列、表达式写不完整）时只留在这一行，不写进 YAML；还没对应的源值只显示（标黄），不写进值字典。
// 内置敏感字段带「敏感」徽标，不能取消。标准字段之后是扩展字段：已有的可改名、类型、中文名与是否敏感（敏感的只能是文本），取消勾选即删除；
// 下面列出还没用到的源列，勾选即加为扩展字段（名称或格式像敏感信息的默认标成敏感）。
// 消费者（customer）映射最后是「身份打通」：从已映射的敏感字段里勾选匹配字段并排序（越靠前优先级越高），不选时用平台默认规则
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseDocument } from 'yaml';
import { entityOf, FIELD_TYPE_NAMES, FIELD_TYPES, type CanonicalEntity, type CanonicalField, type FieldType } from '~/lib/canonical-model';
import { parseExpression } from '~/lib/mapping-expr';
import {
  dictionaryRows, expressionOf, extensionNameProblem, identityCandidates, newExtension, readExtensions, readForm, readIdentity, seedDictionary,
  TRANSFORMS, unusedColumns, writeExtension, writeField, writeIdentity, writtenDictionary,
  type DictionaryEntry, type ExtensionChoice, type ExtensionForm, type FieldChoice, type FieldForm, type Part, type TransformId,
} from '~/lib/mapping-form';
import type { ReferenceColumn, ReferenceFunction, ReferenceTable } from '~/components/mapping-reference';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';

/** 表单显示不了时的说明（YAML 写错了、实体对不上），附到 YAML 标签页的入口 */
function Notice({ children, onEditYaml }: { children: string; onEditYaml: () => void }) {
  return (
    <div data-mapping-form-notice className="space-y-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
      <div>{children}</div>
      <Button type="button" size="sm" variant="outline" onClick={onEditYaml}>到 YAML 标签页修改</Button>
    </div>
  );
}

/** 打开表单时定位到的字段，以及要加进它值对照表的源值（详情页「落入兜底」的取值） */
export interface FormFocus { field: string; add: string[] }

/** 表单标签页：目标实体的全部标准字段，改动写回 yaml 后交给 onChange */
export function MappingForm({ yaml, entity, table, functions, focus, onChange, onEditYaml }: {
  yaml: string;
  /** 目标实体：表单按它列出标准字段 */
  entity: string;
  /** 源表；没有时源列手填 */
  table: ReferenceTable | null;
  functions: ReferenceFunction[];
  focus?: FormFocus | null;
  onChange: (yaml: string) => void;
  /** 切到 YAML 标签页 */
  onEditYaml: () => void;
}) {
  const doc = useMemo(() => parseDocument(yaml), [yaml]);
  // 只在打开时定位一次：保存后 loader 重新给出的 focus 不再滚动
  const focused = focus?.field;
  useEffect(() => {
    if (focused) document.getElementById(fieldId(focused))?.scrollIntoView({ block: 'center' });
  }, [focused]);
  const target = entityOf(entity);
  if (!target) return <Notice onEditYaml={onEditYaml}>{`${entity} 不是标准实体，表单只列标准实体的字段，请在 YAML 里编写。`}</Notice>;
  if (doc.errors.length) {
    const e = doc.errors[0];
    const at = e.linePos ? `第 ${e.linePos[0].line} 行：` : '';
    return <Notice onEditYaml={onEditYaml}>{`YAML 有语法错误（${at}${e.message.split('\n')[0]}），改好之前表单无法显示。`}</Notice>;
  }
  const written = doc.get('entity');
  if (typeof written === 'string' && written !== target.name) {
    return <Notice onEditYaml={onEditYaml}>{`YAML 里写的实体是 ${written}，与目标实体 ${target.name} 不一致；请改成一致或按规则重新生成草稿。`}</Notice>;
  }
  const write = (field: string, choice: FieldChoice | null) => {
    // writeField 会改 Document，另解析一份，不动渲染用的 doc
    const next = parseDocument(yaml);
    writeField(next, target, field, choice);
    onChange(next.toString());
  };
  const writeExt = (name: string, choice: ExtensionChoice | null) => {
    const next = parseDocument(yaml);
    writeExtension(next, name, choice);
    onChange(next.toString());
  };
  const writeMatch = (match: string[]) => {
    const next = parseDocument(yaml);
    writeIdentity(next, match);
    onChange(next.toString());
  };
  return (
    <div className="max-h-[48rem] divide-y overflow-y-auto rounded-lg border text-sm">
      {readForm(doc, target).map(form => (
        <FieldRow
          key={form.field}
          entity={target.name}
          form={form}
          field={target.fields.find(f => f.name === form.field)!}
          table={table}
          functions={functions}
          pending={focus?.field === form.field ? focus.add : []}
          onWrite={choice => write(form.field, choice)}
          onEditYaml={onEditYaml}
        />
      ))}
      <Extensions doc={doc} table={table} onWrite={writeExt} onEditYaml={onEditYaml} />
      {target.name === 'customer' && <Identity doc={doc} entity={target} onWrite={writeMatch} onEditYaml={onEditYaml} />}
    </div>
  );
}

const transformOf = (id: TransformId) => TRANSFORMS.find(t => t.id === id)!;

const fieldId = (field: string) => `form-field-${field}`;

const choiceOf = (form: FieldForm): FieldChoice | null => form.transform && {
  transform: form.transform, column: form.column, args: form.args, parts: form.parts, raw: form.raw,
  dictionary: form.dictionary, ...(form.otherwise !== undefined && { otherwise: form.otherwise }),
};

/** 选择写进 YAML 后的样子；与 YAML 读出的一致时这一行不用重新读 */
const syncKey = (choice: FieldChoice | null, type: FieldType) =>
  choice ? JSON.stringify([expressionOf(choice, type), writtenDictionary(choice.dictionary) ?? [], choice.otherwise === undefined ? 0 : choice.otherwise]) : '';

/** 选择还缺什么（给出时不写进 YAML）；写得出表达式时为 null */
function missing(choice: FieldChoice, type: FieldType): string | null {
  const def = transformOf(choice.transform);
  if (def.column && !choice.column) return '选一个源列';
  const arg = def.args.find((a, i) => !a.optional && !choice.args?.[i]?.trim());
  if (arg) return `填写${arg.label}`;
  if (choice.transform === 'concat') {
    if (!choice.parts?.length) return '至少加一段源列或文本';
    if (choice.parts.some(p => 'column' in p && !p.column)) return '每段源列都要选一列';
  }
  const entries = choice.dictionary ?? [];
  if (entries.some(e => e.to !== null && !e.from)) return '值对照里对应了标准值的行要填源值';
  const twice = (writtenDictionary(entries) ?? []).find((e, i, all) => all.findIndex(x => x.from === e.from) !== i);
  if (twice) return `值对照里源值 ${twice.from} 写了两次，只留一行`;
  try {
    parseExpression(expressionOf(choice, type));
    return null;
  } catch (e) {
    return choice.transform === 'custom' ? `表达式有误：${(e as Error).message}` : (e as Error).message;
  }
}

/** 一个标准字段：说明、源列与转换；只读时显示原表达式 */
function FieldRow({ entity, form, field, table, functions, pending, onWrite, onEditYaml }: {
  entity: string;
  form: FieldForm;
  field: CanonicalField;
  table: ReferenceTable | null;
  functions: ReferenceFunction[];
  /** 要作为待对应的行加进值对照表的源值 */
  pending: string[];
  onWrite: (choice: FieldChoice | null) => void;
  onEditYaml: () => void;
}) {
  const [choice, setChoice] = useState(() => choiceOf(form));
  // 这一行最后写进 YAML 的样子；YAML 在别处改了（YAML 标签页、生成草稿）时按 YAML 重新读出
  const current = syncKey(choiceOf(form), field.type);
  const [synced, setSynced] = useState(current);
  if (current !== synced) {
    setSynced(current);
    setChoice(choiceOf(form));
  }
  const problem = choice && missing(choice, field.type);
  const unmapped = form.required && !form.raw;

  const update = (next: FieldChoice | null) => {
    setChoice(next);
    if (!next) {
      setSynced('');
      onWrite(null);
    } else if (!missing(next, field.type)) {
      setSynced(syncKey(next, field.type));
      onWrite(next);
    }
  };
  const topValues = (column?: string | null) => table?.columns.find(c => c.name === column)?.top?.map(t => t.value) ?? [];
  // 新对应的枚举字段选了源列：按常见取值新建值对照，其他取值默认记为空
  const newEnum = form.dictionary && !form.raw && !form.dictionary.length && form.otherwise === undefined;
  const setColumn = (next: FieldChoice, column: string) => update(
    newEnum && !next.dictionary?.length && column
      ? { ...next, column, dictionary: seedDictionary(entity, field.name, topValues(column)), otherwise: next.otherwise === undefined ? null : next.otherwise }
      : { ...next, column },
  );
  const switchTo = (id: TransformId | '') => {
    if (!id) return update(null);
    const def = transformOf(id);
    let raw = form.raw;
    if (choice && !missing(choice, field.type)) raw = expressionOf(choice, field.type);
    update({
      transform: id,
      column: def.column ? (choice?.column ?? null) : null,
      args: def.args.map(a => a.options?.[0].value ?? ''),
      parts: id === 'concat' ? (choice?.column ? [{ column: choice.column }] : []) : undefined,
      raw: id === 'custom' ? raw : undefined,
      // 换转换时值对照与兜底照旧；新对应的枚举字段默认其他取值记为空
      dictionary: choice?.dictionary ?? form.dictionary,
      ...(choice ? choice.otherwise !== undefined && { otherwise: choice.otherwise } : newEnum && { otherwise: null }),
    });
  };
  const def = choice && transformOf(choice.transform);

  return (
    <div id={fieldId(field.name)} data-form-field={field.name} data-readonly={form.readonly || undefined} className={`space-y-2 p-3 ${unmapped ? 'bg-destructive/10' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono font-medium">{field.name}</span>
        <span>{field.label}</span>
        <span className="text-xs text-muted-foreground">{FIELD_TYPES[field.type].label}</span>
        {field.pii && <Badge variant="outline" title="标准层只存加盐哈希，不能取消">敏感信息</Badge>}
        {form.required && <Badge variant={unmapped ? 'destructive' : 'secondary'}>{unmapped ? '必填（去重键），未对应' : '必填（去重键）'}</Badge>}
      </div>
      <div className="text-xs text-muted-foreground">
        {field.description}
        {field.enum && `。标准枚举：${field.enum.join('、')}`}
      </div>

      {form.readonly ? (
        <div className="space-y-1">
          {form.raw && <code className="block rounded bg-muted px-2 py-1 font-mono text-xs whitespace-pre-wrap">{form.raw}</code>}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{form.reason}</span>
            <Button type="button" size="xs" variant="link" onClick={onEditYaml}>到 YAML 修改</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect size="sm" aria-label={`${field.name} 的转换`} value={choice?.transform ?? ''} onChange={e => switchTo(e.target.value as TransformId | '')}>
            <NativeSelectOption value="">不对应</NativeSelectOption>
            {TRANSFORMS.map(t => <NativeSelectOption key={t.id} value={t.id}>{t.label}</NativeSelectOption>)}
          </NativeSelect>
          {choice && def?.column && (
            <ColumnPicker label={`${field.name} 的源列`} table={table} value={choice.column ?? ''} onChange={column => setColumn(choice, column)} />
          )}
          {choice && def?.args.map((a, i) => {
            const value = choice.args?.[i] ?? '';
            const set = (v: string) => update({ ...choice, args: def.args.map((_, j) => (j === i ? v : (choice.args?.[j] ?? ''))) });
            return a.options ? (
              <NativeSelect key={a.label} size="sm" aria-label={a.label} value={value} onChange={e => set(e.target.value)}>
                {a.options.map(o => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
              </NativeSelect>
            ) : (
              <Input key={a.label} className="h-7 w-56" aria-label={a.label} placeholder={a.hint ?? a.label} title={a.hint} value={value} onChange={e => set(e.target.value)} />
            );
          })}
          {choice?.transform === 'concat' && <PartsEditor table={table} parts={choice.parts ?? []} onChange={parts => update({ ...choice, parts })} />}
          {choice?.transform === 'custom' && <CustomExpression raw={choice.raw ?? ''} functions={functions} onChange={raw => update({ ...choice, raw })} />}
        </div>
      )}
      {!form.readonly && choice && form.dictionary && choice.transform !== 'fixed' && (
        <DictionaryEditor
          entity={entity}
          field={field}
          entries={choice.dictionary ?? []}
          otherwise={choice.otherwise}
          values={[...topValues(choice.column), ...pending]}
          onChange={(dictionary, otherwise) => update({ ...choice, dictionary, otherwise })}
        />
      )}

      {!form.readonly && problem && <div className="text-xs text-destructive">{`${problem}，之后才写进 YAML`}</div>}
      {form.basis && <div className="text-xs text-muted-foreground">{`依据：${form.basis}`}</div>}
    </div>
  );
}

/** 扩展字段区块：已有的扩展字段（可改，取消勾选即删除），以及还没用到的源列（勾选即加为扩展字段） */
function Extensions({ doc, table, onWrite, onEditYaml }: {
  doc: ReturnType<typeof parseDocument>;
  table: ReferenceTable | null;
  onWrite: (name: string, choice: ExtensionChoice | null) => void;
  onEditYaml: () => void;
}) {
  const { extensions, reason } = readExtensions(doc);
  const names = extensions.map(e => e.name);
  const unused = table ? unusedColumns(doc, table) : [];
  return (
    <div data-form-extensions className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">扩展字段</span>
        <span className="text-xs text-muted-foreground">标准模型里没有的租户特有字段，名字以 x_ 开头</span>
      </div>
      {reason ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{reason}</span>
          <Button type="button" size="xs" variant="link" onClick={onEditYaml}>到 YAML 修改</Button>
        </div>
      ) : (
        <>
          {/* 按位置作 key：改名时这一行不重新挂载，输入框不丢焦点 */}
          {extensions.map((form, i) => (
            <ExtensionRow key={i} form={form} others={names.filter(n => n !== form.name)} onWrite={choice => onWrite(form.name, choice)} onEditYaml={onEditYaml} />
          ))}
          {unused.length > 0 && <div className="pt-1 text-xs text-muted-foreground">没用到的源列，勾选即加为扩展字段：</div>}
          {unused.map(c => (
            <label key={c.name} data-unused-column={c.name} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={false} onChange={() => {
                const ext = newExtension(table!, c.name, names);
                onWrite(ext.name, ext);
              }} />
              <span className="font-mono">{columnLabel(c)}</span>
            </label>
          ))}
          {!table && !extensions.length && <div className="text-xs text-muted-foreground">没有可对照的源表，扩展字段请在 YAML 里编写</div>}
        </>
      )}
    </div>
  );
}

/** 一个已有的扩展字段：名字、类型、中文名可改，表达式只显示；名字不合格时只留在这一行，不写进 YAML */
function ExtensionRow({ form, others, onWrite, onEditYaml }: {
  form: ExtensionForm;
  /** 其他扩展字段的名字 */
  others: string[];
  onWrite: (choice: ExtensionChoice | null) => void;
  onEditYaml: () => void;
}) {
  const read = { name: form.name, type: form.type ?? 'string', label: form.label, sensitive: form.sensitive };
  const [draft, setDraft] = useState(read);
  // YAML 在别处改了时按 YAML 重新读出
  const current = JSON.stringify(read);
  const [synced, setSynced] = useState(current);
  if (current !== synced) {
    setSynced(current);
    setDraft(read);
  }
  const problem = extensionNameProblem(draft.name, others);
  const update = (next: typeof draft) => {
    setDraft(next);
    if (extensionNameProblem(next.name, others)) return;
    // 中文名写进 YAML 时去掉首尾空白：按写进去的样子记下，输入中的空格不被重新读出冲掉
    setSynced(JSON.stringify({ ...next, label: next.label.trim() }));
    onWrite({ ...next, expr: form.expr });
  };
  return (
    <div data-form-extension={form.name} data-readonly={form.readonly || undefined} className="space-y-1 rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <input type="checkbox" checked aria-label={`保留扩展字段 ${form.name}`} disabled={form.readonly} onChange={() => onWrite(null)} />
        {form.readonly ? (
          <>
            <span className="font-mono">{form.name}</span>
            {form.sensitive && <Badge variant="outline">敏感信息</Badge>}
          </>
        ) : (
          <>
            <Input className="h-7 w-48 font-mono" aria-label={`${form.name} 的名字`} value={draft.name} onChange={e => update({ ...draft, name: e.target.value })} />
            <NativeSelect
              size="sm"
              aria-label={`${form.name} 的类型`}
              value={draft.type}
              disabled={form.dictionary || draft.sensitive}
              title={form.dictionary ? '带值字典或兜底的扩展字段只能是文本' : draft.sensitive ? '敏感字段只存哈希，只能是文本' : undefined}
              onChange={e => update({ ...draft, type: e.target.value as FieldType })}
            >
              {FIELD_TYPE_NAMES.map(t => <NativeSelectOption key={t} value={t}>{`${t}（${FIELD_TYPES[t].label}）`}</NativeSelectOption>)}
            </NativeSelect>
            <Input className="h-7 w-40" aria-label={`${form.name} 的中文名`} placeholder="中文名（可不填）" value={draft.label} onChange={e => update({ ...draft, label: e.target.value })} />
            <label className="flex items-center gap-1 text-xs" title={form.dictionary ? '带值字典或兜底的扩展字段不能标成敏感' : '标准层只存加盐哈希'}>
              {/* 标成敏感时类型改为文本 */}
              <input
                type="checkbox"
                checked={draft.sensitive}
                disabled={form.dictionary}
                onChange={e => update({ ...draft, sensitive: e.target.checked, ...(e.target.checked && { type: 'string' as const }) })}
              />
              敏感
            </label>
          </>
        )}
      </div>
      {form.expr && <code className="block rounded bg-muted px-2 py-1 font-mono text-xs whitespace-pre-wrap">{form.expr}</code>}
      {form.dictionary && !form.readonly && <div className="text-xs text-muted-foreground">带值字典或兜底，请在 YAML 里修改对照</div>}
      {form.readonly && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{form.reason}</span>
          <Button type="button" size="xs" variant="link" onClick={onEditYaml}>到 YAML 修改</Button>
        </div>
      )}
      {!form.readonly && problem && <div className="text-xs text-destructive">{`${problem}，之后才写进 YAML`}</div>}
    </div>
  );
}

/** 身份打通的匹配字段：勾选已映射的敏感字段，选中的按优先级排列、可上下移动；YAML 里有但已不可选的字段标出，只能去掉 */
function Identity({ doc, entity, onWrite, onEditYaml }: {
  doc: ReturnType<typeof parseDocument>;
  entity: CanonicalEntity;
  onWrite: (match: string[]) => void;
  onEditYaml: () => void;
}) {
  const { match, reason } = readIdentity(doc);
  const candidates = identityCandidates(doc, entity);
  const move = (i: number, by: number) => {
    const next = [...match];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onWrite(next);
  };
  return (
    <div data-form-identity className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">身份打通</span>
        <span className="text-xs text-muted-foreground">
          按哪些敏感字段的哈希判断是同一个人，越靠前优先级越高：更高优先级的字段双方都有值且不同时，不按后面的字段合并。不选时用默认规则（手机号、邮箱、外部 ID）
        </span>
      </div>
      {reason ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{reason}</span>
          <Button type="button" size="xs" variant="link" onClick={onEditYaml}>到 YAML 修改</Button>
        </div>
      ) : (
        <>
          {match.map((name, i) => (
            <div key={name} data-identity-match={name} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked aria-label={`不按 ${name} 匹配`} onChange={() => onWrite(match.filter(m => m !== name))} />
              <span className="w-6 text-muted-foreground">{i + 1}</span>
              <span className="font-mono">{name}</span>
              {!candidates.includes(name) && <span className="text-destructive">没有映射或不是敏感字段，请去掉</span>}
              <Button type="button" size="xs" variant="ghost" aria-label={`${name} 提前`} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
              <Button type="button" size="xs" variant="ghost" aria-label={`${name} 推后`} disabled={i === match.length - 1} onClick={() => move(i, 1)}>↓</Button>
            </div>
          ))}
          {candidates.filter(c => !match.includes(c)).map(name => (
            <label key={name} data-identity-candidate={name} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={false} onChange={() => onWrite([...match, name])} />
              <span className="font-mono">{name}</span>
            </label>
          ))}
          {!candidates.length && !match.length && <div className="text-xs text-muted-foreground">还没有映射敏感字段，映射手机号、邮箱等之后才能选</div>}
        </>
      )}
    </div>
  );
}

const NULL_OTHERWISE = '__null__';

/**
 * 枚举字段的值对照：「源值 → 标准值」一行一条，后面接上样本常见取值与落入兜底里还没对照的源值（标黄，建议对应、不强制），可手动加源值；
 * 下面选兜底：不写（没对上的取值让合并失败）、记为空或记为某个标准值
 */
function DictionaryEditor({ entity, field, entries, otherwise, values, onChange }: {
  entity: string;
  field: CanonicalField;
  entries: DictionaryEntry[];
  otherwise: string | null | undefined;
  /** 常见取值与要加进来的源值 */
  values: string[];
  onChange: (entries: DictionaryEntry[], otherwise: string | null | undefined) => void;
}) {
  const standard = field.enum!;
  const rows = dictionaryRows(entity, field.name, entries, values);
  const set = (entries: DictionaryEntry[]) => onChange(entries, otherwise);
  // 表单上的行与 entries 对齐：extra 的行在对应时追加进 entries
  const setTo = (i: number, to: string | null) => {
    const row = rows[i];
    set(row.extra ? [...entries, { from: row.from, to }] : entries.map((e, j) => (j === i ? { ...e, to } : e)));
  };
  const suggested = rows.filter(r => r.to === null && r.suggestion);
  const fillSuggested = () => set(rows.flatMap(({ from, to, extra, suggestion }) => (extra && !suggestion ? [] : [{ from, to: to ?? suggestion ?? null }])));
  return (
    <div data-form-dictionary={field.name} className="space-y-2 rounded-md border bg-muted/30 p-2 text-xs">
      <div className="text-muted-foreground">值对照（源值 → 标准值）：合并时只认这里写了的源值，源值与标准值相同也要写上</div>
      {rows.map((r, i) => (
        <div key={r.extra ? `extra-${r.from}` : i} data-dictionary-row={r.from} data-unmapped={r.to === null || undefined} className={`flex flex-wrap items-center gap-2 rounded px-1 py-0.5 ${r.to === null ? 'bg-amber-100' : ''}`}>
          {r.extra
            ? <span className="w-40 truncate font-mono" title={r.from}>{r.from}</span>
            : <Input className="h-7 w-40 font-mono" aria-label={`第 ${i + 1} 个源值`} placeholder="源值" value={r.from} onChange={e => set(entries.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />}
          <span className="text-muted-foreground">→</span>
          <NativeSelect size="sm" aria-label={`${r.from || `第 ${i + 1} 个源值`} 对应的标准值`} value={r.to ?? ''} onChange={e => setTo(i, e.target.value || null)}>
            <NativeSelectOption value="">未对应</NativeSelectOption>
            {r.to && !standard.includes(r.to) && <NativeSelectOption value={r.to}>{`${r.to}（不是标准值）`}</NativeSelectOption>}
            {standard.map(v => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}
          </NativeSelect>
          {r.to === null && <span className="text-amber-700">{r.extra ? '样本里出现过，建议对应' : '未对应，不写进值字典'}</span>}
          {r.to === null && r.suggestion && <Button type="button" size="xs" variant="link" onClick={() => setTo(i, r.suggestion!)}>{`对应为 ${r.suggestion}`}</Button>}
          {!r.extra && <Button type="button" size="xs" variant="ghost" aria-label={`去掉源值 ${r.from}`} onClick={() => set(entries.filter((_, j) => j !== i))}>×</Button>}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="xs" variant="outline" onClick={() => set([...entries, { from: '', to: null }])}>加一个源值</Button>
        {suggested.length > 1 && <Button type="button" size="xs" variant="outline" onClick={fillSuggested}>{`按建议对应 ${suggested.length} 个源值`}</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span>没对上的取值</span>
        <NativeSelect
          size="sm"
          aria-label={`${field.name} 的兜底`}
          value={otherwise === undefined ? '' : (otherwise ?? NULL_OTHERWISE)}
          onChange={e => onChange(entries, e.target.value === '' ? undefined : e.target.value === NULL_OTHERWISE ? null : e.target.value)}
        >
          <NativeSelectOption value="">不写兜底（合并失败并列出这些取值）</NativeSelectOption>
          <NativeSelectOption value={NULL_OTHERWISE}>其他取值记为空</NativeSelectOption>
          {otherwise && !standard.includes(otherwise) && <NativeSelectOption value={otherwise}>{`记为 ${otherwise}（不是标准值）`}</NativeSelectOption>}
          {standard.map(v => <NativeSelectOption key={v} value={v}>{`其他取值记为 ${v}`}</NativeSelectOption>)}
        </NativeSelect>
      </div>
    </div>
  );
}

/** 源列的说明：类型与常见取值 */
const columnLabel = (c: ReferenceColumn) => {
  const top = c.top?.slice(0, 3).map(t => t.value).join('、');
  return `${c.name}（${c.type}${top ? `，常见：${top}` : ''}）`;
};

/** 选源列；没有可对照的源表时手填列名 */
function ColumnPicker({ label, table, value, onChange }: { label: string; table: ReferenceTable | null; value: string; onChange: (column: string) => void }) {
  if (!table) return <Input className="h-7 w-48 font-mono" aria-label={label} placeholder="源列名" value={value} onChange={e => onChange(e.target.value)} />;
  const known = table.columns.some(c => c.name === value);
  return (
    <NativeSelect size="sm" aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
      <NativeSelectOption value="">选源列…</NativeSelectOption>
      {value && !known && <NativeSelectOption value={value}>{`${value}（源表里没有这一列）`}</NativeSelectOption>}
      {table.columns.map(c => <NativeSelectOption key={c.name} value={c.name}>{columnLabel(c)}</NativeSelectOption>)}
    </NativeSelect>
  );
}

/** 拼接的各段：源列或一段文本，按顺序拼起来 */
function PartsEditor({ table, parts, onChange }: { table: ReferenceTable | null; parts: Part[]; onChange: (parts: Part[]) => void }) {
  const set = (i: number, p: Part) => onChange(parts.map((q, j) => (j === i ? p : q)));
  return (
    <div className="flex flex-wrap items-center gap-2">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1">
          {'column' in p
            ? <ColumnPicker label={`第 ${i + 1} 段的源列`} table={table} value={p.column} onChange={column => set(i, { column })} />
            : <Input className="h-7 w-28" aria-label={`第 ${i + 1} 段的文本`} placeholder="文本" value={p.text} onChange={e => set(i, { text: e.target.value })} />}
          <Button type="button" size="xs" variant="ghost" aria-label={`去掉第 ${i + 1} 段`} onClick={() => onChange(parts.filter((_, j) => j !== i))}>×</Button>
        </span>
      ))}
      <Button type="button" size="xs" variant="outline" onClick={() => onChange([...parts, { column: '' }])}>加一列</Button>
      <Button type="button" size="xs" variant="outline" onClick={() => onChange([...parts, { text: '' }])}>加一段文本</Button>
    </div>
  );
}

/** 自定义表达式，旁边可把白名单函数插入到光标处 */
function CustomExpression({ raw, functions, onChange }: { raw: string; functions: ReferenceFunction[]; onChange: (raw: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const insert = (name: string) => {
    const el = input.current;
    if (!el) return;
    const at = el.selectionStart ?? raw.length;
    const next = `${raw.slice(0, at)}${name}(${raw.slice(el.selectionEnd ?? at)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + name.length + 1, at + name.length + 1);
    });
  };
  return (
    <>
      <Input ref={input} className="h-7 w-80 font-mono" aria-label="自定义表达式" placeholder="如 coalesce(pay_amount, pay_fen / 100)" value={raw} onChange={e => onChange(e.target.value)} />
      <NativeSelect size="sm" aria-label="插入函数" value="" onChange={e => e.target.value && insert(e.target.value)}>
        <NativeSelectOption value="">插入函数…</NativeSelectOption>
        {functions.map(f => <NativeSelectOption key={f.name} value={f.name}>{`${f.signature}：${f.label}`}</NativeSelectOption>)}
      </NativeSelect>
    </>
  );
}
