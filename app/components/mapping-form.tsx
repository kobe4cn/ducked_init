// app/components/mapping-form.tsx —— 映射编辑区的「表单」标签页：按目标实体列出全部标准字段（类型、说明、是否必填），每个字段选源列
// （带列类型与常见取值）与一种常用转换，或写自定义表达式（可插入白名单函数）；枚举字段另有「源值 → 标准值」的值对照与兜底。
// 表单不存数据，每次修改都由 writeField 写回同一份 YAML（ADR-0017）；表单不认识的写法只读显示原表达式。
// 选到一半（还没选源列、表达式写不完整）时只留在这一行，不写进 YAML；还没对应的源值只显示（标黄），不写进值字典。
// 内置敏感字段带「敏感」徽标，不能取消。标准字段之后是扩展字段：已有的可改名、类型、中文名与是否敏感（敏感的只能是文本），取消勾选即删除；
// 下面列出还没用到的源列，勾选即加为扩展字段（名称或格式像敏感信息的默认标成敏感）。
// 消费者（customer）映射最后是「身份打通」：从已映射的敏感字段里勾选匹配字段并排序（越靠前优先级越高），不选时用平台默认规则。
// 身份打通之下是「属性取舍名次」（survivorship.priority，ADR-0027）：填正整数写回、留空不写（按 updated_at 取最新），只作用于统一消费者属性、不作用于同意；
// 非正整数只在控件旁提示、不写进 YAML；YAML 里手写的非法值由实时校验报在 survivorship.priority，显示在控件旁。
// 键空间（ADR-0024）：最上面是映射的键空间；指向别的实体的字段每行有键空间，没写时按同一数据源里目标实体已发布映射的键空间预填，
// 预填值只在写这个字段时一并写进 YAML，打开表单不改 YAML；清空预填值不写进 YAML，重新打开表单时又会预填（发布时本来也要求写同源目标的键空间）。
// 跨源引用（ADR-0030）：指向 customer 的字段在键空间旁选「所属数据源」，可选本租户有已发布 customer 映射的其他数据源，默认本数据源（不写 customer_source）
// 扩展字段按当前的名字是已登记关系的起点（ADR-0019）、类型是文本且不敏感时同样有键空间（不预填），指向 customer 的还有「所属数据源」；不满足时写回删掉这两项。
// 实时校验的问题按 path 的第一段（groupIssues）显示在对应的区块里，只有文字、不带行列；对应不上的放在表单顶部。
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { parseDocument } from 'yaml';
import { entityOf, FIELD_TYPE_NAMES, FIELD_TYPES, KEY_SPACE_PATTERN, type CanonicalEntity, type CanonicalField, type FieldType } from '~/lib/canonical-model';
import { parseExpression } from '~/lib/mapping-expr';
import { builtinName, CANONICAL_NAMES, ENUM_LABELS } from '~/lib/builtin-names';
import { msgText, MsgError, useT, type T } from '~/lib/i18n';
import { functionText } from '~/lib/mapping-functions-text';
import { transformText } from '~/lib/mapping-transforms-text';
import {
  dictionaryRows, expressionOf, extensionNameProblem, formUnavailable, groupIssues, identityCandidates, keySpaceOf, newExtension, readExtensions, readForm, readIdentity,
  readKeySpace, readSurvivorship, seedDictionary, TRANSFORMS, unusedColumns, writeExtension, writeField, writeIdentity, writeKeySpace, writeSurvivorship, writtenDictionary,
  type DictionaryEntry, type ExtensionChoice, type ExtensionForm, type FieldChoice, type FieldForm, type Part, type TransformId,
} from '~/lib/mapping-form';
import type { MappingIssueView } from '~/components/mapping-editor';
import type { ReferenceColumn, ReferenceFunction, ReferenceTable } from '~/components/mapping-reference';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';

/** 表单显示不了时的说明（YAML 写错了、实体对不上），附到 YAML 标签页的入口 */
function Notice({ children, onEditYaml }: { children: string; onEditYaml: () => void }) {
  const t = useT();
  return (
    <div data-mapping-form-notice className="space-y-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
      <div>{children}</div>
      <Button type="button" size="sm" variant="outline" onClick={onEditYaml}>{t('到 YAML 标签页修改')}</Button>
    </div>
  );
}

/** 实时校验对应到某个区块的问题：只显示文字（与保存校验一致）与改法，行列以 YAML 标签页为准 */
function BlockIssues({ issues }: { issues?: MappingIssueView[] }) {
  if (!issues?.length) return null;
  return (
    <div className="space-y-1 text-xs text-destructive">
      {issues.map((i, n) => (
        <div key={n}>
          <p data-live-issue data-issue-path={i.path}>{i.message}</p>
          {i.hint && <pre data-issue-hint className="mt-1 whitespace-pre-wrap rounded bg-muted px-2 py-1 font-mono text-foreground">{i.hint}</pre>}
        </div>
      ))}
    </div>
  );
}

/** 打开表单时定位到的字段，以及要加进它值对照表的源值（详情页「落入兜底」的取值） */
export interface FormFocus { field: string; add: string[] }

