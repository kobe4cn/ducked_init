# 文件上传数据源：文件存在租户数据湖前缀的 `_uploads/` 下，统一转成 UTF-8 后存，按主键同步

成员手里常有一份 CSV / Excel / Parquet 名单（线下活动报名、门店手工登记、后台导出），没有数据库也没有对象存储。#149 加一种数据源类型「文件上传」（kind `upload`）：在页面上传文件，平台替成员存好，之后像其他数据源一样采集、同步、映射。这一篇记下文件存哪里、怎么读、再次上传怎么同步。

**文件存在租户数据湖前缀下。** 每个上传数据源一个目录 `<租户 dataPath>_uploads/<上传目录 ID>/`，每张表一个文件 `<表名>.<扩展名>`。上传目录 ID 是登记前生成的随机 UUID，存在数据源 `config.dir`（登记时数据源 ID 还没有）。路径不存绝对 URI：每次由 `lakeRow` + `lakeSpecOf` 拿当前前缀拼出，所以 `lake:migrate` 改前缀后照样能读（迁移只跳过 `_serving/`，`_uploads/` 跟着搬）。
- 生产的数据湖在对象存储，多实例都读得到，沿用 ADR-0001 的按租户前缀隔离。没有选本机 `PLATFORM_SOURCE_FILES_DIR`：那是可选的本机目录，生产没有配，多实例读不到。
- 写入在平台进程：对象存储用平台账号 `putObject(platformS3(), uri, body)`，本地目录用 `mkdir` + 写文件（按 `isS3` 分派，同 `copyLakeFile`）。
- 读取：`resolveSourceSpec` 给 upload 的 `SourceSpec` 带上租户数据湖的读写 S3 凭据（`lakeSpecOf(row).s3`）与目录 URI；`attachSource` 在对象存储时以该目录为作用域建密钥（同 `s3Secret`），本地目录不建密钥，`allowed` 只给这个以 `/` 结尾的目录。同步任务里湖的 `lake_s3` 密钥作用域更大，DuckDB 取更具体的那把，读的是同一个账号。`writeGrants` 对 upload 返回 `[]`：凭据本来就能写这个前缀，但文件只由平台写，不能因此拒绝登记。
- 重置数据湖（`lake:reset`）会删掉 `_uploads/`，上传数据源要重新上传。

**统一转成 UTF-8 再存。** 本机 DuckDB 1.5.5 的 `read_csv` 不读 GBK，`encodings` 扩展要现场联网安装。所以上传时在 Node 里解码：先 `new TextDecoder('utf-8', { fatal: true })`，失败再按 `TextDecoder('gbk')`（成员也可在预览里手选），去掉 BOM，存成 UTF-8。官方 Node 构建自带完整 ICU，不新增依赖。存下的是转码后的文件，原编码只记在读取选项里供页面显示。

**读取选项存在 `config.options`。** `config` 只能存字符串，所以每张表的读取选项存成 JSON 字符串 `{ "<表名>": { encoding, delim, header, skip, columns } }`：`skip` 是表头行之前跳过的行数，`columns` 是成员确认的 `{ 列名: DuckDB 类型 }`。读取时拼成 `read_csv(path, delim=…, header=…, skip=…, columns={…})`。没有选项的表按 `read_csv` 自动识别。

**预览不落盘到湖、不保存状态。** 预览请求带着文件上来，平台转码后写到本机临时文件，用进程内 DuckDB 的 `sniff_csv` 识别分隔符、表头与列类型，再按（可能被修改过的）选项读前 20 行，删掉临时文件后返回。确认登记时浏览器再提交一次同一个文件和选项。两次上传换来无状态、不留孤儿文件。

**Excel 用 DuckDB 的 `excel` 扩展。** `read_xlsx` 读第一个工作表，与 httpfs、postgres 等扩展一样运行时 `INSTALL excel; LOAD excel;`（在 `lockConfiguration` 之前），部署环境要能联网安装扩展。Parquet 用 `read_parquet`，列类型取文件自带的，不做编码与分隔符选项。同一个数据源里每个文件按扩展名选读取函数。

**大小上限按租户配额。** 租户配额加「单个上传文件大小上限」（`maxUploadMb`，默认 100 MiB）。`request.formData()` 会把整个请求体读进内存，所以先看 `Content-Length`，超了直接拒绝、不读请求体；再在读的过程中计数，超过即中止。被拒的文件不写入湖、不登记。

**不算水位线候选。** 上传源每次都是整份文件，`profileSource` 对 upload 不算水位线候选，否则「修改时间」之类的列会让表卡在「待确认」。没有水位线的表本来就是全量比对（ADR-0010）。

**再次上传同名表：两种方式。** 新文件覆盖 `_uploads/<目录>/<表名>.<扩展名>` 后入队一次同步：
- 整表替换：就是现有的全量比对，有主键按主键 + 整行哈希，发现新增、更新与删除；没有主键按整行多重集，改一行算删除加新增。
- 按业务主键增量：只新增 / 更新、不删除，名单只是补充时用。要求这张表已有主键（源端或 `confirmKey` 确认的业务主键），否则拒绝。`source_tables.upsert_only` 记下这次选的方式，同步时 `stageKeyedDiff` 跳过「不见了」的主键，之后的同步沿用，直到下次上传换方式。

**审计。** 上传（登记时与再次上传）记 `source.file_uploaded`，详情 `{ table, file, bytes, encoding, mode? }`，不含文件内容。同步与其他数据源一样记在任务与同步历史里，不另记审计。

## 已接受的取舍

- 预览与确认各上传一次文件，大文件要传两遍。
- `lake:reset` 会清掉上传的文件。
- Excel 依赖运行时联网安装 `excel` 扩展。
- 增量模式下源文件里删掉的行在原始层不会删除，要发现删除就选整表替换。

## Considered Options

- 存本机 `PLATFORM_SOURCE_FILES_DIR`：最简单，但生产没有配、多实例读不到。
- 用 `encodings` 扩展让 DuckDB 直接读 GBK：要联网装扩展，且预览与读取两处都要装；在 Node 转码只做一次。
- 用 exceljs 在上传时把 xlsx 转成 CSV：不依赖联网，但多一个依赖，类型要自己推断。
- 预览时先把文件存进湖、确认时再挪：只传一次，但要清理没确认的文件。
