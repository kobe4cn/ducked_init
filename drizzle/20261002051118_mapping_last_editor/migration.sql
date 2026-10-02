ALTER TABLE "platform"."mapping_versions" ADD COLUMN "last_editor" text;--> statement-breakpoint
-- 已有版本以作者列表的最后一位回填（作者去重后按首次出现排序，只是近似值）
UPDATE "platform"."mapping_versions" SET "last_editor" = "authors"[cardinality("authors")];--> statement-breakpoint
ALTER TABLE "platform"."mapping_versions" ALTER COLUMN "last_editor" SET NOT NULL;
