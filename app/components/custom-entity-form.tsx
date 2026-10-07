// app/components/custom-entity-form.tsx —— 自定义实体登记的表单与只读字段表、关系表（ADR-0019）：列表页的新建与详情页的编辑共用。
// 已有字段各一行，再加 EXTRA_ROWS 行空行（空行忽略）；「添加字段」再多给空行，没加载脚本时就先保存再加。主键是逗号分隔的字段名。
// 关系同样按行填：起点实体（本实体或标准实体）、起点字段、终点实体（标准实体与已发布的自定义实体里选）与终点字段（终点的主键）
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Form } from 'react-router';
import { Button } from '~/components/ui/button';
import { Field, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';
import { CUSTOM_ENTITY_KINDS, entityOf, FIELD_TYPE_NAMES, FIELD_TYPES, type CustomEntityField, type EntityRelation } from '~/lib/canonical-model';

/** 表单里的一版登记（与服务端的 CustomEntityInput 同形；类型按字符串传，未通过校验时原样回显） */
export interface EntityFormValues {
  name?: string;
  label: string;
  kind: string;
  fields: (Omit<CustomEntityField, 'type'> & { type: string })[];
  primaryKey: string[];
  relations?: EntityRelation[];
}

/** 关系可选的终点：名称、中文名与主键 */
export interface RelationTarget { name: string; label: string; primaryKey: string[] }

/** 已有字段之后多给的空行数 */
const EXTRA_ROWS = 3;
/** 已有关系之后多给的空行数 */
const EXTRA_RELATION_ROWS = 1;

const EMPTY: EntityFormValues = { label: '', kind: 'dimension', fields: [], primaryKey: [] };

/**
 * 登记表单（提交 intent）：新建时多一个名称输入框（建实体时定下，之后不能改）。
 * 字段按行提交 fieldName / fieldType / fieldDescription，敏感勾选框提交行号 fieldSensitive；关系按行提交 relFrom / relField / relEntity / relTarget，
 * 起点实体选「本实体」时 relFrom 为空
 */
export function CustomEntityForm({ intent, values, targets, submitting, submitLabel }: {
  intent: 'create' | 'save';
  values?: EntityFormValues | null;
  targets: RelationTarget[];
  submitting: boolean;
  submitLabel: string;
}) {
  const v = values ?? EMPTY;
  const canonical = targets.filter(t => entityOf(t.name));
  const [extra, setExtra] = useState(EXTRA_ROWS);
  const [extraRelations, setExtraRelations] = useState(EXTRA_RELATION_ROWS);
  const rows = [...v.fields, ...Array.from({ length: extra }, () => ({ name: '', type: 'string', description: '', sensitive: false }))];
  const relationRows = [
    ...(v.relations ?? []),
    ...Array.from({ length: extraRelations }, () => ({ from: { entity: '', field: '' }, ref: { entity: '', field: '' } })),
  ];
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
      <Button type="button" variant="outline" size="sm" onClick={() => setExtra(n => n + 1)}>
        <Plus />添加字段
      </Button>
      <p className="max-w-2xl text-sm text-slate-500">{`字段名只用小写字母、数字与下划线，以字母开头；字段名留空的行忽略。敏感字段在标准层只存哈希，类型只能是 string。`}</p>
      <Field className="max-w-2xl">
        <FieldLabel htmlFor="entity-primary-key">主键</FieldLabel>
        <Input id="entity-primary-key" name="primaryKey" defaultValue={v.primaryKey.join(', ')} placeholder="store_id" className="font-mono" required />
      </Field>
      <div className="overflow-x-auto rounded-2xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>关系：起点实体</TableHead>
              <TableHead>起点字段</TableHead>
              <TableHead>终点实体</TableHead>
              <TableHead>终点字段（主键）</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {relationRows.map((r, i) => (
              <TableRow key={i} data-relation-row={i}>
                <TableCell>
                  <NativeSelect name="relFrom" defaultValue={entityOf(r.from.entity) ? r.from.entity : ''} aria-label={`第 ${i + 1} 条关系的起点实体`}>
                    <NativeSelectOption value="">本实体</NativeSelectOption>
                    {canonical.map(t => <NativeSelectOption key={t.name} value={t.name}>{`${t.name}（${t.label}）`}</NativeSelectOption>)}
                  </NativeSelect>
                </TableCell>
                <TableCell><Input name="relField" defaultValue={r.from.field} placeholder="region_id" aria-label={`第 ${i + 1} 条关系的字段`} className="font-mono" /></TableCell>
                <TableCell>
                  <NativeSelect name="relEntity" defaultValue={r.ref.entity} aria-label={`第 ${i + 1} 条关系的终点实体`}>
                    <NativeSelectOption value="">选择实体</NativeSelectOption>
                    {/* 已填的终点不在可选列表里（如没发布）时也列出，报错后原样回显 */}
                    {r.ref.entity && !targets.some(t => t.name === r.ref.entity) && <NativeSelectOption value={r.ref.entity}>{r.ref.entity}</NativeSelectOption>}
                    {targets.map(t => <NativeSelectOption key={t.name} value={t.name}>{`${t.name}（${t.label}）`}</NativeSelectOption>)}
                  </NativeSelect>
                </TableCell>
                <TableCell><Input name="relTarget" defaultValue={r.ref.field} placeholder="终点的主键" aria-label={`第 ${i + 1} 条关系的终点字段`} className="font-mono" /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={() => setExtraRelations(n => n + 1)}>
        <Plus />添加关系
      </Button>
      <p className="max-w-2xl text-sm text-slate-500">
        {`关系把一个字段指向另一个实体的主键，两端类型要相同。起点是本实体的字段时，终点可以是标准实体或已发布的自定义实体，只能是单列主键：${targets.filter(t => t.primaryKey.length === 1).map(t => `${t.name}.${t.primaryKey[0]}`).join('、') || '暂无'}。起点也可以是标准实体的字段（含已发布映射用过的 x_ 扩展字段，如 order.x_store_id），这时终点是本实体的主键。不能成环。字段留空的行忽略；发布后只能新增关系。`}
      </p>
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

/** 一版登记的只读关系表：起点实体.起点字段 → 终点实体.终点字段；没有关系时不显示 */
export function EntityRelationsTable({ relations }: { relations: EntityRelation[] }) {
  if (!relations.length) return null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>关系：起点</TableHead>
          <TableHead>终点</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {relations.map(r => (
          <TableRow key={`${r.from.entity}-${r.from.field}-${r.ref.entity}-${r.ref.field}`} data-relation={r.from.field}>
            <TableCell className="font-mono">{`${r.from.entity}.${r.from.field}`}</TableCell>
            <TableCell className="font-mono">{`${r.ref.entity}.${r.ref.field}`}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
