// app/lib/mapping-template.ts —— 新建映射的样例文档与换选数据源 / 表 / 实体时编辑框内容的替换决定（纯函数，客户端也用，不依赖 .server）：
// 样例文档有源表与源视图两种（源视图没有列统计，按规则生成草稿用不上，只给所选实体的样例字段）；
// 换普通表要走 action 取规则草稿，这里只给指令；换源视图直接给空白模板。mappingTemplate 迁自 mapping-spec，withTarget 迁自路由
import { isMap, isScalar, parseDocument } from 'yaml';
import { CANONICAL_ENTITIES, type CanonicalEntity, entityOf, MODEL_MAJOR } from './canonical-model';

/** 表下拉框的取值里源视图的前缀：与同名的源表区分，reselect 以它区分两种输入 */
export const VIEW_PREFIX = 'view:';

/** 样例文档的字段行：实体的前四个字段，各自映射到同名源列，枚举字段附标准枚举 */
const sampleFields = (entity: CanonicalEntity) =>
  entity.fields.slice(0, 4).map(f => `  ${f.name}: ${f.name}${f.enum ? `  # 标准枚举：${f.enum.join('、')}` : ''}`).join('\n');

/** 新建映射时的样例文档 */
export function mappingTemplate(entityName: string, table: string) {
  const entity = entityOf(entityName) ?? CANONICAL_ENTITIES[0];
  const fields = sampleFields(entity);
  return `# 映射：源表 ${table} → ${entity.label}（${entity.name}）
model: ${MODEL_MAJOR}
entity: ${entity.name}
table: ${table}
fields:
${fields}
dedupe:
  key: [${entity.key.join(', ')}]
`;
}

/**
 * 源视图的空白映射模板：`view:` 指向所选视图、首行注释写「源视图」。自定义实体认不出字段（登记在服务端），
 * 写所选实体名并在 fields 下留一行提示手写，不回退成第一个标准实体
 */
export function viewTemplate(entityName: string, view: string) {
  const entity = entityOf(entityName);
  const head = `# 映射：源视图 ${view} → ${entity ? `${entity.label}（${entity.name}）` : entityName}
model: ${MODEL_MAJOR}
entity: ${entityName}
view: ${view}
fields:
`;
  if (!entity) {
    return `${head}  # 手写字段映射（每行「字段: 表达式」，自定义实体的字段与去重键见其登记）
dedupe:
  key: []
`;
  }
  const fields = sampleFields(entity);
  return `${head}${fields}
dedupe:
  key: [${entity.key.join(', ')}]
`;
}

/**
 * YAML 里的 table、view 或 entity 换成 value（保留注释与顺序）；table 与 view 只能写一个，换成另一种时原地改键名，换成 table 时去掉 view_key。
 * YAML 解析不了时不动
 */
export function withTarget(yaml: string, key: 'table' | 'view' | 'entity', value: string) {
  const doc = parseDocument(yaml);
  if (doc.errors.length || !isMap(doc.contents)) return yaml;
  const other = key === 'table' ? 'view' : key === 'view' ? 'table' : null;
  const swapped = other && doc.contents.items.find(i => isScalar(i.key) && i.key.value === other);
  if (!swapped && doc.get(key) === value) return yaml;
  if (swapped && isScalar(swapped.key)) swapped.key.value = key;
  doc.set(key, value);
  if (key === 'table') doc.delete('view_key');
  return doc.toString();
}

/** reselect 的去向：源视图的空白模板，或按新表与实体取规则草稿的指令（要走 action） */
export type ReselectNext = { kind: 'template'; yaml: string } | { kind: 'fetch-draft'; sourceId: string; table: string; entity: string };

/**
 * 换选数据源 / 表 / 实体后编辑框的去向：源视图给所选实体的空白模板，普通表给取规则草稿的指令（这里不生成、不碰当前 YAML）。
 * 编辑框内容与上次放进来的生成稿不同（手改过）时 needsConfirm，由调用方先确认再替换
 */
export function reselect({ sourceId, input, entity, yaml, lastGenerated }: {
  sourceId: string; input: string; entity: string; yaml: string; lastGenerated: string;
}): { needsConfirm: boolean; next: ReselectNext } {
  const view = input.startsWith(VIEW_PREFIX) ? input.slice(VIEW_PREFIX.length) : null;
  return {
    needsConfirm: yaml !== lastGenerated,
    next: view !== null
      ? { kind: 'template', yaml: viewTemplate(entity, view) }
      : { kind: 'fetch-draft', sourceId, table: input, entity },
  };
}

/**
 * 换普通表后取的规则草稿回来时要不要先确认：发请求时编辑框的内容（yamlAtRequest）在请求在途期间又被手改过，
 * 直接换进草稿会悄悄覆盖这段手写内容，所以 needsConfirm；没改过就直接替换（发请求前的手改已在 reselect 时确认过）
 */
export function applyDraft({ yaml, yamlAtRequest }: { yaml: string; yamlAtRequest: string }): { needsConfirm: boolean } {
  return { needsConfirm: yaml !== yamlAtRequest };
}
