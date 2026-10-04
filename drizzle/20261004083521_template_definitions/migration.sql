CREATE TYPE "platform"."template_version_status" AS ENUM('draft', 'published');--> statement-breakpoint
CREATE TABLE "platform"."template_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"template" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"definition_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "platform"."template_version_status" DEFAULT 'draft'::"platform"."template_version_status" NOT NULL,
	"params" jsonb NOT NULL,
	"authors" text[] NOT NULL,
	"last_editor" text NOT NULL,
	"published_by_email" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "template_definitions_tenant_template_uq" ON "platform"."template_definitions" ("tenant_id","template");--> statement-breakpoint
CREATE UNIQUE INDEX "template_versions_definition_version_uq" ON "platform"."template_versions" ("definition_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "template_versions_one_draft_uq" ON "platform"."template_versions" ("definition_id") WHERE status = 'draft';--> statement-breakpoint
ALTER TABLE "platform"."template_definitions" ADD CONSTRAINT "template_definitions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."template_versions" ADD CONSTRAINT "template_versions_definition_id_template_definitions_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "platform"."template_definitions"("id") ON DELETE CASCADE;