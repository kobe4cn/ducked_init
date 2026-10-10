CREATE TYPE "platform"."dsl_kind" AS ENUM('metric', 'tag');--> statement-breakpoint
CREATE TABLE "platform"."dsl_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"kind" "platform"."dsl_kind" NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."dsl_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"definition_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "platform"."template_version_status" DEFAULT 'draft'::"platform"."template_version_status" NOT NULL,
	"yaml" text NOT NULL,
	"authors" text[] NOT NULL,
	"last_editor" text NOT NULL,
	"published_by_email" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "dsl_definitions_tenant_kind_key_uq" ON "platform"."dsl_definitions" ("tenant_id","kind","key");--> statement-breakpoint
CREATE UNIQUE INDEX "dsl_versions_definition_version_uq" ON "platform"."dsl_versions" ("definition_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "dsl_versions_one_draft_uq" ON "platform"."dsl_versions" ("definition_id") WHERE status = 'draft';--> statement-breakpoint
ALTER TABLE "platform"."dsl_definitions" ADD CONSTRAINT "dsl_definitions_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "platform"."dsl_versions" ADD CONSTRAINT "dsl_versions_definition_id_dsl_definitions_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "platform"."dsl_definitions"("id") ON DELETE CASCADE;