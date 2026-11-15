# 记为知识提案

An analyst asks a question that matches two published metrics under the same alias. The reply shows candidate buttons. Picking one shows a card. Confirming it creates a pending term-default proposal on `/knowledge`. A viewer and a person the conversation is shared with do not see the buttons or the card. The stock assistant stub cannot produce this reply.

## Sub-features

- `assistant-choices` shows buttons `revenue_created` and `revenue_paid` under the reply to `营收多少`.
- `assistant-ask-card` shows `把『营收』默认指向 〈revenue_paid〉？` with buttons `记为知识提案` and `不用` after `revenue_paid` is chosen.
- `assistant-propose` leaves the card on `已提交，待复核`. `/knowledge` shows `默认指向：『营收』默认指这一条` and `证据：助手对话中的选择` with no link. The stored row is `term_default`, target `metric:revenue_paid`, content term `营收`, and evidence is only `assistant_conversation:<id>`.
- `assistant-propose-errors` returns 409, 403, 400, and 404 for a direct `knowledge.propose` post. Extra `term` and `entryId` fields do not change the stored proposal.
- `assistant-viewer` shows the read-only banner and no `[data-choices]`, `[data-choice]`, or `[data-ask-card]`.
- `assistant-revalidate` keeps `已提交，待复核` while `关系图` and `流向图` are switched. The request log has no `GET /assistant`.
- `assistant-accepted` asks `营收多少` again after `接受`. There is no candidate button. The tool text contains `ambiguous: false` and `按默认口径`, and names `revenue_paid` as the default.

## How to get to it (user POV)

- On a signed-in page, choose `AI 助手`. The panel is not its own route.
- Candidate buttons sit under the assistant reply. The card sits under the reply that follows the pick.
- `/knowledge?item=metric%3Arevenue_paid` is the proposal. The nav link is `业务知识`.
- `/lineage` has links `关系图` and `流向图`. An analyst can open both. A viewer cannot open `流向图`.

## Driving it with Playwright

Preconditions:

- `launch.sh` printed `READY` and `doctor.sh` printed `DOCTOR PASS`.
- Before launch, point `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` at a temporary stub on `127.0.0.1` with a fake key. Export `LLM_REASONING_*`, `LLM_FAST_*`, and `LLM_EMBEDDING_*` as empty. `scripts/llm-stub.mjs` is not this stub: it never calls `catalog_search`. The temporary stub returns a `ping` tool call for the connectivity probe, a `catalog_search` call with `{"query":"营收"}` when the user text contains `营收` and no tool result is in the request yet, and plain text after a tool result.
- The launch tenant has no order metrics. A temporary script, run with that run's `app.env` and a source database this run created, publishes `revenue_created` (`window.field: created_at`) and `revenue_paid` (`window.field: paid_at`) and gives both the alias `营收`. It also adds `analyst@` and `viewer@` on that tenant. Do not point the script at `crm_platform`. Label the run as a temporary script. Do not commit it.
- Signed in as the analyst. `browser.mjs magic-link` prints the login URL.

