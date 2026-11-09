// app/components/tag-builder.tsx —— 新建标签页的条件构建器（ADR-0017：表单为主、YAML 仍是唯一格式）：单指标 / 多指标两种写法、
// 按顺序的规则（取值 + all / any 一层的条件行）、每个被引用指标的缺值策略与默认值，全部选自服务端 loader 给的已发布数值指标表。
// 状态是 TagForm，序列化（空规则、空条件行丢掉）进隐藏字段 form，服务端规整后 formToYaml 成 YAML——与手写 YAML 走完全一样的校验
// （标签不加「检查」按钮：保存时 checkTag 校验，不合法按行列 400）；本组件不做校验，也不接收用户手输的指标键
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '~/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { TAG_CONDITIONS, TAG_CONDITION_TEXT } from '~/lib/tag-vocab';
import type { TagForm, TagItem, TagRule } from '~/lib/tag-form';

/** 可选的指标：键与页面上的显示名（loader 用 metricOf 过滤出已发布、没有维度、取值为数字的指标） */
export interface TagMetricOption { key: string; label: string }

/** 页面上的显示：有中文名写「中文名（键）」 */
const show = (m: TagMetricOption) => (m.label && m.label !== m.key ? `${m.label}（${m.key}）` : m.key);

/** 空表单（单指标写法）；loader 没给可选指标时也是它 */
const emptyForm = (): TagForm => ({ single: true, rules: [], missing: {}, default: '', readonly: [] });

/** 缺值策略的三态：缺省（不写）、按数值（number）、记空（null）；数值没填完整按缺省 */
type MissingChoice = 'default' | 'value' | 'null';
const choiceOf = (v: number | null | undefined): MissingChoice => (v === undefined ? 'default' : v === null ? 'null' : 'value');

/**
 * 序列化进隐藏字段 form：空规则（取值为空或没有留下条件行）、空条件行（没选指标或比较的数字没填成有限数）丢掉
 * （ui.md「空行保存时忽略」），missing 只写规则里引用到的指标；readonly 构建器没有控件，永远为空（服务端也不信客户端传来的）
 */
function serialize(form: TagForm): string {
  const rules = form.rules.flatMap(rule => {
    const items = rule.items.flatMap(item => {
      const cmp = item.cmp.filter(c => Number.isFinite(c.value));
      // 单指标写法的指标取顶层 metric（先加了规则后选指标时行里的 metric 还是空，不能因此丢掉这条规则）
      const metric = form.single ? form.metric : item.metric;
      return metric && cmp.length ? [{ metric, cmp }] : [];
    });
    const kept = form.single ? items.slice(0, 1) : items;
    return String(rule.value).trim() !== '' && kept.length ? [{ value: rule.value, combinator: rule.combinator, items: kept }] : [];
  });
  // 留下来的规则行都带非空 metric（单指标写法已取顶层 metric），引用到的指标就是这些
  const referenced = new Set(rules.flatMap(rule => rule.items.map(item => item.metric)));
  const missing = Object.fromEntries([...referenced]
    .filter(key => form.missing[key] === null || typeof form.missing[key] === 'number')
    .map(key => [key, form.missing[key]]));
  return JSON.stringify({
    single: form.single,
    ...(form.single && form.metric ? { metric: form.metric } : {}),
    rules,
    missing,
    default: form.default,
    ...(form.description !== undefined && form.description !== '' ? { description: form.description } : {}),
    readonly: [],
  });
}

/** 回显的表单 JSON（actionData.tagForm）读回表单状态；读不出来（只有手工提交才会）从空表单开始，不让渲染报错 */
export function formOfTagEcho(text: string | undefined | null): TagForm | undefined {
  if (!text) return undefined;
  try {
    const v = JSON.parse(text) as Partial<TagForm>;
    return typeof v?.single === 'boolean' ? { ...emptyForm(), ...v } : undefined;
  } catch {
    return undefined;
  }
}

/** 换单指标 / 多指标：单指标的条件行指标取顶层 metric（每条规则只留第一条），多指标把顶层 metric 放进各行的第一条 */
function switchMode(form: TagForm, single: boolean): TagForm {
  if (single) return {
    ...form, single,
    metric: form.metric ?? form.rules[0]?.items[0]?.metric,
    rules: form.rules.map(rule => ({ ...rule, combinator: 'all', items: rule.items.slice(0, 1) })),
  };
  const metric = form.metric ?? '';
  return {
    ...form, single, metric: undefined,
    rules: form.rules.map(rule => ({ ...rule, items: rule.items.map(item => ({ ...item, metric: item.metric || metric })) })),
  };
}

