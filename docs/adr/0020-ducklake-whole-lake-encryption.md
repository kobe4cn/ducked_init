# 租户数据湖用 DuckLake 整湖加密，文件密钥留在租户自己的 catalog

ADR-0005 要求明文只以加密形式留在原始层。原始层（`bronze_<数据源 ID>.*`）、主键状态（`_keys`，ADR-0006）和镜像（`_mirror`，ADR-0010）都由同步在 DuckDB 里整批写入（ADR-0012），存在对象存储上。按列在 Node 侧加密要把每一批数据拉出 DuckDB 再写回去，和同步全在 DuckDB 里完成的做法冲突；比对、哈希和回放也没法再直接在 SQL 里做。所以改用 DuckLake 自带的加密：建 catalog 时 `ATTACH ... (ENCRYPTED)`，此后写入的每个 parquet 文件都用各自随机生成的密钥加密。

**粒度与范围。** 一个文件一个密钥，按整湖开启，没法只加密原始层。标准层（`silver.*`）、批次日志、合并日志都会一并加密，比 ADR-0005 说的“仅原始层”范围更大。这样没有坏处：标准层里的敏感字段本来就是哈希，加密只是多一层保护。

**密钥在哪里。** 文件密钥存在本租户 catalog 的 `ducklake_data_file.encryption_key` / `ducklake_delete_file.encryption_key` 里，也就是平台 PG 中本租户独占的 schema（ADR-0008）。所以加密防的是对象存储泄露：拿到存储前缀下的文件、备份或者旧版本对象，没有 catalog 也读不出来。它不防 catalog 泄露。拿到本租户数据库角色的人可以读出密钥；内联在 catalog 里的小批次（DuckLake 的数据内联）本来就是明文。catalog 的保护靠 ADR-0008 的独占角色和 PG 本身。

**怎么开启。** 加密要写进 catalog：DuckLake 在 `ducklake_metadata` 里记下 `encrypted = true`，之后的挂载不带 `ENCRYPTED` 也照样加密写入。已经建好的未加密 catalog 不能补开加密（带 `ENCRYPTED` 挂载会报错）。所以 `initTenantCatalog` 先看 catalog schema 里有没有元数据表：没有就以加密方式新建，有就照原样挂载，可以重复执行。写加密文件需要 httpfs 带来的加密模块，工作进程在本地目录模式下也加载 httpfs。

**已有的湖不迁移。** 加密上线前开通的租户，catalog 保持不加密，数据文件仍是明文，同步、核对、迁移照常。开发和演示环境可以用 `pnpm lake:reset` 重建成加密湖。生产环境要给已有的湖加密时，另做一个运营命令，把数据复制到新建的加密湖里，本决定不做。迁移存储（`lake:migrate`）只是逐个复制文件，不改变加密状态；文件密钥跟着 catalog 走，不跟着前缀走。

**核对怎么读加密文件。** `parquet_file_metadata` / `parquet_schema` 不接受密钥。核对（ADR-0014）对加密文件改用 `read_parquet(..., encryption_config = {footer_key_value: <目录里的密钥>})` 读行数，不再检查尾部有没有目录里没有的字段（字段信息在加密的尾部里读不出来）。明文文件仍查两项。

**删除请求（#24）怎么擦除。** 一行数据只有在包含它的文件都从存储上删掉以后才算真正擦除。DuckLake 的 `DELETE` 只写删除文件，被删的行还留在原来的数据文件里，并且当前快照仍然引用这个文件。所以顺序是：

1. 在原始层、`_keys`、`_mirror`、标准层里对该消费者执行 `DELETE`；
2. 对涉及的表执行 `ducklake_rewrite_data_files(..., delete_threshold => 0)`，把带删除的数据文件重写成不含这些行的新文件；
3. `ducklake_expire_snapshots` 让引用旧文件的快照全部过期；内联在 catalog 里的行要另外确认已经从内联表中删掉（#24 实现时验证）；
4. `ducklake_cleanup_old_files` 从存储上删掉旧文件。

第 2 步不能省：只做 DELETE、过期快照和清理时，旧数据文件仍是当前文件，被删的行还在里面。旧文件的 catalog 记录随第 3、4 步删掉，密钥也跟着没了；对象存储上如果还有这个文件的备份或旧版本，也已经解不开。

**本机暂存。** 工作进程本机的 `stage.duckdb`（ADR-0010）和溢写目录里有明文临时数据，不加密，会话关闭时删除。

## 已接受的取舍

- 防对象存储泄露，不防 catalog 泄露：密钥和 catalog 放在一起，不另建密钥服务。
- 加密前开通的湖继续是明文，直到重建。
- 加密文件的核对少了尾部字段这一项。
