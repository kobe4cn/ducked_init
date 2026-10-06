// scripts/rfm-seed/check-mappings.ts —— 用平台的 checkMapping 离线校验 mappings/ 下的映射（源列类型按 DuckDB 读到的类型；Mongo 按扩展的展开规则手写）
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMapping, type SourceColumn } from '../../app/.server/pipeline/mapping-spec';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'mappings');
const V = 'VARCHAR', T = 'TIMESTAMP', TZ = 'TIMESTAMP WITH TIME ZONE', B = 'BIGINT', I = 'INTEGER', D = 'DOUBLE';
const cols = (o: Record<string, string>): SourceColumn[] => Object.entries(o).map(([name, type]) => ({ name, type }));
const COLUMNS: Record<string, SourceColumn[]> = {
  'shop_pg.customers': cols({ customer_id: B, nick_name: V, mobile: V, email: V, unionid: V, gender: V, city: V, created_at: TZ, updated_at: TZ }),
  'shop_pg.orders': cols({ order_id: B, customer_id: B, status: V, pay_amount: 'DECIMAL(12,2)', created_at: TZ, paid_at: TZ, channel: V, updated_at: TZ }),
  'pos_mysql.members': cols({ member_id: I, member_name: V, phone: V, email: V, register_store: V, registered_at: T, updated_at: T }),
  'pos_mysql.sales': cols({ sale_id: I, member_id: I, status: V, amount: 'DECIMAL(12,2)', sold_at: T, paid_at: T, store_code: V, updated_at: T }),
  'mini_mongo.users': cols({ _id: V, member_no: V, nickname: V, contact: V, contact_email: V, contact_mobile: V, created_at: T, updated_at: T }),
  'mini_mongo.orders': cols({ _id: V, order_no: V, buyer: V, buyer_member_no: V, status: V, pay: V, pay_amount: D, pay_paid_at: T, created_at: T, updated_at: T }),
  'tmall_s3.buyers': cols({ buyer_id: V, buyer_nick: V, unionid: V, receiver_mobile: V, created_ms: B }),
  'tmall_s3.trades': cols({ tid: B, buyer_id: V, trade_status: V, payment: D, created_ms: B, pay_ms: B, modified_ms: B }),
  'live_duckdb.viewers': cols({ viewer_id: I, phone: V, level: V, joined_at: T, modified_at: T }),
  'live_duckdb.live_orders': cols({ order_code: V, viewer_id: I, state: V, amount_cents: B, ordered_at: T, paid_at: T, modified_at: T }),
};
let bad = 0;
for (const file of readdirSync(dir).filter(f => f.endsWith('.yaml')).sort()) {
  const key = file.replace(/\.yaml$/, '');
  const check = checkMapping(readFileSync(join(dir, file), 'utf8'), () => COLUMNS[key]) as unknown as { issues?: { message: string; line?: number }[]; plan?: unknown };
  const issues = check.issues ?? [];
  if (issues.length) bad++;
  console.log(`${issues.length ? '✘' : '✔'} ${file}${issues.map(i => `\n    第 ${i.line ?? '?'} 行：${i.message}`).join('')}`);
}
process.exit(bad ? 1 : 0);