/** 表单标签页：目标实体的全部标准字段，改动写回 yaml 后交给 onChange；issues 是实时校验的问题，显示在对应的区块里 */
export function MappingForm({ yaml, entity, table, functions, focus, issues = [], onChange, onEditYaml }: {
  yaml: string;
  /** 目标实体：表单按它列出标准字段 */
  entity: string;
  /** 源表；没有时源列手填 */
  table: ReferenceTable | null;
  functions: ReferenceFunction[];
  focus?: FormFocus | null;
  issues?: MappingIssueView[];
  onChange: (yaml: string) => void;
  /** 切到 YAML 标签页 */
  onEditYaml: () => void;
}) {
  const doc = useMemo(() => parseDocument(yaml), [yaml]);
  const t = useT();
  // 只在打开时定位一次：保存后 loader 重新给出的 focus 不再滚动
  const focused = focus?.field;
  useEffect(() => {
    if (focused) document.getElementById(fieldId(focused))?.scrollIntoView({ block: 'center' });
  }, [focused]);
  const unavailable = formUnavailable(doc, entity);
  if (unavailable) return <Notice onEditYaml={onEditYaml}>{msgText(t, unavailable)}</Notice>;
  const target = entityOf(entity)!;
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
  const writeSpace = (keySpace: string | null) => {
    const next = parseDocument(yaml);
    writeKeySpace(next, keySpace);
    onChange(next.toString());
  };
  const writeRank = (priority: number | null) => {
    const next = parseDocument(yaml);
    writeSurvivorship(next, priority);
    onChange(next.toString());
  };
  // 表单上没有那个区块（不是本实体的字段、扩展字段只读、不是 customer 的身份打通与属性取舍名次）的问题也放进顶部
  const groups = groupIssues(issues);
  const extensionsRead = readExtensions(doc);
  const extensionNames = extensionsRead.reason ? [] : extensionsRead.extensions.map(e => e.name);
  const general = [
    ...groups.general,
    ...Object.entries(groups.fields).flatMap(([name, list]) => (target.fields.some(f => f.name === name) ? [] : list)),
    ...Object.entries(groups.extensions).flatMap(([name, list]) => (extensionNames.includes(name) ? [] : list)),
    ...(target.name === 'customer' ? [] : groups.identity),
    ...(target.name === 'customer' ? [] : groups.survivorship),
  ];
  return (
    <div className="max-h-[48rem] divide-y overflow-y-auto rounded-lg border text-sm">
      {general.length > 0 && (
        <div data-form-issues className="space-y-1 p-3">
          <div className="text-xs font-medium text-destructive">{t('实时校验发现的问题')}</div>
          <BlockIssues issues={general} />
        </div>
      )}
      <KeySpace doc={doc} issues={groups.keySpace} onWrite={writeSpace} />
      {readForm(doc, target).map(form => (
        <FieldRow
          key={form.field}
          entity={target.name}
          form={form}
          field={target.fields.find(f => f.name === form.field)!}
          table={table}
          functions={functions}
          keySpaces={table?.keySpaces ?? {}}
          customerSourceOptions={table?.customerSources ?? []}
          pending={focus?.field === form.field ? focus.add : []}
          issues={groups.fields[form.field]}
          onWrite={choice => write(form.field, choice)}
          onEditYaml={onEditYaml}
        />
      ))}
      <Extensions doc={doc} table={table} origins={table?.relationOrigins[target.name] ?? {}} issues={groups.extensions} onWrite={writeExt} onEditYaml={onEditYaml} />
      {target.name === 'customer' && <Identity doc={doc} entity={target} issues={groups.identity} onWrite={writeMatch} onEditYaml={onEditYaml} />}
      {target.name === 'customer' && <Survivorship doc={doc} issues={groups.survivorship} onWrite={writeRank} onEditYaml={onEditYaml} />}
    </div>
  );
}

const transformOf = (id: TransformId) => TRANSFORMS.find(tr => tr.id === id)!;

const fieldId = (field: string) => `form-field-${field}`;

const choiceOf = (form: FieldForm): FieldChoice | null => form.transform && {
  transform: form.transform, column: form.column, args: form.args, parts: form.parts, raw: form.raw,
  dictionary: form.dictionary, ...(form.otherwise !== undefined && { otherwise: form.otherwise }),
};

/** 选择（连同键空间与所属数据源）写进 YAML 后的样子；与 YAML 读出的一致时这一行不用重新读 */
const syncKey = (choice: FieldChoice | null, type: FieldType, keySpace?: string | null, customerSource?: string) => choice
  ? JSON.stringify([
    expressionOf(choice, type), writtenDictionary(choice.dictionary) ?? [], choice.otherwise === undefined ? 0 : choice.otherwise, keySpace?.trim() ?? '', customerSource ?? '',
  ])
  : '';

const KEY_SPACE = new RegExp(KEY_SPACE_PATTERN);
const keySpaceProblem = (t: T, keySpace?: string | null) =>
  keySpace?.trim() && !KEY_SPACE.test(keySpace.trim()) ? t('键空间只用小写字母、数字与下划线') : null;

/** 属性取舍名次的问题：填了但不是正整数（1、2、3…）时只留在本地，不写进 YAML */
const rankProblem = (t: T, rank: string) =>
  rank.trim() && !/^[1-9]\d*$/.test(rank.trim()) ? t('名次是正整数，如 1、2、3') : null;

