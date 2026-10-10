// app/.server/pipeline/dsl/impact.ts —— 发布前的影响预览（ADR-0025）：把同一定义已发布版本与草稿编译出的两条 SQL 按 consumer_id FULL JOIN，只出计数。
// 两边都有但取值不同的算换了取值，只在草稿里有的算新增，只在已发布版本里有的算移出（指标窗口、过滤改了会让消费者整个出现或消失）。
// 结果里没有 consumer_id，也没有指标值；标签只出分析师写的取值。纯函数：不碰平台库与数据湖
const sides = (oldSql: string, newSql: string, select: (sql: string) => string) => `WITH o AS (${select(oldSql)}),\nn AS (${select(newSql)})`;

/**
 * 指标：每个消费者的全部行（带维度时不止一行）按列的值（不含列名，维度改名不算变）拼成一个值再比较，任一行变了就算换了取值。
 * 一行，列为 changed、added、removed（消费者数）
 */
export const compileMetricDiff = (oldSql: string, newSql: string) => [
  sides(oldSql, newSql, sql =>
    `SELECT consumer_id, list(row ORDER BY row) AS v FROM (SELECT consumer_id, CAST(json_extract(to_json(r), '$.*') AS VARCHAR) AS row FROM (${sql}) r) GROUP BY consumer_id`),
  'SELECT count(*) FILTER (WHERE o.consumer_id IS NOT NULL AND n.consumer_id IS NOT NULL AND o.v <> n.v)::INTEGER AS changed,',
  '  count(*) FILTER (WHERE o.consumer_id IS NULL)::INTEGER AS added,',
  '  count(*) FILTER (WHERE n.consumer_id IS NULL)::INTEGER AS removed',
  'FROM o FULL JOIN n ON n.consumer_id = o.consumer_id',
].join('\n');

/**
 * 标签：取值有变的消费者按「原取值 → 新取值」分组计人数，列为 before、after、consumers；新增的 before 为空，移出的 after 为空，取值没变的不出现
 */
export const compileTagDiff = (oldSql: string, newSql: string) => [
  sides(oldSql, newSql, sql => `SELECT consumer_id, tag_value FROM (${sql}) r`),
  'SELECT o.tag_value AS before, n.tag_value AS after, count(*)::INTEGER AS consumers',
  'FROM o FULL JOIN n ON n.consumer_id = o.consumer_id',
  'WHERE o.consumer_id IS NULL OR n.consumer_id IS NULL OR o.tag_value IS DISTINCT FROM n.tag_value',
  'GROUP BY ALL',
  'ORDER BY ALL NULLS FIRST',
].join('\n');
