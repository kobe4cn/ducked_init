// app/lib/business-note-key.ts —— 业务说明（ADR-0041）的键：实体字段的说明是 entity.field，映射字段的说明是 entity.field@mappingId。
// 平台库的当前说明、字段抽屉与语义目录都按它取，前后端共用
export const noteKey = (entity: string, field: string, mappingId: string | null = null) => `${entity}.${field}${mappingId ? `@${mappingId}` : ''}`;
