"""
scripts/make_delta_iceberg.py —— 生成 Delta Lake 与 Iceberg 测试表，供 src/11_extensions.ts 第 19 节读取

模拟“其他团队用 Spark / Flink 写出的湖表”。只在本地测试时需要：
    pip install deltalake pyarrow "pyiceberg[sql-sqlite]"
    python3 scripts/make_delta_iceberg.py
"""
import os, shutil
import pyarrow as pa
import pyarrow.compute as pc
from deltalake import write_deltalake
from pyiceberg.catalog.sql import SqlCatalog

OUT = "./data/lakeformats"
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT, exist_ok=True)

# ---------------- Delta Lake：订单表，两次写入（产生两个版本）----------------
n = 1_000_000
ids = pa.array(range(1, n + 1), pa.int64())
orders = pa.table({
    "order_id": ids,
    "customer_id": pc.add(pc.divide(ids, 13), 1),
    "channel": pa.array(["app", "mini_program", "web", "store"] * (n // 4)),
    "net_amount": pc.round(pc.add(pc.multiply(pc.cast(pc.bit_wise_and(ids, 1023), pa.float64()), 0.9), 39.0), 2),
})
write_deltalake(f"{OUT}/delta_orders", orders.slice(0, 800_000), mode="overwrite")
write_deltalake(f"{OUT}/delta_orders", orders.slice(800_000), mode="append")
print("Delta 表：", f"{OUT}/delta_orders", "（2 个版本，共 100 万行）")

# ---------------- Iceberg：会员积分表（SQLite 目录 + 本地仓库）----------------
catalog = SqlCatalog("local", uri=f"sqlite:///{OUT}/iceberg_catalog.db", warehouse=f"file://{os.path.abspath(OUT)}/iceberg_wh")
catalog.create_namespace("crm")
m = 100_000
cid = pa.array(range(1, m + 1), pa.int64())
members = pa.table({
    "customer_id": cid,
    "tier": pa.array(["普通", "普通", "普通", "银卡", "银卡", "金卡", "黑金", "普通", "银卡", "普通"] * (m // 10)),
    "points": pc.multiply(pc.bit_wise_and(cid, 4095), 3),
})
tbl = catalog.create_table("crm.members", schema=members.schema)
tbl.append(members.slice(0, 60_000))
tbl.append(members.slice(60_000))
tbl = catalog.load_table("crm.members")
with open(f"{OUT}/iceberg_meta.txt", "w") as f:
    f.write(tbl.metadata_location.replace("file://", ""))
print("Iceberg 表：", tbl.metadata_location, "（2 个快照，共 10 万行）")