/** 一条规则：取值 +（多指标时）all / any + 条件行（指标下拉 + 比较下拉 + 数字）；「添加一行」加空条件行，空行序列化时丢掉 */
function RuleRows({ form, metrics, onChange }: {
  form: TagForm;
  metrics: TagMetricOption[];
  onChange: (rules: TagRule[]) => void;
}) {
  const set = (i: number, rule: TagRule) => onChange(form.rules.map((x, n) => (n === i ? rule : x)));
  const setItem = (i: number, j: number, item: TagItem) => set(i, { ...form.rules[i]!, items: form.rules[i]!.items.map((x, n) => (n === j ? item : x)) });
  const metricOptions = (value: string) => (
    <>
      <NativeSelectOption value="">（请选择指标）</NativeSelectOption>
      {metrics.map(m => <NativeSelectOption key={m.key} value={m.key}>{show(m)}</NativeSelectOption>)}
      {value && !metrics.some(m => m.key === value) && <NativeSelectOption value={value}>{value}</NativeSelectOption>}
    </>
  );
  return (
    <div className="space-y-3" data-tag-rules>
      {form.rules.map((rule, i) => (
        <div key={i} className="space-y-2 rounded-xl border p-4" data-tag-rule={i}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-slate-500">规则 {i + 1}</span>
            <Input aria-label="规则取值" className="w-36" placeholder="取值，如 high" value={rule.value}
              onChange={e => set(i, { ...rule, value: e.target.value })} />
            {!form.single && (
              <NativeSelect aria-label="条件的组合方式" value={rule.combinator} onChange={e => set(i, { ...rule, combinator: e.target.value as TagRule['combinator'] })}>
                <NativeSelectOption value="all">全部满足（all）</NativeSelectOption>
                <NativeSelectOption value="any">任一满足（any）</NativeSelectOption>
              </NativeSelect>
            )}
            <Button type="button" variant="ghost" size="icon" aria-label="删除这条规则" onClick={() => onChange(form.rules.filter((_, n) => n !== i))}><X /></Button>
          </div>
          <div className="space-y-2" data-cond-rows={`rule-${i}`}>
            {(form.single ? rule.items.slice(0, 1) : rule.items).map((item, j) => (
              <div key={j} className="flex flex-wrap items-center gap-2">
                {form.single ? (
                  <span className="text-sm text-slate-500">{form.metric ? `指标 ${form.metric}` : '先在上面选指标'}</span>
                ) : (
                  <NativeSelect aria-label="条件指标" value={item.metric} onChange={e => setItem(i, j, { ...item, metric: e.target.value })}>
                    {metricOptions(item.metric)}
                  </NativeSelect>
                )}
                <NativeSelect aria-label="比较" value={item.cmp[0]?.op ?? 'gte'}
                  onChange={e => setItem(i, j, { ...item, cmp: [{ op: e.target.value as TagItem['cmp'][number]['op'], value: item.cmp[0]?.value ?? 0 }] })}>
                  {TAG_CONDITIONS.map(c => <NativeSelectOption key={c} value={c}>{TAG_CONDITION_TEXT[c]}</NativeSelectOption>)}
                </NativeSelect>
                <Input
                  type="number" aria-label="比较数字" className="w-28" placeholder="数字"
                  value={item.cmp[0]?.value ?? ''}
                  onChange={e => setItem(i, j, { ...item, cmp: [{ op: item.cmp[0]?.op ?? 'gte', value: Number(e.target.value) }] })}
                />
                {!form.single && (
                  <Button type="button" variant="ghost" size="icon" aria-label="删除这一行" onClick={() => set(i, { ...rule, items: rule.items.filter((_, n) => n !== j) })}><X /></Button>
                )}
              </div>
            ))}
            {!form.single && (
              <Button type="button" variant="outline" size="sm" onClick={() => set(i, { ...rule, items: [...rule.items, { metric: '', cmp: [{ op: 'gte', value: 0 }] }] })}><Plus />添加一行</Button>
            )}
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...form.rules, { value: '', combinator: 'all', items: [{ metric: form.single ? (form.metric ?? '') : '', cmp: [{ op: 'gte', value: 0 }] }] }])}><Plus />添加一条规则</Button>
    </div>
  );
}