/** 选择还缺什么（给出时不写进 YAML）；写得出表达式时为 null。转换的参数名经 transformText、parseExpression 与 lib 抛的错经 msgText 按界面语言出文字 */
function missing(t: T, choice: FieldChoice, type: FieldType): string | null {
  const def = transformOf(choice.transform);
  const text = transformText(t, def);
  if (def.column && !choice.column) return t('选一个源列');
  const at = def.args.findIndex((a, i) => !a.optional && !choice.args?.[i]?.trim());
  if (at >= 0) return t('填写{label}', { label: text.args[at].label });
  if (choice.transform === 'concat') {
    if (!choice.parts?.length) return t('至少加一段源列或文本');
    if (choice.parts.some(p => 'column' in p && !p.column)) return t('每段源列都要选一列');
  }
  const space = keySpaceProblem(t, choice.keySpace);
  if (space) return space;
  const entries = choice.dictionary ?? [];
  if (entries.some(e => e.to !== null && !e.from)) return t('值对照里对应了标准值的行要填源值');
  const twice = (writtenDictionary(entries) ?? []).find((e, i, all) => all.findIndex(x => x.from === e.from) !== i);
  if (twice) return t('值对照里源值 {from} 写了两次，只留一行', { from: twice.from });
  try {
    parseExpression(expressionOf(choice, type));
    return null;
  } catch (e) {
    // MsgError 带句式（ExprError 与 lib 抛的错）：英文界面出英文（msgText）；其他错误照旧出 message
    const problem = e instanceof MsgError ? msgText(t, e.detail) : (e as Error).message;
    return choice.transform === 'custom' ? t('表达式有误：{message}', { message: problem }) : problem;
  }
}

