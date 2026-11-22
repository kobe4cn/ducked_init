// app/components/metric-builder.tsx —— 新建指标页的条件构建器（ADR-0017：表单为主、YAML 仍是唯一格式）：基础实体、聚合、度量字段、
// latest / earliest 的取行字段、ratio 的分子分母、过滤条件与时间窗口，全部选自服务端 loader 给的字段表（fieldsFor 生成，已剔除敏感字段）。
// 状态是 MetricForm，序列化（没选字段的条件行丢掉；选了字段的时间窗口总带上，天数空输入按 0，<1 交给服务端校验）进隐藏字段 form，服务端按 form.base 重取字段再 formToYaml；
// 本组件不做校验（sum 选了文本字段之类的问题在「检查」或保存时由服务端 checkMetric 按行列报出），也不接收用户手输的字段名
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import type { FieldType } from '~/lib/canonical-model';
import { useT, type T } from '~/lib/i18n';
import { AGGS, FILTER_OPS, NUMERIC_TYPES, RATIO_AGGS, TEMPORAL_TYPES } from '~/lib/metric-vocab';
import { opsFor, type Cond, type FormField, type MetricForm, type RatioForm } from '~/lib/metric-form';

/** 聚合下拉的说明按界面语言出文字（ADR-0060）：metric-vocab 的 AGG_TEXT 是给模型 / 检索的语义目录（capabilities.ts 也读），不接翻译；
 *  这里按聚合名列字面量 t() 对照表（照 app/lib/mapping-functions-text.ts 的做法，键就是词表里的中文原文） */
function aggText(t: T, a: (typeof AGGS)[number]): string {
  return ({
    count: t('行数；写了 field 时只数 field 不为空的行'),
    count_distinct: t('field 的不同取值个数'),
    sum: t('field（数字）求和'),
    avg: t('field（数字）平均值'),
    min: t('field 的最小值（数字、日期或时间）'),
    max: t('field 的最大值（数字、日期或时间）'),
    ratio: t('比率：numerator / denominator，分子、分母各写 agg（只能是 count、count_distinct、sum）、field 与自己的 filter，与顶层 filter、window 叠加'),
    latest: t('按 by（日期或时间）取最新一行的 field（数字）'),
    earliest: t('按 by（日期或时间）取最早一行的 field（数字）'),
    days_since: t('asOf 减 field（日期或时间）最近一天的天数'),
  })[a];
}

/** ratio 分子、分母聚合下拉的说明按界面语言（RATIO_AGG_TEXT 同样是数据不接翻译） */
function ratioAggText(t: T, a: (typeof RATIO_AGGS)[number]): string {
  return ({
    count: t('分子或分母为行数'),
    count_distinct: t('分子或分母为 field 的不同取值个数'),
    sum: t('分子或分母为 field 求和'),
  })[a];
}

/** 过滤运算下拉的说明按界面语言（FILTER_OP_TEXT 同样是数据不接翻译；opsFor 的 label 仍是它，测试断言） */
function opText(t: T, op: (typeof FILTER_OPS)[number]): string {
  return ({
    eq: t('等于 value'),
    ne: t('不等于 value'),
    in: t('在 value 列表里'),
    not_in: t('不在 value 列表里'),
    gt: t('大于 value'),
    gte: t('大于等于 value'),
    lt: t('小于 value'),
    lte: t('小于等于 value'),
    is_null: t('为空（不写 value）'),
    not_null: t('不为空（不写 value）'),
  })[op];
}

/** 可选的基础实体：名称、中文名与字段表（loader 用 fieldsFor 生成，字段带中文名） */
export interface BuilderEntity { name: string; label: string; fields: FormField[] }

