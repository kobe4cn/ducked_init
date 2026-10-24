CREATE TABLE "platform"."business_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"field" text NOT NULL,
	"mapping_id" uuid,
	"note" text NOT NULL,
	"created_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "business_notes_tenant_field_idx" ON "platform"."business_notes" ("tenant_id","entity","field","mapping_id","created_at");--> statement-breakpoint
ALTER TABLE "platform"."business_notes" ADD CONSTRAINT "business_notes_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."business_notes" ADD CONSTRAINT "business_notes_mapping_id_mappings_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "platform"."mappings"("id") ON DELETE CASCADE;