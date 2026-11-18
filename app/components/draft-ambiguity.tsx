// app/components/draft-ambiguity.tsx —— 起草（#827）与一句话解析（#853）共用的歧义提示：检索（draftSearch）判出的歧义词与候选，
// 候选只放标识与名称（不放口径取值）、链到业务知识页，成员确认或改写；最后一段用法提示由调用方给（起草与解析各一句）。
// 词的默认指向生效的组不再歧义（ADR-0056）；业务知识页不能直接设默认指向，提示不写「去这里设默认」
import { Fragment } from 'react';
import type { DraftAmbiguity as Ambiguity } from '~/.server/catalog/draft-search';

/** 歧义提示块：词与候选（链接到 /knowledge?item=<id>）加一段 hint */
export function DraftAmbiguity({ ambiguity, hint }: { ambiguity: Ambiguity; hint: string }) {
  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" data-ambiguity>
      <p className="font-medium">这些词有多种理解</p>
      {ambiguity.groups.map(g => (
        <p key={g.term}>
          「{g.term}」可能指
          {g.candidates.map((c, i) => (
            <Fragment key={c.id}>
              {i > 0 && '、'}
              <a className="underline underline-offset-2" href={`/knowledge?item=${encodeURIComponent(c.id)}`}>{c.name}</a>
            </Fragment>
          ))}
        </p>
      ))}
      <p>{hint}</p>
    </div>
  );
}
