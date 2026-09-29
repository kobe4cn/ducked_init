import { Form, redirect } from "react-router";
import type { Route } from "./+types/login";
import { getCurrentMember, requestMagicLink } from "~/.server/auth";

export function meta({}: Route.MetaArgs) {
  return [{ title: "登录 · CRM 数据分析平台" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  if (await getCurrentMember(request)) throw redirect("/");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const email = String((await request.formData()).get("email") ?? "");
  await requestMagicLink(email, new URL(request.url).origin);
  // 无论邮箱是否已登记都给出同样的答复，避免被用来探测成员邮箱
  return { sent: true };
}

export default function Login({ actionData }: Route.ComponentProps) {
  return (
    <main className="container mx-auto max-w-sm p-8 space-y-4">
      <h1 className="text-2xl font-semibold">登录</h1>
      {actionData?.sent ? (
        <p>如果该邮箱已被邀请加入平台，你会收到一封含登录链接的邮件。</p>
      ) : (
        <Form method="post" className="space-y-3">
          <input type="email" name="email" required placeholder="工作邮箱" className="w-full border rounded px-3 py-2" />
          <button type="submit" className="w-full rounded bg-black text-white py-2">发送登录链接</button>
          <p className="text-sm text-gray-500">平台仅限受邀成员使用，不开放注册。</p>
        </Form>
      )}
    </main>
  );
}
