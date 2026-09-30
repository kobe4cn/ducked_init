// scripts/reset-operator-totp.ts —— 用法：npm run operator:reset-totp -- --email ops@example.com
// 运营者丢失认证器时重置 TOTP（ADR-0007）：只能在服务器上执行。该运营者已登录与待验证的会话全部作废，
// 下次登录时重新绑定 TOTP；在其完成绑定之前，谁拿到登录链接谁就能绑定，重置后应尽快通知本人登录
import { parseArgs } from 'node:util';
import { closeDb } from '../app/.server/db/client';
import { resetOperatorTotp } from '../app/.server/ops-auth';

const { values } = parseArgs({ options: { email: { type: 'string' } } });

if (!values.email) {
  console.error('用法：npm run operator:reset-totp -- --email <运营者邮箱>');
  process.exit(2);
}

try {
  const operator = await resetOperatorTotp(values.email);
  console.log(`已重置运营者 ${operator.email} 的 TOTP，其会话与未使用的登录链接均已作废`);
  console.log('  请尽快通知本人在 /ops/login 登录并重新绑定 TOTP');
} catch (e) {
  console.error(`重置失败：${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
