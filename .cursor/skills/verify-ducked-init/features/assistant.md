# AI 助手

A signed-in admin opens AI 助手, sends a question, and reads the reply. The question is a real browser send. The outgoing chat request hits the local stub, and `platform.llm_calls` records the model, the route, and the fallback reason. No real model key is used.

## Sub-features

- `assistant-bound` sends a question while the reasoning card has its own model. The stub sees `reason-model` on `/tier-reason/v1`, and the call row is `assistant|reason-model|reasoning|`.
- `assistant-unbound` sends a question after 恢复默认. The stub sees `tenant-default` on `/tenant/v1`, and the call row is `assistant|tenant-default|reasoning|unbound`.
- `assistant-dirty` sends a question while the reasoning endpoint has no key. The stub has no `/dirty/` request. The server log warns, and the call row stays `unbound` on `tenant-default`.
- `assistant-platform` sends a question after 恢复平台默认. The stub sees `platform-reasoning` on `/platform-reasoning/v1`, and the call row is `assistant|platform-reasoning|reasoning|`.

## How to get to it (user POV)

- On any signed-in page, choose `AI 助手`. The panel opens on the right. It is not a separate route.
- The question box is named `向 AI 助手提问`. The send button is named `发送`.

## Driving it with Playwright

Preconditions:

- The [模型服务](./model-provider.md) preconditions, including the stub and `VERIFY_LLM_LOG`.
- `doctor.sh` printed `DOCTOR PASS`.
- Signed in as `admin@verify.test`.
- For `assistant-bound`, the reasoning card is saved and 测试连通性 has shown `支持工具调用`.
- For `assistant-unbound`, both tier cards have been reset with `--confirm accept`.
- For `assistant-dirty`, `sql-write.sh` has stored the dirty reasoning row and the page shows that endpoint.
- For `assistant-platform`, 恢复平台默认 has been accepted and the page shows `当前使用平台默认的模型服务`.

`scripts/drive-model.sh` runs these sends in that order, between the model-provider steps. The app shell stays mounted across form posts, so the panel often stays open. Open it only when the textarea is absent.

- **Open and send.** If `browser.mjs count --selector 'textarea[aria-label="向 AI 助手提问"]'` is `0`, run `browser.mjs click --role button --name "AI 助手"` and `browser.mjs wait-selector 'textarea[aria-label="向 AI 助手提问"]'`. Then `browser.mjs fill --label "向 AI 助手提问" --value "<question>"` and `browser.mjs click --role button --name "发送"`. Run `browser.mjs wait-text "验收回复：<question>"`. The stub answers with that exact string and does not call a tool, so the turn ends on the first response.
- **Bound question.** The question is `档位推理`. Run `browser.mjs screenshot --path <evidence>/assistant-bound.png`. The stub log has path `/tier-reason/v1/chat/completions`, model `reason-model`, `authLast4` `BBBB`.
- **Unbound question.** The question is `恢复后回落`. Run `browser.mjs screenshot --path <evidence>/assistant-unbound.png`. The stub log has path `/tenant/v1/chat/completions`, model `tenant-default`, `authLast4` `AAAA`.
- **Dirty question.** The question is `脏档位`. Run `browser.mjs screenshot --path <evidence>/assistant-dirty.png`. No stub path contains `/dirty/`. The server log contains `model_providers 的 reasoning 档位有端点但没有 Key，按未绑定该档位处理`. Copy that line to `<evidence>/dirty-warn.txt`.
- **Platform question.** The question is `平台推理`. Run `browser.mjs screenshot --path <evidence>/assistant-platform.png`. The stub log has path `/platform-reasoning/v1/chat/completions`, model `platform-reasoning`, `authLast4` `DDDD`.
- **Stored calls.** Run `scripts/sql.sh "SELECT purpose, model, coalesce(route, ''), coalesce(fallback_reason, '') FROM platform.llm_calls c JOIN platform.tenants t ON t.id = c.tenant_id WHERE t.slug = 'verify' ORDER BY c.created_at"`. Stdout includes `assistant|reason-model|reasoning|`, `assistant|tenant-default|reasoning|unbound`, and `assistant|platform-reasoning|reasoning|`. Copy it to `<evidence>/llm-calls.txt`. Copy the stub log to `<evidence>/llm-stub.jsonl`.

## Gotchas

- `AI 助手` toggles the panel. Click it once to open. A second click closes it. The open panel covers that button, so a click meant to open it will time out. Form posts do not unmount the shell, and the panel stays open. Count the textarea and click only when the count is `0`.
- `wait-text` is exact. The reply is `验收回复：` plus the question, with the fullwidth colon.
- The send button stays disabled until the question box has text, and while the model service is unconfigured. A connectivity result of 不支持工具调用 also disables it. This recipe's stub returns a `ping` tool call for the probe, so the first send is allowed. Later sends still work when the probed model no longer matches, because that state is "not probed", not "unsupported".
- `llm_calls` does not store the prompt or the reply. Prove the text on screen, and prove model, route, and fallback_reason in SQL and in the stub log.
- The stub log records four characters of the bearer token, not the token. Those suffixes are `AAAA`, `BBBB`, `CCCC`, and `DDDD` for the fake keys in this recipe.
