#!/bin/sh
# 清理本机 seaweedfs 的 filer 元数据日志（/topics/.system/log，每天一个目录、每分钟一个文件）。
#
# 它只给订阅者从「现在」开始读（S3 网关、filer.sync），旧日志没人再读，但会一直占默认 collection 的卷：
# 跑完整测试的日子一天 20G 以上，卷数到上限后对象存储写不进去，门槛里 IAM 调用全部超时。
# fs.configure 的路径 TTL 对 filer 自己写的日志不生效（2026-11-03 试过），所以用这个脚本删。
#
# 做两件事：
#   1. 删掉早于 KEEP_DAYS 天（UTC 日期）的日期目录；
#   2. 删掉默认 collection 里已写满（> 1000MB，不会再被写入）且文件全部已删的卷，立即收回卷位和磁盘。
#      没写满的卷里删掉的部分要等 seaweedfs 自己 vacuum。
#
# 用法：scripts/prune-seaweed-metalog.sh [KEEP_DAYS，默认 2]
# 容器名取 SEAWEED_CONTAINER（默认 seaweedfs）。没有 container 命令或容器没在跑时跳过并退出 0。
# Sandcastle 每轮开头会调用（.sandcastle/main.ts），失败只打日志。
set -eu

keep="${1:-2}"
c="${SEAWEED_CONTAINER:-seaweedfs}"

command -v container >/dev/null 2>&1 || { echo "跳过：没有 container 命令"; exit 0; }
container exec "$c" true >/dev/null 2>&1 || { echo "跳过：容器 $c 没在运行"; exit 0; }

container exec "$c" sh -c '
set -eu
keep=$1
ws() { weed shell -master=localhost:9333 -filer=localhost:8888 2>/dev/null; }
cutoff=$(date -u -d "@$(( $(date +%s) - keep * 86400 ))" +%F)

old=$(echo "fs.ls /topics/.system/log" | ws | grep -E "^[0-9]{4}-[0-9]{2}-[0-9]{2}\$" | awk -v c="$cutoff" "\$0 < c")
dirs=0
if [ -n "$old" ]; then
  for d in $old; do echo "fs.rm -r /topics/.system/log/$d"; done | ws >/dev/null
  dirs=$(echo "$old" | wc -l)
fi

# volume.list 的卷行：volume Id:1, Size:…, ReplicaPlacement:000, Collection:, …, FileCount:210, DeleteCount:210, …
# 卷行属于它上面最近的 DataNode 行。
dead=$(echo "volume.list" | ws | awk -v lim=$((1000 * 1024 * 1024)) "
  /DataNode / { for (i = 1; i <= NF; i++) if (\$i == \"DataNode\") node = \$(i + 1) }
  /volume Id:/ {
    id = \"\"; size = 0; col = \"x\"; fc = -1; dc = -2
    n = split(\$0, f, \", \")
    for (i = 1; i <= n; i++) {
      split(f[i], kv, \":\"); k = kv[1]; sub(/.* /, \"\", k)
      if (k == \"Id\") id = kv[2]
      else if (k == \"Size\") size = kv[2] + 0
      else if (k == \"Collection\") col = kv[2]
      else if (k == \"FileCount\") fc = kv[2] + 0
      else if (k == \"DeleteCount\") dc = kv[2] + 0
    }
    if (col == \"\" && size > lim && fc > 0 && fc == dc) print node, id
  }")
vols=0
if [ -n "$dead" ]; then
  { echo lock; echo "$dead" | while read -r node id; do echo "volume.delete -node $node -volumeId $id"; done; echo unlock; } | ws >/dev/null
  vols=$(echo "$dead" | wc -l)
fi

echo "元数据日志：删除 $dirs 个早于 $cutoff 的日期目录，删除 $vols 个已清空的卷；/data 已用 $(df -h /data | awk "NR == 2 { print \$3 }")"
' _ "$keep"
