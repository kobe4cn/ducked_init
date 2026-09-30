ALTER TABLE "platform"."source_tables" ADD COLUMN "key_columns" text[];--> statement-breakpoint
ALTER TABLE "platform"."source_tables" ADD COLUMN "soft_delete_column" text;--> statement-breakpoint
ALTER TABLE "platform"."source_tables" ADD COLUMN "soft_delete_confirmed_by_email" text;--> statement-breakpoint
-- 已确认的单列业务主键沿用为一列的组合
UPDATE "platform"."source_tables" SET "key_columns" = ARRAY["key_column"] WHERE "key_column" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."source_tables" DROP COLUMN "key_column";