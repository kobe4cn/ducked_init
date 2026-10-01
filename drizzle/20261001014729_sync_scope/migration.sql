ALTER TABLE "platform"."source_tables" ADD COLUMN "table_schema" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."source_tables" ADD COLUMN "readable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."source_tables" ADD COLUMN "estimated_rows" bigint;--> statement-breakpoint
ALTER TABLE "platform"."source_tables" ADD COLUMN "discovered_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."source_tables" ADD COLUMN "gone_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."source_tables" ADD COLUMN "in_scope" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."source_tables" ADD COLUMN "scoped_by_email" text;--> statement-breakpoint
ALTER TABLE "platform"."source_tables" ADD COLUMN "scoped_at" timestamp with time zone;--> statement-breakpoint
-- 已有数据源：最近一次成功采集到的表回填为表清单（PostgreSQL 与 MySQL 以采集结果里的行数作估算行数，其他数据源不给）
WITH "latest" AS (
  SELECT DISTINCT ON ("params"->>'sourceId') ("params"->>'sourceId')::uuid AS "source_id", "result"
  FROM "platform"."tasks" WHERE "kind" = 'source.profile' AND "status" = 'succeeded' AND "result" IS NOT NULL
  ORDER BY "params"->>'sourceId', "created_at" DESC, "id" DESC
), "listed" AS (
  SELECT "source_id", t->>'name' AS "table_name", true AS "readable", (t->>'rows')::bigint AS "estimated_rows"
  FROM "latest", jsonb_array_elements(coalesce("result"->'tables', '[]')) t
  UNION ALL
  SELECT "source_id", t #>> '{}', false, NULL FROM "latest", jsonb_array_elements(coalesce("result"->'unreadable', '[]')) t
)
INSERT INTO "platform"."source_tables" ("source_id", "table_name", "table_schema", "readable", "estimated_rows")
SELECT l."source_id", l."table_name",
  CASE s."kind" WHEN 'postgres' THEN s."config"->>'schema' WHEN 's3' THEN ''
    WHEN 'duckdb' THEN CASE WHEN position('.' IN l."table_name") > 0 THEN split_part(l."table_name", '.', 1) ELSE 'main' END
    ELSE s."config"->>'database' END,
  l."readable", CASE WHEN s."kind" IN ('postgres', 'mysql') THEN l."estimated_rows" END
FROM "listed" l JOIN "platform"."sources" s ON s."id" = l."source_id"
ON CONFLICT ("source_id", "table_name") DO UPDATE
  SET "table_schema" = excluded."table_schema", "readable" = excluded."readable", "estimated_rows" = excluded."estimated_rows";--> statement-breakpoint
-- 确认过设置、但最近一次成功采集里已经没有的表：源端已不存在
WITH "latest" AS (
  SELECT DISTINCT ON ("params"->>'sourceId') ("params"->>'sourceId')::uuid AS "source_id", "result"
  FROM "platform"."tasks" WHERE "kind" = 'source.profile' AND "status" = 'succeeded' AND "result" IS NOT NULL
  ORDER BY "params"->>'sourceId', "created_at" DESC, "id" DESC
)
UPDATE "platform"."source_tables" st SET "gone_at" = now()
FROM "latest" l
WHERE l."source_id" = st."source_id"
  AND NOT jsonb_path_exists(l."result", '$.tables[*] ? (@.name == $n)', jsonb_build_object('n', st."table_name"))
  AND NOT coalesce(l."result"->'unreadable', '[]') ? st."table_name";--> statement-breakpoint
-- 原始层里已有的表（同步写出过变更批次）回填为在同步范围内，同步行为不变；其余不在范围内
INSERT INTO "platform"."source_tables" ("source_id", "table_name", "in_scope", "scoped_at")
SELECT DISTINCT s."id", r->>'table', true, now()
FROM "platform"."tasks" t
JOIN "platform"."sources" s ON s."id"::text = t."params"->>'sourceId'
CROSS JOIN jsonb_array_elements(coalesce(t."result"->'tables', '[]')) r
WHERE t."kind" = 'source.sync' AND r ? 'batch'
ON CONFLICT ("source_id", "table_name") DO UPDATE SET "in_scope" = true, "scoped_at" = now();
