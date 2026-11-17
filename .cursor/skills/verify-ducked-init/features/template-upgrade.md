# Template upgrade notes

A published template locked behind the registry's latest version shows an upgrade banner. The banner lists one line per version after the lock, `vN：` plus that version's `changes`. After 预览升级差异 succeeds, the result header repeats the same list above the migration table. The stock test switch makes RFM and 流失预警 one step newer (v2). Cohort stays at v1 when it was published at v1, so that page has no banner.

## Sub-features

- `upgrade-banner` shows `有新的模板版本 v2（当前 v1）` and one `[data-upgrade-changes]` item with the RFM v2 sentence.
- `upgrade-preview` repeats that sentence under `v1 → v2，统计日 <date>` and makes `[data-upgrade-changes]` appear twice.
- `upgrade-cohort` on a cohort locked at v1, with no newer registry version, has no `[data-upgrade-banner]` and no `[data-upgrade-changes]`.
- `upgrade-churn` shows a different sentence from RFM: the 流失预警 v2 note.

## How to get to it (user POV)

- Choose `分析`, then the template's parameter page. The direct path for RFM is `/analytics/templates/rfm`. The heading is `RFM 分层 · 模板参数`.
- The signed-in person for this recipe is an analyst. The banner is also visible to an admin. The analyst sees `升级到新版本`.
- This page is not on the path `launch.sh` creates. Launch does not export `TEMPLATE_TEST_VERSIONS` and does not publish a template.

## Driving it with Playwright

Preconditions:

- `doctor.sh` printed `DOCTOR PASS`.
- The dev server process was started with `TEMPLATE_TEST_VERSIONS=1`. A flag added after the process is up does not count.
- RFM is published with `template_version` 1. Latest under the flag is 2. If the template was auto-enabled while the flag was already set, it locks at 2 and the banner is absent.
- `silver.order` and `silver._identities` exist. Without them, 预览升级差异 returns an error, `upgradeDiff` stays null, and the header list does not render. The banner list still does.
- Signed in as the analyst. The shell link name is `我的设置（<email>）`.

- **Open RFM.** Run `browser.mjs goto /analytics/templates/rfm` and `browser.mjs wait-text "有新的模板版本 v2（当前 v1）"`. Run `browser.mjs count --selector '[data-upgrade-banner]'` and expect `1`. Run `browser.mjs count --selector '[data-upgrade-changes]'` and expect `1`. Run `browser.mjs text --selector '[data-upgrade-changes]'` and expect `v2：分群名加 v2: 前缀，用于验证升级流程；所有人的分群名都会变`. Run `browser.mjs screenshot` and `browser.mjs snapshot`.
- **Preview.** Run `browser.mjs fill --label "参考日期（不填为今天）" --value "<YYYY-MM-DD>"` with a date that is not after today (UTC) and that still covers the silver orders. Run `browser.mjs click --role button --name "预览升级差异"`. Run `browser.mjs text --selector '[data-upgrade-diff]'`. The first line is `v1 → v2，统计日 <that date>`. The same v2 sentence follows, then the migration table (`原分群`, `新分群`, `人数`) with `v2:` on the new segment names. Run `browser.mjs count --selector '[data-upgrade-changes]'` and expect `2`. Run `browser.mjs count --selector '[data-upgrade-changes] li'` and expect `2`. Screenshot and snapshot again.
- **Locked at latest.** Run `browser.mjs goto /analytics/templates/cohort`. The heading is `同期群 · 模板参数` and the page says `当前生效：第 1 版`. Run `browser.mjs count --selector '[data-upgrade-banner]'` and expect `0`. Run `browser.mjs count --selector '[data-upgrade-changes]'` and expect `0`.
- **Other template's note.** Run `browser.mjs goto /analytics/templates/churn` and `browser.mjs text --selector '[data-upgrade-changes]'`. Expect `v2：at_risk 取反；minOrders 不超过 10，用于验证升级流程；所有人的 at_risk 都会翻转`.

## Gotchas

- `wait-text` is exact. `v1 → v2` does not match the preview line `v1 → v2，统计日 2024-12-31`. Read `[data-upgrade-diff]` instead.
- The heading is `RFM 分层 · 模板参数`, not `RFM`. `wait-text "同期群"` does not match `同期群 · 模板参数`.
- A fresh `launch.sh` tenant has no template row. Do not call the missing banner a pass or a product failure.
- Stock `TEMPLATE_HISTORY` is empty, so the flag shows exactly one note (v2). Several notes means every version from the lock plus one through latest, each as its own `vN：` line, on both the banner and the preview header. Do not edit the registry on the branch under test to manufacture that list.
- An empty `changes` string still renders a list item `vN：`. The registry test forbids an empty note on version > 1. A blank item is not the happy path.
- The date control's accessible name is `参考日期（不填为今天）`. Leaving it empty previews today (UTC).
- Preview does not change the published version. The version table stays `v1` / `已发布` / `platform`.
