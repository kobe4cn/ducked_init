# 模型服务

An admin opens 模型服务, saves this tenant's endpoint, model, and API key, then saves a fast card (model name only) and a reasoning card (its own endpoint and key). 测试连通性 shows success and tool support. 恢复默认 and 恢复平台默认 ask for confirmation. A tier row with an endpoint and no key cannot be saved from the form. That row is written with the verify-only SQL helper, and the page then shows it.

## Sub-features

- `model-provider-open` shows the platform default when `LLM_*` points at the local stub.
- `model-provider-save` stores the tenant endpoint, model, and key. The key is not shown again.
- `model-provider-tiers` saves the fast card and the reasoning card, then accepts 恢复默认 on each.
- `model-provider-test` runs 测试连通性 and shows 连通成功 and 支持工具调用.
- `model-provider-reset` accepts 恢复平台默认 and returns the page to the platform default.
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
- **Save the tenant endpoint.** Inside `form:has(#model-base-url)`, fill `端点` with `$ORIGIN/tenant/v1`, `模型名` with `tenant-default`, and `API Key` with `sk-tenant-AAAA`. Run `browser.mjs click --within 'form:has(#model-base-url)' --role button --name "保存"` and `browser.mjs wait-text "当前使用本租户的配置"`. The key field does not echo the key.
- **Save the fast card.** Inside `form:has(#fast-model)`, fill `模型名` with `fast-model` and leave `端点` empty. Run `browser.mjs click --within 'form:has(#fast-model)' --role button --name "保存"`, `browser.mjs wait-text "模型 fast-model，端点沿用本租户默认"`, and `browser.mjs wait-selector '[data-tier-fast="tenant"]'`.
- **Save the reasoning card.** Inside `form:has(#reasoning-model)`, fill `模型名` with `reason-model`, `端点` with `$ORIGIN/tier-reason/v1`, and `API Key` with `sk-reason-BBBB`. Run `browser.mjs click --within 'form:has(#reasoning-model)' --role button --name "保存"`, `browser.mjs wait-text "模型 reason-model，端点 $ORIGIN/tier-reason/v1"`, and `browser.mjs wait-selector '[data-tier-reasoning="tenant"]'`. Run `browser.mjs screenshot --path <evidence>/model-provider-saved.png`.
- **Test connectivity.** Run `browser.mjs click --role button --name "测试连通性"`, `browser.mjs wait-text "连通成功"`, and `browser.mjs wait-text "支持工具调用"`. Run `browser.mjs screenshot --path <evidence>/model-provider-connectivity.png`. The stub log gains a `tenant-default` request whose `authLast4` is `AAAA`, and a `reason-model` request whose `authLast4` is `BBBB`.
- **Reset both cards.** Run `browser.mjs click --within 'form:has(input[name="intent"][value="tier_reset"]):has(input[name="tier"][value="reasoning"])' --role button --name "恢复默认" --confirm accept` and `browser.mjs wait-selector '[data-tier-reasoning="default"]'`. Repeat for fast with `--within 'form:has(input[name="intent"][value="tier_reset"]):has(input[name="tier"][value="fast"])'`. Run `browser.mjs screenshot --path <evidence>/model-provider-tier-reset.png`.
- **Dirty tier row.** `scripts/sql.sh` rejects `UPDATE`. Run `scripts/sql-write.sh` to set `reasoning_model` to `dirty-model`, `reasoning_base_url` to `$ORIGIN/dirty/v1`, and `reasoning_api_key` to null for tenant `verify`. Read it back with `scripts/sql.sh`. The row is `dirty-model|<dirty url>|`. Run `browser.mjs goto /model-provider` and `browser.mjs wait-text "模型 dirty-model，端点 $ORIGIN/dirty/v1"`. Run `browser.mjs screenshot --path <evidence>/model-provider-dirty.png`. The assistant recipe then shows the request does not use that endpoint.
- **Restore the platform default.** Run `browser.mjs click --within 'form:has(input[name="intent"][value="reset"])' --role button --name "恢复平台默认" --confirm accept` and `browser.mjs wait-text "当前使用平台默认的模型服务"`. Run `browser.mjs screenshot --path <evidence>/model-provider-platform-reset.png`.

## Gotchas

- `端点`, `模型名`, `API Key`, and `保存` each appear on more than one card. `--within` a `form:has(#...)` selector. A bare label matches the wrong field.
- `恢复默认` and `恢复平台默认` call `confirm()`. `--confirm accept` lets the submit proceed. Without `--confirm`, the harness dismisses the dialog and the click does not save.
- `恢复默认` is rendered only while that tier has a model. Reset the reasoning card before the fast card if you still need the fast button, or reset fast while it is still bound.
- The form rejects an endpoint without a key, and it rejects a key without an endpoint. The dirty row exists only after `sql-write.sh`.
- `sql-write.sh` connects only to `crm_platform_verify_<run-id>`. `postgres` and `crm_platform` are refused before any statement runs.
- This recipe does not save the embedding card, so only one `恢复平台默认` button is on the page. After embedding is saved, scope the chat reset with the `intent=reset` form.
- Clearing the chat endpoint does not clear tier columns. After 恢复平台默认 the dirty model text can still be on the card. The source line is what shows the platform default. Assistant routing then uses `LLM_REASONING_*`, which the stub log shows.
- Fake keys stay on `127.0.0.1`. Do not copy a real key into `app.env` or the evidence directory.
