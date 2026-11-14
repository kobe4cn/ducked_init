# 每租户一桶规模实测：SeaweedFS 4.50 与 RustFS 1.0.5 各 1000 个桶（#682 / #663）

测量日期：2026-11-14。基线 commit `6122297`（测量脚本 `scripts/bench-bucket-per-tenant.ts` 随本报告同提交入库）。
机器：沙箱容器，Apple aarch64（12 核）、23 GB 内存；单实例 server + 单进程基准脚本，全走 127.0.0.1（端口 18xxx/19xxx），不连宿主机容器。
两后端均为一次性实例：跑完基准即清理账号与桶并删掉二进制，不动宿主机的 SeaweedFS。

## 测什么

每个租户一个桶 + 一个只能访问自己桶的子账号（策略与产品 `app/.server/s3-accounts.ts` 一致：`s3:GetObject/PutObject/DeleteObject` 作用于 `arn:aws:s3:::<桶>/*` 加 `s3:ListBucket` 作用于桶本身，无 Conditions）。
建到 100 / 500 / 1000 个桶时各测一轮：①策略条数与 `policies.json` 字节 ②策略写入后新账号多久能通过鉴权（每 50ms 探测，5 轮取中位/最大；同时一个存量租户持续读自己桶，看写入期间有没有被拒）③平台列桶 20 次 + 20 个随机租户读写 1KB ④隔离抽查 5 对（A 的凭据读/写/列 B 的桶必须 403）⑤卷数（仅 SeaweedFS）。

## 复现

```bash
# SeaweedFS 4.50（iam 走 AWS IAM API）
AWS_ACCESS_KEY_ID=crm AWS_SECRET_ACCESS_KEY=crm-secret ./weed server -dir=/tmp/weed450/data \
  -ip=127.0.0.1 -ip.bind=127.0.0.1 -s3 -s3.port=18333 -s3.iam.readOnly=false \
  -master.port=19333 -volume.port=18080 -filer.port=18888 -master.volumeSizeLimitMB=64 -volume.max=0
node --import tsx scripts/bench-bucket-per-tenant.ts --backend seaweedfs --endpoint localhost:18333 \
  --access-key crm --secret-key crm-secret --filer http://localhost:18888 --master localhost:19333 \
  --buckets 1000 --checkpoints 100,500,1000 --out /tmp/bpt-seaweedfs.json

# RustFS 1.0.5（RUSTFS_ACCESS_KEY/SECRET_KEY；iam 不兼容 AWS API，脚本自动改走 mc 管理接口）
RUSTFS_ACCESS_KEY=crm RUSTFS_SECRET_KEY=crm-secret ./rustfs server --address 127.0.0.1:19000 /tmp/rustfs/data
node --import tsx scripts/bench-bucket-per-tenant.ts --backend rustfs --endpoint localhost:19000 \
  --access-key crm --secret-key crm-secret --mc ./mc \
  --buckets 1000 --checkpoints 100,500,1000 --out /tmp/bpt-rustfs.json
```

### 卷配置调整后（#687）

上面的 SeaweedFS 命令是 #682 基线配置（64 MB/卷、`-volume.max=0` 自动算出 1274）。#687 把每个新桶首写的预分配卷数从默认 7 调到 1（`db_script/seaweedfs/master.toml` 的 `[master.volume_growth] copy_1 = 1`，卷大小保持 1024 MB），并显式 `-volume.max=2000`；脚本加 `--write-each` 让每个桶建好就首写 1 个对象：

```bash
# 在 db_script/seaweedfs 目录下启动（weed 从当前目录读 ./master.toml；容器则挂 -v db_script/seaweedfs:/etc/seaweedfs:ro）
AWS_ACCESS_KEY_ID=crm AWS_SECRET_ACCESS_KEY=crm-secret ./weed server -dir=/tmp/weed450/data \
  -ip=127.0.0.1 -ip.bind=127.0.0.1 -s3 -s3.port=18333 -s3.iam.readOnly=false \
  -master.port=19333 -volume.port=18080 -filer.port=18888 -master.volumeSizeLimitMB=1024 -volume.max=2000
node --import tsx scripts/bench-bucket-per-tenant.ts --backend seaweedfs --endpoint localhost:18333 \
  --access-key crm --secret-key crm-secret --filer http://localhost:18888 --master localhost:19333 \
  --buckets 1000 --checkpoints 100,500,1000 --write-each --out /tmp/bpt-write-each.json
# 配置生效的快速判据：建 1 个桶首写一次，curl -s localhost:19333/dir/status 的卷数只 +1（+7 就是没读到 master.toml）
```

