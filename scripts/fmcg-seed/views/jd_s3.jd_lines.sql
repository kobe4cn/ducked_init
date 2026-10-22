-- jd_s3 的源视图 jd_lines：京东订单明细。明细只有京东 SKU，连接 SKU 对照表换成商家编码（= ERP 的 SKU），品类分析才对得上商品主数据（K3）。
-- 京东导出没有明细号：同一单里不会有两行同一个 SKU，映射以 订单号 + 京东SKU 为记录标识
SELECT i."订单号", i."京东SKU", m."商家编码", i."数量", i."金额", i._op, i._batch, i._commit_ts
FROM jd_items i
LEFT JOIN (SELECT DISTINCT ON ("京东SKU") "京东SKU", "商家编码" FROM sku_map WHERE _op <> 'delete' ORDER BY "京东SKU", _batch DESC) m ON m."京东SKU" = i."京东SKU"
