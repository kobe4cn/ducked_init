# UI conventions

The look is direction **B** from the UI prototype, with direction A's full-width workspace. The prototype lives on the local branch `prototype/ui-directions` (`app/components/prototype-shells.tsx` `HeroShell`, `app/routes/sources.prototype-variants.tsx` `SourcesB`, `app/routes/mapping.prototype-variants.tsx` `MappingB`). Read it for reference; don't copy prototype files into main.

Build on the shadcn components in `app/components/ui/` and lucide icons. Don't add a new UI library.

## Page layout

- **Shell**: `AppShell` has a white top bar with the brand, pill-shaped nav links (the active one is `bg-slate-900 text-white`), an avatar initial and a logout button. The page background is `bg-slate-50`.
- **Full width**: the top bar, page header and content span the whole window with `px-6 lg:px-8`. Never wrap the content in `max-w-*`. Data tables, YAML editors and column statistics need the room.
- **Limit text and forms, not the page**: descriptions use `max-w-2xl`. A form on its own stays inside a card of `max-w-2xl` or a grid column.
- **Page header**: every logged-in page starts with `PageHeader`. It has a `text-3xl` title, an optional one-line description and the primary actions on the right. The page title lives here, not inside a `CardTitle`. A detail page puts its back link (`← 全部映射`) in the description slot.

## Building blocks

- **Stat tiles** (`StatTile`): a label, a large number and a hint, in `rounded-2xl border bg-white p-5 shadow-sm`. Use 2 to 4 of them at the top of an overview page. Give the number a status color only when it means something.
- **Card grid**: for lists of up to a few dozen items with an identity (sources, mappings), use `grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4`. Each card is a whole `Link`. When a card needs a second link inside it (the mapping card's 实体待补登), make the card a `relative` `div`, stretch the title `Link` over it with `after:absolute after:inset-0`, and give the inner link `relative` so it sits above. When the user can create items, put a dashed "add" card at the end of the grid.
- **Tables**: for long or row-shaped data (tasks, audit logs, members, merge history), use a `Table` inside a white `rounded-2xl border` panel.
- **Panels**: group the content in `rounded-2xl border bg-white p-6 shadow-sm`. Don't nest cards inside panels.
- **Pill tabs**: a `rounded-full bg-slate-200/60 p-1` group, with the active tab `bg-white shadow-sm`. Keep the tab in the URL (`?tab=`), like `source.tsx` does, so the page renders on the server and links work.
- **Flow row**: a detail page that connects two things (source table → entity) shows them as two cards joined by an arrow. Each card has a tinted icon and links to its own page.
- **Kind icons**: data-source kinds have a fixed tint: postgres sky, mysql orange, mongodb emerald, s3 violet, duckdb amber.

## Forms

- **Repeatable rows** (fields, conditions, columns): render existing rows plus an "添加一行" button, with no fixed row limit. Blank rows are ignored on save. HTTP tests only see the server-rendered rows, so test the controls' presence and check the page in a browser.

## Status colors

| Meaning | Color |
| --- | --- |
| Consistent, published, succeeded | emerald (`text-emerald-600`) |
| Draft, pending, running | amber (`text-amber-600`) |
| Differences, failed, blocked | red (`text-red-600`; `border-red-200` on the card) |
| Secondary text | `text-slate-500`; hints `text-slate-400` |

Pair the color with an icon and words (`CheckCircle2` 一致, `AlertTriangle` 3 张表有差异). Color alone is never the only signal.

## Empty states and dangerous actions

- **Empty list**: replace the grid or table with one panel that explains what the list holds and offers the first action. If the user can create items, open the create form straight away.
- **Dangerous actions** (discard a draft, remove a member, delete): use `variant="destructive"` and confirm before posting. Explain why a blocked action is blocked next to the button, like the publish blocker on the mapping page.

## Tests

HTTP tests assert on text and form fields, not on class names. When you move a title from a `CardTitle` to `PageHeader`, keep the wording so existing assertions still hold.
