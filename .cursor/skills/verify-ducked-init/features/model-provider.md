# 模型服务

An admin opens 模型服务, saves this tenant's endpoint, model, and API key, then saves a fast card (model name only) and a reasoning card (its own endpoint and key). After each save the model and endpoint inputs show the stored values and the API Key input is empty. 测试连通性 shows success and tool support. 恢复默认 and 恢复平台默认 ask for confirmation, and the reset card's inputs are empty afterwards while the other card is unchanged. A rejected tier save (400) leaves the half-filled inputs in place. The embedding card is saved and restored the same way. A tier row with an endpoint and no key cannot be saved from the form. That row is written with the verify-only SQL helper, and the page then shows it.

## Sub-features

- `model-provider-open` shows the platform default when `LLM_*` points at the local stub.
- `model-provider-save` stores the tenant endpoint, model, and key. The key input is empty afterwards; the model and endpoint inputs show the stored values.
- `model-provider-tiers` saves the fast card and the reasoning card. Resetting fast while reasoning is still saved clears only the fast inputs. A tier save with hidden `tier=nope` shows `档位须是 fast 或 reasoning` and keeps the typed draft. Resetting reasoning then clears those inputs.
- `model-provider-test` runs 测试连通性 and shows 连通成功 and 支持工具调用.
- `model-provider-embedding` saves the embedding card, then accepts 恢复平台默认. The embedding inputs are empty and the chat inputs are unchanged. Chat 恢复平台默认 then clears the chat inputs.
- `model-provider-reset` accepts 恢复平台默认 on the chat card and returns the page to the platform default.
- `model-provider-dirty` shows a reasoning endpoint that has no key, after `sql-write.sh` inserts that state.

## How to get to it (user POV)

- Choose `模型服务` in the top nav. The path is `/model-provider`. Admins see the link. Other roles do not.
- The page heading is `模型服务`.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- A local stub from `scripts/llm-stub.mjs` is listening, and its log path is `VERIFY_LLM_LOG`. Use fake keys. Do not point `LLM_*` at a real model service.
- Before `launch.sh`, export `LLM_BASE_URL=$ORIGIN/platform/v1`, `LLM_MODEL=platform-default`, `LLM_API_KEY=sk-platform-CCCC`, `LLM_REASONING_BASE_URL=$ORIGIN/platform-reasoning/v1`, `LLM_REASONING_MODEL=platform-reasoning`, `LLM_REASONING_API_KEY=sk-platreason-DDDD`. Export `LLM_FAST_MODEL`, `LLM_FAST_BASE_URL`, `LLM_FAST_API_KEY`, `LLM_EMBEDDING_BASE_URL`, `LLM_EMBEDDING_MODEL`, and `LLM_EMBEDDING_API_KEY` as empty so a repo `.env` cannot refill them.
- `$STATE_DIR/app.env` contains those `LLM_*` names. The dev server process environment has the same `LLM_BASE_URL`.
- Signed in as `admin@verify.test`.

The whole recipe, including the assistant sends in [AI 助手](./assistant.md), is `.cursor/skills/verify-ducked-init/scripts/drive-model.sh`. The commands below are what it runs. `$ORIGIN` is the stub origin. Scope every repeated label with `--within`.