/** 一个标准字段：说明、源列与转换，引用字段另有键空间，指向 customer 的还有所属数据源；只读时显示原表达式 */
function FieldRow({ entity, form, field, table, functions, keySpaces, customerSourceOptions, pending, issues, onWrite, onEditYaml }: {
  entity: string;
  form: FieldForm;
  field: CanonicalField;
  table: ReferenceTable | null;
  functions: ReferenceFunction[];
  /** 同一数据源里各实体已发布映射声明的键空间，引用字段没写键空间时据此预填 */
  keySpaces: Record<string, string>;
  /** 有已发布 customer 映射的其他数据源，指向 customer 的字段可选为所属数据源 */
  customerSourceOptions: { id: string; name: string }[];
  /** 要作为待对应的行加进值对照表的源值 */
  pending: string[];
  /** 实时校验报在这个字段上的问题 */
  issues?: MappingIssueView[];
  onWrite: (choice: FieldChoice | null) => void;
  onEditYaml: () => void;
}) {
  const t = useT();
  const [choice, setChoice] = useState(() => choiceOf(form));
  // 键空间只存在这里（choice 里不带）：引用字段按 keySpaceOf 预填，不论这一行是否已对应都留着，写这个字段时一并写进 YAML；
  // 不是引用字段时照 YAML 里写的（没有输入框）
  const initialKeySpace = keySpaceOf(form, field, keySpaces) ?? form.keySpace ?? null;
  const [keySpace, setKeySpace] = useState(initialKeySpace);
  // 所属数据源同键空间一样只存在这里，空串是本数据源
  const [customerSource, setCustomerSource] = useState(form.customerSource ?? '');
  // 这一行最后写进 YAML 的样子；YAML 在别处改了（YAML 标签页、生成草稿）时按 YAML 重新读出
  const current = syncKey(choiceOf(form), field.type, form.keySpace, form.customerSource);
  const [synced, setSynced] = useState(current);
  if (current !== synced) {
    setSynced(current);
    setChoice(choiceOf(form));
    setKeySpace(initialKeySpace);
    setCustomerSource(form.customerSource ?? '');
  }
  // 新建页换了数据源或源表：没写键空间时按新的同源键空间重新预填
  const declared = field.ref ? (keySpaces[field.ref.entity] ?? '') : null;
  const [seen, setSeen] = useState(declared);
  if (declared !== seen) {
    setSeen(declared);
    if (form.keySpace === undefined) setKeySpace(initialKeySpace);
  }
  const problem = choice && missing(t, { ...choice, keySpace }, field.type);
  const unmapped = form.required && !form.raw;

  const update = (next: FieldChoice | null, space = keySpace, source = customerSource) => {
    setChoice(next);
    if (!next) {
      setSynced('');
      onWrite(null);
      return;
    }
    const written = { ...next, keySpace: space, customerSource: source };
    if (!missing(t, written, field.type)) {
      setSynced(syncKey(next, field.type, space, source || undefined));
      onWrite(written);
    }
  };
  const changeKeySpace = (space: string) => {
    setKeySpace(space);
    if (choice) update(choice, space);
  };
  const changeCustomerSource = (source: string) => {
    setCustomerSource(source);
    if (choice) update(choice, keySpace, source);
  };
  const keySpacePending = keySpace?.trim() && keySpace.trim() !== form.keySpace && choice && !problem;
  const topValues = (column?: string | null) => table?.columns.find(c => c.name === column)?.top?.map(v => v.value) ?? [];
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
    if (choice && !missing(t, choice, field.type)) raw = expressionOf(choice, field.type);
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
  // def 的名称与参数说明按界面语言出（msg / 报错也用同一批词条）
  const defText = def ? transformText(t, def) : null;

  return (
    <div id={fieldId(field.name)} data-form-field={field.name} data-readonly={form.readonly || undefined} className={`space-y-2 p-3 ${unmapped ? 'bg-destructive/10' : ''}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono font-medium">{field.name}</span>
        <span>{builtinName(t, field.label, CANONICAL_NAMES)}</span>
        <span className="text-xs text-muted-foreground">{builtinName(t, FIELD_TYPES[field.type].label, ENUM_LABELS)}</span>
        {field.pii && <Badge variant="outline" title={t('标准层只存加盐哈希，不能取消')}>{t('敏感信息')}</Badge>}
        {form.required && <Badge variant={unmapped ? 'destructive' : 'secondary'}>{unmapped ? t('必填（去重键），未对应') : t('必填（去重键）')}</Badge>}
      </div>
      <div className="text-xs text-muted-foreground">
        {field.description}
        {field.enum && t('。标准枚举：{values}', { values: field.enum.join(t('、')) })}
      </div>

      {form.readonly ? (
        <div className="space-y-1">
          {form.raw && <code className="block rounded bg-muted px-2 py-1 font-mono text-xs whitespace-pre-wrap">{form.raw}</code>}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{form.reason ? msgText(t, form.reason) : null}</span>
            <Button type="button" size="xs" variant="link" onClick={onEditYaml}>{t('到 YAML 修改')}</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect size="sm" aria-label={t('{name} 的转换', { name: field.name })} value={choice?.transform ?? ''} onChange={e => switchTo(e.target.value as TransformId | '')}>
            <NativeSelectOption value="">{t('不对应')}</NativeSelectOption>
            {TRANSFORMS.map(tr => <NativeSelectOption key={tr.id} value={tr.id}>{transformText(t, tr).label}</NativeSelectOption>)}
          </NativeSelect>
          {choice && def?.column && (
            <ColumnPicker label={t('{name} 的源列', { name: field.name })} table={table} value={choice.column ?? ''} onChange={column => setColumn(choice, column)} />
          )}
          {choice && def?.args.map((a, i) => {
            const value = choice.args?.[i] ?? '';
            const set = (v: string) => update({ ...choice, args: def.args.map((_, j) => (j === i ? v : (choice.args?.[j] ?? ''))) });
            // 参数名、提示与单位选项文字经 transformText 按界面语言出；key 与提交的 value 仍用 lib 数据
            const arg = defText!.args[i];
            return a.options ? (
              <NativeSelect key={a.label} size="sm" aria-label={arg.label} value={value} onChange={e => set(e.target.value)}>
                {a.options.map((o, j) => <NativeSelectOption key={o.value} value={o.value}>{arg.options?.[j]?.label ?? o.label}</NativeSelectOption>)}
              </NativeSelect>
            ) : (
              <Input key={a.label} className="h-7 w-56" aria-label={arg.label} placeholder={arg.hint ?? arg.label} title={arg.hint} value={value} onChange={e => set(e.target.value)} />
            );
          })}
          {choice?.transform === 'concat' && <PartsEditor table={table} parts={choice.parts ?? []} onChange={parts => update({ ...choice, parts })} />}
          {choice?.transform === 'custom' && <CustomExpression raw={choice.raw ?? ''} functions={functions} onChange={raw => update({ ...choice, raw })} />}
        </div>
      )}
      {!form.readonly && field.ref && (
        <ReferenceKeyControls
          name={field.name}
          target={field.ref.entity}
          keySpace={keySpace ?? ''}
          customerSource={customerSource}
          options={customerSourceOptions}
          onKeySpace={changeKeySpace}
          onCustomerSource={changeCustomerSource}
        >
          {keySpacePending && (
            <>
              <span className="text-muted-foreground">{t('还没写进 YAML')}</span>
              <Button type="button" size="xs" variant="link" onClick={() => update(choice)}>{t('写进 YAML')}</Button>
            </>
          )}
        </ReferenceKeyControls>
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

      {!form.readonly && problem && <div className="text-xs text-destructive">{t('{problem}，之后才写进 YAML', { problem })}</div>}
      {form.basis && <div className="text-xs text-muted-foreground">{t('依据：{basis}', { basis: form.basis })}</div>}
      <BlockIssues issues={issues} />
    </div>
  );
}

/** 引用字段的键空间输入，指向 customer 时还有所属数据源下拉（空串是本数据源）；children 跟在后面 */
function ReferenceKeyControls({ name, target, keySpace, customerSource, options, onKeySpace, onCustomerSource, children }: {
  name: string;
  /** 引用的终点实体 */
  target: string;
  keySpace: string;
  customerSource: string;
  /** 有已发布 customer 映射的其他数据源 */
  options: { id: string; name: string }[];
  onKeySpace: (keySpace: string) => void;
  onCustomerSource: (source: string) => void;
  children?: ReactNode;
}) {
  // YAML 里写的数据源不在可选里（没有已发布的 customer 映射、写的是本源）时也列出来，保存时由校验指出
  const sourceNames = [...new Set([...options.map(s => s.name), ...(customerSource ? [customerSource] : [])])];
  const t = useT();
  return (
    <div data-form-key-space={name} className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">{t('键空间（{target} 的主键所在）', { target })}</span>
      <Input className="h-7 w-40" aria-label={t('{name} 的键空间', { name })} placeholder={t('不写')} value={keySpace} onChange={e => onKeySpace(e.target.value)} />
      {target === 'customer' && (
        <>
          <span className="text-muted-foreground">{t('所属数据源')}</span>
          <NativeSelect size="sm" aria-label={t('{name} 的所属数据源', { name })} value={customerSource} onChange={e => onCustomerSource(e.target.value)}>
            <NativeSelectOption value="">{t('本数据源')}</NativeSelectOption>
            {sourceNames.map(n => <NativeSelectOption key={n} value={n}>{n}</NativeSelectOption>)}
          </NativeSelect>
        </>
      )}
      {children}
    </div>
  );
}

/** 扩展字段区块：已有的扩展字段（可改，取消勾选即删除），以及还没用到的源列（勾选即加为扩展字段） */
function Extensions({ doc, table, origins, issues, onWrite, onEditYaml }: {
  doc: ReturnType<typeof parseDocument>;
  table: ReferenceTable | null;
  /** 本实体已登记关系的起点字段 → 终点实体 */
  origins: Record<string, string>;
  /** 实时校验的问题，按扩展字段名分组 */
  issues: Record<string, MappingIssueView[]>;
  onWrite: (name: string, choice: ExtensionChoice | null) => void;
  onEditYaml: () => void;
}) {
  const { extensions, reason } = readExtensions(doc);
  const names = extensions.map(e => e.name);
  const unused = table ? unusedColumns(doc, table) : [];
  const t = useT();
  return (
    <div data-form-extensions className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{t('扩展字段')}</span>
        <span className="text-xs text-muted-foreground">{t('标准模型里没有的租户特有字段，名字以 x_ 开头')}</span>
      </div>
      {reason ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{reason ? msgText(t, reason) : null}</span>
          <Button type="button" size="xs" variant="link" onClick={onEditYaml}>{t('到 YAML 修改')}</Button>
        </div>
      ) : (
        <>
          {/* 按位置作 key：改名时这一行不重新挂载，输入框不丢焦点 */}
          {extensions.map((form, i) => (
            <ExtensionRow
              key={i}
              form={form}
              others={names.filter(n => n !== form.name)}
              origins={origins}
              customerSourceOptions={table?.customerSources ?? []}
              issues={issues[form.name]}
              onWrite={choice => onWrite(form.name, choice)}
              onEditYaml={onEditYaml}
            />
          ))}
          {unused.length > 0 && <div className="pt-1 text-xs text-muted-foreground">{t('没用到的源列，勾选即加为扩展字段：')}</div>}
          {unused.map(c => (
            <label key={c.name} data-unused-column={c.name} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={false} onChange={() => {
                const ext = newExtension(table!, c.name, names);
                onWrite(ext.name, ext);
              }} />
              <span className="font-mono">{columnLabel(t, c)}</span>
            </label>
          ))}
          {!table && !extensions.length && <div className="text-xs text-muted-foreground">{t('没有可对照的源表，扩展字段请在 YAML 里编写')}</div>}
        </>
      )}
    </div>
  );
}

/**
 * 一个已有的扩展字段：名字、类型、中文名可改，表达式只显示；名字或键空间不合格时只留在这一行，不写进 YAML。
 * 按当前的名字是已登记关系的起点、类型是文本且不敏感时另有键空间（指向 customer 的还有所属数据源）；不满足时写回删掉这两项
 */
function ExtensionRow({ form, others, origins, customerSourceOptions, issues, onWrite, onEditYaml }: {
  form: ExtensionForm;
  /** 其他扩展字段的名字 */
  others: string[];
  /** 本实体已登记关系的起点字段 → 终点实体 */
  origins: Record<string, string>;
  /** 有已发布 customer 映射的其他数据源 */
  customerSourceOptions: { id: string; name: string }[];
  /** 实时校验报在这个扩展字段上的问题 */
  issues?: MappingIssueView[];
  onWrite: (choice: ExtensionChoice | null) => void;
  onEditYaml: () => void;
}) {
  const t = useT();
  const read = {
    name: form.name, type: form.type ?? 'string', label: form.label, sensitive: form.sensitive, keySpace: form.keySpace ?? '', customerSource: form.customerSource ?? '',
  };
  const [draft, setDraft] = useState(read);
  // YAML 在别处改了时按 YAML 重新读出
  const current = JSON.stringify(read);
  const [synced, setSynced] = useState(current);
  if (current !== synced) {
    setSynced(current);
    setDraft(read);
  }
  const targetOf = (d: typeof draft) => (d.type === 'string' && !d.sensitive ? origins[d.name] : undefined);
  const target = targetOf(draft);
  // 名字的问题是 lib 给的句式（msgText 按界面语言出文字），键空间的问题已是文字
  const problemOf = (d: typeof draft) => {
    const name = extensionNameProblem(d.name, others);
    return (name && msgText(t, name)) ?? (targetOf(d) ? keySpaceProblem(t, d.keySpace) : null);
  };
  const problem = problemOf(draft);
  const update = (next: typeof draft) => {
    setDraft(next);
    if (problemOf(next)) return;
    const nextTarget = targetOf(next);
    const refKeys = { keySpace: nextTarget ? next.keySpace.trim() : '', customerSource: nextTarget === 'customer' ? next.customerSource : '' };
    // 中文名、键空间写进 YAML 时去掉首尾空白：按写进去的样子记下，输入中的空格不被重新读出冲掉
    setSynced(JSON.stringify({ ...next, label: next.label.trim(), ...refKeys }));
    onWrite({ ...next, expr: form.expr, ...refKeys });
  };
  return (
    <div data-form-extension={form.name} data-readonly={form.readonly || undefined} className="space-y-1 rounded-md border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <input type="checkbox" checked aria-label={t('保留扩展字段 {name}', { name: form.name })} disabled={form.readonly} onChange={() => onWrite(null)} />
        {form.readonly ? (
          <>
            <span className="font-mono">{form.name}</span>
            {form.sensitive && <Badge variant="outline">{t('敏感信息')}</Badge>}
          </>
        ) : (
          <>
            <Input className="h-7 w-48 font-mono" aria-label={t('{name} 的名字', { name: form.name })} value={draft.name} onChange={e => update({ ...draft, name: e.target.value })} />
            <NativeSelect
              size="sm"
              aria-label={t('{name} 的类型', { name: form.name })}
              value={draft.type}
              disabled={form.dictionary || draft.sensitive}
              title={form.dictionary ? t('带值字典或兜底的扩展字段只能是文本') : draft.sensitive ? t('敏感字段只存哈希，只能是文本') : undefined}
              onChange={e => update({ ...draft, type: e.target.value as FieldType })}
            >
              {FIELD_TYPE_NAMES.map(ft => <NativeSelectOption key={ft} value={ft}>{t('{type}（{label}）', { type: ft, label: builtinName(t, FIELD_TYPES[ft].label, ENUM_LABELS) })}</NativeSelectOption>)}
            </NativeSelect>
            <Input className="h-7 w-40" aria-label={t('{name} 的中文名', { name: form.name })} placeholder={t('中文名（可不填）')} value={draft.label} onChange={e => update({ ...draft, label: e.target.value })} />
            <label className="flex items-center gap-1 text-xs" title={form.dictionary ? t('带值字典或兜底的扩展字段不能标成敏感') : t('标准层只存加盐哈希')}>
              {/* 标成敏感时类型改为文本 */}
              <input
                type="checkbox"
                checked={draft.sensitive}
                disabled={form.dictionary}
                onChange={e => update({ ...draft, sensitive: e.target.checked, ...(e.target.checked && { type: 'string' as const }) })}
              />
              {t('敏感')}
            </label>
          </>
        )}
      </div>
      {form.expr && <code className="block rounded bg-muted px-2 py-1 font-mono text-xs whitespace-pre-wrap">{form.expr}</code>}
      {!form.readonly && target && (
        <ReferenceKeyControls
          name={form.name}
          target={target}
          keySpace={draft.keySpace}
          customerSource={draft.customerSource}
          options={customerSourceOptions}
          onKeySpace={keySpace => update({ ...draft, keySpace })}
          onCustomerSource={customerSource => update({ ...draft, customerSource })}
        />
      )}
      {form.dictionary && !form.readonly && <div className="text-xs text-muted-foreground">{t('带值字典或兜底，请在 YAML 里修改对照')}</div>}
      {form.readonly && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{form.reason ? msgText(t, form.reason) : null}</span>
          <Button type="button" size="xs" variant="link" onClick={onEditYaml}>{t('到 YAML 修改')}</Button>
        </div>
      )}
      {!form.readonly && problem && <div className="text-xs text-destructive">{t('{problem}，之后才写进 YAML', { problem })}</div>}
      <BlockIssues issues={issues} />
    </div>
  );
}

/** 映射的键空间：主键在标准层带上这个前缀，同一数据源里指向本实体的引用字段要写同一个；清空时删掉 key_space */
function KeySpace({ doc, issues, onWrite }: { doc: ReturnType<typeof parseDocument>; issues: MappingIssueView[]; onWrite: (keySpace: string | null) => void }) {
  const t = useT();
  const written = readKeySpace(doc) ?? '';
  const [value, setValue] = useState(written);
  // YAML 在别处改了时按 YAML 重新读出
  const [synced, setSynced] = useState(written);
  if (written !== synced) {
    setSynced(written);
    setValue(written);
  }
  const problem = keySpaceProblem(t, value);
  const change = (next: string) => {
    setValue(next);
    if (keySpaceProblem(t, next)) return;
    setSynced(next.trim());
    onWrite(next.trim() || null);
  };
  return (
    <div data-form-mapping-key-space className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{t('键空间')}</span>
        <span className="text-xs text-muted-foreground">
          {t('多个映射写同一实体、主键取值可能撞上时，给本映射起一个键空间（如 pos），标准层的主键写成「键空间:原值」；同一数据源里指向本实体的字段要写同一个键空间。不写时主键照原值')}
        </span>
      </div>
      <Input className="h-7 w-40" aria-label={t('映射的键空间')} placeholder={t('不写')} value={value} onChange={e => change(e.target.value)} />
      {problem && <div className="text-xs text-destructive">{t('{problem}，之后才写进 YAML', { problem })}</div>}
      <BlockIssues issues={issues} />
    </div>
  );
}

/** 身份打通的匹配字段：勾选已映射的敏感字段，选中的按优先级排列、可上下移动；YAML 里有但已不可选的字段标出，只能去掉 */
function Identity({ doc, entity, issues, onWrite, onEditYaml }: {
  doc: ReturnType<typeof parseDocument>;
  entity: CanonicalEntity;
  issues: MappingIssueView[];
  onWrite: (match: string[]) => void;
  onEditYaml: () => void;
}) {
  const { match, reason } = readIdentity(doc);
  const candidates = identityCandidates(doc, entity);
  const t = useT();
  const move = (i: number, by: number) => {
    const next = [...match];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    onWrite(next);
  };
  return (
    <div data-form-identity className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{t('身份打通')}</span>
        <span className="text-xs text-muted-foreground">
          {t('按哪些敏感字段的哈希判断是同一个人，越靠前优先级越高：更高优先级的字段双方都有值且不同时，不按后面的字段合并。不选时用默认规则（手机号、邮箱、外部 ID）')}
        </span>
      </div>
      {reason ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{reason ? msgText(t, reason) : null}</span>
          <Button type="button" size="xs" variant="link" onClick={onEditYaml}>{t('到 YAML 修改')}</Button>
        </div>
      ) : (
        <>
          {match.map((name, i) => (
            <div key={name} data-identity-match={name} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked aria-label={t('不按 {name} 匹配', { name })} onChange={() => onWrite(match.filter(m => m !== name))} />
              <span className="w-6 text-muted-foreground">{i + 1}</span>
              <span className="font-mono">{name}</span>
              {!candidates.includes(name) && <span className="text-destructive">{t('没有映射或不是敏感字段，请去掉')}</span>}
              <Button type="button" size="xs" variant="ghost" aria-label={t('{name} 提前', { name })} disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
              <Button type="button" size="xs" variant="ghost" aria-label={t('{name} 推后', { name })} disabled={i === match.length - 1} onClick={() => move(i, 1)}>↓</Button>
            </div>
          ))}
          {candidates.filter(c => !match.includes(c)).map(name => (
            <label key={name} data-identity-candidate={name} className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={false} onChange={() => onWrite([...match, name])} />
              <span className="font-mono">{name}</span>
            </label>
          ))}
          {!candidates.length && !match.length && <div className="text-xs text-muted-foreground">{t('还没有映射敏感字段，映射手机号、邮箱等之后才能选')}</div>}
        </>
      )}
      <BlockIssues issues={issues} />
    </div>
  );
}

/** 属性取舍名次（ADR-0027，只用于 customer）：正整数，数字越小越优先；清空时删掉 survivorship */
function Survivorship({ doc, issues, onWrite, onEditYaml }: {
  doc: ReturnType<typeof parseDocument>;
  issues: MappingIssueView[];
  onWrite: (priority: number | null) => void;
  onEditYaml: () => void;
}) {
  const { priority, reason } = readSurvivorship(doc);
  const written = priority == null ? '' : String(priority);
  const t = useT();
  const [value, setValue] = useState(written);
  // YAML 在别处改了时按 YAML 重新读出
  const [synced, setSynced] = useState(written);
  if (written !== synced) {
    setSynced(written);
    setValue(written);
  }
  const problem = rankProblem(t, value);
  const change = (next: string) => {
    setValue(next);
    const trimmed = next.trim();
    if (!trimmed) {
      setSynced('');
      onWrite(null);
      return;
    }
    if (rankProblem(t, next)) return;
    setSynced(trimmed);
    onWrite(Number(trimmed));
  };
  return (
    <div data-form-survivorship className="space-y-2 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{t('属性取舍名次')}</span>
        <span className="text-xs text-muted-foreground">
          {t('统一消费者的属性来自几个 customer 映射时，数字越小越优先；只作用于属性，不作用于同意；不写时按 updated_at 取最新')}
        </span>
      </div>
      {reason ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{reason ? msgText(t, reason) : null}</span>
          <Button type="button" size="xs" variant="link" onClick={onEditYaml}>{t('到 YAML 修改')}</Button>
        </div>
      ) : (
        <Input className="h-7 w-40" aria-label={t('属性取舍名次')} placeholder={t('不写')} value={value} onChange={e => change(e.target.value)} inputMode="numeric" />
      )}
      {problem && <div className="text-xs text-destructive">{t('{problem}，之后才写进 YAML', { problem })}</div>}
      <BlockIssues issues={issues} />
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
  const t = useT();
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
      <div className="text-muted-foreground">{t('值对照（源值 → 标准值）：合并时只认这里写了的源值，源值与标准值相同也要写上')}</div>
      {rows.map((r, i) => (
        <div key={r.extra ? `extra-${r.from}` : i} data-dictionary-row={r.from} data-unmapped={r.to === null || undefined} className={`flex flex-wrap items-center gap-2 rounded px-1 py-0.5 ${r.to === null ? 'bg-amber-100' : ''}`}>
          {r.extra
            ? <span className="w-40 truncate font-mono" title={r.from}>{r.from}</span>
            : <Input className="h-7 w-40 font-mono" aria-label={t('第 {n} 个源值', { n: i + 1 })} placeholder={t('源值')} value={r.from} onChange={e => set(entries.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />}
          <span className="text-muted-foreground">→</span>
          <NativeSelect size="sm" aria-label={r.from ? t('{from} 对应的标准值', { from: r.from }) : t('第 {n} 个源值对应的标准值', { n: i + 1 })} value={r.to ?? ''} onChange={e => setTo(i, e.target.value || null)}>
            <NativeSelectOption value="">{t('未对应')}</NativeSelectOption>
            {r.to && !standard.includes(r.to) && <NativeSelectOption value={r.to}>{t('{value}（不是标准值）', { value: r.to })}</NativeSelectOption>}
            {standard.map(v => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}
          </NativeSelect>
          {r.to === null && <span className="text-amber-700">{r.extra ? t('样本里出现过，建议对应') : t('未对应，不写进值字典')}</span>}
          {r.to === null && r.suggestion && <Button type="button" size="xs" variant="link" onClick={() => setTo(i, r.suggestion!)}>{t('对应为 {value}', { value: r.suggestion })}</Button>}
          {!r.extra && <Button type="button" size="xs" variant="ghost" aria-label={t('去掉源值 {from}', { from: r.from })} onClick={() => set(entries.filter((_, j) => j !== i))}>×</Button>}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="xs" variant="outline" onClick={() => set([...entries, { from: '', to: null }])}>{t('加一个源值')}</Button>
        {suggested.length > 1 && <Button type="button" size="xs" variant="outline" onClick={fillSuggested}>{t('按建议对应 {n} 个源值', { n: suggested.length })}</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span>{t('没对上的取值')}</span>
        <NativeSelect
          size="sm"
          aria-label={t('{name} 的兜底', { name: field.name })}
          value={otherwise === undefined ? '' : (otherwise ?? NULL_OTHERWISE)}
          onChange={e => onChange(entries, e.target.value === '' ? undefined : e.target.value === NULL_OTHERWISE ? null : e.target.value)}
        >
          <NativeSelectOption value="">{t('不写兜底（合并失败并列出这些取值）')}</NativeSelectOption>
          <NativeSelectOption value={NULL_OTHERWISE}>{t('其他取值记为空')}</NativeSelectOption>
          {otherwise && !standard.includes(otherwise) && <NativeSelectOption value={otherwise}>{t('记为 {value}（不是标准值）', { value: otherwise })}</NativeSelectOption>}
          {standard.map(v => <NativeSelectOption key={v} value={v}>{t('其他取值记为 {value}', { value: v })}</NativeSelectOption>)}
        </NativeSelect>
      </div>
    </div>
  );
}

/** 源列的说明：类型与常见取值 */
const columnLabel = (t: T, c: ReferenceColumn) => {
  const top = c.top?.slice(0, 3).map(v => v.value).join(t('、'));
  return top ? t('{name}（{type}，常见：{values}）', { name: c.name, type: c.type, values: top }) : t('{name}（{type}）', { name: c.name, type: c.type });
};

/** 选源列；没有可对照的源表时手填列名 */
function ColumnPicker({ label, table, value, onChange }: { label: string; table: ReferenceTable | null; value: string; onChange: (column: string) => void }) {
  const t = useT();
  if (!table) return <Input className="h-7 w-48 font-mono" aria-label={label} placeholder={t('源列名')} value={value} onChange={e => onChange(e.target.value)} />;
  const known = table.columns.some(c => c.name === value);
  return (
    <NativeSelect size="sm" aria-label={label} value={value} onChange={e => onChange(e.target.value)}>
      <NativeSelectOption value="">{t('选源列…')}</NativeSelectOption>
      {value && !known && <NativeSelectOption value={value}>{t('{column}（源表里没有这一列）', { column: value })}</NativeSelectOption>}
      {table.columns.map(c => <NativeSelectOption key={c.name} value={c.name}>{columnLabel(t, c)}</NativeSelectOption>)}
    </NativeSelect>
  );
}

/** 拼接的各段：源列或一段文本，按顺序拼起来 */
function PartsEditor({ table, parts, onChange }: { table: ReferenceTable | null; parts: Part[]; onChange: (parts: Part[]) => void }) {
  const t = useT();
  const set = (i: number, p: Part) => onChange(parts.map((q, j) => (j === i ? p : q)));
  return (
    <div className="flex flex-wrap items-center gap-2">
      {parts.map((p, i) => (
        <span key={i} className="flex items-center gap-1">
          {'column' in p
            ? <ColumnPicker label={t('第 {n} 段的源列', { n: i + 1 })} table={table} value={p.column} onChange={column => set(i, { column })} />
            : <Input className="h-7 w-28" aria-label={t('第 {n} 段的文本', { n: i + 1 })} placeholder={t('文本')} value={p.text} onChange={e => set(i, { text: e.target.value })} />}
          <Button type="button" size="xs" variant="ghost" aria-label={t('去掉第 {n} 段', { n: i + 1 })} onClick={() => onChange(parts.filter((_, j) => j !== i))}>×</Button>
        </span>
      ))}
      <Button type="button" size="xs" variant="outline" onClick={() => onChange([...parts, { column: '' }])}>{t('加一列')}</Button>
      <Button type="button" size="xs" variant="outline" onClick={() => onChange([...parts, { text: '' }])}>{t('加一段文本')}</Button>
    </div>
  );
}

/** 自定义表达式，旁边可把白名单函数插入到光标处 */
function CustomExpression({ raw, functions, onChange }: { raw: string; functions: ReferenceFunction[]; onChange: (raw: string) => void }) {
  const t = useT();
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
      <Input ref={input} className="h-7 w-80 font-mono" aria-label={t('自定义表达式')} placeholder={t('如 coalesce(pay_amount, pay_fen / 100)')} value={raw} onChange={e => onChange(e.target.value)} />
      <NativeSelect size="sm" aria-label={t('插入函数')} value="" onChange={e => e.target.value && insert(e.target.value)}>
        <NativeSelectOption value="">{t('插入函数…')}</NativeSelectOption>
        {functions.map(f => {
          const text = functionText(t, f);
          return <NativeSelectOption key={f.name} value={f.name}>{t('{signature}：{label}', { signature: text.signature, label: text.label })}</NativeSelectOption>;
        })}
      </NativeSelect>
    </>
  );
}
