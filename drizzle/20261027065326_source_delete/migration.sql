ALTER TABLE "platform"."sources" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."sources" ADD COLUMN "deleted_by_email" text;--> statement-breakpoint
DROP INDEX "platform"."sources_tenant_name_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "sources_tenant_name_uq" ON "platform"."sources" ("tenant_id","name") WHERE deleted_at is null;