// app/components/custom-entity-form.tsx —— 自定义实体登记的表单与只读字段表（ADR-0019）：列表页的新建与详情页的编辑共用。
// 不用脚本增删行：已有字段各一行，再加 EXTRA_ROWS 行空行（空行忽略），要更多行就先保存。主键是逗号分隔的字段名
import { Form } from 'react-router';
import { Button } from '~/components/ui/button';
import { Field, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { CUSTOM_ENTITY_KINDS, FIELD_TYPE_NAMES, FIELD_TYPES, type CustomEntityField } from '~/lib/canonical-model';

/** 表单里的一版登记（与服务端的 CustomEntityInput 同形；类型按字符串传，未通过校验时原样回显） */
export interface EntityFormValues {
  name?: string;
  label: string;
  kind: string;
  fields: (Omit<CustomEntityField, 'type'> & { type: string })[];
  primaryKey: string[];
}

/** 已有字段之后多给的空行数 */
const EXTRA_ROWS = 3;

const EMPTY: EntityFormValues = { label: '', kind: 'dimension', fields: [], primaryKey: [] };

/**
 * 登记表单（提交 intent）：新建时多一个名称输入框（建实体时定下，之后不能改）。
 * 字段按行提交 fieldName / fieldType / fieldDescription，敏感勾选框提交行号 fieldSensitive
 */
export function CustomEntityForm({ intent, values, submitting, submitLabel }: {
  intent: 'create' | 'save';
  values?: EntityFormValues | null;
  submitting: boolean;
  submitLabel: string;
}) {
  const v = values ?? EMPTY;
  const rows = [...v.fields, ...Array.from({ length: EXTRA_ROWS }, () => ({ name: '', type: 'string', description: '', sensitive: false }))];
  return (
    <Form method="post" className="space-y-5 text-left">
      <input type="hidden" name="intent" value={intent} />
      <div className="grid max-w-2xl gap-4 sm:grid-cols-3">
        {intent === 'create' && (
          <Field>
            <FieldLabel htmlFor="entity-name">名称</FieldLabel>
            <Input id="entity-name" name="name" defaultValue={v.name ?? ''} placeholder="custom_store" className="font-mono" required />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="entity-label">中文名</FieldLabel>
          <Input id="entity-label" name="label" defaultValue={v.label} placeholder="门店" required />
        </Field>
        <Field>
          <FieldLabel htmlFor="entity-kind">类型</FieldLabel>
          <NativeSelect id="entity-kind" name="kind" defaultValue={v.kind}>
            {Object.entries(CUSTOM_ENTITY_KINDS).map(([k, label]) => <NativeSelectOption key={k} value={k}>{label}</NativeSelectOption>)}
          </NativeSelect>
        </Field>
      </div>
      {intent === 'create' && <p className="max-w-2xl text-sm text-slate-500">名称以 custom_ 开头，只含小写字母、数字和下划线，建好后不能改。类型只用于引导：维度是被描述的对象（如门店），事实是发生的事件（如巡店记录）。</p>}
      <div className="overflow-x-auto rounded-2xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>字段名</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>说明</TableHead>
              <TableHead>敏感</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((f, i) => (
              <TableRow key={i} data-field-row={i}>
                <TableCell><Input name="fieldName" defaultValue={f.name} aria-label={`第 ${i + 1} 行字段名`} className="font-mono" /></TableCell>
                <TableCell>
                  <NativeSelect name="fieldType" defaultValue={f.type} aria-label={`第 ${i + 1} 行类型`}>
                    {FIELD_TYPE_NAMES.map(t => <NativeSelectOption key={t} value={t}>{`${t}（${FIELD_TYPES[t].label}）`}</NativeSelectOption>)}
                  </NativeSelect>
                </TableCell>
                <TableCell><Input name="fieldDescription" defaultValue={f.description} aria-label={`第 ${i + 1} 行说明`} /></TableCell>
                <TableCell><input type="checkbox" name="fieldSensitive" value={i} defaultChecked={f.sensitive} aria-label={`第 ${i + 1} 行敏感`} className="size-4" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="max-w-2xl text-sm text-slate-500">{`字段名只用小写字母、数字与下划线，以字母开头；字段名留空的行忽略，要更多行请先保存。敏感字段在标准层只存哈希，类型只能是 string。`}</p>
      <Field className="max-w-2xl">
        <FieldLabel htmlFor="entity-primary-key">主键</FieldLabel>
        <Input id="entity-primary-key" name="primaryKey" defaultValue={v.primaryKey.join(', ')} placeholder="store_id" className="font-mono" required />
      </Field>
      <Button type="submit" disabled={submitting}>{submitting ? '正在保存…' : submitLabel}</Button>
    </Form>
  );
}

/** 一版登记的只读字段表：主键字段标「主键」，敏感字段标「敏感」 */
export function EntityFieldsTable({ fields, primaryKey }: Pick<EntityFormValues, 'fields' | 'primaryKey'>) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>字段名</TableHead>
          <TableHead>类型</TableHead>
          <TableHead>说明</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {fields.map(f => (
          <TableRow key={f.name} data-field={f.name}>
            <TableCell className="font-mono">{f.name}</TableCell>
            <TableCell className="text-sm">{f.type}</TableCell>
            <TableCell className="text-sm text-slate-500">{f.description || '—'}</TableCell>
            <TableCell className="text-sm text-slate-500">{[primaryKey.includes(f.name) && '主键', f.sensitive && '敏感'].filter(Boolean).join('、')}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
