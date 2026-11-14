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

## SeaweedFS 4.50（AWS IAM API 模式，墙钟 6.9 分钟，建/删失败 0 次）

| 桶数 | 累计建桶 | 单租户建桶 p50/p95 | 策略条数 / policies.json 字节 | 重载生效中位/最大 | 列桶 p50/p95（实列桶数） | 租户写/读 1KB p50/p95 | 隔离抽查 | 卷数（free/max） |
|---|---|---|---|---|---|---|---|---|
| 100 | 3.0 s | 29.5 / 44.6 ms | 100 / 51,622 B | 0.63 / 0.78 ms | 0.7 / 0.9 ms（101） | 202.9 / 203.3 → 1.1 / 1.4 ms | 5 对全部 403 | 168（1107/1275） |
| 500 | 47.7 s | 96.0 / 167.2 ms | 505 / 261,932 B | 0.73 / 0.94 ms | 1.9 / 2.1 ms（502） | 202.8 / 203.4 → 1.0 / 1.2 ms | 5 对全部 403 | 350（925/1275） |
| 1000 | 176.6 s | 177.5 / 323.3 ms | 1010 / 524,145 B | 0.73 / 1.03 ms | 3.2 / 3.4 ms（1003） | 202.8 / 203.7 → 1.0 / 1.1 ms | 5 对全部 403 | 539（735/1274） |

- 策略条数含每个 checkpoint 的 5 个 reload 探测账号（1000 桶时 1000 + 10 = 1010）。
- 建桶变慢是 IAM 侧的：每次 `PutUserPolicy` 整份重写 `policies.json`（51 KB → 524 KB），单租户建桶 p50 从 29.5 ms 涨到 177.5 ms；列桶随桶数线性变慢（0.7 → 3.2 ms）但绝对值小。
- 重载生效始终 <1.1 ms、写入期间存量租户读全部 200（每轮 watch 上千次，0 次 403）——#560/#569 的整份重写拒绝窗口在 4.50 上没有复现。
- 写 1KB 稳定在 ~203 ms：每个新桶第一次写会分配卷（本实例 64 MB/卷，每写一个桶约多 7 个卷；1000 桶只抽查写 20 个就用掉 539 个卷，满配 1274 个）。全量每桶都写会先碰卷数上限，容量规划要按桶数 × 每桶卷数估。
- 隔离 100% 通过：跨租户读/写/列全部 403，无一例放行。

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
- SeaweedFS 的真实代价是**建租户变慢**（p50 29.5 → 177.5 ms，IAM 整份重写 `policies.json`）和**首写分配卷**（每桶约 7 个 64 MB 卷，只写 20 个桶就用了 539/1274 个卷）；RustFS 这两项都没有此问题，但接入要改账号层。

**可行/不可行：两后端 1000 桶档均可行（SeaweedFS 需接受建租户毫秒级变慢并按桶数 × 每桶 7 卷做容量规划；RustFS 需先写 mc 管理接口的账号适配）。** 本报告只记事实，方案取舍留给 #663 的后续工单。
