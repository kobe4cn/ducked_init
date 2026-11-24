// scripts/eval-assertions/golden.ts —— 断言起草黄金集（ADR-0035 的评测）：每例借映射黄金集（scripts/eval-mapping/golden）一个样例的表统计与期望映射作「当前映射」，
// 写明模型必须给出的断言（字段 + 检查）与不该给出的断言。不该给的是依据列统计就站不住的（有空值的列 not_null）或映射校验不允许的（敏感字段 range / in、文本字段 range）
import type { CustomCheck } from '../../app/.server/pipeline/custom-assertions';
import type { TableProfile } from '../../app/.server/pipeline/source-engine';
import { GOLDEN } from '../eval-mapping/golden';

export interface Expected { field: string; check: CustomCheck }

export interface AssertionCase {
  name: string;
  /** 借用的映射黄金样例名 */
  mapping: string;
  profile: TableProfile;
  /** 当前映射 YAML */
  yaml: string;
  require: Expected[];
  forbid: Expected[];
}

const golden = (name: string, mapping: string, require: Expected[], forbid: Expected[]): AssertionCase => {
  const g = GOLDEN.find(c => c.name === mapping);
  if (!g) throw new Error(`映射黄金集里没有 ${mapping}`);
  return { name, mapping, profile: g.profile, yaml: g.expectedYaml, require, forbid };
};

export const ASSERTION_GOLDEN: AssertionCase[] = [
  // 做不到：手机号、邮箱在标准层只存哈希，不能给取值范围或枚举；不要求任何断言
  golden('sensitive-customers', 'rename-customers', [], [
    { field: 'phone', check: 'range' }, { field: 'phone', check: 'in' },
    { field: 'email', check: 'range' }, { field: 'email', check: 'in' },
  ]),
  golden('letter-status-orders', 'cents-letter-status', [
    { field: 'order_id', check: 'not_null' }, { field: 'status', check: 'in' },
  ], [
    { field: 'status', check: 'range' }, { field: 'paid_at', check: 'not_null' },
  ]),
  golden('nullable-member-sales', 'chinese-status', [
    { field: 'order_id', check: 'not_null' }, { field: 'order_id', check: 'unique' }, { field: 'status', check: 'in' },
  ], [
    { field: 'customer_id', check: 'not_null' }, { field: 'paid_at', check: 'not_null' },
  ]),
  golden('dedupe-orders', 'dedupe-orders', [
    { field: 'order_id', check: 'not_null' }, { field: 'status', check: 'in' },
  ], [
    { field: 'paid_at', check: 'not_null' }, { field: 'customer_id', check: 'range' },
  ]),
  golden('code-status-orders', 'chinese-header-code-status', [
    { field: 'order_id', check: 'not_null' }, { field: 'status', check: 'in' },
  ], [
    { field: 'paid_at', check: 'not_null' }, { field: 'customer_id', check: 'in' },
  ]),
];
