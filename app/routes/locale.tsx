// app/routes/locale.tsx —— 切换界面语言（ADR-0060）：入口在页面外壳上，用 <Form reloadDocument method="post" action="/locale"> 整页提交
// 总是写 cookie（登录与否都写，退出后登录页仍是刚选的语言）；已登录时再同步到同一邮箱的所有成员记录。
// 项目没有 CSRF token，和 logout 一样靠 session cookie 的 SameSite=Lax
import { redirect } from 'react-router';
import { eq } from 'drizzle-orm';
import type { Route } from './+types/locale';
import { getCurrentMember } from '~/.server/auth';
import { getDb } from '~/.server/db/client';
import { members } from '~/.server/db/schema';
import { localeSwitchEnabled } from '~/.server/locale';

export async function loader() {
  throw redirect('/');
}

export async function action({ request }: Route.ActionArgs) {
  if (!localeSwitchEnabled()) throw new Response('Not Found', { status: 404 });
  const form = await request.formData();
  const locale = form.get('locale');
  if (locale !== 'en' && locale !== 'zh-CN') throw new Response('Bad Request', { status: 400 });
  // redirectTo 只认站内路径，防开放跳转（仓库里没有现成 helper）
  const requested = String(form.get('redirectTo') ?? '');
  const redirectTo = requested.startsWith('/') && !requested.startsWith('//') && !requested.startsWith('/\\') ? requested : '/';
  const current = await getCurrentMember(request);
  if (current) {
    // 同一邮箱在所有租户的成员记录同步更新；邮箱入库前已 normalize，直接等值匹配，不需要租户上下文
    await getDb().update(members).set({ locale }).where(eq(members.email, current.email));
  }
  // cookie 用明文值（getLocale 按明文读）；有效期一年，退出登录后选择仍保留
  throw redirect(redirectTo, { headers: { 'Set-Cookie': `crm_locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax` } });
}
