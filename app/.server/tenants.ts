// app/.server/tenants.ts —— 运营者开通租户：租户 + 默认空间 + 首个管理员，一个事务内完成
import { getDb } from './db/client';
import { members, spaces, tenants } from './db/schema';

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreateTenantInput { slug: string; name: string; adminEmail: string }

export async function createTenant(input: CreateTenantInput) {
  const slug = input.slug.trim();
  const name = input.name.trim();
  const adminEmail = normalizeEmail(input.adminEmail);
  if (!SLUG.test(slug)) throw new Error(`租户标识不合法：${slug}（只允许小写字母、数字与连字符）`);
  if (!name) throw new Error('租户名称不能为空');
  if (!EMAIL.test(adminEmail)) throw new Error(`管理员邮箱不合法：${input.adminEmail}`);

  return getDb().transaction(async tx => {
    const [tenant] = await tx.insert(tenants).values({ slug, name }).returning();
    const [space] = await tx.insert(spaces).values({ tenantId: tenant.id, name: '默认空间', isDefault: true }).returning();
    const [admin] = await tx.insert(members).values({ tenantId: tenant.id, email: adminEmail, role: 'admin' }).returning();
    return { tenant, space, admin };
  });
}
