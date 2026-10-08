// app/components/relation-suggestions-card.tsx —— 实体页的「推荐关系」（relation-suggest.ts，ADR-0019）：按列名与取值包含推荐的关系，
// 标出取值是否核对过；每行一个采纳按钮，提交 intent=adoptRelation 与关系表单同名的 relFrom / relField / relEntity / relTarget，把关系追加到登记草稿
import { Plus } from 'lucide-react';
import { Form } from 'react-router';
import { StatusText } from '~/components/status-text';
import { Button } from '~/components/ui/button';
import { type RelationSuggestion, relationText } from '~/lib/canonical-model';

export function RelationSuggestionsCard({ suggestions, submitting }: { suggestions: RelationSuggestion[]; submitting: boolean }) {
  return (
    <div className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm" data-relation-suggestions>
      <div className="space-y-1">
        <h2 className="font-semibold">推荐关系</h2>
        <p className="max-w-2xl text-sm text-slate-500">按字段名与终点主键相似推荐；起点的常见取值都在终点的标准层里找到时标「取值已核对」。采纳后关系追加到登记草稿，你成为最后保存的人，需由另一位成员发布。</p>
      </div>
      <ul className="divide-y">
        {suggestions.map(({ relation: r, checked }) => {
          const text = relationText(r);
          return (
            <li key={text} className="flex flex-wrap items-center justify-between gap-4 py-3" data-relation-suggestion={text}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm">{text}</span>
                {checked === 'values'
                  ? <StatusText tone="ok" data-checked={checked}>取值已核对</StatusText>
                  : <StatusText tone="none" data-checked={checked}>未核对取值</StatusText>}
              </div>
              <Form method="post">
                <input type="hidden" name="intent" value="adoptRelation" />
                <input type="hidden" name="relFrom" value={r.from.entity} />
                <input type="hidden" name="relField" value={r.from.field} />
                <input type="hidden" name="relEntity" value={r.ref.entity} />
                <input type="hidden" name="relTarget" value={r.ref.field} />
                <Button type="submit" size="sm" variant="outline" disabled={submitting}><Plus />采纳</Button>
              </Form>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
