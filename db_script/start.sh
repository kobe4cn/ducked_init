#对象存储setup 脚本
#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="seaweedfs"
VOLUME_NAME="seaweedfs-data"
IMAGE="docker.io/chrislusf/seaweedfs:latest"

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
    -v "$PROJECT_DIR/docker/seaweedfs/s3.json:/etc/seaweedfs/s3.json:ro" \
    -v "$VOLUME_NAME:/data" \
    "$IMAGE" \
    server \
        -dir=/data \
        -ip.bind=0.0.0.0 \
        -s3 \
        -s3.port=8333 \
        -s3.config=/etc/seaweedfs/s3.json \
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

echo
echo "==> SeaweedFS started."
echo
echo "Endpoints:"
echo "  S3 API:        http://localhost:8333"
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
