// app/routes/ops.model-prices.tsx —— 运营后台的模型单价页：llm_calls.model 的每百万 token 输入 / 输出单价（ADR-0057），
// 只有元数据，不显示任何租户的调用数据（ADR-0007）；填已有模型名就是修改，同值保存不会有任何变化
import { data, Form, redirect, useNavigation } from 'react-router';
import { CircleAlert } from 'lucide-react';
import type { Route } from './+types/ops.model-prices';
import { requireOperator } from '~/.server/ops-auth';
import { listModelPrices, ModelPriceError, upsertModelPrice } from '~/.server/model-prices';
import { OpsShell } from '~/components/ops-shell';
import { PageHeader } from '~/components/page-header';
import { SectionHeader } from '~/components/section-header';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';
import { NativeSelect, NativeSelectOption } from '~/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '~/components/ui/table';

export function meta({}: Route.MetaArgs) {
  return [{ title: '模型单价 · 运营后台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const operator = await requireOperator(request);
  const prices = await listModelPrices();
  return { email: operator.email, prices: prices.map(p => ({ ...p, updatedAt: p.updatedAt.toISOString() })) };
}

export async function action({ request }: Route.ActionArgs) {
  const operator = await requireOperator(request);
  const form = await request.formData();
  if (String(form.get('intent') ?? '') !== 'save-price') return data({ error: '未知操作' }, { status: 400 });
  try {
    await upsertModelPrice(operator, {
      model: form.get('model'),
      inputPerMTok: form.get('inputPerMTok'),
      outputPerMTok: form.get('outputPerMTok'),
      currency: form.get('currency'),
    });
  } catch (e) {
    if (e instanceof ModelPriceError) return data({ error: e.message }, { status: e.status });
    throw e;
  }
  throw redirect('/ops/model-prices');
}

const CURRENCIES = ['CNY', 'USD'] as const;

export default function OpsModelPrices({ loaderData, actionData }: Route.ComponentProps) {
  const { email, prices } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  return (
    <OpsShell email={email}>
      <PageHeader title="模型单价" description="按模型名配置每百万 token 的输入 / 输出单价，金额按当前单价折算（ADR-0057）；只能增改，不能删除。" />

      {actionData?.error && (
        <Alert variant="destructive" role="alert">
          <CircleAlert />
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>{actionData.error}</AlertDescription>
        </Alert>
      )}

      {prices.length ? (
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>模型</TableHead>
                <TableHead className="text-right">输入单价（每百万 token）</TableHead>
                <TableHead className="text-right">输出单价（每百万 token）</TableHead>
                <TableHead>币种</TableHead>
                <TableHead>更新时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prices.map(p => (
                <TableRow key={p.model} data-model={p.model} data-currency={p.currency}>
                  <TableCell className="font-mono">{p.model}</TableCell>
                  <TableCell className="text-right">{p.inputPerMTok}</TableCell>
                  <TableCell className="text-right">{p.outputPerMTok}</TableCell>
                  <TableCell>{p.currency}</TableCell>
                  <TableCell className="text-slate-500">{new Date(p.updatedAt).toLocaleString('zh-CN')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="rounded-2xl border bg-white p-6 text-slate-500 shadow-sm">暂无模型单价。在下面填模型名与单价，保存第一条。</div>
      )}

      <div className="max-w-2xl space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <SectionHeader title="新增或修改单价">单价按每百万 token 计。填已有模型名就是修改；保存相同的单价不会有任何变化，也不写审计。不同币种的金额不相加。</SectionHeader>
        <Form method="post">
          <input type="hidden" name="intent" value="save-price" />
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="price-model">模型名</FieldLabel>
              <Input id="price-model" name="model" required placeholder="qwen-plus" />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="price-input">输入单价（每百万 token）</FieldLabel>
                <Input id="price-input" name="inputPerMTok" required inputMode="decimal" placeholder="2.5" />
              </Field>
              <Field>
                <FieldLabel htmlFor="price-output">输出单价（每百万 token）</FieldLabel>
                <Input id="price-output" name="outputPerMTok" required inputMode="decimal" placeholder="10" />
              </Field>
              <Field>
                <FieldLabel htmlFor="price-currency">币种</FieldLabel>
                <NativeSelect id="price-currency" name="currency" defaultValue="CNY">
                  {CURRENCIES.map(c => <NativeSelectOption key={c} value={c}>{c}</NativeSelectOption>)}
                </NativeSelect>
              </Field>
            </div>
            <div>
              <Button type="submit" disabled={submitting}>保存</Button>
            </div>
          </FieldGroup>
        </Form>
      </div>
    </OpsShell>
  );
}
