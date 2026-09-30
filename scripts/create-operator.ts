// scripts/create-operator.ts —— 用法：pnpm operator:create --email ops@example.com
// 新增运营者（ADR-0007）：只能在服务器上用这条命令创建，运营后台没有新增或停用运营者的入口。
// 运营者随后在 /ops/login 用 Magic Link 登录，首次登录时绑定 TOTP
import { parseArgs } from 'node:util';
import { closeDb } from '../app/.server/db/client';
import { createOperator } from '../app/.server/ops-auth';

const { values } = parseArgs({ options: { email: { type: 'string' } } });

if (!values.email) {
  console.error('用法：pnpm operator:create --email <运营者邮箱>');
  process.exit(2);
}

try {
  const operator = await createOperator(values.email);
  console.log(`已创建运营者 ${operator.email}（id=${operator.id}）`);
  console.log('  请在 /ops/login 用该邮箱登录，首次登录时绑定 TOTP');
} catch (e) {
  console.error(`创建失败：${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