## SeaweedFS 4.50（AWS IAM API 模式，墙钟 6.9 分钟，建/删失败 0 次）

| 桶数 | 累计建桶 | 单租户建桶 p50/p95 | 策略条数 / policies.json 字节 | 重载生效中位/最大 | 列桶 p50/p95（实列桶数） | 租户写/读 1KB p50/p95 | 隔离抽查 | 卷数（free/max） |
|---|---|---|---|---|---|---|---|---|
| 100 | 3.0 s | 29.5 / 44.6 ms | 100 / 51,622 B | 0.63 / 0.78 ms | 0.7 / 0.9 ms（101） | 202.9 / 203.3 → 1.1 / 1.4 ms | 5 对全部 403 | 168（1107/1275） |
| 500 | 47.7 s | 96.0 / 167.2 ms | 505 / 261,932 B | 0.73 / 0.94 ms | 1.9 / 2.1 ms（502） | 202.8 / 203.4 → 1.0 / 1.2 ms | 5 对全部 403 | 350（925/1275） |
| 1000 | 176.6 s | 177.5 / 323.3 ms | 1010 / 524,145 B | 0.73 / 1.03 ms | 3.2 / 3.4 ms（1003） | 202.8 / 203.7 → 1.0 / 1.1 ms | 5 对全部 403 | 539（735/1274） |

- 策略条数含每个 checkpoint 的 5 个 reload 探测账号（1000 桶时 1000 + 10 = 1010）。
- 建桶变慢是 IAM 侧的：每次 `PutUserPolicy` 整份重写 `policies.json`（51 KB → 524 KB），单租户建桶 p50 从 29.5 ms 涨到 177.5 ms；列桶随桶数线性变慢（0.7 → 3.2 ms）但绝对值小。
- 重载生效始终 <1.1 ms、写入期间存量租户读全部 200（每轮 watch 上千次，0 次 403）——#560/#569 的整份重写拒绝窗口在 4.50 上没有复现。
- 写 1KB 稳定在 ~203 ms：每个新桶第一次写会分配卷（本实例 64 MB/卷，满配 1274 个）。到 1000 桶 checkpoint 时累计写过对象的桶约 75–79 个，不只是 20 个。这个数没有留 JSON，按脚本口径算：每个 checkpoint 写 1 个 reload 探测桶、`tenants[0]` 的 watch 桶、随机 20 个读写抽样桶、5 个隔离 B 桶，三轮合计最多 3 + 1 + 60 + 15 = 79 个，随机抽样有重叠时会少几个。用掉 539 个卷，539 / ≈77 ≈ 每桶 7 个卷。
- 按这个比例推算：本实例配置（64 MB/卷、max 1274）下如果每个桶都写入，大约到第 1274 / 7 ≈ **180** 个桶时卷位耗尽（`Free` 归 0，新桶首写报 `No writable volumes and no free volumes left`）。这是推算值，本次没有全量写入实测。要撑到 1000 个桶，需要调卷配置（如减小 `-master.volumeSizeLimitMB`、调 collection 的预分配卷数、加磁盘或卷服务器），或者按「桶数 × 每桶卷数」做容量规划。
- 隔离 100% 通过：跨租户读/写/列全部 403，无一例放行。

### 卷配置调整后（#687）实测：1000 桶全部首写通过

2026-11-14 实测（沙箱容器同机，weed 4.50 单实例，1024 MB/卷、`-volume.max=2000`、`master.toml` `copy_1 = 1`，复现命令见上节；commit 为本票分支）。`--write-each` 让每个桶建好就用平台账号首写 1 个 1KB 对象：

- **每桶首写 1000/1000 次成功**，建租户失败 0、清理失败 0、隔离放行 0，退出码 0，墙钟 10.0 分钟（含 checkpoint 与清理）。
- **`No writable volumes` 0 次**（基准日志与服务端日志均无）。
- **每桶实际只占 1 个卷**：单桶验证建桶不占卷、首写后卷数 0→1、同桶再写不涨；1000 桶全部首写后最后一个 checkpoint 的卷数 **1004/2000（free 996）** = 1000 桶 × 1 + 3 个 checkpoint 的 reload 探测桶 + 1 个 filer 元数据日志卷（checkpoint 100/500/1000 时分别为 101/503/1004）。
- 对照 #682 基线不变的项：建租户 p50 178.2 / p95 327.7 ms（IAM 整份重写 `policies.json` 主导，与 #682 的 177.5 ms 一致）；隔离抽查 45 次全 403；重载生效 <0.9 ms。抽样桶的写 p50 从 #682 的 202.8 ms 降到 1.1 ms——#682 的 203 ms 里主要是首写分配 7 卷的代价，本跑的抽样桶已被 `--write-each` 写过，只剩常规写。