/** 条件构建器：metrics 是本租户已发布、没有维度、取值为数字的指标（loader 生成）；defaultForm 是上次提交回显（actionData.tagForm，JSON） */
export function TagBuilder({ metrics, defaultForm }: { metrics: TagMetricOption[]; defaultForm?: TagForm }) {
  const [form, setForm] = useState<TagForm>(() => ({ ...emptyForm(), ...defaultForm }));
  const patch = (p: Partial<TagForm>) => setForm(f => ({ ...f, ...p }));
  /** 规则里引用到的指标（单指标取顶层 metric），缺值策略按它显示 */
  const referenced = form.single
    ? (form.metric ? [form.metric] : [])
    : [...new Set(form.rules.flatMap(rule => rule.items.map(item => item.metric).filter(m => m !== '')))];
  const labelOf = (key: string) => metrics.find(m => m.key === key)?.label ?? key;

  if (!metrics.length) {
    return (
      <div className="space-y-5" data-tag-builder>
        <input type="hidden" name="form" value={serialize(form)} />
        <p className="text-sm text-slate-500">先发布一个数值型指标（没有维度），标签的规则要比较它们的取值。</p>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-tag-builder>
      <input type="hidden" name="form" value={serialize(form)} />
      <Field>
        <FieldLabel htmlFor="tag-mode">写法（单指标 / 多指标）</FieldLabel>
        <NativeSelect id="tag-mode" value={form.single ? 'single' : 'multi'} onChange={e => setForm(f => switchMode(f, e.target.value === 'single'))}>
          <NativeSelectOption value="single">单指标：全部规则比较同一个指标</NativeSelectOption>
          <NativeSelectOption value="multi">多指标：每条规则里选 all / any 与各指标的比较</NativeSelectOption>
        </NativeSelect>
        <FieldDescription>两种写法不能混用；规则按顺序取第一条命中的，都没命中取默认值。</FieldDescription>
      </Field>
      {form.single && (
        <Field>
          <FieldLabel htmlFor="tag-metric">指标</FieldLabel>
          <NativeSelect id="tag-metric" value={form.metric ?? ''} onChange={e => patch({ metric: e.target.value || undefined })}>
            <NativeSelectOption value="">（请选择）</NativeSelectOption>
            {metrics.map(m => <NativeSelectOption key={m.key} value={m.key}>{show(m)}</NativeSelectOption>)}
          </NativeSelect>
          <FieldDescription>列表是本租户已发布、没有维度、取值为数字的指标。</FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel>规则（按顺序，第一条命中的给出取值）</FieldLabel>
        <RuleRows form={form} metrics={metrics} onChange={rules => patch({ rules })} />
      </Field>
      <Field>
        <FieldLabel>缺值策略（消费者不在某个指标的结果里时按什么比较）</FieldLabel>
        {referenced.length === 0 && <p className="text-sm text-slate-500">先在规则里引用指标。</p>}
        {referenced.map(key => {
          const choice = choiceOf(form.missing[key]);
          return (
            <div key={key} className="flex flex-wrap items-center gap-2" data-tag-missing={key}>
              <span className="text-sm text-slate-500">{labelOf(key)}</span>
              <NativeSelect aria-label={`${labelOf(key)} 的缺值策略`} value={choice} onChange={e => {
                const picked = e.target.value as MissingChoice;
                const missing = { ...form.missing };
                if (picked === 'default') delete missing[key];
                else missing[key] = picked === 'null' ? null : 0;
                patch({ missing });
              }}>
                <NativeSelectOption value="default">缺省（计数 / 求和记 0，其余记空）</NativeSelectOption>
                <NativeSelectOption value="value">按数值</NativeSelectOption>
                <NativeSelectOption value="null">记空（比较为假）</NativeSelectOption>
              </NativeSelect>
              {choice === 'value' && (
                <Input
                  type="number" aria-label={`${labelOf(key)} 的缺省数值`} className="w-24" placeholder="数字"
                  value={typeof form.missing[key] === 'number' ? String(form.missing[key]) : ''}
                  onChange={e => patch({ missing: { ...form.missing, [key]: Number(e.target.value) } })}
                />
              )}
            </div>
          );
        })}
        <FieldDescription>不在指标结果里（或取值为空）的消费者按这里的取值比较；没写的指标按缺省。</FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor="tag-default">默认值（都没命中时的取值）</FieldLabel>
        <Input id="tag-default" className="max-w-xs" placeholder="如 normal" value={form.default} onChange={e => patch({ default: e.target.value })} />
      </Field>
      <Field>
        <FieldLabel htmlFor="tag-description">说明（可不填）</FieldLabel>
        <Input id="tag-description" className="max-w-2xl" placeholder="这个标签分什么" value={form.description ?? ''} onChange={e => patch({ description: e.target.value })} />
      </Field>
    </div>
  );
}
