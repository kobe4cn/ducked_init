CREATE TYPE "platform"."mapping_version_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TABLE "platform"."mapping_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"mapping_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "platform"."mapping_version_status" DEFAULT 'draft'::"platform"."mapping_version_status" NOT NULL,
	"yaml" text NOT NULL,
	"plan" jsonb NOT NULL,
	"authors" text[] NOT NULL,
	"published_by_email" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"entity" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mapping_versions_mapping_version_uq" ON "platform"."mapping_versions" ("mapping_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "mapping_versions_one_draft_uq" ON "platform"."mapping_versions" ("mapping_id") WHERE status = 'draft';--> statement-breakpoint
CREATE INDEX "mappings_tenant_idx" ON "platform"."mappings" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mappings_source_table_entity_uq" ON "platform"."mappings" ("source_id","table_name","entity");--> statement-breakpoint
ALTER TABLE "platform"."mapping_versions" ADD CONSTRAINT "mapping_versions_mapping_id_mappings_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "platform"."mappings"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."mappings" ADD CONSTRAINT "mappings_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."mappings" ADD CONSTRAINT "mappings_space_id_spaces_id_fkey" FOREIGN KEY ("space_id") REFERENCES "platform"."spaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."mappings" ADD CONSTRAINT "mappings_source_id_sources_id_fkey" FOREIGN KEY ("source_id") REFERENCES "platform"."sources"("id") ON DELETE CASCADE;