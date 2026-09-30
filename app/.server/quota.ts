// app/.server/quota.ts —— 租户配额：单任务的内存上限与线程数、并发任务数。字段的名称、单位与取值范围只在这里定义；
// 校验、运营后台表单与审计描述都由它生成，新增配额字段只改这里与 schema
export const QUOTA_FIELDS = {
  memoryLimitMb: { label: '单任务内存上限', short: '内存', unit: ' MiB', min: 128, max: 1024 * 1024 },
  threads: { label: '单任务线程数', short: '线程', unit: '', min: 1, max: 256 },
  maxConcurrentTasks: { label: '并发任务数', short: '并发任务', unit: '', min: 1, max: 64 },
} as const;

export type QuotaKey = keyof typeof QUOTA_FIELDS;
export type TenantQuota = Record<QuotaKey, number>;
export const QUOTA_KEYS = Object.keys(QUOTA_FIELDS) as QuotaKey[];

/** 从租户行（或任何带配额字段的对象）取出配额 */
export const quotaOf = (t: TenantQuota): TenantQuota =>
  Object.fromEntries(QUOTA_KEYS.map(k => [k, t[k]])) as TenantQuota;

/** 校验配额；不合法时返回第一个错误的说明 */
export function parseQuota(raw: Record<QuotaKey, unknown>): { quota: TenantQuota } | { error: string } {
  const quota = {} as TenantQuota;
  for (const key of QUOTA_KEYS) {
    const { label, unit, min, max } = QUOTA_FIELDS[key];
    // 表单提交的是字符串；空串不能当成 0
    const v = typeof raw[key] === 'string' && !raw[key].trim() ? NaN : Number(raw[key]);
    if (!Number.isInteger(v) || v < min || v > max) return { error: `${label}必须是 ${min} 到 ${max}${unit} 之间的整数` };
    quota[key] = v;
  }
  return { quota };
}

/** 配额变化的一句话描述，只列出变了的字段 */
export const describeQuotaChange = (from: TenantQuota, to: TenantQuota) =>
  QUOTA_KEYS.filter(k => from[k] !== to[k])
    .map(k => `${QUOTA_FIELDS[k].short} ${from[k]}${QUOTA_FIELDS[k].unit} → ${to[k]}${QUOTA_FIELDS[k].unit}`)
    .join('，');
