CREATE TYPE "platform"."custom_entity_version_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TABLE "platform"."custom_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."custom_entity_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"entity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "platform"."custom_entity_version_status" DEFAULT 'draft'::"platform"."custom_entity_version_status" NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"fields" jsonb NOT NULL,
	"primary_key" text[] NOT NULL,
	"authors" text[] NOT NULL,
	"last_editor" text NOT NULL,
	"published_by_email" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "custom_entities_tenant_name_uq" ON "platform"."custom_entities" ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_entity_versions_entity_version_uq" ON "platform"."custom_entity_versions" ("entity_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_entity_versions_one_draft_uq" ON "platform"."custom_entity_versions" ("entity_id") WHERE status = 'draft';--> statement-breakpoint
ALTER TABLE "platform"."custom_entities" ADD CONSTRAINT "custom_entities_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."custom_entity_versions" ADD CONSTRAINT "custom_entity_versions_entity_id_custom_entities_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "platform"."custom_entities"("id") ON DELETE CASCADE;