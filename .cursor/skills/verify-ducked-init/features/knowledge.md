# 业务知识：词的默认指向

A member who can draft definitions opens `/knowledge` and handles a pending `term_default` proposal. The row reads `默认指向：『<词>』默认指这一条` and offers `接受` and `拒绝` only. Accepting writes `platform.knowledge_term_defaults`, an audit action `term_default.set`, and a catalog version whose reason is `term_default.set`. Accepting the same word, ignoring case, for another target retires the previous row. A viewer can read the proposal and cannot accept it.

## Sub-features

- `knowledge-open` shows the proposal on `/knowledge?item=<targetId>`.
- `knowledge-actions` shows `接受` and a `拒绝` disclosure, and does not show `修改后接受`.
- `knowledge-accept` stores one active default and bumps the catalog version with reason `term_default.set`.
- `knowledge-replace` retires that row when the same word is accepted for another target.
- `knowledge-reject` marks the proposal rejected and does not insert a default.
- `knowledge-viewer` hides the actions and answers `proposal.accept` with 403.
- `knowledge-edit` answers `proposal.acceptEdited` with 400 and leaves the proposal pending.

## How to get to it (user POV)

- Choose `业务知识` in the top nav. The path is `/knowledge`. The heading is `业务知识`.
- With a proposal on a catalog entry, open `/knowledge?item=<targetId>` (for the seeded order entity, `/knowledge?item=entity%3Aorder`). The same panel is the one on a definition page; this recipe uses `/knowledge`.
- A viewer has `业务知识` (`definitions:read`) and can open the same URL. The proposal text is there. `接受` and `拒绝` are not.
- There is no control that creates a `term_default` proposal. The assistant choice card that would create one is a later ticket. Seed the proposals with a temporary script after launch.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- Signed in as `admin@verify.test`.
- The launch tenant has no data source. Canonical entities are still in the catalog: `entity:order` is named `订单`, `entity:customer` is named `消费者`.
- A temporary script, outside the commit, calls `proposeKnowledge` on this run's database only. Do not insert proposal rows with `sql-write.sh`.

- **Add the aliases the words must match.** `goto '/knowledge?item=entity%3Aorder'`. The panel lists the order fields (`订单 ID`). `fill --label "新别名" --value "Revenue"`, then `click --role button --name "新增别名"`, then `wait-selector '[data-alias="Revenue"]'`. Repeat on `/knowledge?item=entity%3Acustomer` with value `revenue` and `[data-alias="revenue"]`. Screenshot each panel.
- **Seed four proposals.** Against `PLATFORM_DATABASE_URL` from this run's `app.env`, call `proposeKnowledge` in its own transaction per proposal: `entity:order` / `Revenue`, `entity:customer` / `revenue`, `entity:customer` / `消费者`, `entity:order` / `订单`. Kind `term_default`, content `{ term }`, evidence `[{ ref: 'verify:term-default' }]`. Record the four ids. A term that is neither the current name nor an active alias (`不是别名`), a blank term, and a 51-character term each throw status 400 and write no row.
- **Open the proposal.** `goto '/knowledge?item=entity%3Aorder'`. `wait-text` does not match a bare `订单` (that string is only inside `订单 ID`). Wait for the proposal text `默认指向：『Revenue』默认指这一条` by snapshot, not by `wait-text` of a shorter fragment that is not its own text node. The accessible snapshot has `button "接受"` and `group: 拒绝` inside each `[data-proposal]`, and no `修改后接受`. `count --selector 'summary:has-text("修改后接受")'` is `0`. The hub tile `待确认提案` counts the pending rows. Screenshot and snapshot.
- **Accept.** `click --role button --name "接受" --within '[data-proposal="<Revenue proposal id>"]'`. The redirect stays on `/knowledge?item=entity%3Aorder`, so `wait-url` can time out after the load. Poll `count --selector '[data-proposal="<id>"]'` until it is `0`. The `订单` proposal is still listed. Screenshot.
- **Replace.** `goto '/knowledge?item=entity%3Acustomer'` and accept the `revenue` proposal the same way, scoped to its id. `scripts/sql.sh` on `platform.knowledge_term_defaults` for slug `verify` shows `Revenue|entity:order|f` and `revenue|entity:customer|t` (`retired_at IS NULL` as the third column). `platform.audit_logs` has two `term_default.set` rows; the second `detail` is `{"term":"revenue","replaced":"entity:order","targetId":"entity:customer"}`. `platform.catalog_versions.reason` gains `term_default.set` for each accept. The audit page (`审计日志`) shows `设置词的默认指向` and `[data-audit-action="设置词的默认指向"]`.
- **Reject.** The `拒绝` control is a `<summary>`. `click --role button --name "拒绝"` and `click --role group --name "拒绝"` both time out, and the `拒绝理由` input is in the DOM but not visible, so `fill` cannot type into it. Submit the same form the disclosure would submit, with the admin session cookie, to `POST /knowledge?item=entity%3Acustomer`: `intent=proposal.reject`, `targetId=entity:customer`, `proposalId=<消费者 id>`, `reason=这个词留给订单`. The status is `302`. SQL shows that proposal `rejected` with that reason, and no new default row.
- **Edited accept.** `POST /knowledge?item=entity%3Aorder` as the admin: `intent=proposal.acceptEdited`, `targetId=entity:order`, `proposalId=<订单 id>`, `kind=term_default`, `term=营收`. The status is `400`. The body contains `词的默认指向提案不能修改后接受`. SQL still shows that proposal `proposed`.
- **Viewer.** Invite `viewer@verify.test` with role value `viewer` (see [members](./members.md)). Sign in as that viewer and `goto '/knowledge?item=entity%3Aorder'`. The snapshot contains `默认指向：『订单』默认指这一条` and does not contain `button "接受"`, `拒绝`, or `修改后接受`. `count --selector 'button:has-text("接受")'` is `0`. `POST` `intent=proposal.accept` for that proposal id as the viewer returns `403`. The page heading is `无权访问` and the text is `仅管理员、数据工程师、分析师可以起草指标、标签与模板定义`.

## Gotchas

- `wait-text` is exact. `订单` and `消费者` are not standalone text nodes on these panels. Match the proposal sentence or a field label such as `订单 ID`.
- Two proposals on one entry mean two `接受` buttons. A click without `--within '[data-proposal="<id>"]'` accepts whichever button Playwright resolves first.
- After accept, `wait-url /knowledge` is the wrong signal: the action redirects to the same path. Wait until that proposal's `[data-proposal]` count is 0.
- `拒绝` stays closed. Do not report the reject as unverified because the summary click failed; POST the form and read `knowledge_proposals.status`.
- The page does not create `term_default` proposals. Seeding with `proposeKnowledge` is the product path (system or assistant). A direct `INSERT` skips the fingerprint and the name-or-alias check.
- Alias `Revenue` on the order and `revenue` on the customer are different targets, so both proposals can exist. Accepting the second retires the first because the unique index is `(tenant_id, lower(term))` where `retired_at` is null.
- The audit row's `target_id` column is the new `knowledge_term_defaults` id. The page shows `detail.targetId`, which is the catalog id (`entity:order` or `entity:customer`).
- A viewer GET is 200. The 403 is only the accept (or other draft) POST.
- Concurrent accepts of one word can return 400 `这个词刚被设置过默认指向，请重试` for one caller and leave a single active row. That race is not part of the browser steps.
