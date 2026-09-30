// app/lib/sources.ts —— 数据源类型四种：PostgreSQL、MySQL、对象存储文件、DuckDB 文件。前后端共用（页面组件也要显示类型名称）
export const SOURCE_KINDS = ['postgres', 'mysql', 's3', 'duckdb'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
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

/** 凭据字段：任何页面都不回显，出错时回填表单也不带上 */
const SECRET_FIELDS = ['password', 'keyId', 'secret'];

/** 表单里提交的全部字段，去掉凭据后可以回填 */
export const formValues = (form: FormData): Record<string, string> =>
  Object.fromEntries([...form].filter(([k, v]) => typeof v === 'string' && !SECRET_FIELDS.includes(k)).map(([k, v]) => [k, String(v)]));
