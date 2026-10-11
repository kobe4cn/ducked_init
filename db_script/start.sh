#对象存储setup 脚本
#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="seaweedfs"
VOLUME_NAME="seaweedfs-data"
IMAGE="docker.io/chrislusf/seaweedfs:latest"

# 平台账号经 AWS_* 注入，租户账号由平台经 IAM API 创建、保存在 filer 中（ADR-0008）
# SeaweedFS 资源
CPU_COUNT=8
MEMORY_SIZE="12g"

PROJECT_DIR="$(pwd)"

echo "==> Starting Apple Container runtime..."
container system start || {
    echo "ERROR: Failed to start Apple Container runtime."
    exit 1
}

echo "==> Creating SeaweedFS volume..."
container volume create "$VOLUME_NAME" >/dev/null 2>&1 || true

echo "==> Removing old SeaweedFS container..."
container stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
container delete "$CONTAINER_NAME" >/dev/null 2>&1 || true

echo "==> Starting SeaweedFS..."
echo "    CPUs:   $CPU_COUNT"
echo "    Memory: $MEMORY_SIZE"

container run -d \
    --name "$CONTAINER_NAME" \
    --cpus "$CPU_COUNT" \
    --memory "$MEMORY_SIZE" \
    -p 8333:8333 \
    -p 9333:9333 \
    -p 8888:8888 \
    -e AWS_ACCESS_KEY_ID=crm \
    -e AWS_SECRET_ACCESS_KEY=crm-secret \
    -v "$VOLUME_NAME:/data" \
    "$IMAGE" \
    server \
        -dir=/data \
        -ip.bind=0.0.0.0 \
        -s3 \
        -s3.port=8333 \
        -s3.iam.readOnly=false \
        -master.volumeSizeLimitMB=1024 \
        -volume.max=0 || {
    echo "ERROR: Failed to start SeaweedFS."
    exit 1
}

echo "==> Waiting for SeaweedFS S3 API..."

for i in $(seq 1 60); do
    if curl -s http://localhost:8333 >/dev/null 2>&1; then
        echo "==> SeaweedFS S3 API is ready."
        break
    fi
    sleep 1
done

echo "==> Creating bucket crm-lake..."

if command -v aws >/dev/null 2>&1; then
    AWS_ACCESS_KEY_ID=crm \
    AWS_SECRET_ACCESS_KEY=crm-secret \
    AWS_DEFAULT_REGION=us-east-1 \
    aws \
        --endpoint-url http://localhost:8333 \
        s3 mb s3://crm-lake >/dev/null 2>&1 || true
else
    curl -s \
        -X POST \
        "http://localhost:8888/buckets/crm-lake/" \
        >/dev/null 2>&1 || true
fi

# localhost 的端口转发在大流量下会断连（#169），平台与测试的 S3_ENDPOINT 直接用容器 IP；IP 每次重建容器都可能变
CONTAINER_IP="$(container inspect "$CONTAINER_NAME" | python3 -c 'import json,sys; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print(d["status"]["networks"][0]["ipv4Address"].split("/")[0])' 2>/dev/null || true)"

echo
echo "==> SeaweedFS started."
echo
echo "Container IP: ${CONTAINER_IP:-（没查到，用 container ls 看）}"
echo "  .env 里设 S3_ENDPOINT=${CONTAINER_IP:-<容器 IP>}:8333，改完重启平台进程与调度器"
echo
echo "Endpoints:"
echo "  S3 API:        http://localhost:8333（大流量会断，平台用上面的容器 IP）"
echo "  Master UI:     http://localhost:9333"
echo "  Filer UI:      http://localhost:8888"
echo
echo "Bucket:"
echo "  crm-lake"
echo
echo "Logs:"
echo "  container logs $CONTAINER_NAME"
echo
echo "Resources:"
echo "  container stats $CONTAINER_NAME"
