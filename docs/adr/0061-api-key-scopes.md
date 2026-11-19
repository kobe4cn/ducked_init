# API Key 的接口范围：三类接口、按路径判定、范围外 403

API Key 原来能调 `/api/v1/` 下全部外部接口，租户没法只把一部分接口交给某个外部系统（#973）。本票（#974）给 Key 加「可用接口」范围：`catalog`、`consumers`、`exports` 三类，创建时勾选，范围外的接口 403。数据范围（点查只返回范围内的标签、指标与 RFM，#975 起）由后续子 issue 补进同一份 ADR。

**三类划分。** `catalog`（`GET /api/v1/catalog`）、`consumers`（`GET /api/v1/consumers/:id` 与 `GET /api/v1/consumers/by-source/...`）、`exports`（`POST /api/v1/exports`、`GET /api/v1/exports/:id`）。三类与 `/api-keys` 页「接口说明」登记表里的接口一一对应，页面上给用户看的名字是目录 / 点查 / 导出（`app/lib/api-scopes.ts`，前后端共用）。

**按路径判定，不改路由文件。** `requireApiKey` 在认证通过后用 `new URL(request.url).pathname` 判定请求属于哪一类（`scopeOfPath`），Key 没开这一类就返回 403 `{ error: '这把 Key 没有<类>接口的权限' }`。判定落在认证这一处，五个路由文件不动，以后新增接口只登记路径归属。判定前与路由匹配一样把路径逐段解码、转小写、去掉结尾的 `/`，`catalog` 精确比较，`consumers`、`exports` 要求等于基路径或以「基路径 + `/`」开头——否则 `/api/v1/Catalog`、`/api/v1/catalog/` 这类路由照样匹配的写法能绕过范围。403 文案不含 Key 前缀或租户信息。导出下载 `GET /api/v1/exports/:id/download` 凭限时令牌、不走 `requireApiKey`，不在范围判定里。

**403 与 401 的先后。** 先认证后判范围：没有 Key、Key 错误、已吊销、租户已暂停仍是原来同一个 401（ADR 与 #920 的口径不变，不泄露是哪种原因），认证通过才轮到 403。被 403 拒绝的请求不算一次使用，不更新 `last_used_at`；调用计数（ADR-0059）照旧只记成功的点查，不放进 `requireApiKey`。

**存储与迁移默认。** `platform.api_keys.scopes` 是 `text[]`，非空，默认 `'{catalog,consumers,exports}'`：迁移加列时已有 Key 三类全开，行为不变。创建表单三个复选框默认全勾；提交值收敛成三类的非空子集（白名单外的值忽略、去重、按 `catalog → consumers → exports` 固定顺序存），一类都不勾是业务错误（400，不创建）。审计 `api_key.created` 的 detail 记 `scopes`。修改已有 Key 的范围（#977）另算一次操作、记审计。

## Considered Options

- **按端点逐个勾选**：粒度细，但三类共 5 个端点，勾选清单跟着接口增改走，管理员不好理解；三类对应页面上「接口说明」的分组，够用。
- **在每个路由文件里判范围**：五处重复同样的判定，新增接口容易漏；集中在 `requireApiKey` 一处。
- **范围判在认证之前**：会让一把已吊销的 Key 在范围外接口上返回 403，泄露「这把 Key 曾经存在且没开这类」，也和「401 一律同样响应」的口径冲突。

## Consequences

- 新增外部接口时要先决定它属于哪一类（或新开一类），并把路径登记进 `scopeOfPath`；默认不在任何类里的路径不受范围限制，所以新端点必须登记；`test/http/api.test.ts` 遍历 `app/lib/api-docs.ts` 里每个走 Bearer Key 的端点，断言 `scopeOfPath` 不为 `null`，忘了登记会失败。
- 范围是接口维度，不是数据维度：范围内的接口仍能看到该租户的全部目录、全部点查结果，数据范围见后续子 issue。
- 已有 Key 迁移后三类全开，管理员如需收窄，等 #977 的改范围功能。

相关：ADR-0033（点查接口与服务库）、ADR-0040（Bearer Key 的外部接口）、ADR-0059（调用计数）。