- **Open and ask.** If the textarea count is `0`, click `AI 助手` and wait for `textarea[aria-label="向 AI 助手提问"]`. Fill `向 AI 助手提问` with `营收多少` and click `发送`. Wait for `营收按哪个时间字段算？` and for `[data-choices]`. The buttons are `revenue_created` and `revenue_paid`. Screenshot and snapshot.
- **Pick.** Click button `revenue_paid`. Wait for `把『营收』默认指向 〈revenue_paid〉？` and for `[data-ask-card]`. The card also has `不用`. Screenshot and snapshot.
- **Confirm.** Click `记为知识提案`. Wait for `已提交，待复核`. Wait again after a short pause; the text is still there. Screenshot. `sql.sh` on `platform.knowledge_proposals` for this tenant returns one `proposed` row: `term_default|metric:revenue_paid|{"term": "营收"}` and evidence `[{"ref": "assistant_conversation:<id>"}]`. The row does not contain the question text.
- **Knowledge page.** `goto /knowledge?item=metric%3Arevenue_paid`. `text --selector '[data-proposal]'` contains `默认指向：『营收』默认指这一条` and `证据：助手对话中的选择`. `count --selector 'a:has-text("助手对话中的选择")'` is `0`. Screenshot.
- **Direct errors.** Sign in again with `curl` against this run's base URL and save the `crm_session` cookie. `POST /assistant` with `Content-Type: application/json`. While the proposal is pending, the same conversation with `{"intent":"knowledge.propose","conversationId":"<id>","index":2,"term":"流水","entryId":"metric:revenue_created"}` returns `409` and `{"error":"这个词已有待复核的默认指向提案"}`. The row count stays 1. `index` `0` or `3` returns `400` `这条消息不是点选候选的回答`. `index` `2.5` or `"2"` returns `400` `index 要是整数`. A missing `conversationId` returns `400` `缺少对话`. An unknown id returns `404` `没有这个对话`. The same post with the viewer's cookie returns `403` and an `error` that contains `仅`. The same post with an admin who was not shared the conversation returns `404` `没有这个对话`. After deleting that proposal with `sql-write.sh` on this run's database only, the post that still sends `term` `流水` and `entryId` `metric:revenue_created` returns `200` `{"ok":true,"proposalId":...}`, and the new row is still term `营收` and target `metric:revenue_paid`.
- **Shared reader.** As the analyst, fill `分享给成员的邮箱` with the viewer address and click `分享`. Sign in as the viewer, open `AI 助手`, click `历史对话`, and open the row under `分享给我的`. The button's accessible name is the title plus the owner and the timestamp, not the title alone. Wait for `analyst@… 分享给你的对话，只能查看，不能续写。` `count` of `[data-choices]`, `[data-choice]`, and `[data-ask-card]` is `0`. Screenshot. `GET /assistant?id=<id>` with the viewer's cookie is `200`, the body has no `askCard`, and message 1 still has `choices`.
- **Tab switch.** Delete the pending proposal with `sql-write.sh` so the card can be assembled again. Sign in as the analyst and open `/lineage`. Open the same conversation from `历史对话` and wait for the card. From a temporary Playwright script that records requests, click `记为知识提案`, wait for `已提交，待复核`, then click `流向图`, `关系图`, `流向图`, and `关系图`. The card text stays. The recorded URLs are `POST /assistant.data` for the confirm, then only `GET /lineage.data` and `GET /lineage.data?tab=flow`. There is no `GET /assistant` and no `GET /assistant?id=`. `browser.mjs` does not record this. Screenshot.
- **Accept.** `goto /knowledge?item=metric%3Arevenue_paid` and click `接受`. The proposal text goes away. `sql.sh` shows the proposal `accepted` and `platform.knowledge_term_defaults` has term `营收` on `metric:revenue_paid`. Open `AI 助手`, click `新对话`, and send `营收多少`. The reply is the stub's text. `[data-choice]` and `[data-ask-card]` are `0`. The stub log's tool message contains `ambiguous: false`, `按默认口径`, and `词的默认指向：营收（默认指这一条）` on `metric:revenue_paid`.

## Gotchas

- `scripts/llm-stub.mjs` answers with `验收回复：` plus the question, or a `ping` tool call. It never calls `catalog_search`, so this recipe never reaches the buttons. Use a temporary stub. Leave `scripts/llm-stub.mjs` unchanged for [AI 助手](./assistant.md).
- `wait-text` is exact on one element's text. `助手对话中的选择` is not that element; the proposal block reads `证据：助手对话中的选择`. Use `text --selector '[data-proposal]'`.
- The history row is one button. Its accessible name includes the owner and the timestamp. `click --role button --name "营收多少"` times out. A temporary script can click `[data-conversation]`.
- `AI 助手` toggles. On `/lineage` the first click can land before hydration. If `历史对话` is absent, click `AI 助手` once more.
- Opening `/knowledge` mounts that page's shell and the panel closes. Switching `关系图` and `流向图` stays on `/lineage` and leaves the panel open. A viewer has no `流向图` link.
- Older replies keep their candidate buttons. The server accepts a choice only from the last assistant message. Clicking an older button is a `400`. This recipe clicks the button on the latest reply.
- `不用` only hides the card in the browser. It does not write a proposal.
- The confirm post from the panel sends `conversationId` and `index` only. Prove ignored fields with the curl post, not by typing them into the card.
- Do not use `sql-write.sh` to insert members, sessions, or the proposal. Deleting the proposal this run just created, on `crm_platform_verify_<run-id>` only, is what makes the card appear again.
