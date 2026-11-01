CREATE TABLE "platform"."knowledge_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"target_id" text NOT NULL,
	"mapping_id" uuid,
	"kind" text NOT NULL,
	"claim" jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]' NOT NULL,
	"based_on" jsonb DEFAULT '[]' NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"generator_version" text NOT NULL,
	"reviewed_by_email" text,
	"reviewed_at" timestamp with time zone,
	"rejected_reason" text,
	"accepted_ref" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_proposals_tenant_fingerprint_uq" ON "platform"."knowledge_proposals" ("tenant_id","fingerprint");--> statement-breakpoint
CREATE INDEX "knowledge_proposals_tenant_target_idx" ON "platform"."knowledge_proposals" ("tenant_id","target_id");--> statement-breakpoint
ALTER TABLE "platform"."knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_mapping_id_mappings_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "platform"."mappings"("id") ON DELETE CASCADE;