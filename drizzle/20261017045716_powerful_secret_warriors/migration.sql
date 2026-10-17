CREATE TABLE "platform"."mapping_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"entity" text NOT NULL,
	"mapping_id" uuid,
	"origin" text NOT NULL,
	"yaml" text NOT NULL,
	"items" jsonb DEFAULT '[]' NOT NULL,
	"created_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mapping_generations_tenant_created_idx" ON "platform"."mapping_generations" ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "platform"."mapping_generations" ADD CONSTRAINT "mapping_generations_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."mapping_generations" ADD CONSTRAINT "mapping_generations_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "platform"."sources"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."mapping_generations" ADD CONSTRAINT "mapping_generations_mapping_id_mappings_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "platform"."mappings"("id") ON DELETE SET NULL;