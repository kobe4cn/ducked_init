#!/bin/sh
# 验收计划 S2.8–S2.11（docs/test-plans/acceptance-plan.md）：生成「文件上传数据源」用的 CSV。
#   sh scripts/fmcg-seed/uploads/make-uploads.sh
# 产物在 scripts/fmcg-seed/out/uploads/（out/ 不提交）：
#   dealer_stock_gbk.csv   经销商月度进货，GBK 编码（中文表头与取值），24 行；平台应识别为 GBK 并转成 UTF-8 登记
#   dealer_stock_utf8.csv  同一份内容的 UTF-8 版，用来对照两边原始层查出的内容逐行相同
#   big.csv                约 4 MiB，验证「单个上传文件上限」（运营后台把 A 的上传上限临时调成 1 MiB）
# 结尾打印期望：行数、进货箱数合计、金额合计、华东大区金额。
set -eu
OUT="$(cd "$(dirname "$0")/.." && pwd)/out/uploads"
mkdir -p "$OUT"
awk 'BEGIN {
  OFS = ",";
  split("D001,D002,D003,D004", code, ",");
  split("上海禾川商贸有限公司,苏州乳品经销部,北京鲜奶配送中心,广州华南乳业", name, ",");
  split("华东,华东,华北,华南", region, ",");
  split("HC0001,HC0002,HC0003", sku, ",");
  print "经销商编码", "经销商名称", "大区", "月份", "商家编码", "进货箱数", "金额";
  for (d = 1; d <= 4; d++) for (m = 5; m <= 10; m++) {
    s = sku[(d + m) % 3 + 1]; boxes = (d * 7 + m * 3) % 20 + 5; amount = boxes * 96;
    printf "%s,%s,%s,2026-%02d,%s,%d,%.2f\n", code[d], name[d], region[d], m, s, boxes, amount;
  }
}' > "$OUT/dealer_stock_utf8.csv"
iconv -f UTF-8 -t GBK "$OUT/dealer_stock_utf8.csv" > "$OUT/dealer_stock_gbk.csv"
{
  echo "id,note"
  i=1; while [ $i -le 60000 ]; do echo "$i,这是一行用来撑大文件体积的说明文字abcdefghij"; i=$((i + 1)); done
} > "$OUT/big.csv"
echo "生成在 ${OUT}："; ls -l "$OUT"
echo "期望：$(($(wc -l < "$OUT/dealer_stock_utf8.csv") - 1)) 行"
awk -F, 'NR > 1 { b += $6; a += $7; if ($3 == "华东") e += $7 } END { printf "进货箱数合计 %d，金额合计 %.2f，华东金额 %.2f\n", b, a, e }' "$OUT/dealer_stock_utf8.csv"
file "$OUT/dealer_stock_gbk.csv" "$OUT/dealer_stock_utf8.csv"