/** 聚合能用的度量字段类型：ANY 不限（count / count_distinct 可不选字段）；ratio 只用在分子、分母上，顶层字段隐藏 */
const ANY = 'any' as const;
const FIELD_TYPES: Record<MetricForm['agg'], readonly FieldType[] | typeof ANY> = {
  count: ANY, count_distinct: ANY, sum: NUMERIC_TYPES, avg: NUMERIC_TYPES,
  min: [...NUMERIC_TYPES, ...TEMPORAL_TYPES], max: [...NUMERIC_TYPES, ...TEMPORAL_TYPES],
  ratio: ANY, latest: NUMERIC_TYPES, earliest: NUMERIC_TYPES, days_since: TEMPORAL_TYPES,
};

/** ratio 分子、分母能用的字段类型（count 可不选字段） */
const RATIO_FIELD_TYPES: Record<(typeof RATIO_AGGS)[number], readonly FieldType[] | typeof ANY> = { count: ANY, count_distinct: ANY, sum: NUMERIC_TYPES };

const noValue = (op: Cond['op']) => op === 'is_null' || op === 'not_null';
const multiOf = (op: Cond['op']) => op === 'in' || op === 'not_in';
/** 文本里输的列表（、，逗号或空白分隔） */
const listOf = (text: string) => text.split(/[,，、\s]+/).filter(Boolean);
/** 字段在页面上的显示：有中文名写「中文名（字段名）」，括号随界面语言（字段名本身是路由传的数据，不在这里翻） */
const show = (t: T, f: FormField) => (f.label && f.label !== f.name ? t('{label}（{name}）', { label: f.label, name: f.name }) : f.name);

/** 空表单；换基础实体时字段引用全部失效，重置成它（保留聚合） */
const emptyForm = (): MetricForm => ({
  base: '', agg: 'count',
  numerator: { agg: 'count', filter: [] }, denominator: { agg: 'count', filter: [] },
  filter: [], dimensions: [], readonly: [],
});

/**
 * 序列化进隐藏字段 form：没选字段的条件行丢掉（ui.md「空行保存时忽略」），空字符串归一成缺省；选了字段的时间窗口总是带上
 * （天数 <1 不丢、空输入按 0，交给服务端按 window.days 校验，与直接 POST 同样的值结果一致）；dimensions 与 readonly 构建器没有控件，永远为空（服务端也不信客户端传来的这两项）
 */
function serialize(form: MetricForm): string {
  const conds = (list: readonly Cond[]) => list.filter(c => c.field !== '');
  const part = (p: RatioForm | undefined): RatioForm | undefined =>
    (p === undefined ? undefined : { agg: p.agg, ...(p.field ? { field: p.field } : {}), filter: conds(p.filter) });
  return JSON.stringify({
    base: form.base,
    agg: form.agg,
    ...(form.field ? { field: form.field } : {}),
    ...(form.by ? { by: form.by } : {}),
    ...(form.agg === 'ratio' ? { numerator: part(form.numerator), denominator: part(form.denominator) } : {}),
    filter: conds(form.filter),
    ...(form.window?.field ? { window: { field: form.window.field, days: Number.isFinite(form.window.days) ? form.window.days : 0 } } : {}),
    dimensions: [],
    readonly: [],
  });
}

/** 回显的表单 JSON（actionData.form）读回表单状态；读不出来（只有手工提交才会）从空表单开始，不让渲染报错 */
export function formOfEcho(text: string | undefined | null): MetricForm | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text) as Partial<MetricForm>;
    return typeof v?.base === 'string' && v.base !== '' ? { ...emptyForm(), ...v } : undefined;
  } catch {
    return undefined;
  }
}

/** 换运算：判空不写取值；单值与列表（in / not_in）互换时取值按新形状重置 */
function changeOp(c: Cond, op: Cond['op']): Cond {
  if (noValue(op)) return { field: c.field, op };
  const one = Array.isArray(c.value) ? c.value[0] : c.value;
  return { field: c.field, op, value: multiOf(op) ? (one === undefined || one === '' ? [] : [one]) : one };
}

