#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="postgres-server"
VOLUME_NAME="pg-data"
POSTGRES_IMAGE="postgres:17"

POSTGRES_USER="crm"
POSTGRES_PASSWORD="crm"
POSTGRES_DB="crm"

# Apple Container VM resources
CPU_COUNT=8
MEMORY_SIZE="12g"
SHM_SIZE="2g"

echo "==> Starting Apple Container runtime..."
container system start || {
    echo "ERROR: Failed to start Apple Container runtime."
    exit 1
}

echo "==> Creating PostgreSQL volume..."
container volume create "$VOLUME_NAME" >/dev/null 2>&1 || true

echo "==> Removing existing container..."
container stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
container delete "$CONTAINER_NAME" >/dev/null 2>&1 || true

echo "==> Starting PostgreSQL..."

container run -d \
    --name "$CONTAINER_NAME" \
    --cpus "$CPU_COUNT" \
    --memory "$MEMORY_SIZE" \
    --shm-size "$SHM_SIZE" \
    -p 5432:5432 \
    -e POSTGRES_USER="$POSTGRES_USER" \
    -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    -e POSTGRES_DB="$POSTGRES_DB" \
    -e PGDATA=/var/lib/postgresql/data/pgdata \
    -v "$VOLUME_NAME:/var/lib/postgresql/data" \
    "$POSTGRES_IMAGE" \
    postgres \
        -c shared_buffers=2GB \
        -c max_wal_size=16GB \
        -c checkpoint_timeout=30min \
        -c synchronous_commit=off \
        -c maintenance_work_mem=1GB \
        -c max_parallel_maintenance_workers=4 || {
    echo "ERROR: Failed to start PostgreSQL container."
    exit 1
}

echo
echo "==> PostgreSQL container started."
echo "==> Waiting for PostgreSQL..."

for i in $(seq 1 30); do
    if container exec -u postgres "$CONTAINER_NAME" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
        echo "==> PostgreSQL is ready."
        break
    fi
    sleep 1
done

echo
container list

echo
echo "Database:"
echo "  Host:     localhost"
echo "  Port:     5432"
echo "  Database: $POSTGRES_DB"
echo "  User:     $POSTGRES_USER"
echo "  Password: $POSTGRES_PASSWORD"

echo
echo "Connect:"
echo "  container exec -it -u postgres $CONTAINER_NAME psql -U $POSTGRES_USER -d $POSTGRES_DB"

echo
echo "Logs:"
echo "  container logs $CONTAINER_NAME"
