ALTER TABLE "platform"."business_notes" ADD COLUMN "target_id" text;--> statement-breakpoint
ALTER TABLE "platform"."business_notes" ADD COLUMN "based_on" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."business_notes" ALTER COLUMN "entity" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."business_notes" ALTER COLUMN "field" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "business_notes_tenant_target_idx" ON "platform"."business_notes" ("tenant_id","target_id","created_at");--> statement-breakpoint
ALTER TABLE "platform"."business_notes" ADD CONSTRAINT "business_notes_target_kind" CHECK (("target_id" IS NULL) = ("entity" IS NOT NULL AND "field" IS NOT NULL));