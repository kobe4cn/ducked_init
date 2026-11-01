# 字符串排序：名字按 zh-CN，内部键按码点

不带 locale 参数的 `localeCompare` 取 Node 进程启动时的默认 locale（来自 `LC_ALL` / `LANG`），同一份代码在不同机器上排出的顺序不同：`'「CRM」…'.localeCompare('「会员」…')` 在 `LANG=zh_CN.UTF-8` 下是 1，在 `LANG=C` 下是 -1。合并组页的候选映射因此随机器换顺序，测试也只在某一种 shell 语言下通过（#312）。默认 locale 在进程启动时就定下，同一进程里改 `process.env.LANG` 不起作用，只能在每次比较时显式给出。

**约定。** 共用的比较函数在 `app/lib/compare.ts`（前后端共用）：

- 给用户看的名字（数据源名、映射名、实体标签）用 `cmpName`，即 `localeCompare(b, 'zh-CN')`：汉字按拼音，汉字排在拉丁字母前。用户多是中文名字，按拼音排符合他们找东西的习惯。
- 内部键（实体名、映射 ID、模板 ID、表名、列名、kind）用 `cmp`，按码点比较：结果与 ICU 版本、locale 都无关，`_`、`:` 与数字的相对顺序固定，适合要求确定性的地方（血缘、语义目录、生成的 SQL）。
- 任何地方都不再用不带 locale 参数的 `localeCompare`。

**合并组。** 合并组页的候选映射按 `cmpName` 排序。这只是给人看的顺序；合并组的优先级是 `members` 数组的顺序（ADR-0032），与候选列表的顺序无关。

**迁移。** `app/lib/lineage.ts` 原有的 `cmp` 搬进 `compare.ts`，`lineage.ts` 仍导出它，原引用方不用改。`app/` 里其余不带 locale 参数的 `localeCompare` 由后续工单按上面的约定逐处改成 `cmp` 或 `cmpName`。全部改完后，`vitest.config.ts` 里把测试的 `LC_ALL` 固定成 `en_US.UTF-8` 的那行就该去掉，免得它掩盖新的不带 locale 的比较。