## RustFS 1.0.5（mc 管理接口模式，墙钟 4.9 分钟，建/删失败 0 次）

| 桶数 | 累计建桶 | 单租户建桶 p50/p95 | 策略条数 | 重载生效中位/最大 | 列桶 p50/p95（实列桶数） | 租户写/读 1KB p50/p95 | 隔离抽查 |
|---|---|---|---|---|---|---|---|
| 100 | 17.4 s | 172.8 / 192.7 ms | 108 | 0.48 / 0.62 ms | 0.6 / 0.7 ms（101） | 1.6 / 2.0 → 0.5 / 0.6 ms | 5 对全部 403 |
| 500 | 87.4 s | 174.2 / 188.9 ms | 513 | 0.39 / 0.72 ms | 1.7 / 1.9 ms（502） | 1.8 / 2.7 → 0.5 / 0.5 ms | 5 对全部 403 |
| 1000 | 176.6 s | 175.9 / 193.6 ms | 1018 | 0.31 / 0.39 ms | 2.6 / 3.1 ms（1003） | 1.8 / 4.0 → 0.6 / 0.8 ms | 5 对全部 403 |

- 策略条数为 `mc admin policy list` 行数，含内置策略与 reload 探测账号；RustFS 没有 SeaweedFS 那份 `policies.json`，字节一栏不适用，也没有卷概念。
- 单租户建桶 ~175 ms 且不随规模增长——其中约 170 ms 是脚本里 3 次 `mc` 子进程（`admin user add` / `policy create` / `policy attach`）的固定开销，不是服务端变慢。
- 写 1KB 只有 ~1.8 ms（没有首写分配卷的代价）；列桶随桶数线性变慢（0.6 → 2.6 ms）但绝对值小；重载生效 <1 ms、watch 全 200。
- 隔离 100% 通过：跨租户读/写/列全部 403，无一例放行。

## 事实结论

- **RustFS 1.0.5 不兼容 AWS IAM API**：签 `iam` 请求返回 `NotImplemented: unknown service 'iam' in credential scope; expected one of: s3, sts, s3tables`，账号只能走它自己的管理接口（`mc admin user/policy`）。要支持它，产品代码（`app/.server/s3-accounts.ts`）需另写一套账号适配，不能像 SeaweedFS 一样复用 AWS IAM 调用。
- 两个后端在 1000 桶时**隔离都无一例放行**（每轮 5 对 × 读/写/列，共 45 次抽查全 403），列桶都在 3.4 ms 内，重载生效都在 1 ms 量级，存量租户读写没有被 IAM 写入打断。
- SeaweedFS 的真实代价是**建租户变慢**（p50 29.5 → 177.5 ms，IAM 整份重写 `policies.json`）和**首写分配卷**（每桶约 7 个 64 MB 卷；累计写过对象的约 75–79 个桶用掉 539/1274 个卷，口径见上文）。按这个比例，本配置下每个桶都写入时大约到**第 180 个桶**卷位耗尽。按 #687 配置（`copy_1 = 1`、1024 MB/卷、`-volume.max=2000`）实测 1000 桶全部首写通过，见下节。RustFS 这两项都没有问题，但接入要改账号层。

**可行/不可行：**
- **SeaweedFS 4.50 有条件可行**：建桶、IAM、列桶、读写和隔离在 1000 个桶时都没有问题；但如果每个桶都写入，本配置（64 MB/卷、max 1274）下约到第 180 个桶时卷位耗尽。要上 1000 个桶，必须调卷配置或做卷容量规划，并且接受建租户变慢到毫秒级。卷配置按 #687 调整后（每桶首写 1 卷、`-volume.max=2000`）已实测 1000 个桶全部写入通过，该条件已消除。
- **RustFS 1.0.5 可行**：前提是先为 mc 管理接口写账号适配。 本报告只记事实，方案取舍留给 #663 的后续工单。