- **Open the page.** Choose `模型服务`. Run `browser.mjs click --role link --name "模型服务"` and `browser.mjs wait-url /model-provider`. The title is `模型服务 · CRM 数据分析平台`. The page shows `当前使用平台默认的模型服务`. `[data-tier-fast="default"]` and `[data-tier-reasoning="default"]` are present. Run `browser.mjs screenshot --path <evidence>/model-provider-platform.png` and `browser.mjs snapshot --path <evidence>/model-provider-platform.aria.txt`.
- **Save the tenant endpoint.** Inside `form:has(#model-base-url)`, fill `端点` with `$ORIGIN/tenant/v1`, `模型名` with `tenant-default`, and `API Key` with `sk-tenant-AAAA`. Run `browser.mjs click --within 'form:has(#model-base-url)' --role button --name "保存"` and `browser.mjs wait-text "当前使用本租户的配置"`. `browser.mjs value --within 'form:has(#model-base-url)' --label "模型名"` prints `tenant-default`, `--label "端点"` prints the tenant URL, and `--label "API Key"` prints an empty line.
- **Save the fast card.** Inside `form:has(#fast-model)`, fill `模型名` with `fast-model` and leave `端点` empty. Run `browser.mjs click --within 'form:has(#fast-model)' --role button --name "保存"`, `browser.mjs wait-text "模型 fast-model，端点沿用本租户默认"`, and `browser.mjs wait-selector '[data-tier-fast="tenant"]'`. `value --label "模型名"` prints `fast-model`. `端点` and `API Key` are empty.
- **Save the reasoning card.** Inside `form:has(#reasoning-model)`, fill `模型名` with `reason-model`, `端点` with `$ORIGIN/tier-reason/v1`, and `API Key` with `sk-reason-BBBB`. Run `browser.mjs click --within 'form:has(#reasoning-model)' --role button --name "保存"`, `browser.mjs wait-text "模型 reason-model，端点 $ORIGIN/tier-reason/v1"`, and `browser.mjs wait-selector '[data-tier-reasoning="tenant"]'`. `value` prints `reason-model`, the tier URL, and an empty API Key. The fast card's `模型名` is still `fast-model`. Run `browser.mjs screenshot --path <evidence>/model-provider-saved.png`.
- **Reset the fast card while reasoning stays.** Run `browser.mjs click --within 'form:has(input[name="intent"][value="tier_reset"]):has(input[name="tier"][value="fast"])' --role button --name "恢复默认" --confirm accept` and `browser.mjs wait-selector '[data-tier-fast="default"]'`. `browser.mjs text --selector '[data-tier-fast="default"]'` prints `使用默认`. The fast `模型名`, `端点`, and `API Key` values are empty. The reasoning `模型名` is still `reason-model` and its `端点` is still the tier URL.
- **Rejected draft.** Inside `form:has(#reasoning-model)`, fill `模型名` with `qwen-plus-draft`, `端点` with `$ORIGIN/half-draft/v1`, and `API Key` with `sk-half-GGGG`. Run `browser.mjs set-hidden --within 'form:has(#reasoning-model)' --name tier --value nope` and, as the next command, `browser.mjs click --within 'form:has(#reasoning-model)' --role button --name "保存"`. Run `browser.mjs wait-text "档位须是 fast 或 reasoning"`. The three inputs still hold the draft. `text --selector '[data-tier-reasoning="tenant"]'` is still `模型 reason-model，端点 $ORIGIN/tier-reason/v1`.
- **Test connectivity.** Run `browser.mjs click --role button --name "测试连通性"`, `browser.mjs wait-text "连通成功"`, and `browser.mjs wait-text "支持工具调用"`. Run `browser.mjs screenshot --path <evidence>/model-provider-connectivity.png`. The stub log gains a `tenant-default` request whose `authLast4` is `AAAA`, and a `reason-model` request whose `authLast4` is `BBBB`.
- **Reset the reasoning card.** Run `browser.mjs click --within 'form:has(input[name="intent"][value="tier_reset"]):has(input[name="tier"][value="reasoning"])' --role button --name "恢复默认" --confirm accept` and `browser.mjs wait-selector '[data-tier-reasoning="default"]'`. The status text is `使用默认`. The reasoning `模型名`, `端点`, and `API Key` values are empty, including the draft from the rejected save. The fast status is still `使用默认` and its `模型名` is still empty. Run `browser.mjs screenshot --path <evidence>/model-provider-tier-reset.png`.
- **Dirty tier row.** `scripts/sql.sh` rejects `UPDATE`. Run `scripts/sql-write.sh` to set `reasoning_model` to `dirty-model`, `reasoning_base_url` to `$ORIGIN/dirty/v1`, and `reasoning_api_key` to null for tenant `verify`. Read it back with `scripts/sql.sh`. The row is `dirty-model|<dirty url>|`. Run `browser.mjs goto /model-provider` and `browser.mjs wait-text "模型 dirty-model，端点 $ORIGIN/dirty/v1"`. Run `browser.mjs screenshot --path <evidence>/model-provider-dirty.png`. The assistant recipe then shows the request does not use that endpoint.
- **Save and restore embedding.** Inside `form:has(#embedding-model)`, fill `端点` with `$ORIGIN/embed/v1`, `模型名` with `text-embedding-v3`, and `API Key` with `sk-embed-FFFF`. Run `browser.mjs click --within 'form:has(#embedding-model)' --role button --name "保存"` and `browser.mjs wait-text "当前使用本租户的 embedding 配置"`. `value` prints `text-embedding-v3`, the embed URL, and an empty API Key. The chat `模型名` is still `tenant-default`. Run `browser.mjs click --within 'form:has(input[name="intent"][value="embedding_reset"])' --role button --name "恢复平台默认" --confirm accept` and `browser.mjs wait-text "还没有配置 embedding：不配置时目录检索只用关键词"` (this sentence is the one shown when `LLM_EMBEDDING_*` is empty). The embedding inputs are empty. The chat `模型名` and `端点` are still the tenant values.
- **Restore the platform default.** Run `browser.mjs click --within 'form:has(input[name="intent"][value="reset"])' --role button --name "恢复平台默认" --confirm accept` and `browser.mjs wait-text "当前使用平台默认的模型服务"`. The chat `模型名`, `端点`, and `API Key` values are empty. The embedding inputs stay empty. Run `browser.mjs screenshot --path <evidence>/model-provider-platform-reset.png`.

## Gotchas

- `端点`, `模型名`, `API Key`, and `保存` each appear on more than one card. `--within` a `form:has(#...)` selector. A bare label matches the wrong field.
- `恢复默认` and `恢复平台默认` call `confirm()`. `--confirm accept` lets the submit proceed. Without `--confirm`, the harness dismisses the dialog and the click does not save.
- `恢复默认` is rendered only while that tier has a model. This recipe resets fast while reasoning is still bound, so the reasoning inputs can show that the other card did not change. Reset reasoning after that. A second click on a card that already says `使用默认` has no button.
- `value --label "API Key"` reads the DOM value of the password input. After a successful save it is empty. If the form did not remount, it still contains the key that was typed.
- `set-hidden` writes the live DOM value and the next React render puts `fast` or `reasoning` back. Run the save click as the next command. The 400 text `档位须是 fast 或 reasoning` is the action's status 400. The saved status line does not change, and the typed draft stays until a later action changes that card's saved model, endpoint, or `apiKeySet`.
- The form rejects an endpoint without a key, and it rejects a key without an endpoint. The dirty row exists only after `sql-write.sh`.
- `sql-write.sh` connects only to `crm_platform_verify_<run-id>`. `postgres` and `crm_platform` are refused before any statement runs.
- Saving embedding puts a second `恢复平台默认` on the page. Scope the chat reset with `intent=reset` and the embedding reset with `intent=embedding_reset`.
- Clearing the chat endpoint does not clear tier columns. After 恢复平台默认 the dirty model text can still be on the card. The source line is what shows the platform default. Assistant routing then uses `LLM_REASONING_*`, which the stub log shows. Do not require the tier inputs to be empty after the chat reset.
- Fake keys stay on `127.0.0.1`. Do not copy a real key into `app.env` or the evidence directory.
