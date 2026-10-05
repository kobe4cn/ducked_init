ALTER TABLE "platform"."mappings" ADD COLUMN "source_view_id" uuid;--> statement-breakpoint
ALTER TABLE "platform"."source_view_versions" ADD COLUMN "columns" jsonb;--> statement-breakpoint
ALTER TABLE "platform"."source_view_versions" ADD COLUMN "tables" text[];--> statement-breakpoint
ALTER TABLE "platform"."mappings" ADD CONSTRAINT "mappings_source_view_id_source_views_id_fkey" FOREIGN KEY ("source_view_id") REFERENCES "platform"."source_views"("id");