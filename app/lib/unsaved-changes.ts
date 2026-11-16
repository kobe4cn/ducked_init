// app/lib/unsaved-changes.ts —— 新建定义页「有没有还没保存的内容」的判断（纯函数，客户端用，#797）：
// 快照只取编辑框与构建器隐藏字段（key / yaml / form / sentence / request，固定顺序 JSON 序列化），其余字段（kind、intent、parsed 等）不参与——
// 切换与解析按钮的 intent 不算改动；有 action 回显就一律算有未保存内容（本页的 action 只有保存成功才跳走，回显出来的都是还没保存的内容）；
// 否则与挂载 / 上次回显后存的基线比：构建器的增删行按钮不触发 change 事件，所以靠比较隐藏字段 form 的值记脏，不靠 onChange
/** 表单当前内容的快照：只看会丢的那几个字段，其余（intent、kind、parsed 等）不参与比较 */
export function snapshotOf(data: FormData): string {
  return JSON.stringify(['key', 'yaml', 'form', 'sentence', 'request'].map(name => {
    const v = data.get(name);
    return typeof v === 'string' ? v : null;
  }));
}

/** 有没有还没保存的内容：回显过就一定有；否则与基线比（基线还没存下来时不算有，比如表单没挂载） */
export function hasUnsavedChanges({ echoed, baseline, current }: { echoed: boolean; baseline: string | undefined; current: string }): boolean {
  if (echoed) return true;
  return baseline !== undefined && baseline !== current;
}
