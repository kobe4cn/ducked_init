// app/lib/mapping-outline.ts —— 从编辑中的映射 YAML 里读出对照面板要用的要点（客户端用，不做校验；校验见 .server/pipeline/mapping-spec.ts）
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

/** YAML 里的 entity、table（或源视图 view）、fields 下已对应（写了表达式）的字段与 dedupe.key 声明的去重键；写到一半解析出错时尽量取能解析的部分 */
export function mappingOutline(yaml: string) {
  const doc = parseDocument(yaml);
  const scalar = (key: string) => {
    const v = doc.get(key);
    return typeof v === 'string' ? v : null;
  };
  const fields = doc.get('fields');
  const dedupeKey = doc.getIn(['dedupe', 'key']);
  return {
    entity: scalar('entity'),
    table: scalar('table'),
    view: scalar('view'),
    fields: new Set(isMap(fields) ? fields.items.flatMap(i => (isScalar(i.key) && !(i.value == null || (isScalar(i.value) && i.value.value == null)) ? [String(i.key.value)] : [])) : []),
    dedupeKey: isSeq(dedupeKey) ? dedupeKey.items.flatMap(i => (isScalar(i) ? [String(i.value)] : [])) : null,
  };
}
