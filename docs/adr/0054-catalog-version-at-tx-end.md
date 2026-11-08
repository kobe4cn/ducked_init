# 成员操作的目录版本由 `catalogTx` 在事务收尾时记一次，审计只登记目录动作

ADR-0041 规定成员操作「在审计的同一事务里」比较目录、记版本。实现是 `recordAudit` 写完审计行后，动作在白名单 `CATALOG_ACTIONS` 里就当场记版本：对租户行加 `FOR KEY SHARE`，拿按租户的 advisory 锁，在事务里重新生成整份目录与上一版比较。这带来两条只靠调用方自觉的约束：

- **拿了 advisory 锁之后不能再等租户行的锁**，否则与先锁租户行再记审计的事务互相等待。事务开头没锁租户行的操作，审计必须放在入队任务（`insertTask` 的 `FOR SHARE`）与 `lockTenant` 之后。这条规则以注释形式抄在 `sources.ts`（三处）、`source-views.ts`、`templates.ts` 里。
- **快照在审计那一刻生成**。同一事务里审计之后再改目录，这一版就漏掉那部分改动，要等下次读目录时补记，原因还会被记成 `catalog.detected`。这条没有写在任何地方。

ADR-0051 让七种可发布项的发布由 `publishing.ts` 保证审计在最后，但白名单里另外 17 个动作分散在 10 个文件里，新写一个目录动作的人仍要知道这两条。

决定：**成员操作的目录版本由 `app/.server/catalog/tx.ts` 的 `catalogTx(tenantId, fn)` 在 `fn` 结束后、同一事务里记一次。`recordAudit` 只把白名单动作登记到 `catalogTx` 的上下文（AsyncLocalStorage）里，不再记版本。**

- 在 `catalogTx` 外面审计白名单动作、`entry.tenantId` 与上下文的租户不同、在 `catalogTx` 里再开 `catalogTx`，一律抛错（生产环境也抛）。这是写代码时的错误，由测试发现，不留退回旧做法的路径。
- 接收 `tx` 参数的函数（如 `addAliasTx`、在调用方事务里执行的发布）自己不开 `catalogTx`，由最外层调用方负责。
- 一个事务里有多个目录动作只记一版，原因取第一个目录动作。
- `CATALOG_ACTIONS` 移到 `catalog/tx.ts`。`catalog/load.ts` 静态 import 了 `mappings`、`custom-entities` 等调用 `catalogTx` 的模块，所以 `catalog/tx.ts` 在记版本时动态 import `versions.ts`，全代码库只此一处；`audit.ts` 不再动态 import。

没有选「从审计里拿掉，各处显式调用 `catalogChanged(tx, …)`」：那样「哪些操作改变目录」从一张白名单分散到 24 个调用点，漏写一处就静默少记一版。白名单仍然挂在审计动作上，因为改变目录的成员操作本来都要审计。

## Consequences

- 两条约束由 `catalogTx` 保证：记版本永远是事务里最后一步，之后不再拿锁，快照包含事务里所有写入。各处「审计放在入队之后」的注释删除；`versions.ts` 的加锁说明改为指向 `catalogTx`。
- ADR-0051「审计永远是发布事务里最后一步」保留，但原因不再是目录版本的锁顺序。
- 采集、同步后补记（`recordCatalogVersionIfChanged`）与读取时补记（`ensureCatalogVersion`）不经成员事务，不受影响。
- `recordAudit` 传连接（非事务）时另开事务记版本的分支删除：传连接的调用都不是目录动作。
