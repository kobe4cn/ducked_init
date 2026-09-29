// app/routes/ops.totp.tsx —— 运营者第二因素：首次登录时绑定 TOTP（展示密钥并确认一次验证码），之后每次登录输入验证码
import { data, Form, redirect, useNavigation } from 'react-router';
import type { Route } from './+types/ops.totp';
import { totpChallenge, verifyOperatorTotp } from '~/.server/ops-auth';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '~/components/ui/field';
import { Input } from '~/components/ui/input';

export function meta({}: Route.MetaArgs) {
  return [{ title: 'TOTP 验证 · 运营后台' }];
}

export async function loader({ request }: Route.LoaderArgs) {
  return totpChallenge(request);
}

export async function action({ request }: Route.ActionArgs) {
  const code = String((await request.formData()).get('code') ?? '');
  const result = await verifyOperatorTotp(request, code);
  if (result.ok) throw redirect('/ops', { headers: { 'Set-Cookie': result.setCookie } });
  if (result.locked) throw redirect('/ops/login?reason=totp_locked', { headers: { 'Set-Cookie': result.setCookie } });
  return data({ error: result.error }, { status: 400 });
}

/** 密钥每 4 个字符一组，便于手动输入 */
const grouped = (secret: string) => secret.match(/.{1,4}/g)!.join(' ');

export default function OpsTotp({ loaderData, actionData }: Route.ComponentProps) {
  const { email, setup } = loaderData;
  const submitting = useNavigation().state === 'submitting';
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-xl">{setup ? '绑定 TOTP' : '输入 TOTP 验证码'}</CardTitle>
          <CardDescription>
            {setup
              ? `运营后台强制使用第二因素。请在认证器 App 中为 ${email} 添加一个条目，然后输入 App 上显示的 6 位验证码完成绑定。`
              : `请输入认证器 App 上 ${email} 的 6 位验证码。`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {setup && (
            <dl className="flex flex-col gap-2 text-sm">
              <dt className="text-muted-foreground">密钥（手动输入）</dt>
              <dd className="font-mono text-base tracking-wider" data-totp-secret={setup.secret}>{grouped(setup.secret)}</dd>
              <dt className="text-muted-foreground">绑定链接（可生成二维码扫码添加）</dt>
              <dd className="break-all font-mono text-xs">{setup.uri}</dd>
            </dl>
          )}
          <Form method="post">
            <FieldGroup>
              <Field data-invalid={!!actionData?.error}>
                <FieldLabel htmlFor="code">验证码</FieldLabel>
                <Input
                  id="code"
                  name="code"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]{6,7}"
                  aria-invalid={!!actionData?.error}
                />
                {actionData?.error && <FieldError role="alert">{actionData.error}</FieldError>}
              </Field>
              <Field>
                <Button type="submit" disabled={submitting}>{setup ? '确认绑定并登录' : '登录'}</Button>
                <FieldDescription className="text-center">连续输错 5 次后需要重新申请登录链接。</FieldDescription>
              </Field>
            </FieldGroup>
          </Form>
        </CardContent>
      </Card>
    </main>
  );
}
