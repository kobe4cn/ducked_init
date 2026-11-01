# Coding Standards

reviewer 在审查时通过 `@.sandcastle/CODING_STANDARDS.md` 读这份文件；implementer 不读，所以这里只放审查时要查的规则。架构决定以 `docs/adr/README.md` 为准，这里只列最常被违反的几条。

## 语言与风格

- 用户可见文字、提交信息、issue / PR 正文、代码注释用中文；标识符用英文。
- 不加只复述代码的注释；注释写「为什么」与约束（参考已有模块的头注释）。
- 不用 `any`、不做没有校验的类型断言；外部输入（HTTP、YAML、模型输出）先校验再用。
- 不写嵌套三元；分支多时用 `switch` 或 if/else。
- 不为一处调用新建抽象；可复用的已有函数优先（票的指引里 **Reuse** 列出的）。

## 排序（ADR-0045）

- 字符串排序一律经 `app/lib/compare.ts`：给用户看的名字用 `cmpName`，内部键用对应的比较函数。不要直接用 `localeCompare` 或依赖系统 locale。

## 租户、权限与敏感数据

- 每个查询都按 `tenant_id` 限定；别的租户的对象一律当作不存在（400 / 404，不泄露存在性）。
- 写操作先检查权限（如 `definitions:draft`、`sources:write`、`publish`），和同类功能保持一致。
- 敏感字段（ADR-0005）不进日志、审计 detail、检索文本、目录 Markdown、模型请求。
- 审计：新动作要登记；detail 只放 ID 与类型，不记用户输入的原文。改到目录的动作要进 `CATALOG_ACTIONS`。

## 数据库

- 平台 PG 的表结构改在 `app/.server/db/schema.ts`，迁移由 drizzle-kit 生成（`drizzle/` 下），不手写迁移。
- 唯一约束冲突等并发错误要转成业务错误（400），不要冒 500。
- 业务数据只落 DuckLake（ADR-0002），平台 PG 只存元数据。

## 测试

- 每条验收标准至少一个测试，测试名写清楚预期行为。
- 用 `test/README.md` 里的夹具与 helper，不要自己造一套连接 / 清表逻辑。
- 新测试文件在 `test/CATALOG.md` 加一行；新 fixture helper 写进 `test/README.md`。
- 测试走公开接口（模块导出的函数、HTTP 路由），不测私有实现细节。

## 文档

- 新增或修改领域术语时更新 `CONTEXT.md`；新 ADR 在 `docs/adr/README.md` 加一行。
- 页面改动遵守 `docs/agents/ui.md`。
