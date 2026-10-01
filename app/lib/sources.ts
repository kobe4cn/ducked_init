// app/lib/sources.ts —— 数据源类型五种：PostgreSQL、MySQL、MongoDB、对象存储文件、DuckDB 文件。前后端共用（页面组件也要显示类型名称）
export const SOURCE_KINDS = ['postgres', 'mysql', 'mongodb', 's3', 'duckdb'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  s3: '对象存储文件（S3）',
  duckdb: 'DuckDB 文件',
};

/** 源表的同步方式（由平台根据水位线候选与行数判断） */
export const SYNC_MODES = {
  watermark: '水位线增量',
  needs_confirmation: '待确认水位线',
  full_compare: '全量比对',
} as const;
export type SyncMode = keyof typeof SYNC_MODES;

/**
 * 源表在湖中的覆盖情况（核对结果）：已进湖；未进湖的原因；或源端已删除（湖中仍有、或同步范围内的表源端已没有）
 */
export const LAKE_COVERAGE = {
  in_lake: '已进湖',
  out_of_scope: '不在同步范围',
  pending_profile: '等待采集',
  needs_watermark: '待确认水位线',
  pending_sync: '等待首次同步',
  sync_failed: '同步失败',
  unreadable: '账号没有读权限',
  gone: '源端已删除',
} as const;
export type LakeCoverage = keyof typeof LAKE_COVERAGE;
/** 未进湖的原因中由平台按同步范围、采集与同步历史判断的那些（账号读不了、源端已删除由核对时实时判断） */
export type NotInLakeReason = Exclude<LakeCoverage, 'in_lake' | 'unreadable' | 'gone'>;

/** 凭据字段：任何页面都不回显，出错时回填表单也不带上 */
const SECRET_FIELDS = ['password', 'keyId', 'secret'];

/** 表单里提交的全部字段，去掉凭据后可以回填 */
export const formValues = (form: FormData): Record<string, string> =>
  Object.fromEntries([...form].filter(([k, v]) => typeof v === 'string' && !SECRET_FIELDS.includes(k)).map(([k, v]) => [k, String(v)]));