/** 条件取值控件：enum 字段用下拉（in / not_in 用多选框），其余文本输入（in / not_in 输、或逗号分隔的列表）；判空运算没有取值 */
function ValueInput({ field, cond, onValue }: { field: FormField; cond: Cond; onValue: (value: string | string[]) => void }) {
  const t = useT();
  if (field.enum) {
    if (multiOf(cond.op)) {
      const picked = Array.isArray(cond.value) ? cond.value : [];
      return (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {field.enum.map(v => (
            <label key={v} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox" aria-label={t('取值 {v}', { v })} checked={picked.includes(v)}
                onChange={e => onValue(e.target.checked ? [...picked, v] : picked.filter(x => x !== v))}
              />
              {v}
            </label>
          ))}
        </div>
      );
    }
    return (
      <NativeSelect aria-label={t('条件取值')} value={cond.value ?? ''} onChange={e => onValue(e.target.value)}>
        <NativeSelectOption value="">{t('（请选择）')}</NativeSelectOption>
        {field.enum.map(v => <NativeSelectOption key={v} value={v}>{v}</NativeSelectOption>)}
      </NativeSelect>
    );
  }
  return (
    <Input
      aria-label={t('条件取值')} className="w-44" placeholder={multiOf(cond.op) ? t('多个取值用、或逗号分隔') : t('取值')}
      value={Array.isArray(cond.value) ? cond.value.join(t('、')) : (cond.value ?? '')}
      onChange={e => onValue(multiOf(cond.op) ? listOf(e.target.value) : e.target.value)}
    />
  );
}

/** 一组过滤条件行（顶层 filter 与 ratio 分子、分母各自的 filter）：字段 → 运算（opsFor 按类型）→ 取值；「添加一行」加空行，空行序列化时丢掉 */
function CondRows({ at, fields, conds, onChange }: { at: string; fields: FormField[]; conds: Cond[]; onChange: (conds: Cond[]) => void }) {
  const t = useT();
  const set = (i: number, c: Cond) => onChange(conds.map((x, n) => (n === i ? c : x)));
  return (
    <div className="space-y-2" data-cond-rows={at}>
      {conds.map((c, i) => {
        const field = fields.find(f => f.name === c.field);
        const ops = field ? opsFor(field.type) : undefined;
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <NativeSelect aria-label={t('条件字段')} value={c.field} onChange={e => set(i, { field: e.target.value, op: 'eq' })}>
              <NativeSelectOption value="">{t('（请选择字段）')}</NativeSelectOption>
              {fields.map(f => <NativeSelectOption key={f.name} value={f.name}>{show(t, f)}</NativeSelectOption>)}
            </NativeSelect>
            <NativeSelect aria-label={t('条件运算')} value={c.op} onChange={e => set(i, changeOp(c, e.target.value as Cond['op']))}>
              {(ops ?? [{ op: 'eq' as const }]).map(o => <NativeSelectOption key={o.op} value={o.op}>{opText(t, o.op)}</NativeSelectOption>)}
            </NativeSelect>
            {field && !noValue(c.op) && <ValueInput field={field} cond={c} onValue={value => set(i, { ...c, value })} />}
            <Button type="button" variant="ghost" size="icon" aria-label={t('删除这一行')} onClick={() => onChange(conds.filter((_, n) => n !== i))}><X /></Button>
          </div>
        );
      })}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...conds, { field: '', op: 'eq' }])}><Plus />{t('添加一行')}</Button>
    </div>
  );
}

