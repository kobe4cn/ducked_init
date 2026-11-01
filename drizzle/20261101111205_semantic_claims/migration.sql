CREATE TABLE "platform"."semantic_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"target_id" text NOT NULL,
	"mapping_id" uuid,
	"claim_type" text NOT NULL,
	"value" text NOT NULL,
	"based_on" jsonb DEFAULT '[]' NOT NULL,
	"created_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "semantic_claims_target_idx" ON "platform"."semantic_claims" ("tenant_id","target_id","mapping_id","claim_type","created_at");--> statement-breakpoint
ALTER TABLE "platform"."semantic_claims" ADD CONSTRAINT "semantic_claims_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."semantic_claims" ADD CONSTRAINT "semantic_claims_mapping_id_mappings_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "platform"."mappings"("id") ON DELETE CASCADE;