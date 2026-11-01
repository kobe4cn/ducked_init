CREATE TABLE "platform"."knowledge_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"target_id" text NOT NULL,
	"mapping_id" uuid,
	"alias" text NOT NULL,
	"based_on" jsonb DEFAULT '[]' NOT NULL,
	"created_by_email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_by_email" text,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_aliases_active_uq" ON "platform"."knowledge_aliases" ("tenant_id","target_id",coalesce("mapping_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("alias")) WHERE retired_at is null;--> statement-breakpoint
ALTER TABLE "platform"."knowledge_aliases" ADD CONSTRAINT "knowledge_aliases_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."knowledge_aliases" ADD CONSTRAINT "knowledge_aliases_mapping_id_mappings_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "platform"."mappings"("id") ON DELETE CASCADE;