/** 条件构建器：entities 是本租户能用的实体与字段（loader 生成）；defaultForm 是上次提交回显（actionData.form，JSON） */
export function MetricBuilder({ entities, defaultForm }: { entities: BuilderEntity[]; defaultForm?: MetricForm }) {
  const t = useT();
  const [form, setForm] = useState<MetricForm>(() => ({ ...emptyForm(), ...defaultForm }));
  const fields = entities.find(e => e.name === form.base)?.fields ?? [];
  const typeOf = (name: string | undefined) => fields.find(f => f.name === name)?.type;
  /** 字段类型是否还能用在某聚合上（换聚合时保留还适用的字段，清掉不适用的）；allowed 可能是词表外聚合查出来的 undefined，视为不适用 */
  const fits = (name: string | undefined, allowed: readonly FieldType[] | typeof ANY | undefined) => {
    const type = typeOf(name);
    return name !== undefined && type !== undefined && (allowed === ANY || allowed?.includes(type));
  };
  const patch = (p: Partial<MetricForm>) => setForm(f => ({ ...f, ...p }));
  const setPart = (at: 'numerator' | 'denominator', p: Partial<RatioForm>) => setForm(f => ({ ...f, [at]: { ...(f[at] ?? { agg: 'count', filter: [] }), ...p } }));

  /** 换基础实体：字段引用全部失效，重置（保留聚合）；换聚合：字段与 by 只在类型还适用时保留 */
  const changeBase = (base: string) => setForm(f => ({ ...emptyForm(), base, agg: f.agg }));
  const changeAgg = (agg: MetricForm['agg']) => setForm(f => ({
    ...f,
    agg,
    field: agg === 'ratio' ? undefined : (fits(f.field, FIELD_TYPES[agg]) ? f.field : undefined),
    by: (agg === 'latest' || agg === 'earliest') && fits(f.by, TEMPORAL_TYPES) ? f.by : undefined,
  }));

  /** 某聚合能选的字段下拉选项（count / count_distinct 不限类型，sum / avg 只列数字，min / max 也列日期时间，days_since 与 by 只列时间）；词表外的聚合不按类型过滤，列出全部字段（当前字段仍能选中回显） */
  const fieldOptions = (allowed: readonly FieldType[] | typeof ANY | undefined, empty: string) => (
    <>
      <NativeSelectOption value="">{empty}</NativeSelectOption>
      {fields.filter(f => allowed === ANY || allowed?.includes(f.type)).map(f => <NativeSelectOption key={f.name} value={f.name}>{show(t, f)}</NativeSelectOption>)}
    </>
  );

  /** 词表外的聚合（只有手工改隐藏字段 form 才会出现）：下拉多渲染一个当前值的选项并标出「不支持」，与生成的 YAML 一致，不替客户端猜成别的聚合 */
  const unsupportedAggOption = (agg: string, vocab: readonly string[]) =>
    vocab.includes(agg) ? null : <NativeSelectOption value={agg}>{t('{agg}（不支持，请改选）', { agg })}</NativeSelectOption>;

  return (
    <div className="space-y-5" data-metric-builder>
      <input type="hidden" name="form" value={serialize(form)} />
      <Field>
        <FieldLabel htmlFor="builder-base">{t('基础实体')}</FieldLabel>
        <NativeSelect id="builder-base" value={form.base} onChange={e => changeBase(e.target.value)}>
          <NativeSelectOption value="">{t('（请选择）')}</NativeSelectOption>
          {entities.map(e => <NativeSelectOption key={e.name} value={e.name}>{e.label !== e.name ? t('{label}（{name}）', { label: e.label, name: e.name }) : e.name}</NativeSelectOption>)}
        </NativeSelect>
        <FieldDescription>{t('列表与字段来自本租户能用于指标的定义字段（不含敏感字段）；不能做基础实体的实体会被「检查」拦下。')}</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="builder-agg">{t('聚合')}</FieldLabel>
        <NativeSelect id="builder-agg" value={form.agg} onChange={e => changeAgg(e.target.value as MetricForm['agg'])}>
          {AGGS.map(a => <NativeSelectOption key={a} value={a}>{aggText(t, a)}</NativeSelectOption>)}
          {unsupportedAggOption(form.agg, AGGS)}
        </NativeSelect>
      </Field>
      {form.agg !== 'ratio' && (
        <Field>
          <FieldLabel htmlFor="builder-field">{t('字段')}</FieldLabel>
          <NativeSelect id="builder-field" value={form.field ?? ''} onChange={e => patch({ field: e.target.value || undefined })}>
            {fieldOptions(FIELD_TYPES[form.agg] ?? ANY, form.agg === 'count' ? t('不选（数行数）') : t('（请选择）'))}
          </NativeSelect>
          <FieldDescription>{AGGS.includes(form.agg) ? aggText(t, form.agg) : t('先在上面改选支持的聚合')}</FieldDescription>
        </Field>
      )}
      {(form.agg === 'latest' || form.agg === 'earliest') && (
        <Field>
          <FieldLabel htmlFor="builder-by">{t('取行字段（按哪个日期或时间取那一行）')}</FieldLabel>
          <NativeSelect id="builder-by" value={form.by ?? ''} onChange={e => patch({ by: e.target.value || undefined })}>
            {fieldOptions(TEMPORAL_TYPES, t('（请选择）'))}
          </NativeSelect>
          <FieldDescription>{t('latest / earliest 必须选，不选会在「检查」时被拦下。')}</FieldDescription>
        </Field>
      )}
      {form.agg === 'ratio' && (['numerator', 'denominator'] as const).map(at => (
        <div key={at} className="space-y-3 rounded-xl border p-4" data-ratio-part={at}>
          <p className="text-sm font-medium">{({ numerator: t('分子'), denominator: t('分母') })[at]}</p>
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect aria-label={({ numerator: t('分子聚合'), denominator: t('分母聚合') })[at]} value={form[at]?.agg ?? 'count'} onChange={e => {
              const agg = e.target.value as RatioForm['agg'];
              setPart(at, { agg, field: fits(form[at]?.field, RATIO_FIELD_TYPES[agg]) ? form[at]?.field : undefined });
            }}>
              {RATIO_AGGS.map(a => <NativeSelectOption key={a} value={a}>{ratioAggText(t, a)}</NativeSelectOption>)}
              {unsupportedAggOption(form[at]?.agg ?? 'count', RATIO_AGGS)}
            </NativeSelect>
            <NativeSelect aria-label={({ numerator: t('分子字段'), denominator: t('分母字段') })[at]} value={form[at]?.field ?? ''} onChange={e => setPart(at, { field: e.target.value || undefined })}>
              {fieldOptions(RATIO_FIELD_TYPES[form[at]?.agg ?? 'count'] ?? ANY, t('不选（数行数）'))}
            </NativeSelect>
          </div>
          <CondRows at={at} fields={fields} conds={form[at]?.filter ?? []} onChange={filter => setPart(at, { filter })} />
        </div>
      ))}
      <Field>
        <FieldLabel>{t('过滤条件（列出的条件全部满足）')}</FieldLabel>
        <CondRows at="filter" fields={fields} conds={form.filter} onChange={filter => patch({ filter })} />
      </Field>
      <Field>
        <FieldLabel>{t('时间窗口（可不填）')}</FieldLabel>
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect aria-label={t('时间窗口字段')} value={form.window?.field ?? ''} onChange={e => setForm(f => (e.target.value
            ? { ...f, window: { field: e.target.value, days: f.window ? f.window.days : 30 } }
            : { ...f, window: undefined }))}>
            <NativeSelectOption value="">{t('不限时间')}</NativeSelectOption>
            {fields.filter(f => TEMPORAL_TYPES.includes(f.type)).map(f => <NativeSelectOption key={f.name} value={f.name}>{show(t, f)}</NativeSelectOption>)}
          </NativeSelect>
          {form.window?.field && (
            <>
              <span className="text-sm text-slate-500">{t('近')}</span>
              <Input
                type="number" aria-label={t('时间窗口天数')} className="w-24"
                value={Number.isFinite(form.window.days) ? String(form.window.days) : ''}
                onChange={e => setForm(f => (f.window ? { ...f, window: { ...f.window, days: e.target.value === '' ? Number.NaN : Math.trunc(Number(e.target.value)) } } : f))}
              />
              {/* 「天」单字词条被口径单位标签占用（Day），这里用复数句式：中文两支都是「天」，英文 day / days */}
              <span className="text-sm text-slate-500">{t('{days, plural, one {天} other {天}}', { days: form.window.days })}</span>
            </>
          )}
        </div>
        <FieldDescription>{t('按 asOf（统计日）往前数自然日：只算窗口字段在这个范围内的记录。')}</FieldDescription>
      </Field>
    </div>
  );
}
