// app/components/source-view-form.tsx —— 源视图的 SQL 编辑框与新建表单（ADR-0022）：源视图页与数据源页的空状态共用
import { Form } from 'react-router';
import { Button } from '~/components/ui/button';
import { Field, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';

/** 编写源视图时的规则说明 */
export const SOURCE_VIEW_HINT = '只能读本数据源原始层的表，表名直接写源表名（如 customers），不能读标准层、结果层或其他数据源，也不能写入。'
  + '视图要输出平台列 _op、_batch、_commit_ts（从原始层的表里带出来），映射才能按变更批次增量合并。';

export function SqlEditor({ defaultValue, readOnly }: { defaultValue: string; readOnly?: boolean }) {
  return (
    <textarea
      name="sql"
      defaultValue={defaultValue}
      readOnly={readOnly}
      spellCheck={false}
      rows={Math.max(10, defaultValue.split('\n').length + 2)}
      className="w-full rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-xs leading-5 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 read-only:bg-muted"
    />
  );
}

/** 新建源视图（intent=create，提交到 action，即 /sources/:sourceId/views/new）：视图名与 SQL，校验通过后保存为第一版草稿 */
export function NewSourceViewForm({ action, name, sql, submitting }: { action?: string; name?: string | null; sql?: string | null; submitting: boolean }) {
  return (
    <Form method="post" action={action} className="space-y-4 text-left">
      <input type="hidden" name="intent" value="create" />
      <Field className="max-w-2xl">
        <FieldLabel htmlFor="name">视图名</FieldLabel>
        <Input id="name" name="name" defaultValue={name ?? ''} placeholder="customer_orders" className="font-mono" required />
      </Field>
      <p className="max-w-2xl text-sm text-slate-500">{SOURCE_VIEW_HINT}</p>
      <SqlEditor defaultValue={sql ?? 'SELECT *\nFROM customers'} />
      <Button type="submit" disabled={submitting}>{submitting ? '正在校验…' : '校验并保存草稿'}</Button>
    </Form>
  );
}
